/*
 * Kennlinie der Bedarfsregelung zum Anfassen: ein Bild ueber die volle Breite mit ziehbaren
 * Stuetzpunkten und den beiden Leistungsgrenzen als ziehbare waagerechte Linien. Die Tabelle derselben
 * Punkte gibt es weiter, aber eingeklappt ("Werte als Tabelle"). Geschrieben wird nur ins Formular
 * (onChange): "Speichern" der Instanz uebernimmt, "Schliessen" verwirft.
 *
 * Bedienung im Bild: Punkt ziehen (oder Pfeiltasten), Doppelklick in die Flaeche = Punkt hinzufuegen,
 * Rechtsklick auf einen Punkt oder Entf = entfernen (zwei bleiben). Die Grenzlinien lassen sich am
 * Griff, an der Linie und mit den Pfeiltasten verschieben. Ihr Wert steht als Schrift an der Linie;
 * Doppelklick darauf (Finger: antippen; Tastatur: Enter oder F2 am Griff) oeffnet an Ort und Stelle
 * eine Zahleneingabe - Enter uebernimmt, Esc verwirft, Unzulaessiges wird mit Begruendung abgelehnt.
 *
 * Der Jetzt-Marker (Aussentemperatur des Geraets) ist bewusst zurueckhaltend: duenne blasse Linie,
 * kleiner Kreis auf der Kurve, ein Etikett. Er liegt UNTER den Griffen, nimmt keine Mausereignisse an
 * und verschwindet waehrend des Ziehens - vorher lag ein dicker Balken ueber den Punkten und hat das
 * Anpassen blockiert (Nutzerfund 21.11.2026).
 *
 * Die Regeln (Raster, Grenzen durch die Nachbarpunkte, Grenzlinien, Pruefung) stehen in
 * lib/kennlinienzug.js, Achse und Farben kommen aus derselben Datei wie das Bild der Geraetekarte und
 * der VIS-Baustein (lib/kennlinienbild.js). Der Arbeitspunkt des Geraets kommt vom Adapter (sendTo
 * regelArbeitspunkt). Kopieren/Einfuegen/Zuruecksetzen: Werkzeugleiste.tsx.
 */
import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import {
    Box,
    Button,
    IconButton,
    SvgIcon,
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableRow,
    Tooltip,
    Typography,
} from '@mui/material';
import { I18n } from '@iobroker/gui-components';
import { ConfigGeneric, type ConfigGenericProps, type ConfigGenericState } from '@iobroker/json-config';

import zugLib from '../../lib/kennlinienzug.js';
import bildLib from '../../lib/kennlinienbild.js';
import Werkzeugleiste from './Werkzeugleiste';
import { kt, type Schluessel } from './Kennlinie.texte';

/** Geraet ohne Maus (grober Zeiger): dort gibt es weder Doppel- noch Rechtsklick */
const TOUCH =
    typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches;

export type Richtung = 'heizen' | 'kuehlen';
type Grenze = 'unter' | 'ober';
interface Punkt {
    x: number;
    y: number;
}
/** Arbeitspunkt des Geraets: Aussentemperatur und - wenn die Regelung in dieser Richtung laeuft - die gesendete Leistung. */
interface Etikett {
    x: number;
    wert: number | null;
    /** fertige Beschriftung des Adapters (fuer das Bild der Geraetekarte; hier nicht mehr gezeichnet) */
    text?: string;
    unterzeile?: string;
    /** Schwelle der vollen Freigabe in K */
    vollAbK?: number;
    probelauf?: boolean;
}
interface Fehler {
    schluessel: string;
    n?: number;
}
interface Grenzen {
    untergrenze: number;
    obergrenze: number;
}
/** Alles, was zu einer Grafik gehoert - so wie es im Formular steht ('' = es gilt die Vorlage). */
export interface Stand {
    punkte: Punkt[];
    untergrenze: number | '';
    obergrenze: number | '';
}

const zug = zugLib as {
    RASTER: { x: number; y: number };
    GRENZEN: { xMin: number; xMax: number; yMin: number; yMax: number };
    GRENZLINIE: { raster: number; min: number; max: number };
    VORGABE: Record<Richtung, Punkt[]>;
    VORGABE_GRENZEN: Grenzen;
    punkte(roh: unknown): Punkt[];
    pruefen(p: Punkt[], richtung: Richtung): Fehler | null;
    ziehen(p: Punkt[], i: number, ziel: Partial<Punkt>, richtung: Richtung, rahmen?: object): Punkt[];
    schritt(p: Punkt[], i: number, dx: number, dy: number, richtung: Richtung): Punkt[];
    hinzu(p: Punkt[]): { punkte: Punkt[]; neu: number };
    einfuegen(p: Punkt[], ziel: Punkt, richtung: Richtung, rahmen?: object): { punkte: Punkt[]; neu: number };
    entfernen(p: Punkt[], i: number): { punkte: Punkt[]; entfernt: boolean };
    grenzenGueltig(untergrenze: number, obergrenze: number): boolean;
    grenzBereich(welche: Grenze, grenzen: Grenzen): { min: number; max: number };
    grenzeZiehen(welche: Grenze, ziel: number, grenzen: Grenzen): number;
    grenzeSchritt(welche: Grenze, n: number, grenzen: Grenzen): number;
    inhaltLesen(
        inhalt: unknown,
        richtung: Richtung,
    ): { punkte: Punkt[]; untergrenze: number | null; obergrenze: number | null } | null;
    anzeige(n: number, sprache?: string): string;
    anzeigeFest(n: number, stellen: number, sprache?: string): string;
    etikett(p: Punkt, sprache?: string): string;
};
const bild = bildLib as {
    FARBEN: Record<Richtung, string>;
    achse(punkte: number[][], x?: number | null): { min: number; max: number; schritt: number };
    wertAuf(punkte: number[][], x: number): number;
};

// Die Symbole als Pfade (Material Icons) - so braucht das Paket keine eigene Kopie der Symbolbibliothek.
const symbol = (pfad: string) =>
    function Symbol(): React.JSX.Element {
        return (
            <SvgIcon fontSize="small">
                <path d={pfad} />
            </SvgIcon>
        );
    };
const AddIcon = symbol('M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6z');
const DeleteIcon = symbol('M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6zM19 4h-3.5l-1-1h-5l-1 1H5v2h14z');
const ZuIcon = symbol('M10 6 8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z');
const AufIcon = symbol('M16.59 8.59 12 13.17 7.41 8.59 6 10l6 6 6-6z');

/**
 * Zeichenflaeche (viewBox): so breit wie der Platz im Formular (nicht skaliert - Schrift und Griffe
 * behalten ihre Groesse), auf schmalen Schirmen etwas niedriger.
 */
const B_MAX = 1600;
const B_MIN = 300;
const B_START = 640;
const RAND = { l: 44, r: 14, o: 14, u: 28 };

/** Text der Komponente aus src/i18n (Fehlertexte, wortgleich mit dem Adapter), Platzhalter %s. */
export function t(schluessel: string, ...werte: (string | number)[]): string {
    return I18n.t(`fk_${schluessel}`, ...(werte as string[]));
}

const istLeer = (v: unknown): boolean => v === undefined || v === null || v === '';
const zahlOder = (v: unknown, sonst: number): number => (istLeer(v) || !Number.isFinite(Number(v)) ? sonst : Number(v));
const gleich = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
/** geschaetzte Breite eines 11-px-Textes der Zeichnung (CJK-Zeichen sind etwa doppelt so breit) */
const textBreite = (text: string): number =>
    [...text].reduce((summe, z) => summe + ((z.codePointAt(0) || 0) > 0x2e80 ? 11.2 : 6.1), 0);

/** Ein Zahlenfeld der Tabelle: zeigt den Wert des Formulars, laesst beim Tippen Zwischenstaende zu. */
function Zahlfeld(props: {
    wert: unknown;
    min: number;
    max: number;
    step: number;
    name: string;
    fehler: boolean;
    onWert: (wert: number | '') => void;
    onFokus: (drin: boolean) => void;
}): React.JSX.Element {
    const [text, setText] = useState(istLeer(props.wert) ? '' : String(props.wert));
    const aussen = istLeer(props.wert) ? NaN : Number(props.wert);
    useEffect(() => {
        // nur uebernehmen, wenn das Formular etwas anderes sagt als das Getippte (z. B. nach dem Ziehen)
        setText(alt => {
            const innen = alt.trim() === '' ? NaN : Number(alt.replace(',', '.'));
            return Object.is(innen, aussen) || (Number.isNaN(innen) && Number.isNaN(aussen))
                ? alt
                : Number.isNaN(aussen)
                  ? ''
                  : String(aussen);
        });
    }, [aussen]);
    return (
        <input
            className="fk-zahl"
            type="number"
            inputMode="decimal"
            aria-label={props.name}
            aria-invalid={props.fehler}
            min={props.min}
            max={props.max}
            step={props.step}
            value={text}
            onFocus={() => props.onFokus(true)}
            onBlur={() => props.onFokus(false)}
            onChange={e => {
                const neu = e.target.value;
                setText(neu);
                const n = neu.trim() === '' ? NaN : Number(neu.replace(',', '.'));
                props.onWert(Number.isFinite(n) ? n : '');
            }}
        />
    );
}

interface AnsichtProps {
    richtung: Richtung;
    /** Ueberschrift (uebersetzt) */
    titel: string;
    /** Wert des Formulars: Zeilen {x, y} */
    wert: unknown;
    /** Punkte, die gelten, solange die eigene Liste leer ist */
    vorgabe: Punkt[];
    /** Grenzen, die gelten (am Geraet: eigene oder die der Vorlage) */
    untergrenze: number;
    obergrenze: number;
    /** Arbeitspunkt (Jetzt-Marker) oder null */
    arbeitspunkt: Etikett | null;
    sprache: string;
    /** Farben des Admin-Themas */
    farben: { flaeche: string; fokus: string; fehler: string };
    /** true: Kennlinie eines Geraets (leer = Vorlage); false: die Vorlage selbst (leer = Werksvorgabe) */
    mitVorgabe: boolean;
    onWert: (zeilen: Punkt[]) => void;
    /** meldet dem Formular eine ungueltige Kennlinie ('' = in Ordnung) - der Admin sperrt dann "Speichern" */
    onFehler?: (meldung: string) => void;
    /** eigene Grenzen des Formulars ('' = es gilt die Vorlage); fehlt die Angabe, gelten die Zahlen oben als eigene */
    grenzenEigen?: { untergrenze: number | ''; obergrenze: number | '' };
    /** schreibt eine Grenze ins Formular; ohne diese Funktion sind die Grenzlinien nur Anzeige */
    onGrenze?: (welche: Grenze, wert: number | '') => void;
    /** schreibt Punkte und beide Grenzen in einem Zug (Einfuegen, Zuruecksetzen, Rueckgaengig) */
    onAlles?: (stand: Stand) => void;
    /** Herkunft fuer "Kopieren", z. B. der Name des Geraets */
    quelle?: string;
    /** zunaechst nur eine Zeile mit Aufklapp-Pfeil (Kuehlkurve, solange die Anlage nicht kuehlt) */
    eingeklappt?: boolean;
    /** gespeicherte Kennlinie, mit der der Adapter gerade rechnet (fuer den Text zur Raumkorrektur) */
    gespeichert?: Punkt[];
}

/** Bild, Legende und (eingeklappt) Tabelle - ohne jsonConfig, damit es sich einzeln rendern und pruefen laesst. */
export function KennlinieAnsicht(props: AnsichtProps): React.JSX.Element {
    const { richtung, sprache, farben } = props;
    const akzent = bild.FARBEN[richtung];
    const k = (schluessel: Schluessel, ...werte: (string | number)[]): string => kt(sprache, schluessel, ...werte);
    const zahl = (n: number): string => zug.anzeige(n, sprache);
    const musterId = `fk-muster-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
    const svg = useRef<SVGSVGElement | null>(null);
    // Entwurf: was gerade gezogen oder getippt wurde, bis das Formular denselben Stand zeigt
    const [entwurf, setEntwurf] = useState<unknown[] | null>(null);
    const [aktiv, setAktiv] = useState(-1);
    const [zeile, setZeile] = useState(-1);
    const [tastatur, setTastatur] = useState(false);
    const [tabelleOffen, setTabelleOffen] = useState(false);
    // null = selbsttaetig: eingeklappt, solange nichts dagegen spricht (Fehler, Anlage laeuft in dieser Richtung)
    const [offenWahl, setOffenWahl] = useState<boolean | null>(null);
    const [notiz, setNotiz] = useState('');
    const rahmen = useRef<HTMLDivElement | null>(null);
    const [platz, setPlatz] = useState(B_START);
    const istVorlage = !props.mitVorgabe;

    const wertText = JSON.stringify(Array.isArray(props.wert) ? props.wert : []);
    const zieht = useRef<{ i: number; achse: { min: number; max: number; schritt: number }; zeiger: number } | null>(
        null,
    );
    const [ziehend, setZiehend] = useState(-1);
    useEffect(() => {
        if (!zieht.current) {
            setEntwurf(null);
        }
    }, [wertText]);

    const eigenRoh: unknown[] = entwurf || (Array.isArray(props.wert) ? props.wert : []);
    const eigene = eigenRoh.length > 0;
    // Am Geraet ohne eigene Punkte ist die Kennlinie der Vorlage die Arbeitsgrundlage: ihre Punkte sind direkt
    // anfassbar, und die erste Aenderung schreibt Vorlage + Aenderung in EINEM Zug als eigene Kennlinie.
    const vorlageText = JSON.stringify(props.vorgabe);
    const roh: unknown[] = useMemo(
        () => (eigene || istVorlage ? eigenRoh : props.vorgabe.map(p => ({ x: p.x, y: p.y }))),
        [eigene, istVorlage, JSON.stringify(eigenRoh), vorlageText],
    );
    const zeilen = useMemo(() => zug.punkte(roh), [JSON.stringify(roh)]);
    const fehler = eigene ? zug.pruefen(zeilen, richtung) : null;
    // gezeichnet wird, was gilt: die eigenen Punkte oder - bei leerer Liste - die Vorgabe
    const punkte: Punkt[] = eigene ? zeilen : props.vorgabe;
    const gueltig = !fehler && !zug.pruefen(punkte, richtung);
    /**
     * anfassbar sind gueltige Punkte: die eigenen - und am Geraet auch die der Vorlage (das erste Anfassen macht
     * daraus die eigene Kennlinie). In der Vorlage selbst wird die Werksvorgabe erst mit dem Knopf zur eigenen.
     */
    const ziehbar = (eigene || !istVorlage) && gueltig;

    // Grenzlinien: waehrend des Ziehens gilt der gezogene Wert, sonst der des Formulars
    const grenzZieht = useRef<{ welche: Grenze; zeiger: number; x: number } | null>(null);
    const [grenzZug, setGrenzZug] = useState<{ welche: Grenze; wert: number } | null>(null);
    const [grenzNah, setGrenzNah] = useState<Grenze | null>(null);
    // Zahleneingabe an der Schrift einer Grenzlinie (Doppelklick, Antippen, Enter/F2 am Griff)
    const [eingabe, setEingabe] = useState<{ welche: Grenze; text: string; grund: string } | null>(null);
    const eingabeFeld = useRef<HTMLInputElement | null>(null);
    const eingabeOffen = useRef(false);
    const zeigerArt = useRef('mouse');
    const grundId = `fk-grund-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
    const grenzText = `${props.untergrenze}/${props.obergrenze}`;
    useEffect(() => {
        if (!grenzZieht.current) {
            setGrenzZug(null);
        }
    }, [grenzText]);
    const unter = grenzZug && grenzZug.welche === 'unter' ? grenzZug.wert : props.untergrenze;
    const ober = grenzZug && grenzZug.welche === 'ober' ? grenzZug.wert : props.obergrenze;
    const grenzenGut = zug.grenzenGueltig(unter, ober);
    const grenzenZiehbar = !!props.onGrenze;
    const grenzenEigen = props.grenzenEigen || { untergrenze: props.untergrenze, obergrenze: props.obergrenze };

    const meldungen: string[] = [];
    if (fehler) {
        meldungen.push(fehler.n ? t(fehler.schluessel, fehler.n) : t(fehler.schluessel));
    }
    if (!grenzenGut) {
        meldungen.push(t('fGrenzen'));
    }
    // Eine ungueltige Kennlinie oder ungueltige Grenzen sperren das Speichern.
    const fehlerText = meldungen[0] || '';
    const onFehler = props.onFehler;
    useEffect(() => {
        if (onFehler) {
            onFehler(fehlerText);
        }
    }, [fehlerText, onFehler]);

    const ap =
        gueltig && props.arbeitspunkt && Number.isFinite(Number(props.arbeitspunkt.x)) ? props.arbeitspunkt : null;
    const laeuft = !!ap && ap.wert !== null && Number.isFinite(Number(ap.wert));
    const offen = offenWahl !== null ? offenWahl : !props.eingeklappt || laeuft || !!fehlerText;

    useEffect(() => {
        const el = rahmen.current;
        if (!el || typeof ResizeObserver === 'undefined') {
            return undefined;
        }
        const messen = (): void => setPlatz(el.clientWidth || B_START);
        const waechter = new ResizeObserver(messen);
        waechter.observe(el);
        messen();
        return () => waechter.disconnect();
    }, [offen]);
    // Finger auf einem Griff: die Seite darf dabei nicht rollen, sonst bricht der Browser das Ziehen ab.
    // (touch-action wirkt auf Teile einer SVG-Zeichnung nicht verlaesslich; neben den Griffen rollt die
    // Seite wie gewohnt.)
    useEffect(() => {
        const el = svg.current;
        if (!el) {
            return undefined;
        }
        const halten = (e: TouchEvent): void => {
            const ziel = e.target as Element | null;
            if (ziel && typeof ziel.closest === 'function' && ziel.closest('.fk-griff:not(.fk-starr), .fk-greifer')) {
                e.preventDefault();
            }
        };
        el.addEventListener('touchstart', halten, { passive: false });
        return () => el.removeEventListener('touchstart', halten);
    }, [offen]);
    const notizUhr = useRef<ReturnType<typeof setTimeout> | null>(null);
    const melde = useCallback((text: string) => {
        if (notizUhr.current) {
            clearTimeout(notizUhr.current);
        }
        setNotiz(text);
        notizUhr.current = setTimeout(() => setNotiz(''), 4000);
    }, []);
    useEffect(
        () => () => {
            if (notizUhr.current) {
                clearTimeout(notizUhr.current);
            }
        },
        [],
    );
    // nach dem Hinzufuegen oder Entfernen per Tastatur soll der Fokus auf einem Punkt bleiben
    const fokusPunkt = useRef(-1);
    useEffect(() => {
        if (fokusPunkt.current >= 0 && svg.current) {
            const el = svg.current.querySelector<SVGGElement>(`.fk-griff[data-punkt="${fokusPunkt.current}"]`);
            fokusPunkt.current = -1;
            el?.focus({ preventScroll: true });
        }
    });

    const B = Math.round(Math.min(B_MAX, Math.max(B_MIN, platz)));
    const H = B < 480 ? 260 : 300;
    const W = B - RAND.l - RAND.r;
    const HH = H - RAND.o - RAND.u;

    const paare = (liste: Punkt[]): number[][] =>
        liste
            .filter(p => Number.isFinite(p.x) && Number.isFinite(p.y))
            .map(p => [p.x, p.y])
            .sort((a, b) => a[0] - b[0]);
    const sauber = paare(punkte);
    // die Vorlage als blasse gestrichelte Linie hinter der eigenen Kennlinie des Geraets
    const hinten = eigene && !istVorlage && !zug.pruefen(props.vorgabe, richtung) ? paare(props.vorgabe) : [];
    const achsPunkte = [...sauber, ...hinten];
    const a = zieht.current
        ? zieht.current.achse
        : bild.achse(achsPunkte.length ? achsPunkte : [[0, 0]], ap ? Number(ap.x) : null);
    const X = (x: number): number => RAND.l + ((x - a.min) / (a.max - a.min)) * W;
    const Y = (y: number): number => RAND.o + (1 - Math.min(100, Math.max(0, y)) / 100) * HH;

    const schreiben = useCallback(
        (neu: Punkt[] | { x: unknown; y: unknown }[]): void => {
            setEntwurf(neu);
            props.onWert(neu as Punkt[]);
        },
        [props.onWert],
    );

    /** Stelle des Zeigers in Grad und Prozent */
    const stelle = (e: { clientX: number; clientY: number }): Punkt => {
        const r = (svg.current as SVGSVGElement).getBoundingClientRect();
        const px = ((e.clientX - r.left) / r.width) * B;
        const py = ((e.clientY - r.top) / r.height) * H;
        const achse = zieht.current ? zieht.current.achse : a;
        return {
            x: achse.min + ((px - RAND.l) / W) * (achse.max - achse.min),
            y: (1 - (py - RAND.o) / HH) * 100,
        };
    };

    // ---- Stuetzpunkte: ziehen, Pfeiltasten, entfernen
    const greifen = (i: number) => (e: React.PointerEvent<SVGGElement>) => {
        if (!ziehbar || (e.pointerType === 'mouse' && e.button !== 0)) {
            return;
        }
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        e.currentTarget.focus({ preventScroll: true });
        // die Achse bleibt waehrend des Ziehens stehen - sonst liefe das Bild unter dem Zeiger weg
        zieht.current = { i, achse: a, zeiger: e.pointerId };
        setTastatur(false);
        setZiehend(i);
        setAktiv(i);
    };
    const bewegen = (e: React.PointerEvent<SVGGElement>): void => {
        const z = zieht.current;
        if (!z || z.zeiger !== e.pointerId) {
            return;
        }
        const neu = zug.ziehen(punkte, z.i, stelle(e), richtung, { xMin: z.achse.min, xMax: z.achse.max });
        if (!gleich(neu, punkte)) {
            schreiben(neu);
        }
    };
    const loslassen = (e: React.PointerEvent<SVGGElement>): void => {
        const z = zieht.current;
        if (!z || z.zeiger !== e.pointerId) {
            return;
        }
        zieht.current = null;
        setZiehend(-1);
        if (entwurf && gleich(entwurf, props.wert)) {
            setEntwurf(null);
        }
    };
    const entferne = (i: number, mitFokus: boolean): void => {
        if (!ziehbar) {
            return;
        }
        const r = zug.entfernen(punkte, i);
        if (!r.entfernt) {
            melde(k('mind2'));
            return;
        }
        if (mitFokus) {
            fokusPunkt.current = Math.min(i, r.punkte.length - 1);
        }
        setAktiv(-1);
        schreiben(r.punkte);
    };
    const taste = (i: number) => (e: React.KeyboardEvent<SVGGElement>) => {
        if (!ziehbar) {
            return;
        }
        if (e.key === 'Delete' || e.key === 'Backspace') {
            e.preventDefault();
            entferne(i, true);
            return;
        }
        const wege: Record<string, [number, number]> = {
            ArrowLeft: [-1, 0],
            ArrowRight: [1, 0],
            ArrowUp: [0, 1],
            ArrowDown: [0, -1],
        };
        const weg = wege[e.key];
        if (!weg) {
            return;
        }
        e.preventDefault();
        setTastatur(true);
        setAktiv(i);
        const neu = zug.schritt(punkte, i, weg[0], weg[1], richtung);
        if (!gleich(neu, punkte)) {
            schreiben(neu);
        }
    };
    /** Doppelklick in die Flaeche: neuer Punkt an der Klickstelle (auf dem Raster, zwischen den Nachbarn) */
    const doppelklick = (e: React.MouseEvent<SVGSVGElement>): void => {
        const ziel = e.target as Element | null;
        if (!ziehbar || (ziel && ziel.closest('.fk-griff, .fk-greifer'))) {
            return;
        }
        const s = stelle(e);
        if (s.x < a.min || s.x > a.max || s.y < -5 || s.y > 105) {
            return;
        }
        e.preventDefault();
        const r = zug.einfuegen(punkte, s, richtung, { xMin: a.min, xMax: a.max });
        if (r.neu < 0) {
            melde(k('keinPlatz'));
            return;
        }
        fokusPunkt.current = r.neu;
        schreiben(r.punkte);
    };

    // ---- Grenzlinien: ziehen und Pfeiltasten
    const grenzen: Grenzen = { untergrenze: unter, obergrenze: ober };
    const setzeGrenze = (welche: Grenze, wert: number): void => {
        const alt = welche === 'ober' ? ober : unter;
        if (!props.onGrenze || !Number.isFinite(wert) || wert === alt) {
            return;
        }
        setGrenzZug({ welche, wert });
        props.onGrenze(welche, wert);
    };
    const grenzeGreifen = (welche: Grenze, nurGriff: boolean) => (e: React.PointerEvent<SVGElement>) => {
        // mit dem Finger nur am Griff - an der Linie quer ueber das ganze Bild soll die Seite weiter rollen
        if (!grenzenZiehbar || (e.pointerType === 'mouse' && e.button !== 0) || (e.pointerType === 'touch' && !nurGriff)) {
            return;
        }
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        svg.current?.querySelector<SVGGElement>(`.fk-greifer[data-grenze="${welche}"]`)?.focus({ preventScroll: true });
        grenzZieht.current = { welche, zeiger: e.pointerId, x: griffX[welche] };
        setGrenzZug({ welche, wert: welche === 'ober' ? ober : unter });
    };
    const grenzeBewegen = (e: React.PointerEvent<SVGElement>): void => {
        const z = grenzZieht.current;
        if (!z || z.zeiger !== e.pointerId) {
            return;
        }
        setzeGrenze(z.welche, zug.grenzeZiehen(z.welche, stelle(e).y, grenzen));
    };
    const grenzeLoslassen = (e: React.PointerEvent<SVGElement>): void => {
        const z = grenzZieht.current;
        if (!z || z.zeiger !== e.pointerId) {
            return;
        }
        grenzZieht.current = null;
        setGrenzZug(g => (g && (g.welche === 'ober' ? props.obergrenze : props.untergrenze) === g.wert ? null : g));
        setGrenzNah(null);
    };
    const grenzeTaste = (welche: Grenze) => (e: React.KeyboardEvent<SVGGElement>) => {
        if (!grenzenZiehbar) {
            return;
        }
        if (e.key === 'Enter' || e.key === 'F2') {
            e.preventDefault();
            eingabeOeffnen(welche);
            return;
        }
        const b = zug.grenzBereich(welche, grenzen);
        const schritte: Record<string, number> = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1, PageUp: 2, PageDown: -2 };
        let ziel: number | null = null;
        if (e.key in schritte) {
            ziel = zug.grenzeSchritt(welche, schritte[e.key], grenzen);
        } else if (e.key === 'Home') {
            ziel = b.min;
        } else if (e.key === 'End') {
            ziel = b.max;
        }
        if (ziel === null) {
            return;
        }
        e.preventDefault();
        setzeGrenze(welche, ziel);
    };
    const grenzeZiehtGerade = !!grenzZug && !!grenzZieht.current;

    // ---- Grenzlinien: Zahl direkt eingeben
    const eingabeOeffnen = (welche: Grenze): void => {
        // nicht waehrend des Ziehens (Punkt oder Linie)
        if (!grenzenZiehbar || grenzZieht.current || zieht.current) {
            return;
        }
        eingabeOffen.current = true;
        setEingabe({ welche, text: String(welche === 'ober' ? ober : unter), grund: '' });
    };
    /** zulaessig ist, was auch das Ziehen erreicht: im Bereich der Linie und auf dem Raster */
    const eingabePruefen = (welche: Grenze, roh: string): { wert: number; grund: '' } | { wert: null; grund: string } => {
        const b = zug.grenzBereich(welche, grenzen);
        const r = zug.GRENZLINIE.raster;
        const kurz = roh.trim().replace(/\s*%$/, '').replace(',', '.');
        const n = kurz === '' ? NaN : Number(kurz);
        if (!Number.isFinite(n)) {
            return { wert: null, grund: k('eingabeZahl', zahl(b.min), zahl(b.max)) };
        }
        if (n === (welche === 'ober' ? ober : unter)) {
            return { wert: n, grund: '' };
        }
        if (n < b.min || n > b.max) {
            return { wert: null, grund: k('eingabeBereich', zahl(b.min), zahl(b.max)) };
        }
        if (n % r !== 0) {
            return { wert: null, grund: k('eingabeRaster', zahl(r), zahl(b.min), zahl(b.max)) };
        }
        return { wert: n, grund: '' };
    };
    const eingabeZu = (zumGriff: boolean): void => {
        const welche = eingabe?.welche;
        eingabeOffen.current = false;
        setEingabe(null);
        if (zumGriff && welche) {
            svg.current?.querySelector<SVGGElement>(`.fk-greifer[data-grenze="${welche}"]`)?.focus({ preventScroll: true });
        }
    };
    const eingabeTaste = (e: React.KeyboardEvent<HTMLInputElement>): void => {
        if (!eingabe) {
            return;
        }
        if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            eingabeZu(true);
        } else if (e.key === 'Enter') {
            e.preventDefault();
            e.stopPropagation();
            const p = eingabePruefen(eingabe.welche, eingabe.text);
            if (p.wert === null) {
                setEingabe({ ...eingabe, grund: p.grund });
                eingabeFeld.current?.select();
                return;
            }
            eingabeZu(true);
            setzeGrenze(eingabe.welche, p.wert);
        }
    };
    /** Feld verlassen: Gueltiges gilt, Ungueltiges faellt weg (mit Begruendung in der Statuszeile) */
    const eingabeVerlassen = (): void => {
        if (!eingabe || !eingabeOffen.current) {
            return;
        }
        const p = eingabePruefen(eingabe.welche, eingabe.text);
        eingabeZu(false);
        if (p.wert !== null) {
            setzeGrenze(eingabe.welche, p.wert);
        } else if (eingabe.text.trim() !== '') {
            melde(p.grund);
        }
    };
    const eingabeWelche = eingabe ? eingabe.welche : null;
    useEffect(() => {
        if (eingabeWelche && eingabeFeld.current) {
            eingabeFeld.current.focus({ preventScroll: true });
            eingabeFeld.current.select();
        }
    }, [eingabeWelche]);

    // ---- Tabelle
    const feld = (i: number, achse: 'x' | 'y', wert: number | ''): void => {
        const neu = roh.map((z, n) => {
            const alt = (z || {}) as { x: unknown; y: unknown };
            return n === i ? { x: alt.x, y: alt.y, [achse]: wert } : { x: alt.x, y: alt.y };
        });
        schreiben(neu as Punkt[]);
    };
    const anlegen = (): void => schreiben(props.vorgabe.map(p => ({ x: p.x, y: p.y })));
    const dazu = (): void => {
        if (!eigene && istVorlage) {
            anlegen();
            return;
        }
        if (fehler) {
            // eine ungueltige Liste bekommt eine leere Zeile zum Ausfuellen
            schreiben([...roh.map(z => ({ x: (z as Punkt)?.x, y: (z as Punkt)?.y })), { x: '', y: '' }]);
            return;
        }
        const r = zug.hinzu(zeilen);
        if (r.neu >= 0) {
            schreiben(r.punkte);
        }
    };
    const weg = (i: number): void => {
        schreiben(roh.filter((_z, n) => n !== i).map(z => ({ x: (z as Punkt)?.x, y: (z as Punkt)?.y })) as Punkt[]);
    };

    // ---- Kopieren, Einfuegen, Zuruecksetzen
    const alles = (stand: Stand): void => {
        setEntwurf(null);
        setGrenzZug(null);
        if (props.onAlles) {
            props.onAlles(stand);
            return;
        }
        props.onWert(stand.punkte);
        if (props.onGrenze) {
            props.onGrenze('unter', stand.untergrenze);
            props.onGrenze('ober', stand.obergrenze);
        }
    };
    const standJetzt: Stand = {
        punkte: (Array.isArray(props.wert) ? props.wert : []) as Punkt[],
        untergrenze: grenzenEigen.untergrenze,
        obergrenze: grenzenEigen.obergrenze,
    };
    const einfuegen = (inhalt: unknown): boolean => {
        const kopie = zug.inhaltLesen(inhalt, richtung);
        if (!kopie) {
            return false;
        }
        alles({
            punkte: kopie.punkte,
            untergrenze: kopie.untergrenze === null ? grenzenEigen.untergrenze : kopie.untergrenze,
            obergrenze: kopie.obergrenze === null ? grenzenEigen.obergrenze : kopie.obergrenze,
        });
        return true;
    };
    const zuruecksetzen = (): void =>
        alles(
            istVorlage
                ? { punkte: zug.VORGABE[richtung].map(p => ({ x: p.x, y: p.y })), ...zug.VORGABE_GRENZEN }
                : { punkte: [], untergrenze: '', obergrenze: '' },
        );

    // ---- Zeichnung
    const zugPfad = (liste: number[][]): string =>
        (liste.length >= 2 ? [[a.min, liste[0][1]], ...liste, [a.max, liste[liste.length - 1][1]]] : [])
            .map(([x, y], i) => `${i ? 'L' : 'M'}${X(x).toFixed(1)} ${Y(y).toFixed(1)}`)
            .join(' ');
    const pfad = zugPfad(sauber);
    const pfadHinten = zugPfad(hinten);
    const blass = !eigene;
    const zeigeEtikett = ziehend >= 0 ? ziehend : tastatur ? aktiv : -1;
    const hervor = ziehend >= 0 ? ziehend : aktiv >= 0 ? aktiv : zeile;

    // auf schmalen Schirmen jede zweite Zahl, wenn die Achse sonst zu dicht beschriftet waere
    const xSchritt = W / ((a.max - a.min) / a.schritt) < 34 ? a.schritt * 2 : a.schritt;
    const xStriche: number[] = [];
    for (let x = a.min; x <= a.max; x += xSchritt) {
        xStriche.push(x);
    }

    const vollAbK = ap && Number.isFinite(Number(ap.vollAbK)) ? Number(ap.vollAbK) : 2;
    const kuehlen = richtung === 'kuehlen';
    // Griffe der Grenzlinien: dort, wo die Kennlinie die Linie gewoehnlich NICHT beruehrt - beim Heizen
    // (links oben nach rechts unten) die Untergrenze links und die Obergrenze rechts, beim Kuehlen
    // umgekehrt. Liegt dort doch ein Stuetzpunkt, rueckt der Griff nach innen. So liegen die Griffe auch
    // nie aufeinander, wenn beide Linien zusammenfallen. Waehrend des Ziehens bleibt der Griff stehen.
    const griffStelle = (welche: Grenze): number => {
        if (grenzZieht.current && grenzZieht.current.welche === welche) {
            return grenzZieht.current.x;
        }
        const links = (welche === 'unter') !== kuehlen;
        const gy = Y(welche === 'ober' ? ober : unter);
        for (let n = 0; n < 6; n++) {
            const x = links ? RAND.l + 22 + n * 40 : B - RAND.r - 22 - n * 40;
            if (!ziehbar || !punkte.some(p => Math.abs(X(p.x) - x) < 32 && Math.abs(Y(p.y) - gy) < 26)) {
                return x;
            }
        }
        return links ? RAND.l + 22 : B - RAND.r - 22;
    };
    const griffX: Record<Grenze, number> = { ober: griffStelle('ober'), unter: griffStelle('unter') };
    const beschriftung = (welche: Grenze): { text: string; x: number; y: number; anker: 'start' | 'end' } => {
        const wert = welche === 'ober' ? ober : unter;
        const lang =
            welche === 'unter'
                ? k('unterLang', zahl(wert))
                : wert < 100
                  ? k(kuehlen ? 'oberLangKuehlen' : 'oberLangHeizen', zahl(wert), zahl(vollAbK))
                  : k('ober', zahl(wert));
        const text = textBreite(lang) <= W - 60 ? lang : k(welche === 'unter' ? 'unter' : 'ober', zahl(wert));
        // Beide Schriften stehen unter ihrer Linie (die Untergrenze damit in ihrer gesperrten Zone; der
        // Streifen ueber der Obergrenze ist bei 95 % zu schmal fuer Schrift) - und neben dem Griff, also
        // auf der Seite, auf der die Kennlinie die Linie nicht beruehrt.
        const y = welche === 'unter' && Y(0) - Y(wert) < 18 ? Y(wert) - 5 : Y(wert) + (welche === 'unter' ? 14 : 13);
        const gx = griffX[welche];
        const links = (welche === 'unter') !== kuehlen;
        return links ? { text, x: gx + 24, y, anker: 'start' } : { text, x: gx - 24, y, anker: 'end' };
    };

    // Jetzt-Marker: duenn, blass, ohne Mausereignisse - und waehrend des Ziehens gar nicht
    let jetztBild: React.JSX.Element | null = null;
    let jetztText = '';
    if (ap && sauber.length >= 2) {
        const x = Math.min(a.max, Math.max(a.min, Number(ap.x)));
        const aufLinie = bild.wertAuf(sauber, x);
        const wert = laeuft ? Number(ap.wert) : null;
        const text =
            wert === null
                ? k('jetztOhne', zug.anzeigeFest(Number(ap.x), 1, sprache))
                : k('jetzt', zug.anzeigeFest(Number(ap.x), 1, sprache), zahl(Math.round(wert)));
        const links = X(x) + 8 + textBreite(text) > B - RAND.r;
        if (ziehend < 0 && !grenzeZiehtGerade) {
            jetztBild = (
                <g
                    className="fk-jetzt"
                    pointerEvents="none"
                    aria-hidden="true"
                >
                    <line
                        x1={X(x)}
                        x2={X(x)}
                        y1={Y(100)}
                        y2={Y(0)}
                        stroke="currentColor"
                        strokeOpacity="0.3"
                        strokeWidth="1"
                    />
                    <circle
                        className="fk-jetzt-punkt"
                        cx={X(x)}
                        cy={Y(aufLinie)}
                        r="3.5"
                        fill={farben.flaeche}
                        stroke="currentColor"
                        strokeOpacity="0.75"
                        strokeWidth="1.3"
                    />
                    <text
                        className="fk-jetzt-etikett"
                        x={X(x) + (links ? -7 : 7)}
                        y={Y(0) - 7}
                        textAnchor={links ? 'end' : 'start'}
                        fillOpacity="0.8"
                        stroke={farben.flaeche}
                        strokeWidth="3"
                        strokeLinejoin="round"
                        paintOrder="stroke"
                    >
                        {text}
                    </text>
                </g>
            );
        }
        // Raumkorrektur als Satz unter dem Bild statt als Balken im Bild
        const teile: string[] = [];
        if (wert !== null && wert >= 100 && props.obergrenze < 100) {
            teile.push(k(kuehlen ? 'vollKuehlen' : 'vollHeizen', zahl(vollAbK)));
        } else if (wert !== null) {
            const basis = props.gespeichert && !zug.pruefen(props.gespeichert, richtung) ? paare(props.gespeichert) : sauber;
            const linie = Math.round(bild.wertAuf(basis, Number(ap.x)));
            const korrektur = Math.round(wert) - linie;
            if (korrektur) {
                teile.push(k('raumkorrektur', `${korrektur > 0 ? '+' : ''}${zahl(korrektur)}`, zahl(linie)));
            }
        }
        if (ap.probelauf && wert !== null) {
            teile.push(k('probelauf'));
        }
        jetztText = teile.join(' ');
    }

    let etikett: React.JSX.Element | null = null;
    if (zeigeEtikett >= 0 && ziehbar && punkte[zeigeEtikett]) {
        const p = punkte[zeigeEtikett];
        const text = zug.etikett(p, sprache);
        const breite = text.length * 7.4 + 18;
        const cx = Math.min(B - RAND.r - breite / 2, Math.max(RAND.l + breite / 2, X(p.x)));
        // ueber dem Punkt; ganz oben ist dort kein Platz, dann darunter
        const oben = Y(p.y) - 40 >= 2;
        const cy = oben ? Y(p.y) - 28 : Y(p.y) + 30;
        etikett = (
            <g
                pointerEvents="none"
                className="fk-etikett"
            >
                <rect
                    x={cx - breite / 2}
                    y={cy - 12}
                    width={breite}
                    height="24"
                    rx="6"
                    fill={farben.flaeche}
                    stroke={akzent}
                    strokeWidth="1.5"
                />
                <text
                    x={cx}
                    y={cy + 4.5}
                    textAnchor="middle"
                    fontSize="13"
                    fontWeight="700"
                >
                    {text}
                </text>
            </g>
        );
    }

    // Etikett an der gestrichelten Linie, solange es keine eigene Kennlinie gibt
    let leerEtikett: React.JSX.Element | null = null;
    if (blass && sauber.length >= 2) {
        const mitteX = (sauber[0][0] + sauber[sauber.length - 1][0]) / 2;
        const text = k(istVorlage ? 'etikettWerk' : 'etikettVorlage');
        const passtRechts = X(mitteX) + 10 + textBreite(text) * 1.1 <= B - RAND.r;
        const nachLinks = kuehlen || !passtRechts;
        leerEtikett = (
            <text
                className="fk-leer-etikett"
                x={Math.max(RAND.l + 4 + (nachLinks ? textBreite(text) * 1.1 : 0), X(mitteX) + (nachLinks ? -10 : 10))}
                y={Y(bild.wertAuf(sauber, mitteX)) - 12}
                textAnchor={nachLinks ? 'end' : 'start'}
                fontSize="12"
                fontWeight="600"
                fillOpacity="0.85"
                stroke={farben.flaeche}
                strokeWidth="3"
                strokeLinejoin="round"
                paintOrder="stroke"
                pointerEvents="none"
            >
                {text}
            </text>
        );
    }

    const zonen: { welche: Grenze; y: number; h: number; text: string }[] = [];
    if (unter > 0) {
        zonen.push({ welche: 'unter', y: Y(unter), h: Y(0) - Y(unter), text: k('zoneUnter', zahl(unter)) });
    }
    if (ober < 100) {
        zonen.push({
            welche: 'ober',
            y: Y(100),
            h: Y(ober) - Y(100),
            text: k(kuehlen ? 'zoneOberKuehlen' : 'zoneOberHeizen', zahl(ober), zahl(vollAbK)),
        });
    }
    const linien: Grenze[] = ['unter', 'ober'];
    // Am Geraet sagt die Ueberschrift, was gilt: die globale Kennlinie oder eine eigene (eigene Punkte ODER eine
    // eigene Grenze) - der Wechsel aendert nur den Text in der Klammer, nichts am Aufbau darunter.
    const eigenStand =
        eigene ||
        (!istVorlage && !!grenzZug) ||
        (!!props.grenzenEigen && (!istLeer(grenzenEigen.untergrenze) || !istLeer(grenzenEigen.obergrenze)));
    const titelText = istVorlage ? props.titel : `${props.titel} (${k(eigenStand ? 'klammerEigen' : 'klammerGlobal')})`;
    const kopfZeile = !eigene
        ? k(istVorlage ? 'etikettWerk' : 'etikettVorlage')
        : fehler
          ? ''
          : k('punkteN', zeilen.length);
    const svgKlasse = `fk-zeichnung${ziehend >= 0 ? ' fk-zieht' : ''}${grenzeZiehtGerade ? ' fk-zieht-grenze' : ''}`;

    return (
        <Box
            className="fk-kennlinie"
            data-richtung={richtung}
            data-offen={offen ? '1' : '0'}
            sx={{
                width: '100%',
                color: 'text.primary',
                '& .fk-kopf': { display: 'flex', flexWrap: 'wrap', alignItems: 'center', columnGap: 1.5, rowGap: 0.25, mb: 0.5 },
                '& .fk-titel': { fontSize: '1.05rem', fontWeight: 500, mr: 'auto' },
                '& .fk-klapp': {
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '2px',
                    font: 'inherit',
                    fontSize: '1.05rem',
                    fontWeight: 500,
                    color: 'inherit',
                    background: 'none',
                    border: 0,
                    padding: '2px 6px 2px 0',
                    marginRight: 'auto',
                    cursor: 'pointer',
                    borderRadius: '6px',
                    textAlign: 'left',
                },
                '& .fk-klapp:hover': { backgroundColor: 'action.hover' },
                '& .fk-klapp:focus-visible, & .fk-tabknopf:focus-visible': { outline: `2px solid ${farben.fokus}`, outlineOffset: '1px' },
                '& .fk-kurz': { color: 'text.secondary', fontSize: '0.875rem' },
                '& .fk-kennlinie-werkzeug': { minWidth: 0, mt: 0.5 },
                '& .fk-leer': {
                    display: 'flex',
                    flexWrap: 'wrap',
                    alignItems: 'center',
                    gap: 1,
                    mb: 0.75,
                    fontSize: '0.9rem',
                    color: 'text.secondary',
                },
                '& .fk-bild': { position: 'relative', width: '100%', minWidth: 0 },
                '& .fk-zeichnung': { display: 'block', width: '100%', height: 'auto', userSelect: 'none' },
                '& .fk-zeichnung.fk-zieht, & .fk-zeichnung.fk-zieht .fk-griff': { cursor: 'grabbing' },
                '& .fk-zeichnung.fk-zieht-grenze, & .fk-zeichnung.fk-zieht-grenze .fk-griff': { cursor: 'ns-resize' },
                '& .fk-griff': { cursor: 'grab', outline: 'none', touchAction: 'none' },
                '& .fk-griff.fk-starr': { cursor: 'default' },
                '& .fk-griff .fk-punkt': {
                    transformBox: 'fill-box',
                    transformOrigin: 'center',
                    transition: 'transform 0.12s',
                },
                '& .fk-griff:not(.fk-starr):hover .fk-punkt, & .fk-griff.fk-aktiv .fk-punkt': {
                    transform: 'scale(1.3)',
                },
                '& .fk-griff .fk-hof': { opacity: 0, transition: 'opacity 0.12s' },
                '& .fk-griff:not(.fk-starr):hover .fk-hof, & .fk-griff.fk-aktiv .fk-hof': { opacity: 0.22 },
                '& .fk-griff .fk-ring': { opacity: 0 },
                '& .fk-griff:focus-visible .fk-ring': { opacity: 1 },
                '& .fk-streifen, & .fk-greifer': { cursor: 'ns-resize' },
                '& .fk-greifer': { outline: 'none', touchAction: 'none' },
                '& .fk-greifer .fk-ring': { opacity: 0 },
                '& .fk-greifer:focus-visible .fk-ring': { opacity: 1 },
                '& .fk-grenzlinie': { transition: 'stroke-opacity 0.12s' },
                '& .fk-unten': {
                    display: 'flex',
                    flexWrap: 'wrap',
                    alignItems: 'center',
                    columnGap: 2.5,
                    rowGap: 0.5,
                    mt: 0.5,
                    fontSize: '0.8125rem',
                    color: 'text.secondary',
                },
                '& .fk-legende': { display: 'flex', flexWrap: 'wrap', columnGap: 2, rowGap: 0.25, mr: 'auto' },
                '& .fk-legende span': { display: 'inline-flex', alignItems: 'center', gap: '6px', whiteSpace: 'nowrap' },
                '& .fk-grenzwahl': { cursor: 'text' },
                '& .fk-grenzeingabe': {
                    position: 'absolute',
                    zIndex: 2,
                    boxSizing: 'border-box',
                    maxWidth: 'min(250px, 100%)',
                    padding: '2px 6px 3px',
                    fontSize: '0.75rem',
                    lineHeight: 1.35,
                    color: 'text.primary',
                    backgroundColor: farben.flaeche,
                    border: `1px solid ${farben.fokus}`,
                    borderRadius: '6px',
                    boxShadow: '0 1px 4px rgba(0, 0, 0, 0.25)',
                },
                '& .fk-grenzeingabe[data-falsch="1"]': { borderColor: farben.fehler },
                '& .fk-grenzeingabe label': { display: 'inline-flex', alignItems: 'baseline', gap: '4px', whiteSpace: 'nowrap' },
                '& .fk-grenzeingabe input': {
                    width: '3.2em',
                    font: 'inherit',
                    // unter 16 px zoomt iOS beim Antippen in das Feld
                    fontSize: TOUCH ? '16px' : 'inherit',
                    color: 'inherit',
                    background: 'transparent',
                    border: 0,
                    borderBottom: `1px solid ${farben.fokus}`,
                    borderRadius: 0,
                    padding: '1px 2px',
                    margin: 0,
                    outline: 'none',
                    textAlign: 'right',
                },
                '& .fk-grenzeingabe input[aria-invalid="true"]': { borderBottomColor: farben.fehler },
                '& .fk-grenzgrund': { color: farben.fehler, whiteSpace: 'normal', overflowWrap: 'anywhere' },
                '& .fk-zahl': {
                    width: '100%',
                    minWidth: 56,
                    font: 'inherit',
                    color: 'inherit',
                    background: 'transparent',
                    border: 0,
                    borderBottom: '1px solid',
                    borderColor: 'divider',
                    padding: '4px 2px',
                    outline: 'none',
                },
                '& .fk-zahl:focus': { borderBottomColor: farben.fokus, boxShadow: `0 1px 0 0 ${farben.fokus}` },
                '& .fk-zahl[aria-invalid="true"]': { borderBottomColor: farben.fehler, color: farben.fehler },
                '& .fk-jetzt-text, & .fk-notiz': { mt: 0.5, fontSize: '0.8125rem', color: 'text.secondary' },
                '& .fk-tabknopf': {
                    display: 'inline-flex',
                    alignItems: 'center',
                    font: 'inherit',
                    fontSize: '0.875rem',
                    color: 'inherit',
                    background: 'none',
                    border: 0,
                    padding: '2px 8px 2px 0',
                    mt: 0.5,
                    cursor: 'pointer',
                    borderRadius: '6px',
                },
                '& .fk-tabknopf:hover': { backgroundColor: 'action.hover' },
                '& .fk-tabelle': { maxWidth: 380 },
                '& .fk-tabelle th': { whiteSpace: 'nowrap' },
                '& tr.fk-hervor': { backgroundColor: 'action.hover' },
                '@media (prefers-reduced-motion: reduce)': {
                    '& .fk-griff .fk-punkt, & .fk-griff .fk-hof, & .fk-grenzlinie': { transition: 'none' },
                },
            }}
        >
            <div className="fk-kopf">
                {props.eingeklappt === undefined ? (
                    <Typography
                        className="fk-titel"
                        variant="h6"
                        component="div"
                    >
                        {titelText}
                    </Typography>
                ) : (
                    <button
                        type="button"
                        className="fk-klapp"
                        aria-expanded={offen}
                        onClick={() => setOffenWahl(!offen)}
                    >
                        {offen ? <AufIcon /> : <ZuIcon />}
                        {titelText}
                    </button>
                )}
                {offen ? null : <span className="fk-kurz">{kopfZeile}</span>}
            </div>
            {offen ? (
                <>
                    {blass && istVorlage ? (
                        <div className="fk-leer">
                            <span>{k('hinweisWerk')}</span>
                            <Button
                                className="fk-anlegen"
                                size="small"
                                variant="outlined"
                                sx={{ textTransform: 'none' }}
                                onClick={anlegen}
                            >
                                {k('anlegen')}
                            </Button>
                        </div>
                    ) : null}
                    <div
                        className="fk-bild"
                        ref={rahmen}
                    >
                        <svg
                            ref={svg}
                            className={svgKlasse}
                            xmlns="http://www.w3.org/2000/svg"
                            viewBox={`0 0 ${B} ${H}`}
                            role="group"
                            aria-label={props.titel}
                            fontSize="11"
                            fill="currentColor"
                            onDoubleClick={doppelklick}
                        >
                            <defs>
                                <pattern
                                    id={musterId}
                                    width="7"
                                    height="7"
                                    patternUnits="userSpaceOnUse"
                                    patternTransform="rotate(45)"
                                >
                                    <line
                                        x1="0"
                                        y1="0"
                                        x2="0"
                                        y2="7"
                                        stroke="currentColor"
                                        strokeOpacity="0.2"
                                        strokeWidth="1.2"
                                    />
                                </pattern>
                            </defs>
                            {[0, 25, 50, 75, 100].map(y => (
                                <g key={y}>
                                    <line
                                        x1={RAND.l}
                                        x2={B - RAND.r}
                                        y1={Y(y)}
                                        y2={Y(y)}
                                        stroke="currentColor"
                                        strokeOpacity={y ? 0.12 : 0.35}
                                    />
                                    <text
                                        x={RAND.l - 6}
                                        y={Y(y) + 4}
                                        textAnchor="end"
                                        fillOpacity="0.7"
                                    >
                                        {y} %
                                    </text>
                                </g>
                            ))}
                            {xStriche.map(x => (
                                <g key={x}>
                                    <line
                                        x1={X(x)}
                                        x2={X(x)}
                                        y1={Y(0)}
                                        y2={Y(0) + 4}
                                        stroke="currentColor"
                                        strokeOpacity="0.35"
                                    />
                                    <text
                                        x={X(x)}
                                        y={H - 8}
                                        textAnchor="middle"
                                        fillOpacity="0.7"
                                    >
                                        {zahl(x)}
                                        {x + xSchritt > a.max ? ' °C' : ''}
                                    </text>
                                </g>
                            ))}
                            {/* gesperrte Zonen: dezent schraffiert, der Hinweis folgt dem Zeiger */}
                            {zonen.map(z => (
                                <Tooltip
                                    key={z.welche}
                                    title={z.text}
                                    followCursor
                                    enterDelay={400}
                                >
                                    <rect
                                        className="fk-zone"
                                        data-zone={z.welche}
                                        x={RAND.l}
                                        y={z.y}
                                        width={W}
                                        height={Math.max(0, z.h)}
                                        fill={`url(#${musterId})`}
                                    />
                                </Tooltip>
                            ))}
                            {pfadHinten ? (
                                <path
                                    className="fk-vorlage-linie"
                                    d={pfadHinten}
                                    fill="none"
                                    stroke="currentColor"
                                    strokeOpacity="0.4"
                                    strokeWidth="1.4"
                                    strokeDasharray="6 5"
                                    pointerEvents="none"
                                />
                            ) : null}
                            {pfad ? (
                                <g pointerEvents="none">
                                    <path
                                        d={`${pfad} L${X(a.max)} ${Y(0)} L${X(a.min)} ${Y(0)} Z`}
                                        fill={akzent}
                                        fillOpacity={blass ? 0.05 : 0.12}
                                    />
                                    <path
                                        className="fk-linie"
                                        d={pfad}
                                        fill="none"
                                        stroke={akzent}
                                        strokeOpacity={blass ? 0.6 : 1}
                                        strokeWidth={blass ? 2 : 2.4}
                                        strokeLinejoin="round"
                                        strokeLinecap="round"
                                        strokeDasharray={blass ? '7 5' : undefined}
                                    />
                                </g>
                            ) : (
                                <text
                                    x={B / 2}
                                    y={H / 2}
                                    textAnchor="middle"
                                    fillOpacity="0.7"
                                >
                                    {t('fZuWenig')}
                                </text>
                            )}
                            {jetztBild}
                            {/* Flaeche unter der Schrift jeder Grenze: Doppelklick (Finger: antippen) oeffnet die Zahleneingabe.
                                Sie liegt UNTER den Greifflaechen der Linien, den Griffen und den Punkten - Ziehen hat Vorrang. */}
                            {grenzenZiehbar
                                ? linien.map(welche => {
                                      const b = beschriftung(welche);
                                      const breite = textBreite(b.text) + 8;
                                      return eingabeWelche === welche ? null : (
                                          <rect
                                              key={welche}
                                              className="fk-grenzwahl"
                                              data-grenze={welche}
                                              x={b.anker === 'start' ? b.x - 4 : b.x - breite + 4}
                                              y={b.y - 11}
                                              width={breite}
                                              height="16"
                                              fill="transparent"
                                              onPointerDown={e => {
                                                  zeigerArt.current = e.pointerType;
                                              }}
                                              onClick={e => {
                                                  if (zeigerArt.current !== 'mouse') {
                                                      e.stopPropagation();
                                                      eingabeOeffnen(welche);
                                                  }
                                              }}
                                              onDoubleClick={e => {
                                                  e.stopPropagation();
                                                  eingabeOeffnen(welche);
                                              }}
                                          >
                                              <title>{k(TOUCH ? 'eingabeTippTouch' : 'eingabeTipp')}</title>
                                          </rect>
                                      );
                                  })
                                : null}
                            {/* Grenzlinien: erst beide Linien mit ihrer Greifflaeche, dann die Griffe - so bleibt jeder Griff erreichbar */}
                            {linien.map(welche => {
                                const wert = welche === 'ober' ? ober : unter;
                                const b = beschriftung(welche);
                                const betont = grenzNah === welche || (grenzZug && grenzZug.welche === welche && grenzeZiehtGerade);
                                return (
                                    <g
                                        key={welche}
                                        className={`fk-grenze fk-grenze-${welche}`}
                                    >
                                        <line
                                            className="fk-grenzlinie"
                                            x1={RAND.l}
                                            x2={B - RAND.r}
                                            y1={Y(wert)}
                                            y2={Y(wert)}
                                            stroke="currentColor"
                                            strokeOpacity={betont ? 0.95 : 0.55}
                                            strokeWidth={betont ? 2 : 1.2}
                                            strokeDasharray="5 4"
                                            pointerEvents="none"
                                        />
                                        <text
                                            className="fk-grenztext"
                                            x={b.x}
                                            y={b.y}
                                            textAnchor={b.anker}
                                            fillOpacity="0.8"
                                            stroke={farben.flaeche}
                                            strokeWidth="3"
                                            strokeLinejoin="round"
                                            paintOrder="stroke"
                                            pointerEvents="none"
                                            visibility={eingabeWelche === welche ? 'hidden' : undefined}
                                        >
                                            {b.text}
                                        </text>
                                        {grenzenZiehbar ? (
                                            <rect
                                                className="fk-streifen"
                                                data-grenze={welche}
                                                x={RAND.l}
                                                y={Y(wert) - 7}
                                                width={W}
                                                height="14"
                                                fill="transparent"
                                                onPointerDown={grenzeGreifen(welche, false)}
                                                onPointerMove={grenzeBewegen}
                                                onPointerUp={grenzeLoslassen}
                                                onPointerCancel={grenzeLoslassen}
                                                onPointerEnter={() => setGrenzNah(welche)}
                                                onPointerLeave={() => setGrenzNah(n => (n === welche && !grenzZieht.current ? null : n))}
                                            />
                                        ) : null}
                                    </g>
                                );
                            })}
                            {grenzenZiehbar
                                ? linien.map(welche => {
                                      const wert = welche === 'ober' ? ober : unter;
                                      const b = zug.grenzBereich(welche, grenzen);
                                      const gx = griffX[welche];
                                      const gy = Y(wert);
                                      const betont = grenzNah === welche || (grenzZug && grenzZug.welche === welche && grenzeZiehtGerade);
                                      return (
                                          <g
                                              key={welche}
                                              className="fk-greifer"
                                              data-grenze={welche}
                                              role="slider"
                                              tabIndex={0}
                                              aria-label={k(welche === 'ober' ? 'nameOber' : 'nameUnter')}
                                              aria-orientation="vertical"
                                              aria-valuemin={b.min}
                                              aria-valuemax={b.max}
                                              aria-valuenow={wert}
                                              aria-valuetext={`${zahl(wert)} %`}
                                              aria-keyshortcuts="Enter F2"
                                              onPointerDown={grenzeGreifen(welche, true)}
                                              onPointerMove={grenzeBewegen}
                                              onPointerUp={grenzeLoslassen}
                                              onPointerCancel={grenzeLoslassen}
                                              onPointerEnter={() => setGrenzNah(welche)}
                                              onPointerLeave={() => setGrenzNah(n => (n === welche && !grenzZieht.current ? null : n))}
                                              onFocus={() => setGrenzNah(welche)}
                                              onBlur={() => setGrenzNah(n => (n === welche ? null : n))}
                                              onKeyDown={grenzeTaste(welche)}
                                          >
                                              {/* grosse unsichtbare Flaeche fuer den Finger */}
                                              <rect
                                                  x={gx - 18}
                                                  y={gy - 16}
                                                  width="36"
                                                  height="32"
                                                  fill="transparent"
                                              />
                                              <rect
                                                  className="fk-ring"
                                                  x={gx - 18}
                                                  y={gy - 11}
                                                  width="36"
                                                  height="22"
                                                  rx="11"
                                                  fill="none"
                                                  stroke={farben.fokus}
                                                  strokeWidth="2.5"
                                              />
                                              <rect
                                                  className="fk-greifer-form"
                                                  x={gx - 14}
                                                  y={gy - 7}
                                                  width="28"
                                                  height="14"
                                                  rx="7"
                                                  fill={farben.flaeche}
                                                  stroke={betont ? farben.fokus : 'currentColor'}
                                                  strokeOpacity={betont ? 1 : 0.6}
                                                  strokeWidth="1.4"
                                              />
                                              <path
                                                  d={`M${gx - 4} ${gy - 1.5} L${gx} ${gy - 5} L${gx + 4} ${gy - 1.5} Z M${gx - 4} ${gy + 1.5} L${gx} ${gy + 5} L${gx + 4} ${gy + 1.5} Z`}
                                                  fill={betont ? farben.fokus : 'currentColor'}
                                                  fillOpacity={betont ? 1 : 0.7}
                                              />
                                          </g>
                                      );
                                  })
                                : null}
                            {punkte.map((p, i) =>
                                Number.isFinite(p.x) && Number.isFinite(p.y) ? (
                                    ziehbar ? (
                                        <g
                                            key={i}
                                            className={`fk-griff${hervor === i ? ' fk-aktiv' : ''}`}
                                            data-punkt={i}
                                            role="slider"
                                            tabIndex={0}
                                            aria-label={t('punkt', i + 1)}
                                            aria-orientation="vertical"
                                            aria-valuemin={0}
                                            aria-valuemax={100}
                                            aria-valuenow={p.y}
                                            aria-valuetext={zug.etikett(p, sprache)}
                                            onPointerDown={greifen(i)}
                                            onPointerMove={bewegen}
                                            onPointerUp={loslassen}
                                            onPointerCancel={loslassen}
                                            onKeyDown={taste(i)}
                                            onContextMenu={e => {
                                                e.preventDefault();
                                                entferne(i, false);
                                            }}
                                            onFocus={() => setAktiv(i)}
                                            onBlur={() => {
                                                setAktiv(v => (v === i ? -1 : v));
                                                setTastatur(false);
                                            }}
                                        >
                                            {/* grosse unsichtbare Flaeche: mit Maus und Finger sicher zu treffen */}
                                            <circle
                                                cx={X(p.x)}
                                                cy={Y(p.y)}
                                                r="17"
                                                fill="transparent"
                                            />
                                            <circle
                                                className="fk-hof"
                                                cx={X(p.x)}
                                                cy={Y(p.y)}
                                                r="14"
                                                fill={akzent}
                                            />
                                            <circle
                                                className="fk-ring"
                                                cx={X(p.x)}
                                                cy={Y(p.y)}
                                                r="12.5"
                                                fill="none"
                                                stroke={farben.fokus}
                                                strokeWidth="2.5"
                                            />
                                            <circle
                                                className="fk-punkt"
                                                cx={X(p.x)}
                                                cy={Y(p.y)}
                                                r="7"
                                                fill={farben.flaeche}
                                                stroke={akzent}
                                                strokeWidth="2.6"
                                            />
                                        </g>
                                    ) : (
                                        // Vorlage oder ungueltige Liste: kleine Marken, nichts zu ziehen
                                        <g
                                            key={i}
                                            className="fk-griff fk-starr"
                                            data-punkt={i}
                                            pointerEvents="none"
                                        >
                                            <circle
                                                className="fk-punkt"
                                                cx={X(p.x)}
                                                cy={Y(p.y)}
                                                r={blass ? 3.5 : 4.5}
                                                fill={farben.flaeche}
                                                stroke={akzent}
                                                strokeOpacity={blass ? 0.7 : 1}
                                                strokeWidth={blass ? 1.6 : 2.6}
                                            />
                                        </g>
                                    )
                                ) : null,
                            )}
                            {leerEtikett}
                            {etikett}
                        </svg>
                        {eingabe && grenzenZiehbar
                            ? (() => {
                                  const b = beschriftung(eingabe.welche);
                                  const name = k(eingabe.welche === 'ober' ? 'nameOber' : 'nameUnter');
                                  // an der Stelle der Schrift: gleiche Seite, gleiche Grundlinie (die Zeichnung ist nicht skaliert)
                                  const ort: React.CSSProperties =
                                      b.anker === 'start'
                                          ? { left: `${(Math.max(0, b.x - 7) / B) * 100}%`, top: `${((b.y - 17) / H) * 100}%` }
                                          : { right: `${(Math.max(0, B - b.x - 7) / B) * 100}%`, top: `${((b.y - 17) / H) * 100}%` };
                                  return (
                                      <div
                                          className="fk-grenzeingabe"
                                          data-grenze={eingabe.welche}
                                          data-falsch={eingabe.grund ? '1' : '0'}
                                          style={ort}
                                      >
                                          <label>
                                              <span>{name}</span>
                                              <input
                                                  ref={eingabeFeld}
                                                  type="text"
                                                  inputMode="numeric"
                                                  autoComplete="off"
                                                  enterKeyHint="done"
                                                  aria-invalid={!!eingabe.grund}
                                                  aria-describedby={eingabe.grund ? grundId : undefined}
                                                  value={eingabe.text}
                                                  onChange={e => setEingabe({ welche: eingabe.welche, text: e.target.value, grund: '' })}
                                                  onKeyDown={eingabeTaste}
                                                  onBlur={eingabeVerlassen}
                                              />
                                              <span>%</span>
                                          </label>
                                          {eingabe.grund ? (
                                              <div
                                                  className="fk-grenzgrund"
                                                  id={grundId}
                                                  role="alert"
                                              >
                                                  {eingabe.grund}
                                              </div>
                                          ) : null}
                                      </div>
                                  );
                              })()
                            : null}
                    </div>
                    {/* unter dem Bild: ein Knopf mehr ("Rueckgaengig") oder die Rueckfrage verschieben das Diagramm nicht */}
                    <div className="fk-kennlinie-werkzeug">
                        <Werkzeugleiste
                            art={kuehlen ? 'kennlinieKuehlen' : 'kennlinieHeizen'}
                            inhalt={{ punkte: gueltig ? punkte : [], untergrenze: unter, obergrenze: ober }}
                            onEinfuegen={einfuegen}
                            onZuruecksetzen={zuruecksetzen}
                            zuruecksetzenText={istVorlage ? undefined : k('tipVorlage')}
                            frageText={istVorlage ? k('frageWerk') : undefined}
                            istVorlage={istVorlage}
                            quelle={props.quelle || (istVorlage ? k('quelleVorlage') : '')}
                            sprache={sprache}
                            stand={standJetzt}
                            onRueckgaengig={s => alles(s as Stand)}
                        />
                    </div>
                    <div className="fk-unten">
                        <div
                            className="fk-legende"
                            aria-hidden="true"
                        >
                            {ziehbar ? (
                                <span className="fk-leg-punkt">
                                    <svg
                                        width="14"
                                        height="14"
                                        viewBox="0 0 14 14"
                                    >
                                        <circle
                                            cx="7"
                                            cy="7"
                                            r="4.6"
                                            fill={farben.flaeche}
                                            stroke={akzent}
                                            strokeWidth="2.4"
                                        />
                                    </svg>
                                    {k('legPunkt')}
                                </span>
                            ) : null}
                            {blass || pfadHinten ? (
                                <span className="fk-leg-vorlage">
                                    <svg
                                        width="26"
                                        height="14"
                                        viewBox="0 0 26 14"
                                    >
                                        <line
                                            x1="1"
                                            x2="25"
                                            y1="7"
                                            y2="7"
                                            stroke={blass ? akzent : 'currentColor'}
                                            strokeOpacity={blass ? 0.7 : 0.6}
                                            strokeWidth="1.8"
                                            strokeDasharray="6 4"
                                        />
                                    </svg>
                                    {k(istVorlage ? 'legWerk' : 'legVorlage')}
                                </span>
                            ) : null}
                            {ap ? (
                                <span className="fk-leg-jetzt">
                                    <svg
                                        width="14"
                                        height="14"
                                        viewBox="0 0 14 14"
                                    >
                                        <circle
                                            cx="7"
                                            cy="7"
                                            r="3.5"
                                            fill="none"
                                            stroke="currentColor"
                                            strokeOpacity="0.75"
                                            strokeWidth="1.3"
                                        />
                                    </svg>
                                    {k('legJetzt')}
                                </span>
                            ) : null}
                        </div>
                    </div>
                    {jetztText ? <div className="fk-jetzt-text">{jetztText}</div> : null}
                    <div
                        className="fk-notiz"
                        role="status"
                    >
                        {notiz}
                    </div>
                    <button
                        type="button"
                        className="fk-tabknopf"
                        aria-expanded={tabelleOffen}
                        onClick={() => setTabelleOffen(v => !v)}
                    >
                        {tabelleOffen ? <AufIcon /> : <ZuIcon />}
                        {k('tabelle')}
                    </button>
                    {tabelleOffen ? (
                        <div className="fk-tabelle">
                            <Table
                                size="small"
                                aria-label={props.titel}
                            >
                                <TableHead>
                                    <TableRow>
                                        <TableCell sx={{ fontWeight: 600 }}>{I18n.t('colX')}</TableCell>
                                        <TableCell sx={{ fontWeight: 600 }}>{I18n.t('colY')}</TableCell>
                                        <TableCell
                                            align="right"
                                            padding="none"
                                            sx={{ whiteSpace: 'nowrap', pr: 0.5 }}
                                        >
                                            <Tooltip title={eigene || !istVorlage ? t('punktDazu') : k('anlegen')}>
                                                <IconButton
                                                    size="small"
                                                    color="primary"
                                                    className="fk-dazu"
                                                    aria-label={eigene || !istVorlage ? t('punktDazu') : k('anlegen')}
                                                    onClick={dazu}
                                                >
                                                    <AddIcon />
                                                </IconButton>
                                            </Tooltip>
                                        </TableCell>
                                    </TableRow>
                                </TableHead>
                                <TableBody>
                                    {roh.map((z, i) => {
                                        const r = (z || {}) as { x: unknown; y: unknown };
                                        const p = zeilen[i];
                                        return (
                                            <TableRow
                                                key={i}
                                                className={hervor === i ? 'fk-hervor' : undefined}
                                            >
                                                <TableCell>
                                                    <Zahlfeld
                                                        wert={r.x}
                                                        min={zug.GRENZEN.xMin}
                                                        max={zug.GRENZEN.xMax}
                                                        step={zug.RASTER.x}
                                                        name={`${I18n.t('colX')} ${i + 1}`}
                                                        fehler={
                                                            !Number.isFinite(p.x) ||
                                                            p.x < zug.GRENZEN.xMin ||
                                                            p.x > zug.GRENZEN.xMax ||
                                                            (i > 0 && p.x <= zeilen[i - 1].x)
                                                        }
                                                        onWert={w => feld(i, 'x', w)}
                                                        onFokus={drin => setZeile(v => (drin ? i : v === i ? -1 : v))}
                                                    />
                                                </TableCell>
                                                <TableCell>
                                                    <Zahlfeld
                                                        wert={r.y}
                                                        min={zug.GRENZEN.yMin}
                                                        max={zug.GRENZEN.yMax}
                                                        step={zug.RASTER.y}
                                                        name={`${I18n.t('colY')} ${i + 1}`}
                                                        fehler={
                                                            !Number.isFinite(p.y) ||
                                                            p.y < zug.GRENZEN.yMin ||
                                                            p.y > zug.GRENZEN.yMax
                                                        }
                                                        onWert={w => feld(i, 'y', w)}
                                                        onFokus={drin => setZeile(v => (drin ? i : v === i ? -1 : v))}
                                                    />
                                                </TableCell>
                                                <TableCell
                                                    align="right"
                                                    padding="none"
                                                    sx={{ pr: 0.5 }}
                                                >
                                                    <Tooltip title={t('punktWeg')}>
                                                        <IconButton
                                                            size="small"
                                                            className="fk-weg"
                                                            aria-label={`${t('punktWeg')} ${i + 1}`}
                                                            onClick={() => weg(i)}
                                                        >
                                                            <DeleteIcon />
                                                        </IconButton>
                                                    </Tooltip>
                                                </TableCell>
                                            </TableRow>
                                        );
                                    })}
                                    {!eigene && istVorlage ? (
                                        <TableRow>
                                            <TableCell
                                                colSpan={3}
                                                className="fk-leerzeile"
                                                sx={{ color: 'text.secondary' }}
                                            >
                                                {k('hinweisWerk')}
                                            </TableCell>
                                        </TableRow>
                                    ) : null}
                                </TableBody>
                            </Table>
                        </div>
                    ) : null}
                    {meldungen.map(m => (
                        <Box
                            key={m}
                            className="fk-fehler"
                            role="alert"
                            sx={{
                                mt: 0.75,
                                px: 1.25,
                                py: 0.75,
                                maxWidth: 640,
                                borderRadius: '6px',
                                border: `1px solid ${farben.fehler}`,
                                color: farben.fehler,
                                fontSize: '0.9em',
                            }}
                        >
                            {m}
                        </Box>
                    ))}
                    {ziehbar || grenzenZiehbar ? (
                        <Typography
                            variant="caption"
                            color="text.secondary"
                            className="fk-hinweis"
                            sx={{ display: 'block', mt: 0.5 }}
                        >
                            {ziehbar ? k('hinweis') : ''}
                            {/* ohne Maus gibt es weder Doppel- noch Rechtsklick: auf die Tabelle verweisen */}
                            {ziehbar && TOUCH ? ` ${k('hinweisTouch')}` : ''}
                            {/* die Grenzen haben keine Felder mehr: sagen, wie man sie stellt */}
                            {grenzenZiehbar ? `${ziehbar ? ' ' : ''}${k(TOUCH ? 'hinweisGrenzenTouch' : 'hinweisGrenzen')}` : ''}
                        </Typography>
                    ) : null}
                </>
            ) : null}
        </Box>
    );
}

/** Namen der beiden Grenz-Attribute neben der Kennlinie (im Schema ueberschreibbar). */
function grenzAttribute(props: ConfigGenericProps): { jeGeraet: boolean; unter: string; ober: string } {
    // eigene Angaben (eingeklappt, attrUntergrenze, attrObergrenze) stehen unter `custom` - das Schema der
    // jsonConfig erlaubt keine freien Schluessel; direkt am Eintrag werden sie weiter verstanden
    const roh = (props.schema || {}) as unknown as Record<string, unknown>;
    const schema = { ...roh, ...((roh.custom as Record<string, unknown>) || {}) };
    // Zeile eines Geraets (Accordion) oder die Vorlage der Instanz (Attribute "regel...")
    const jeGeraet = !!props.attr && !props.attr.startsWith('regel');
    const name = (v: unknown, sonst: string): string => (typeof v === 'string' && v ? v : sonst);
    return {
        jeGeraet,
        unter: name(schema.attrUntergrenze, jeGeraet ? 'untergrenze' : 'regelUntergrenze'),
        ober: name(schema.attrObergrenze, jeGeraet ? 'obergrenze' : 'regelObergrenze'),
    };
}

/** Welche Felder des Formulars zu einer Kennlinie gehoeren. */
function felder(
    props: ConfigGenericProps,
    richtung: Richtung,
): {
    vorgabe: Punkt[];
    untergrenze: number;
    obergrenze: number;
    grenzenEigen: { untergrenze: number | ''; obergrenze: number | '' };
    geraet: string;
    mitVorgabe: boolean;
    gespeichert: Punkt[] | undefined;
} {
    const data = (props.data || {}) as Record<string, unknown>;
    const global = (props.globalData || {}) as Record<string, unknown>;
    const g = grenzAttribute(props);
    const vorgabeAttr = richtung === 'kuehlen' ? 'regelKennlinieKuehlen' : 'regelKennlinieHeizen';
    // Zeile eines Geraets: leere Liste = Vorlage der Instanz. In der Vorlage selbst gilt bei leerer
    // Liste die Werksvorgabe.
    const gute = (roh: unknown): Punkt[] | null => {
        const liste = zug.punkte(roh);
        return liste.length && !zug.pruefen(liste, richtung) ? liste : null;
    };
    const vorgabe = (g.jeGeraet && gute(global[vorgabeAttr])) || zug.VORGABE[richtung];
    const grund = g.jeGeraet ? global : data;
    const grundUnter = zahlOder(grund.regelUntergrenze, zug.VORGABE_GRENZEN.untergrenze);
    const grundOber = zahlOder(grund.regelObergrenze, zug.VORGABE_GRENZEN.obergrenze);
    const eigen = (v: unknown): number | '' => (istLeer(v) || !Number.isFinite(Number(v)) ? '' : Number(v));
    // womit der Adapter gerade rechnet: der gespeicherte Stand (nicht der ungespeicherte des Formulars)
    const alt = (props.originalData || {}) as Record<string, unknown>;
    const geraet = g.jeGeraet && typeof data.geraet === 'string' ? data.geraet : '';
    let gespeichert: Punkt[] | undefined;
    if (g.jeGeraet && props.attr) {
        const eintrag = (Array.isArray(alt.regelGeraete) ? alt.regelGeraete : []).find(
            (e: unknown) => !!e && !!geraet && (e as Record<string, unknown>).geraet === geraet,
        ) as Record<string, unknown> | undefined;
        gespeichert =
            (eintrag && eintrag.individuell !== false && gute(eintrag[props.attr])) ||
            gute(alt[vorgabeAttr]) ||
            zug.VORGABE[richtung];
    }
    return {
        vorgabe,
        untergrenze: g.jeGeraet ? zahlOder(data[g.unter], grundUnter) : grundUnter,
        obergrenze: g.jeGeraet ? zahlOder(data[g.ober], grundOber) : grundOber,
        grenzenEigen: g.jeGeraet
            ? { untergrenze: eigen(data[g.unter]), obergrenze: eigen(data[g.ober]) }
            : { untergrenze: grundUnter, obergrenze: grundOber },
        geraet,
        mitVorgabe: g.jeGeraet,
        gespeichert,
    };
}

/** Arbeitspunkt des Geraets vom Adapter - beim Oeffnen, bei geaenderter Obergrenze und alle 15 s. */
function useArbeitspunkt(props: ConfigGenericProps, geraet: string, obergrenze: number, richtung: Richtung): Etikett | null {
    const [punkt, setPunkt] = useState<Etikett | null>(null);
    const socket = props.oContext?.socket;
    const ziel = `${props.oContext?.adapterName}.${props.oContext?.instance}`;
    useEffect(() => {
        if (!geraet || !props.alive || !socket || typeof socket.sendTo !== 'function') {
            setPunkt(null);
            return undefined;
        }
        let lebt = true;
        const fragen = (): void => {
            Promise.resolve(socket.sendTo(ziel, 'regelArbeitspunkt', { geraet, obergrenze }))
                .then((antwort: any) => {
                    if (lebt) {
                        const e = antwort && antwort.etikett && antwort.etikett[richtung];
                        setPunkt(e ? { ...e, vollAbK: antwort.vollAbK, probelauf: !!antwort.probelauf } : null);
                    }
                })
                .catch(() => lebt && setPunkt(null));
        };
        fragen();
        const takt = setInterval(fragen, 15000);
        return () => {
            lebt = false;
            clearInterval(takt);
        };
    }, [geraet, obergrenze, richtung, props.alive, socket, ziel]);
    return punkt;
}

function KennlinieFeld(
    props: ConfigGenericProps & {
        richtung: Richtung;
        onWert: (zeilen: Punkt[]) => void;
        onGrenze: (welche: Grenze, wert: number | '') => void;
        onAlles: (stand: Stand) => void;
        onFehler: (meldung: string) => void;
    },
): React.JSX.Element {
    const f = felder(props, props.richtung);
    const punkt = useArbeitspunkt(props, f.geraet, f.obergrenze, props.richtung);
    const palette = props.oContext?.theme?.palette;
    // eigene Angaben (eingeklappt, attrUntergrenze, attrObergrenze) stehen unter `custom` - das Schema der
    // jsonConfig erlaubt keine freien Schluessel; direkt am Eintrag werden sie weiter verstanden
    const roh = (props.schema || {}) as unknown as Record<string, unknown>;
    const schema = { ...roh, ...((roh.custom as Record<string, unknown>) || {}) };
    const label = schema.label;
    return (
        <KennlinieAnsicht
            richtung={props.richtung}
            titel={typeof label === 'string' ? I18n.t(label) : ''}
            wert={ConfigGeneric.getValue(props.data, props.attr as string)}
            vorgabe={f.vorgabe}
            untergrenze={f.untergrenze}
            obergrenze={f.obergrenze}
            grenzenEigen={f.grenzenEigen}
            arbeitspunkt={punkt}
            gespeichert={f.gespeichert}
            sprache={I18n.getLanguage()}
            farben={{
                flaeche: palette?.background?.paper || '#fff',
                fokus: palette?.primary?.main || '#3399cc',
                fehler: palette?.error?.main || '#d9534f',
            }}
            mitVorgabe={f.mitVorgabe}
            quelle={f.geraet}
            eingeklappt={schema.eingeklappt === undefined ? undefined : !!schema.eingeklappt}
            onWert={props.onWert}
            onGrenze={props.onGrenze}
            onAlles={props.onAlles}
            onFehler={props.onFehler}
        />
    );
}

class Kennlinie extends ConfigGeneric<ConfigGenericProps, ConfigGenericState> {
    richtung: Richtung = 'heizen';

    /** schreibt die Punkte ins Formular - der Rest (Speichern aktiv, Verwerfen) ist Sache des Admins */
    onWert = (zeilen: Punkt[]): void => {
        if (this.props.attr) {
            void this.onChange(this.props.attr, zeilen);
        }
    };

    /**
     * Schreibt eine Grenze in das Attribut NEBEN der Kennlinie (Geraet: untergrenze/obergrenze, Vorlage:
     * regelUntergrenze/regelObergrenze). ConfigGeneric.onChange nimmt jedes Attribut derselben
     * Datenebene: auf oberster Ebene setzt es den Wert in eine Kopie der Formulardaten, in einer
     * Accordion-Zeile reicht es (attr, wert) an die Zeile weiter.
     */
    onGrenze = (welche: Grenze, wert: number | ''): void => {
        const g = grenzAttribute(this.props);
        void this.onChange(welche === 'ober' ? g.ober : g.unter, wert);
    };

    /**
     * Mehrere Attribute in einem Zug (Einfuegen, Zuruecksetzen, Rueckgaengig). Zwei onChange-Aufrufe
     * direkt nacheinander gehen nicht: beide rechnen mit dem Stand VOR dem ersten, der zweite wuerde den
     * ersten ueberschreiben.
     *  - oberste Ebene: alle Werte in EINE Kopie der Formulardaten, ein Aufruf mit dem ganzen Objekt
     *  - Accordion-Zeile: die Zeile nimmt nur (attr, wert) - also der Reihe nach, jeweils erst wenn der
     *    vorige Wert im Formular angekommen ist (componentDidUpdate), zur Sicherheit mit Zeitgrenze
     */
    schlange: [string, unknown][] = [];
    wartetAuf: { attr: string; wert: unknown; uhr: ReturnType<typeof setTimeout> } | null = null;
    onAlles = (stand: Stand): void => {
        const attr = this.props.attr;
        if (!attr) {
            return;
        }
        const g = grenzAttribute(this.props);
        const paare: [string, unknown][] = [
            [attr, stand.punkte],
            [g.unter, stand.untergrenze],
            [g.ober, stand.obergrenze],
        ];
        if (!this.props.custom) {
            const data = JSON.parse(JSON.stringify(this.props.data)) as Record<string, unknown>;
            for (const [a, wert] of paare) {
                ConfigGeneric.setValue(data, a, wert);
            }
            this.props.onChange(data, undefined, () =>
                this.props.oContext?.forceUpdate?.(
                    paare.map(p => p[0]),
                    data,
                ),
            );
            return;
        }
        this.schlange.push(...paare);
        this.weiter();
    };

    weiter(): void {
        while (!this.wartetAuf && this.schlange.length) {
            const [attr, wert] = this.schlange.shift() as [string, unknown];
            const jetzt = ConfigGeneric.getValue(this.props.data, attr);
            if (gleich(jetzt ?? '', wert ?? '')) {
                continue;
            }
            this.wartetAuf = {
                attr,
                wert,
                uhr: setTimeout(() => {
                    this.wartetAuf = null;
                    this.weiter();
                }, 500),
            };
            void this.onChange(attr, wert);
        }
    }

    componentDidUpdate(): void {
        const w = this.wartetAuf;
        if (w && gleich(ConfigGeneric.getValue(this.props.data, w.attr) ?? '', w.wert ?? '')) {
            clearTimeout(w.uhr);
            this.wartetAuf = null;
            this.weiter();
        }
    }

    /**
     * Ungueltige Kennlinie ans Formular melden: der Admin sperrt dann "Speichern" und markiert den
     * Geraete-Eintrag - vorher liess sich eine Liste mit leerem oder doppeltem Punkt speichern.
     */
    letzterFehler = '';
    onFehler = (meldung: string): void => {
        if (this.props.attr && meldung !== this.letzterFehler) {
            this.letzterFehler = meldung;
            this.onError(this.props.attr, meldung || undefined);
        }
    };

    componentWillUnmount(): void {
        if (this.wartetAuf) {
            clearTimeout(this.wartetAuf.uhr);
            this.wartetAuf = null;
        }
        this.schlange = [];
        // ein zugeklappter oder geloeschter Eintrag darf das Formular nicht gesperrt zuruecklassen
        if (this.props.attr && this.letzterFehler) {
            this.letzterFehler = '';
            this.onError(this.props.attr, undefined);
        }
        super.componentWillUnmount?.();
    }

    renderItem(): React.JSX.Element {
        return (
            <KennlinieFeld
                {...this.props}
                richtung={this.richtung}
                onWert={this.onWert}
                onGrenze={this.onGrenze}
                onAlles={this.onAlles}
                onFehler={this.onFehler}
            />
        );
    }
}

/** jsonConfig-Komponente "KennlinieHeizen" */
export class KennlinieHeizen extends Kennlinie {
    richtung: Richtung = 'heizen';
}

/** jsonConfig-Komponente "KennlinieKuehlen" */
export class KennlinieKuehlen extends Kennlinie {
    richtung: Richtung = 'kuehlen';
}

export default { KennlinieHeizen, KennlinieKuehlen };
