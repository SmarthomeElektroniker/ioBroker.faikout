/*
 * Reiter "Multisplit": Innengeraete per ZIEHEN ihrem gemeinsamen Aussengeraet zuordnen - als Bild.
 * (Nutzer 22.11.2026: "das Thema zuordnen muss grafisch und einfach gehen"; "man muss sehen, WAS zugeordnet wird".)
 *
 * Jede Anlage ist EINE Kachel: oben das Aussengeraet (Zeichnung, Name, Leistung jetzt, Energie heute), darunter an
 * einer sichtbaren Leitung seine Innengeraete als kleine Kacheln (Raum, Betriebsart, Raumtemperatur, Anteil heute).
 *   - Multisplit: ein Aussengeraet, mehrere Innengeraete.
 *   - Einzelne Anlage (Single-Split): dieselbe Kachel mit genau einem Innengeraet - der Unterschied ist sofort zu sehen.
 *   - Vorschlag aus den Daten: dieselbe Kachel gestrichelt, mit "Uebernehmen" / "Ablehnen". Nie automatisch.
 * Zuordnen: Innengeraet auf ein anderes Aussengeraet ziehen (Maus oder Finger; auch auf eine einzelne Anlage - dann
 * teilen sich beide deren Aussengeraet) oder ueber das Menue an der Kachel. Aus einem Aussengeraet herausgezogen und
 * irgendwo ausserhalb losgelassen = geloest (mit "Rueckgaengig").
 *
 * Wert: native.aussengeraete = [{id, name, weitere, innen: [{geraet, modulId}]}]; abgelehnte Vorschlaege in
 * native.aussengeraeteAbgelehnt. Live-Werte und Vorschlag liefert der Adapter (sendTo verbundStand,
 * lib/verbundlauf.js) - gerechnet mit dem UNGESPEICHERTEN Formular.
 */
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Box, Menu, MenuItem } from '@mui/material';
import { I18n } from '@iobroker/gui-components';
import { ConfigGeneric, type ConfigGenericProps, type ConfigGenericState } from '@iobroker/json-config';

import { t as text, type Schluessel } from './Aussengeraete.texte';

export interface Innen {
    geraet: string;
    modulId?: string | null;
}
export interface Aussen {
    id: string;
    name: string;
    weitere?: number;
    innen: Innen[];
    /** Bezugsleistung der Gruppenregelung fuer die Strategie "Vortag" (W); ohne = Summe der Einzelwerte */
    vortagReferenzW?: number;
    /** weitere Felder anderer Teile des Adapters bleiben beim Speichern erhalten */
    [feld: string]: unknown;
}
interface GeraetStand {
    id: string;
    name: string;
    verbunden: boolean;
    laeuft: boolean;
    modell: string | null;
    /** Betriebsart als Text in der Sprache des Admins, Raumtemperatur */
    modusText?: string | null;
    raum?: number | null;
    leistung: number | null;
    heute: number | null;
    heuteGesamt: number | null;
    zaehler: boolean;
    farbe?: { hell: string; dunkel: string } | null;
}
interface GruppeStand {
    id: string;
    name: string;
    weitere: number;
    innen: { id: string; name: string; fehlt: boolean; modulId: string | null }[];
    leistung: number | null;
    heute: number | null;
    monat: number | null;
    rest: number;
    cop: number | null;
    pruefung: 'bestaetigt' | 'widerspricht' | 'unbekannt';
    /** aktuelle Leistungsgrenze der Gruppe (%) und ihr Leitgeraet - aus der Gruppenregelung */
    grenze?: number | null;
    leitgeraet?: string | null;
    anteile: Record<string, { heute: number | null; anteil: number | null }>;
}
export interface Vorschlag {
    art: 'neu' | 'dazu' | 'widerspruch';
    ids: string[];
    neu: string[];
    gruppe: string | null;
    gruende: string[];
    sicherheit: 'hoch' | 'mittel';
    schluessel: string;
    /** sicher: Zaehler ueber den Beobachtungszeitraum gleich; pruefung: Beobachtung laeuft; unsicher: nur Verdichter */
    stufe?: 'sicher' | 'pruefung' | 'unsicher';
    minuten?: number;
    noetig?: number;
}
export interface Stand {
    geraete: GeraetStand[];
    gruppen: GruppeStand[];
    vorschlaege: Vorschlag[];
    konfig: Aussen[];
    geaendert: boolean;
}
export interface Farben {
    text: string;
    blass: string;
    linie: string;
    flaeche: string;
    karte: string;
    akzent: string;
    gut: string;
    warn: string;
    /** Farbe des Vorschlagsmodus (Band, Rahmen, Pfeile) - bewusst anders als die Akzentfarbe der Anlagen */
    vorschlag: string;
    dunkel: boolean;
}

const WEITERE_MAX = 8;
/** Farben der Anteile, falls der Adapter keine Diagrammfarbe liefert */
/**
 * Farben der Vorschlaege - je vorgeschlagenem Aussengeraet eine eigene (Kachel, Kennzeichen, Nummern, Pfeile).
 * Nach Okabe/Ito gewaehlt: auch bei Farbschwaeche unterscheidbar (nicht Rot gegen Gruen), je hell und dunkel.
 */
const VORSCHLAG_FARBEN = [
    { hell: '#7a3fd0', dunkel: '#b78cff' }, // Violett
    { hell: '#c85200', dunkel: '#ff9a4d' }, // Orange
    { hell: '#007f73', dunkel: '#3fd1c0' }, // Blaugruen
    { hell: '#b0307a', dunkel: '#f29ac8' }, // Magenta
    { hell: '#8a6d00', dunkel: '#e8c53a' }, // Ocker
];
const ERSATZ = ['#2a7fd8', '#d8572a', '#3d9a50', '#a05ad8', '#d9a400', '#2aa8a8'];

/** Kleinste freie Kennung a1, a2, ... (wie lib/verbund.js) */
export function kennungNeu(liste: Aussen[]): string {
    let n = 1;
    while (liste.some(a => a.id === `a${n}`)) {
        n++;
    }
    return `a${n}`;
}

/**
 * Innengeraet zuordnen: aus allen Aussengeraeten herausnehmen und an das Ziel haengen.
 *
 * @param liste   Aussengeraete
 * @param geraet  Innengeraet
 * @param ziel    Kennung eines Aussengeraets, 'neu' (neues Aussengeraet) oder null (loesen: einzelne Anlage)
 * @returns neue Liste; ein leeres Aussengeraet ohne Namen verschwindet
 */
export function zuordnen(liste: Aussen[], geraet: Innen, ziel: string | null): Aussen[] {
    const neu = liste.map(a => ({ ...a, innen: a.innen.filter(i => i.geraet !== geraet.geraet) }));
    const eintrag = { geraet: geraet.geraet, modulId: geraet.modulId || null };
    if (ziel === 'neu') {
        neu.push({ id: kennungNeu(neu), name: '', weitere: 0, innen: [eintrag] });
    } else if (ziel) {
        const a = neu.find(x => x.id === ziel);
        if (a) {
            a.innen.push(eintrag);
        }
    }
    return neu.filter(a => a.innen.length || a.name.trim() || a.id === ziel);
}

/** Vorschlag uebernehmen: neues Aussengeraet mit allen Geraeten bzw. die neuen Geraete zum bestehenden. */
export function annehmen(liste: Aussen[], v: Vorschlag, modulIds: Record<string, string | null>): Aussen[] {
    let neu = liste;
    let ziel: string | null = v.art === 'dazu' ? v.gruppe : null;
    for (const id of v.art === 'dazu' ? v.neu : v.ids) {
        neu = zuordnen(neu, { geraet: id, modulId: modulIds[id] || null }, ziel || 'neu');
        ziel = ziel || neu[neu.length - 1].id;
    }
    return neu;
}

const SYMBOL = {
    // Innengeraet (Wandgeraet): flacher Kasten mit Luftauslass
    innen: 'M3 7h18v8a2 2 0 01-2 2H5a2 2 0 01-2-2zM6 14h12M7 20v-1M12 21v-2M17 20v-1',
    aussen: 'M3 5h18v13H3zM10 15.5a4 4 0 100-8 4 4 0 000 8zM10 7.5v8M6 11.5h8M17 9h1.5M17 12h1.5M17 15h1.5M6 18v2M18 18v2',
    griff: 'M9 6h.01M9 12h.01M9 18h.01M15 6h.01M15 12h.01M15 18h.01',
    pfeil: 'M5 8.5l7 7 7-7',
    idee: 'M9 18h6M10 21h4M12 3a6 6 0 00-3.5 10.9c.6.5 1 1.3 1 2.1h5c0-.8.4-1.6 1-2.1A6 6 0 0012 3z',
    haken: 'M5 12.5l4.5 4.5L19 7.5',
    warn: 'M12 4l9 16H3zM12 10v4M12 17h.01',
    weg: 'M6 6l12 12M18 6L6 18',
    stift: 'M4 20h4L19 9l-4-4L4 16zM14 6l4 4',
    plus: 'M12 5v14M5 12h14',
    minus: 'M5 12h14',
};

function Zeichen(props: { d: string; groesse: number; dick?: number; stil?: React.CSSProperties; klasse?: string }): React.JSX.Element {
    return (
        <svg
            className={props.klasse}
            viewBox="0 0 24 24"
            width={props.groesse}
            height={props.groesse}
            aria-hidden="true"
            fill="none"
            stroke="currentColor"
            strokeWidth={props.dick || 1.8}
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{ flex: '0 0 auto', ...props.stil }}
        >
            <path d={props.d} />
        </svg>
    );
}

/** Zeichnung eines Aussengeraets: Gehaeuse auf Fuessen, Luefter mit Fluegeln, Lamellen. Laeuft es, dreht der Luefter. */
function AussenBild(props: { laeuft?: boolean; breite?: number }): React.JSX.Element {
    const b = props.breite || 96;
    return (
        <svg
            className={`fk-ag-abild${props.laeuft ? ' fk-ag-dreht' : ''}`}
            viewBox="0 0 76 56"
            width={b}
            height={(b * 56) / 76}
            aria-hidden="true"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{ flex: '0 0 auto' }}
        >
            <rect
                x="2"
                y="4"
                width="72"
                height="42"
                rx="5"
                fill="currentColor"
                fillOpacity="0.1"
            />
            <path d="M12 46v6M64 46v6M8 52h8M60 52h8" />
            <circle
                cx="28"
                cy="25"
                r="15"
            />
            <g className="fk-ag-fluegel">
                <path d="M28 25c-2-6 0-11 4-13M28 25c6-2 11 0 13 4M28 25c2 6 0 11-4 13M28 25c-6 2-11 0-13-4" />
            </g>
            <circle
                cx="28"
                cy="25"
                r="2.2"
                fill="currentColor"
            />
            <path d="M52 13h14M52 19h14M52 25h14M52 31h14M52 37h14" />
        </svg>
    );
}

export interface AnsichtProps {
    liste: Aussen[];
    abgelehnt: string[];
    stand: Stand | null;
    sprache: string;
    f: Farben;
    alive: boolean;
    onListe: (liste: Aussen[]) => void;
    onAbgelehnt: (abgelehnt: string[]) => void;
    /** Stand neu vom Adapter holen ("Zuordnung vorschlagen") */
    onNeu?: () => void;
}

interface Zug {
    id: string;
    name: string;
    x: number;
    y: number;
    aktiv: boolean;
    von: string;
    ziel: string | null;
}

/** Namen als Aufzaehlung: "A, B und C" */
function aufzaehlung(namen: string[], und: string): string {
    return namen.length < 2 ? namen.join('') : `${namen.slice(0, -1).join(', ')} ${und} ${namen[namen.length - 1]}`;
}

export function AussengeraeteAnsicht(props: AnsichtProps): React.JSX.Element {
    const { liste, stand, sprache, f } = props;
    const t = (s: Schluessel, ...w: (string | number)[]): string => text(sprache, s, ...w);
    const zahl = (n: number, stellen: number): string => n.toLocaleString(sprache, { minimumFractionDigits: stellen, maximumFractionDigits: stellen });
    const [zug, setZug] = useState<Zug | null>(null);
    const start = useRef<{ x: number; y: number } | null>(null);
    const zugRef = useRef<Zug | null>(null);
    const [menue, setMenue] = useState<{ anker: HTMLElement; id: string } | null>(null);
    const [geaendert, setGeaendert] = useState(false);
    /** kurze Meldung mit "Rueckgaengig" (nach Uebernehmen bzw. nach dem Loesen durch Herausziehen) */
    const [meldung, setMeldung] = useState<{ text: string; vorher: Aussen[] } | null>(null);
    const [gesucht, setGesucht] = useState(false);
    useEffect(() => {
        if (!meldung) {
            return undefined;
        }
        const timer = setTimeout(() => setMeldung(null), 30000);
        return () => clearTimeout(timer);
    }, [meldung]);

    const geraete = stand ? stand.geraete : [];
    const vonId = new Map(geraete.map(g => [g.id, g]));
    const zugeordnet = new Map<string, string>();
    liste.forEach(a => a.innen.forEach(i => zugeordnet.set(i.geraet, a.id)));
    const frei = geraete.filter(g => !zugeordnet.has(g.id));
    const vorschlaege = stand ? stand.vorschlaege : [];
    const nameVon = (id: string): string => vonId.get(id)?.name || id;
    const aussenName = (a: Aussen, n: number): string => a.name.trim() || `${t('aussen')} ${n + 1}`;
    const farbeVon = (id: string, n: number): string => {
        const farbe = vonId.get(id)?.farbe;
        return farbe ? (f.dunkel ? farbe.dunkel : farbe.hell) : ERSATZ[n % ERSATZ.length];
    };
    const modulIds = Object.fromEntries((stand?.konfig || []).flatMap(a => a.innen).map(i => [i.geraet, i.modulId || null]));
    const innenVon = (id: string): Innen => {
        const alt = liste.flatMap(a => a.innen).find(i => i.geraet === id);
        return { geraet: id, modulId: alt?.modulId || modulIds[id] || null };
    };

    const setzen = (neu: Aussen[]): void => {
        setGeaendert(true);
        setMeldung(null); // eine aeltere Meldung gehoert zu einem aelteren Stand - ihr "Rueckgaengig" waere falsch
        props.onListe(neu);
    };
    /**
     * Innengeraet zuordnen. ziel: Kennung eines Aussengeraets, 'neu', null (loesen) oder 's:<Geraet>' - auf eine
     * einzelne Anlage gelegt: beide teilen sich ab jetzt deren Aussengeraet (neues Aussengeraet mit beiden).
     */
    const fallen = (id: string, ziel: string | null): void => {
        if (ziel && ziel.startsWith('s:')) {
            const mit = zuordnen(liste, innenVon(ziel.slice(2)), 'neu');
            setzen(zuordnen(mit, innenVon(id), mit[mit.length - 1].id));
            return;
        }
        setzen(zuordnen(liste, innenVon(id), ziel));
    };
    /** Aus dem Aussengeraet herausgezogen: loesen - mit Meldung und "Rueckgaengig" */
    const herausziehen = (id: string): void => {
        const vorher = liste;
        fallen(id, null);
        setMeldung({ text: t('geloest', nameVon(id)), vorher });
    };

    // ---------- Ziehen mit Maus oder Finger (Pointer-Ereignisse; die Kachel folgt als Schatten) ----------
    const zoneBei = (x: number, y: number): string | null => {
        const el = document.elementFromPoint(x, y) as HTMLElement | null;
        return el?.closest?.('[data-fk-zone]')?.getAttribute('data-fk-zone') || null;
    };
    // Die Wahrheit steht in zugRef: Druecken, Bewegen und Loslassen koennen schneller aufeinander folgen, als
    // React neu zeichnet - der Zustand `zug` dient nur der Anzeige (Schatten, hervorgehobene Ziele).
    const zugSetzen = (z: Zug | null): void => {
        zugRef.current = z;
        setZug(z);
    };
    const zugGriffe = (id: string, von: string): Record<string, unknown> => ({
        onPointerDown: (e: React.PointerEvent<HTMLElement>): void => {
            if (e.button !== 0 || (e.target as HTMLElement).closest('button')) {
                return;
            }
            try {
                e.currentTarget.setPointerCapture(e.pointerId);
            } catch {
                // ohne Zeigerbindung laeuft das Ziehen weiter, solange der Zeiger ueber der Kachel bleibt
            }
            start.current = { x: e.clientX, y: e.clientY };
            zugSetzen({ id, name: nameVon(id), x: e.clientX, y: e.clientY, aktiv: false, von, ziel: null });
        },
        onPointerMove: (e: React.PointerEvent<HTMLElement>): void => {
            const z = zugRef.current;
            if (!z || z.id !== id || !start.current) {
                return;
            }
            const weit = Math.hypot(e.clientX - start.current.x, e.clientY - start.current.y) > 6;
            if (z.aktiv || weit) {
                zugSetzen({ ...z, x: e.clientX, y: e.clientY, aktiv: true, ziel: zoneBei(e.clientX, e.clientY) });
            }
        },
        onPointerUp: (e: React.PointerEvent<HTMLElement>): void => {
            const z = zugRef.current;
            const weit = !!start.current && Math.hypot(e.clientX - start.current.x, e.clientY - start.current.y) > 6;
            start.current = null;
            zugSetzen(null);
            if (!z || z.id !== id || !(z.aktiv || weit)) {
                return;
            }
            const ziel = zoneBei(e.clientX, e.clientY);
            if (ziel === z.von) {
                return;
            }
            if (!ziel) {
                // irgendwo ausserhalb losgelassen: aus einem Aussengeraet heraus heisst das "loesen"
                if (z.von.startsWith('a:')) {
                    herausziehen(z.id);
                }
            } else {
                fallen(z.id, ziel === 'neu' ? 'neu' : ziel.startsWith('a:') ? ziel.slice(2) : ziel);
            }
        },
        onPointerCancel: (): void => {
            start.current = null;
            zugSetzen(null);
        },
    });
    /** Loslassen wuerde das Geraet loesen: aus einem Aussengeraet gezogen und ueber keinem Ziel */
    const loestGerade = !!zug?.aktiv && zug.von.startsWith('a:') && !zug.ziel;
    const zoneKlasse = (zone: string): string => {
        const bereit = !!zug?.aktiv && zug.von !== zone;
        return `fk-ag-zone${bereit ? ' fk-ag-bereit' : ''}${bereit && zug?.ziel === zone ? ' fk-ag-ziel' : ''}`;
    };

    // ---------- kleine Kachel eines Innengeraets ----------
    const kachel = (id: string, von: string, opt: { anteil?: { heute: number | null; anteil: number | null }; farbe?: string; fehlt?: boolean } = {}): React.JSX.Element => {
        const g = vonId.get(id);
        const teile: string[] = [];
        if (opt.fehlt || (stand && !g)) {
            teile.push(t('fehlt'));
        } else if (g) {
            teile.push(!g.verbunden ? t('getrennt') : g.laeuft ? g.modusText || t('an') : t('aus'));
            if (typeof g.raum === 'number') {
                teile.push(`${zahl(g.raum, 1)} °C`);
            }
        }
        const heute = opt.anteil?.heute ?? (von.startsWith('a:') ? g?.heute : null);
        return (
            <div
                className={`fk-ag-kachel${zug?.aktiv && zug.id === id ? ' fk-ag-gezogen' : ''}`}
                data-geraet={id}
                title={t('ziehen')}
                {...zugGriffe(id, von)}
            >
                <Zeichen
                    d={SYMBOL.griff}
                    groesse={20}
                    dick={2.6}
                    klasse="fk-ag-griff"
                />
                {opt.farbe ? (
                    <span
                        className="fk-ag-farbe"
                        style={{ background: opt.farbe }}
                    />
                ) : null}
                <Zeichen
                    d={SYMBOL.innen}
                    groesse={30}
                    dick={1.6}
                    stil={{ color: g && g.verbunden && g.laeuft ? f.akzent : f.blass }}
                />
                <span className="fk-ag-ktext">
                    <span className="fk-ag-kname">{nameVon(id)}</span>
                    <span className="fk-ag-kunter">{teile.join(' · ')}</span>
                </span>
                {opt.anteil && typeof opt.anteil.anteil === 'number' ? (
                    <span className="fk-ag-proz">
                        <b>{`${Math.round(opt.anteil.anteil * 100)} %`}</b>
                        {typeof heute === 'number' ? <small>{`${zahl(heute, 1)} kWh`}</small> : null}
                    </span>
                ) : null}
                <button
                    type="button"
                    className="fk-ag-knopf fk-ag-menue"
                    title={t('zuordnen')}
                    aria-label={`${nameVon(id)}: ${t('zuordnen')}`}
                    aria-haspopup="menu"
                    onClick={e => setMenue({ anker: e.currentTarget, id })}
                >
                    <Zeichen
                        d={SYMBOL.pfeil}
                        groesse={20}
                    />
                </button>
            </div>
        );
    };
    /** Die Leitung vom Aussengeraet zu seinen Innengeraeten */
    const baum = (kinder: React.ReactNode[], leer?: string, stamm?: string): React.JSX.Element => (
        <div
            className="fk-ag-baum"
            data-stamm={stamm}
        >
            {kinder.length ? (
                kinder.map((k, n) => (
                    <div
                        className="fk-ag-ast"
                        key={n}
                    >
                        {k}
                    </div>
                ))
            ) : (
                <div className="fk-ag-ast">
                    <div className="fk-ag-leer">{leer}</div>
                </div>
            )}
        </div>
    );

    // ---------- Kachel einer Multisplit-Anlage ----------
    const multiKachel = (a: Aussen, n: number): React.JSX.Element => {
        const w = stand?.gruppen.find(g => g.id === a.id) || null;
        const zone = `a:${a.id}`;
        const werte: string[] = [];
        if (w && typeof w.leistung === 'number') {
            werte.push(`${zahl(w.leistung, 0)} W`);
        }
        if (w && typeof w.heute === 'number') {
            werte.push(t('heute', zahl(w.heute, 1)));
        }
        const balken = w && typeof w.heute === 'number' && w.heute > 0 ? a.innen.map((i, k) => ({ id: i.geraet, anteil: w.anteile[i.geraet]?.anteil || 0, farbe: farbeVon(i.geraet, k) })) : [];
        const weitere = Math.min(WEITERE_MAX, Math.max(0, Number(a.weitere) || 0));
        const aendern = (teil: Partial<Aussen>): void => setzen(liste.map(x => (x.id === a.id ? { ...x, ...teil } : x)));
        return (
            <div
                key={a.id}
                className={`fk-ag-anlage fk-ag-multi ${zoneKlasse(zone)}${modus && !zielGruppen.has(a.id) ? ' fk-ag-blass' : ''}`}
                data-fk-zone={zone}
                data-aussen={a.id}
            >
                <div className="fk-ag-akopf">
                    <AussenBild laeuft={!!w && typeof w.leistung === 'number' && w.leistung > 50} />
                    <span className="fk-ag-amitte">
                        <span className="fk-ag-art">{t('aussen')}</span>
                        <label
                            className="fk-ag-name"
                            title={t('nameTipp')}
                        >
                            <input
                                type="text"
                                value={a.name}
                                maxLength={60}
                                placeholder={`${t('aussen')} ${n + 1} – ${t('namePlatz')}`}
                                aria-label={t('nameTipp')}
                                onChange={e => aendern({ name: e.target.value })}
                            />
                            <Zeichen
                                d={SYMBOL.stift}
                                groesse={16}
                            />
                        </label>
                        <span className="fk-ag-werte">{werte.join(' · ')}</span>
                    </span>
                    <button
                        type="button"
                        className="fk-ag-knopf"
                        title={t('aufloesen')}
                        aria-label={t('aufloesen')}
                        onClick={() => setzen(liste.filter(x => x.id !== a.id))}
                    >
                        <Zeichen
                            d={SYMBOL.weg}
                            groesse={20}
                        />
                    </button>
                </div>
                {baum(
                    a.innen.map((i, k) => kachel(i.geraet, zone, { anteil: w?.anteile[i.geraet], farbe: farbeVon(i.geraet, k), fehlt: w?.innen.find(x => x.id === i.geraet)?.fehlt })),
                    t('boxLeer'),
                )}
                <div className="fk-ag-afuss">
                    {w && w.pruefung !== 'unbekannt' ? (
                        <div
                            className={`fk-ag-pruef fk-ag-${w.pruefung}`}
                            title={w.pruefung === 'bestaetigt' ? t('bestaetigtTipp') : undefined}
                        >
                            <Zeichen
                                d={w.pruefung === 'bestaetigt' ? SYMBOL.haken : SYMBOL.warn}
                                groesse={16}
                                dick={2.2}
                            />
                            {t(w.pruefung)}
                        </div>
                    ) : null}
                    {balken.length ? (
                        <>
                            <div
                                className="fk-ag-balken"
                                role="img"
                                aria-label={a.innen.map(i => `${nameVon(i.geraet)} ${Math.round((w?.anteile[i.geraet]?.anteil || 0) * 100)} %`).join(', ')}
                            >
                                {balken.map(b => (
                                    <span
                                        key={b.id}
                                        title={`${nameVon(b.id)}: ${Math.round(b.anteil * 100)} %`}
                                        style={{ width: `${b.anteil * 100}%`, background: b.farbe }}
                                    />
                                ))}
                            </div>
                            <div className="fk-ag-fuss">
                                {w && w.rest > 0 ? (
                                    <span
                                        className="fk-ag-restzeile"
                                        title={t('restTipp')}
                                    >
                                        <span className="fk-ag-restfarbe" />
                                        {t('rest', zahl(w.rest, 1))}
                                    </span>
                                ) : null}
                                {w && typeof w.cop === 'number' ? <span>{t('systemCop', zahl(w.cop, 1))}</span> : null}
                            </div>
                        </>
                    ) : null}
                    {w && typeof w.grenze === 'number' ? (
                        <div className="fk-ag-grenze">
                            <Zeichen
                                d="M4 16a8 8 0 1116 0M12 16l4-5M4 20h16"
                                groesse={18}
                            />
                            {w.leitgeraet ? t('grenzeLeit', zahl(w.grenze, 0), w.leitgeraet) : t('grenze', zahl(w.grenze, 0))}
                        </div>
                    ) : null}
                    <div className="fk-ag-weitere">
                        <span>{t('weitere')}</span>
                        <span className="fk-ag-zaehler">
                            <button
                                type="button"
                                className="fk-ag-knopf fk-ag-klein"
                                title={t('weniger')}
                                aria-label={t('weniger')}
                                disabled={weitere <= 0}
                                onClick={() => aendern({ weitere: weitere - 1 })}
                            >
                                <Zeichen
                                    d={SYMBOL.minus}
                                    groesse={16}
                                    dick={2.2}
                                />
                            </button>
                            <b>{weitere}</b>
                            <button
                                type="button"
                                className="fk-ag-knopf fk-ag-klein"
                                title={t('mehr')}
                                aria-label={t('mehr')}
                                disabled={weitere >= WEITERE_MAX}
                                onClick={() => aendern({ weitere: weitere + 1 })}
                            >
                                <Zeichen
                                    d={SYMBOL.plus}
                                    groesse={16}
                                    dick={2.2}
                                />
                            </button>
                        </span>
                    </div>
                    <details className="fk-ag-fort">
                        <summary>
                            <Zeichen
                                d={SYMBOL.pfeil}
                                groesse={18}
                            />
                            {t('fortgeschritten')}
                        </summary>
                        <label>
                            <span>{t('bezug')}</span>
                            <input
                                type="number"
                                min={0}
                                step={50}
                                inputMode="numeric"
                                value={typeof a.vortagReferenzW === 'number' && a.vortagReferenzW > 0 ? a.vortagReferenzW : ''}
                                placeholder={t('bezugPlatz')}
                                onChange={e => {
                                    const n = Math.round(Number(e.target.value));
                                    const { vortagReferenzW: _alt, ...rest } = a;
                                    setzen(liste.map(x => (x.id === a.id ? (n > 0 ? { ...rest, vortagReferenzW: n } : (rest as Aussen)) : x)));
                                }}
                            />
                        </label>
                    </details>
                </div>
            </div>
        );
    };

    // ---------- Kachel einer einzelnen Anlage: ein Aussengeraet, ein Innengeraet ----------
    const einzelKachel = (g: GeraetStand): React.JSX.Element => {
        const zone = `s:${g.id}`;
        const werte: string[] = [];
        if (typeof g.leistung === 'number') {
            werte.push(`${zahl(g.leistung, 0)} W`);
        }
        const heute = g.heuteGesamt ?? g.heute;
        if (typeof heute === 'number') {
            werte.push(t('heute', zahl(heute, 1)));
        }
        return (
            <div
                key={g.id}
                className={`fk-ag-anlage fk-ag-einzel ${zug?.id === g.id ? 'fk-ag-zone' : zoneKlasse(zone)}${modus ? (quellen.has(g.id) ? ' fk-ag-quelle' : ' fk-ag-blass') : ''}`}
                data-fk-zone={zone}
                data-nr-quelle={quellen.has(g.id) ? g.id : undefined}
                style={quellen.has(g.id) ? vStil(quellen.get(g.id)?.farbe || f.vorschlag) : undefined}
                title={quellen.has(g.id) ? t('wandert', g.name, quellen.get(g.id)?.ziel || '') : undefined}
            >
                {quellen.has(g.id) ? <span className="fk-ag-nr fk-ag-nr-quelle">{quellen.get(g.id)?.nr}</span> : null}
                <div className="fk-ag-akopf">
                    <AussenBild
                        laeuft={typeof g.leistung === 'number' && g.leistung > 50}
                        breite={64}
                    />
                    <span className="fk-ag-amitte">
                        <span className="fk-ag-art">{t('einzelAussen')}</span>
                        <span className="fk-ag-werte">{werte.join(' · ')}</span>
                    </span>
                </div>
                {baum([kachel(g.id, zone)])}
            </div>
        );
    };

    // ---------- Vorschlag ----------
    const offeneVorschlaege = vorschlaege.filter(v => v.art !== 'widerspruch');
    /** Vorschlagsmodus: es gibt einen offenen Vorschlag - Band, Rahmen, Pfeile; alles andere tritt zurueck */
    const modus = offeneVorschlaege.length > 0;
    const zielGruppen = new Set(offeneVorschlaege.filter(v => v.art === 'dazu').map(v => v.gruppe));
    /** Innengeraete, die durch den Vorschlag wandern wuerden: Nummer (an Quelle und Ziel gleich) und Name des Ziels */
    // Die Farbe gehoert zum Vorschlag, nicht zu seinem Platz in der Liste: wird einer uebernommen, behalten die
    // uebrigen ihre Farbe. Vergeben wird die erste Farbe, die gerade kein offener Vorschlag traegt.
    const farbPlatz = useRef(new Map<string, number>());
    for (const k of [...farbPlatz.current.keys()]) {
        if (!offeneVorschlaege.some(v => v.schluessel === k)) {
            farbPlatz.current.delete(k);
        }
    }
    for (const v of offeneVorschlaege) {
        if (!farbPlatz.current.has(v.schluessel)) {
            const belegt = new Set(farbPlatz.current.values());
            let platz = 0;
            while (belegt.has(platz) && platz < VORSCHLAG_FARBEN.length - 1) {
                platz++;
            }
            farbPlatz.current.set(v.schluessel, platz);
        }
    }
    const vFarbe = (n: number): string => {
        const platz = farbPlatz.current.get(offeneVorschlaege[n]?.schluessel) ?? n;
        return VORSCHLAG_FARBEN[platz % VORSCHLAG_FARBEN.length][f.dunkel ? 'dunkel' : 'hell'];
    };
    const vStil = (farbe: string): React.CSSProperties => ({ '--fk-v': farbe }) as React.CSSProperties;
    const quellen = new Map<string, { nr: string; ziel: string; farbe: string; gruppe: number; schluessel: string }>();
    offeneVorschlaege.forEach((v, n) => {
        const k = liste.findIndex(a => a.id === v.gruppe);
        const ziel = v.art === 'dazu' && k >= 0 ? aussenName(liste[k], k) : `${t('aussen')} ${liste.length + n + 1}`;
        // Kennung an Quelle und Ziel: Buchstabe des Vorschlags + laufende Nummer (A1, A2, B1 ...) - auch ohne Farbe eindeutig
        (v.art === 'dazu' ? v.neu : v.ids).forEach((id, k) => quellen.set(id, { nr: `${'ABCDEFGH'[(farbPlatz.current.get(v.schluessel) ?? n) % 8]}${k + 1}`, ziel, farbe: vFarbe(n), gruppe: n, schluessel: v.schluessel }));
    });
    // Pfeile von jeder betroffenen einzelnen Anlage zu ihrem Platz in der vorgeschlagenen Kachel - eine sanfte Linie
    // ohne Knick, die von der Seite eintrifft, aus der sie kommt: Anlage links der Kachel -> linker Rand des Platzes,
    // rechts -> rechter Rand, darunter bzw. darueber -> gerade auf den Platz. Gemessen wird am fertigen Bild; stehen
    // die Kacheln untereinander (schmal), bleiben nur die Kennungen (A1, B2 ...) an Quelle und Ziel.
    const flaeche = useRef<HTMLDivElement | null>(null);
    const [pfeile, setPfeile] = useState<{ id: string; d: string; titel: string; farbe: string }[]>([]);
    const pfeilSchluessel = `${f.dunkel}#${[...quellen.keys()].join('|')}#${liste.map(a => `${a.id}:${a.innen.length}`).join(',')}#${frei.map(g => g.id).join(',')}`;
    useLayoutEffect(() => {
        const el = flaeche.current;
        if (!el || !quellen.size) {
            setPfeile(alt => (alt.length ? [] : alt));
            return undefined;
        }
        const messen = (): void => {
            const r = el.getBoundingClientRect();
            const neu: { id: string; d: string; titel: string; farbe: string }[] = [];
            if (r.width >= 880) {
                for (const [id, q] of quellen) {
                    const von = el.querySelector(`[data-nr-quelle="${CSS.escape(id)}"]`)?.getBoundingClientRect();
                    const platz = el.querySelector(`[data-nr-ziel="${CSS.escape(id)}"]`);
                    const zu = platz?.getBoundingClientRect();
                    const kachelRand = platz?.closest('.fk-ag-anlage')?.getBoundingClientRect();
                    if (!von || !zu || !kachelRand) {
                        continue;
                    }
                    const p = (n: number): string => n.toFixed(1);
                    const mx = von.left + von.width / 2;
                    const unten = von.top >= zu.bottom;
                    // Start: Mitte des Rands der Anlage, der zur Kachel zeigt
                    const [x1, y1] = [mx - r.left, (unten ? von.top - 2 : von.bottom + 2) - r.top];
                    const zy = zu.top + zu.height / 2 - r.top;
                    let d: string;
                    if (mx >= kachelRand.left && mx <= kachelRand.right) {
                        // darunter bzw. darueber: gerade auf den Platz (dessen naeheren Rand)
                        const x2 = Math.min(zu.right - 24, Math.max(zu.left + 24, mx)) - r.left;
                        d = `M${p(x1)} ${p(y1)} L${p(x2)} ${p((unten ? zu.bottom + 5 : zu.top - 5) - r.top)}`;
                    } else {
                        // von der Seite: sanfter Bogen an den Rand des Platzes auf der Herkunftsseite
                        const x2 = (mx < kachelRand.left ? zu.left - 6 : zu.right + 6) - r.left;
                        d = `M${p(x1)} ${p(y1)} Q${p(x1 + (x2 - x1) * 0.45)} ${p(zy + (y1 - zy) * 0.12)} ${p(x2)} ${p(zy)}`;
                    }
                    neu.push({ id, d, titel: `${nameVon(id)} → ${q.ziel}`, farbe: q.farbe });
                }
            }
            setPfeile(alt => (JSON.stringify(alt) === JSON.stringify(neu) ? alt : neu));
        };
        messen();
        const beobachter = typeof ResizeObserver === 'function' ? new ResizeObserver(messen) : null;
        beobachter?.observe(el);
        window.addEventListener('resize', messen);
        return () => {
            beobachter?.disconnect();
            window.removeEventListener('resize', messen);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [pfeilSchluessel]);
    const uebernehmen = (auswahl: Vorschlag[]): void => {
        if (!auswahl.length) {
            return;
        }
        const vorher = liste;
        const neu = auswahl.reduce((l, v) => annehmen(l, v, modulIds), liste);
        const innen = auswahl.reduce((n, v) => n + (v.art === 'dazu' ? v.neu : v.ids).length, 0);
        setzen(neu);
        setMeldung({ text: t('uebernommen', auswahl.length, innen), vorher });
    };
    const ablehnen = (auswahl: Vorschlag[]): void => {
        setGeaendert(true);
        setGesucht(false);
        const weg = auswahl.map(v => v.schluessel);
        props.onAbgelehnt([...props.abgelehnt.filter(k => !weg.includes(k)), ...weg]);
    };
    /** "Zuordnung vorschlagen": neu rechnen lassen - auch abgelehnte Vorschlaege kommen wieder */
    const vorschlagen = (): void => {
        setGesucht(true);
        if (props.abgelehnt.length) {
            setGeaendert(true);
            props.onAbgelehnt([]);
        } else {
            props.onNeu?.();
        }
    };
    const vorschlagName = (v: Vorschlag, n: number): string => {
        const k = liste.findIndex(a => a.id === v.gruppe);
        return v.art === 'dazu' && k >= 0 ? aussenName(liste[k], k) : `${t('aussen')} ${liste.length + n + 1}`;
    };
    /** Zeile eines Vorschlags: "Aussengeraet 2 = A + B" bzw. "Garten + C" */
    const vorschlagZeile = (v: Vorschlag, n: number): string =>
        v.art === 'dazu' ? `${vorschlagName(v, n)} + ${v.neu.map(nameVon).join(' + ')}` : `${vorschlagName(v, n)} = ${v.ids.map(nameVon).join(' + ')}`;
    const vorschlagGrund = (v: Vorschlag): string =>
        t(v.gruende.includes('zaehler') ? 'vorschlagZaehler' : 'vorschlagVerdichter', aufzaehlung(v.ids.map(nameVon), t('und')));
    const stufeText = (v: Vorschlag): string =>
        v.stufe === 'sicher' ? t('stufeSicher') : v.stufe === 'pruefung' ? t('stufePruefung', v.minuten || 0, v.noetig || 10) : t('stufeUnsicher');
    const stufeTipp = (v: Vorschlag): string =>
        v.stufe === 'sicher' ? t('stufeSicherTipp', v.noetig || 10) : v.stufe === 'pruefung' ? t('stufePruefungTipp') : t('stufeUnsicherTipp');
    /** Der Vorschlag als Bild: dieselbe Kachel, gestrichelt */
    const vorschlagKachel = (v: Vorschlag, n: number): React.JSX.Element => (
        <div
            key={v.schluessel}
            className={`fk-ag-anlage fk-ag-vkachel fk-ag-stufe-${v.stufe || 'unsicher'}`}
            data-vorschlag={v.stufe || 'unsicher'}
            title={vorschlagGrund(v)}
            style={vStil(vFarbe(n))}
        >
            <div className="fk-ag-akopf">
                <AussenBild />
                <span className="fk-ag-amitte">
                    <span className="fk-ag-art">
                        <span className="fk-ag-neumarke">{t(v.art === 'dazu' ? 'dazuVorschlag' : 'neuVorschlag')}</span>
                        <span
                            className="fk-ag-stufe"
                            title={stufeTipp(v)}
                        >
                            {stufeText(v)}
                        </span>
                    </span>
                    <span className="fk-ag-vkname">{vorschlagName(v, n)}</span>
                </span>
                <button
                    type="button"
                    className="fk-ag-ok"
                    title={t(v.art === 'dazu' ? 'hinzufuegen' : 'uebernehmenTipp')}
                    aria-label={`${vorschlagZeile(v, n)}: ${t(v.art === 'dazu' ? 'hinzufuegen' : 'uebernehmen')}`}
                    onClick={() => uebernehmen([v])}
                >
                    <Zeichen
                        d={SYMBOL.haken}
                        groesse={34}
                        dick={3.2}
                    />
                </button>
            </div>
            {baum(
                (v.art === 'dazu' ? v.neu : v.ids).map(id => (
                    <div
                        className="fk-ag-vinnen"
                        key={id}
                        data-nr-ziel={id}
                        title={`${nameVon(id)} → ${vorschlagName(v, n)}`}
                    >
                        <span className="fk-ag-nr">{quellen.get(id)?.nr}</span>
                        <Zeichen
                            d={SYMBOL.innen}
                            groesse={26}
                            dick={1.6}
                        />
                        {nameVon(id)}
                    </div>
                )),
                undefined,
                v.schluessel,
            )}
        </div>
    );

    const hatMulti = liste.some(a => a.innen.length);
    const kante = f.dunkel ? 'rgba(255,255,255,0.28)' : 'rgba(0,0,0,0.26)';
    const tonung = f.dunkel ? 'rgba(51,153,204,0.14)' : 'rgba(51,153,204,0.09)';

    return (
        <Box
            className={`fk-ag${zug?.aktiv ? ' fk-ag-zieht' : ''}`}
            sx={{
                width: '100%',
                boxSizing: 'border-box',
                color: 'text.primary',
                minWidth: 0,
                '& .fk-ag-erkl': { fontSize: '1rem', lineHeight: 1.45, margin: '4px 0 4px', maxWidth: '60em' },
                '& .fk-ag-wie': { fontSize: '0.875rem', lineHeight: 1.45, color: f.blass, margin: '0 0 14px', maxWidth: '68em' },
                '& .fk-ag-hinweis': { fontSize: '0.8125rem', color: f.blass, margin: '10px 0 0' },
                // Vorschlag (Leiste)
                '& .fk-ag-vorschlag': {
                    display: 'flex',
                    flexWrap: 'wrap',
                    alignItems: 'center',
                    gap: '10px 14px',
                    padding: '10px 14px',
                    marginBottom: '12px',
                    borderRadius: '8px',
                    border: `1.5px solid ${f.akzent}`,
                    backgroundColor: tonung,
                },
                '& .fk-ag-vorschlag.fk-ag-warn': { borderColor: f.warn, backgroundColor: 'rgba(217,138,0,0.12)' },
                '& .fk-ag-vtext': { flex: '1 1 260px', minWidth: 0, fontSize: '0.9375rem', lineHeight: 1.4 },
                '& .fk-ag-vtext b': { display: 'block' },
                '& .fk-ag-vtext small': { display: 'block', fontSize: '0.8125rem', color: f.blass, marginTop: '2px' },
                '& .fk-ag-vliste': { display: 'flex', flexDirection: 'column', gap: '1px', margin: '2px 0' },
                '& .fk-ag-vknoepfe': { display: 'flex', flexWrap: 'wrap', gap: '8px' },
                '& .fk-ag-haupt, & .fk-ag-neben': {
                    all: 'unset',
                    boxSizing: 'border-box',
                    cursor: 'pointer',
                    fontSize: '0.875rem',
                    fontWeight: 600,
                    lineHeight: 1,
                    padding: '10px 16px',
                    borderRadius: '6px',
                    whiteSpace: 'nowrap',
                },
                '& .fk-ag-haupt': { backgroundColor: f.akzent, color: '#fff', boxShadow: '0 1px 3px rgba(0,0,0,0.3)' },
                '& .fk-ag-haupt:hover': { filter: 'brightness(1.1)' },
                '& .fk-ag-haupt:disabled': { opacity: 0.45, cursor: 'default', filter: 'none' },
                '& .fk-ag-neben': { border: `1px solid ${kante}`, color: f.text },
                '& .fk-ag-neben:hover': { backgroundColor: f.dunkel ? 'rgba(255,255,255,0.09)' : 'rgba(0,0,0,0.06)' },
                '& .fk-ag-nein': { borderWidth: '1.5px' },
                '& .fk-ag-ja': { borderColor: f.akzent, color: f.akzent },
                '& .fk-ag-haupt:focus-visible, & .fk-ag-neben:focus-visible, & .fk-ag-knopf:focus-visible': { outline: `2px solid ${f.akzent}`, outlineOffset: '2px' },
                '& .fk-ag-meldung': {
                    display: 'flex',
                    flexWrap: 'wrap',
                    alignItems: 'center',
                    gap: '8px 12px',
                    padding: '8px 12px',
                    marginBottom: '12px',
                    borderRadius: '8px',
                    border: `1px solid ${f.gut}`,
                    fontSize: '0.9375rem',
                },
                '& .fk-ag-meldung svg': { color: f.gut },
                '& .fk-ag-meldung span': { flex: '1 1 200px' },
                '& .fk-ag-meldung .fk-ag-neben': { padding: '7px 14px' },
                // Vorschlagsmodus: Band ueber die ganze Breite, gerahmte Arbeitsflaeche, Unbeteiligtes tritt zurueck
                '& .fk-ag-band': {
                    display: 'flex',
                    flexWrap: 'wrap',
                    alignItems: 'center',
                    gap: '10px 16px',
                    padding: '12px 16px',
                    borderRadius: '10px 10px 0 0',
                    backgroundColor: f.dunkel ? '#5b2fa8' : '#7a3fd0',
                    color: '#fff',
                },
                '& .fk-ag-band .fk-ag-vtext b': { fontSize: '1.0625rem', letterSpacing: '0.01em' },
                '& .fk-ag-band .fk-ag-vtext small': { color: 'rgba(255,255,255,0.85)' },
                '& .fk-ag-zu': { display: 'inline-flex', alignItems: 'center', gap: '8px', padding: '10px 16px' },
                // der gruene Haken am vorgeschlagenen Aussengeraet: gross genug fuer den Finger
                '& .fk-ag-ok': {
                    all: 'unset',
                    boxSizing: 'border-box',
                    flex: '0 0 auto',
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    width: 56,
                    height: 56,
                    borderRadius: '50%',
                    cursor: 'pointer',
                    color: '#fff',
                    backgroundColor: '#1f9d45',
                    boxShadow: '0 2px 6px rgba(0,0,0,0.4)',
                    transition: 'transform 0.1s, background-color 0.1s',
                },
                '& .fk-ag-ok:hover': { backgroundColor: '#23b84f', transform: 'scale(1.08)' },
                '& .fk-ag-ok:focus-visible': { outline: '3px solid #fff', outlineOffset: '2px', boxShadow: '0 0 0 6px #1f9d45' },
                '& .fk-ag-band .fk-ag-neben': { borderColor: '#fff', color: '#fff', borderWidth: '1.5px' },
                '& .fk-ag-band .fk-ag-neben:hover': { backgroundColor: 'rgba(255,255,255,0.18)' },
                '& .fk-ag-flaeche': { position: 'relative' },
                '& .fk-ag-flaeche.fk-ag-modus': {
                    border: `2px dashed ${f.vorschlag}`,
                    borderTop: 'none',
                    borderRadius: '0 0 10px 10px',
                    padding: '4px 14px 16px',
                    marginBottom: '12px',
                    backgroundColor: f.dunkel ? 'rgba(183,140,255,0.06)' : 'rgba(122,63,208,0.04)',
                },
                '& .fk-ag-buendel': { display: 'flex', flexDirection: 'column', gap: '34px', margin: '16px 0 0', padding: '12px 0 4px 12px', borderLeft: `4px solid var(--fk-v, ${f.vorschlag})` },
                '& .fk-ag-blass': { opacity: 0.4 },
                '& .fk-ag-blass:hover, & .fk-ag-blass:focus-within': { opacity: 1 },
                '& .fk-ag-quelle': { borderColor: `var(--fk-v, ${f.vorschlag})`, borderStyle: 'dashed', borderWidth: '2.5px', position: 'relative' },
                '& .fk-ag-nr': {
                    flex: '0 0 auto',
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    minWidth: 26,
                    height: 22,
                    padding: '0 5px',
                    borderRadius: 11,
                    fontSize: '0.8125rem',
                    fontWeight: 700,
                    color: f.dunkel ? '#111' : '#fff',
                    backgroundColor: `var(--fk-v, ${f.vorschlag})`,
                    opacity: 1,
                },
                '& .fk-ag-nr-quelle': { position: 'absolute', top: 8, right: 10, zIndex: 1, minWidth: 30, height: 26, borderRadius: 13, fontSize: '0.9375rem', boxShadow: '0 1px 3px rgba(0,0,0,0.4)' },
                '& .fk-ag-neumarke': { fontWeight: 700, color: f.dunkel ? '#111' : '#fff', backgroundColor: `var(--fk-v, ${f.vorschlag})`, borderRadius: '4px', padding: '1px 7px', letterSpacing: '0.05em' },
                '& .fk-ag-pfeile': { position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none', overflow: 'visible', zIndex: 2 },
                '& .fk-ag-pfeil': { fill: 'none', strokeWidth: 2.5, strokeDasharray: '7 6', strokeLinecap: 'round' },
                '& .fk-ag-pfeilgriff': { fill: 'none', stroke: 'transparent', strokeWidth: 14, pointerEvents: 'stroke', cursor: 'help' },
                // Abschnitte und Raster
                '& .fk-ag-stitel': { display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: '6px 12px', fontWeight: 600, fontSize: '1rem', margin: '18px 0 8px' },
                '& .fk-ag-stitel:first-of-type': { marginTop: '6px' },
                '& .fk-ag-sunter': { fontSize: '0.8125rem', color: f.blass, fontWeight: 400, marginLeft: '8px' },
                '& .fk-ag-such': { display: 'inline-flex', alignItems: 'center', gap: '6px', padding: '7px 12px', fontSize: '0.8125rem' },
                '& .fk-ag-raster': { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 430px), 540px))', gap: '14px', alignItems: 'start' },
                // Kachel einer Anlage
                '& .fk-ag-anlage': {
                    borderRadius: '12px',
                    border: `1.5px solid ${kante}`,
                    backgroundColor: f.flaeche,
                    boxShadow: f.dunkel ? '0 1px 4px rgba(0,0,0,0.5)' : '0 1px 4px rgba(0,0,0,0.14)',
                    overflow: 'hidden',
                    minWidth: 0,
                    transition: 'border-color 0.12s, background-color 0.12s, box-shadow 0.12s',
                },
                '& .fk-ag-anlage.fk-ag-bereit': { borderStyle: 'dashed', borderColor: f.akzent },
                '& .fk-ag-anlage.fk-ag-ziel': { borderStyle: 'solid', borderColor: f.akzent, boxShadow: `0 0 0 3px ${f.akzent}`, backgroundColor: tonung },
                '& .fk-ag-akopf': { display: 'flex', alignItems: 'center', gap: '12px', padding: '10px 10px 10px 14px', backgroundColor: tonung, color: f.akzent },
                '& .fk-ag-einzel .fk-ag-akopf': { backgroundColor: f.dunkel ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.04)', color: f.blass, padding: '8px 10px 8px 14px' },
                '& .fk-ag-amitte': { flex: '1 1 auto', minWidth: 0, display: 'flex', flexDirection: 'column', gap: '1px', color: f.text },
                '& .fk-ag-art': { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '4px 8px', fontSize: '0.75rem', letterSpacing: '0.04em', textTransform: 'uppercase', color: f.blass },
                '& .fk-ag-name': { display: 'flex', alignItems: 'center', gap: '6px', color: f.blass, cursor: 'text' },
                '& .fk-ag-name input': {
                    all: 'unset',
                    flex: '1 1 auto',
                    minWidth: 0,
                    font: 'inherit',
                    fontWeight: 600,
                    fontSize: '1.0625rem',
                    color: f.text,
                    borderBottom: `1px dashed ${kante}`,
                    padding: '1px 0',
                },
                '& .fk-ag-name input:hover, & .fk-ag-name input:focus': { borderBottom: `1px solid ${f.akzent}` },
                '& .fk-ag-name input::placeholder': { color: f.blass, fontWeight: 400, opacity: 1 },
                '& .fk-ag-werte': { fontSize: '0.9375rem', fontWeight: 600, minHeight: '1.3em' },
                '& .fk-ag-einzel .fk-ag-werte': { fontWeight: 400, fontSize: '0.875rem' },
                '& .fk-ag-dreht .fk-ag-fluegel': { transformOrigin: '28px 25px', animation: 'fk-ag-dreh 2.4s linear infinite' },
                '@keyframes fk-ag-dreh': { to: { transform: 'rotate(360deg)' } },
                // Baum: die Leitung vom Aussengeraet zu seinen Innengeraeten
                '& .fk-ag-baum': { margin: '0 12px 0 clamp(22px, 13%, 60px)', padding: '12px 0 4px 24px', borderLeft: `3px solid ${f.akzent}`, display: 'flex', flexDirection: 'column', gap: '8px' },
                '& .fk-ag-einzel .fk-ag-baum': { marginLeft: 'clamp(22px, 10%, 44px)', borderLeftColor: f.blass, paddingBottom: '10px' },
                '& .fk-ag-ast': { position: 'relative' },
                '& .fk-ag-ast::before': { content: '""', position: 'absolute', left: -24, top: '50%', width: 22, borderTop: `3px solid ${f.akzent}` },
                '& .fk-ag-einzel .fk-ag-ast::before': { borderTopColor: f.blass },
                // die Leitung endet am letzten Ast
                '& .fk-ag-ast:last-child::after': { content: '""', position: 'absolute', left: -27, top: 'calc(50% + 3px)', bottom: -12, width: 3, backgroundColor: f.flaeche },
                '& .fk-ag-leer': { fontSize: '0.8125rem', color: f.blass, padding: '12px 4px', border: `1px dashed ${kante}`, borderRadius: '8px', textAlign: 'center' },
                // kleine Kachel eines Innengeraets
                '& .fk-ag-kachel': {
                    display: 'flex',
                    alignItems: 'center',
                    gap: '8px',
                    minHeight: 52,
                    padding: '4px 6px',
                    borderRadius: '9px',
                    border: `1px solid ${kante}`,
                    backgroundColor: f.dunkel ? 'rgba(255,255,255,0.07)' : '#fff',
                    boxShadow: f.dunkel ? '0 1px 2px rgba(0,0,0,0.5)' : '0 1px 2px rgba(0,0,0,0.14)',
                    cursor: 'grab',
                    touchAction: 'none',
                    userSelect: 'none',
                },
                '& .fk-ag-kachel:hover': { borderColor: f.akzent },
                '& .fk-ag-kachel:hover .fk-ag-griff': { color: f.akzent },
                '& .fk-ag-gezogen': { opacity: 0.35 },
                '&.fk-ag-zieht, &.fk-ag-zieht .fk-ag-kachel': { cursor: 'grabbing' },
                '& .fk-ag-griff': { color: f.blass },
                '& .fk-ag-farbe': { width: 6, alignSelf: 'stretch', borderRadius: 3, flex: '0 0 auto' },
                '& .fk-ag-ktext': { flex: '1 1 auto', minWidth: 0, display: 'flex', flexDirection: 'column' },
                // der Raumname bricht um, statt abgeschnitten zu werden (schmale Fenster, Handy)
                '& .fk-ag-kname': { fontWeight: 600, fontSize: '0.9375rem', lineHeight: 1.25, overflowWrap: 'anywhere' },
                '& .fk-ag-kunter': { fontSize: '0.8125rem', lineHeight: 1.3, color: f.blass, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
                '& .fk-ag-proz': { display: 'flex', flexDirection: 'column', alignItems: 'flex-end', whiteSpace: 'nowrap', lineHeight: 1.25 },
                '& .fk-ag-proz b': { fontSize: '0.9375rem' },
                '& .fk-ag-proz small': { fontSize: '0.75rem', color: f.blass },
                '& .fk-ag-knopf': {
                    all: 'unset',
                    boxSizing: 'border-box',
                    flex: '0 0 auto',
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    width: 36,
                    height: 36,
                    borderRadius: '50%',
                    cursor: 'pointer',
                    color: f.blass,
                },
                '& .fk-ag-knopf:hover': { backgroundColor: f.dunkel ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.08)', color: f.text },
                '& .fk-ag-knopf:disabled': { opacity: 0.3, cursor: 'default' },
                '& .fk-ag-menue': { border: `1px solid ${kante}`, width: 32, height: 32 },
                '& .fk-ag-klein': { width: 28, height: 28, border: `1px solid ${kante}` },
                // Fuss der Multisplit-Kachel
                '& .fk-ag-afuss': { padding: '8px 12px 10px 14px' },
                '& .fk-ag-pruef': { display: 'flex', alignItems: 'center', gap: '6px', fontSize: '0.8125rem', marginBottom: '8px' },
                '& .fk-ag-bestaetigt': { color: f.gut },
                '& .fk-ag-widerspricht': { color: f.warn },
                '& .fk-ag-balken': { display: 'flex', height: 10, borderRadius: 5, overflow: 'hidden', backgroundColor: f.dunkel ? '#69737e' : '#a9b1ba' },
                '& .fk-ag-balken span': { display: 'block', height: '100%' },
                '& .fk-ag-fuss': { display: 'flex', flexWrap: 'wrap', gap: '2px 16px', fontSize: '0.8125rem', color: f.blass, marginTop: '4px', minHeight: '1.2em' },
                '& .fk-ag-restzeile': { display: 'inline-flex', alignItems: 'center', gap: '5px' },
                '& .fk-ag-restfarbe': { flex: '0 0 auto', width: 10, height: 10, borderRadius: 2, backgroundColor: f.dunkel ? '#69737e' : '#a9b1ba' },
                '& .fk-ag-weitere': {
                    display: 'flex',
                    flexWrap: 'wrap',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: '4px 10px',
                    marginTop: '8px',
                    paddingTop: '6px',
                    borderTop: `1px solid ${f.linie}`,
                    fontSize: '0.8125rem',
                    color: f.blass,
                },
                '& .fk-ag-grenze': { display: 'flex', alignItems: 'center', gap: '6px', fontSize: '0.875rem', marginTop: '8px' },
                '& .fk-ag-grenze svg': { color: f.akzent },
                '& .fk-ag-fort': { marginTop: '8px', paddingTop: '6px', borderTop: `1px solid ${f.linie}`, fontSize: '0.8125rem', color: f.blass },
                '& .fk-ag-fort summary': { display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer', listStyle: 'none', fontWeight: 600 },
                '& .fk-ag-fort summary::-webkit-details-marker': { display: 'none' },
                '& .fk-ag-fort summary svg': { transition: 'transform 0.15s' },
                '& .fk-ag-fort[open] summary svg': { transform: 'rotate(180deg)' },
                '& .fk-ag-fort label': { display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: '4px 10px', marginTop: '8px' },
                '& .fk-ag-fort input': {
                    all: 'unset',
                    boxSizing: 'border-box',
                    width: '15em',
                    maxWidth: '100%',
                    padding: '6px 8px',
                    borderRadius: '6px',
                    border: `1px solid ${kante}`,
                    color: f.text,
                    font: 'inherit',
                },
                '& .fk-ag-fort input:focus': { borderColor: f.akzent },
                '& .fk-ag-zaehler': { display: 'inline-flex', alignItems: 'center', gap: '8px', color: f.text },
                // Vorschlag als Kachel: gestrichelt, halb durchsichtig
                '& .fk-ag-vkachel': { borderStyle: 'dashed', borderWidth: '2.5px', borderColor: `var(--fk-v, ${f.vorschlag})`, boxShadow: 'none', backgroundColor: f.flaeche },
                '& .fk-ag-vkachel .fk-ag-akopf': { backgroundColor: 'transparent', color: `var(--fk-v, ${f.vorschlag})` },
                '& .fk-ag-vkachel .fk-ag-abild, & .fk-ag-vkachel .fk-ag-vkname': { opacity: 0.75 },
                '& .fk-ag-vkachel .fk-ag-baum': { borderLeftStyle: 'dashed', borderLeftColor: `var(--fk-v, ${f.vorschlag})`, paddingBottom: '12px' },
                '& .fk-ag-vkachel .fk-ag-ast::before': { borderTopStyle: 'dashed', borderTopColor: `var(--fk-v, ${f.vorschlag})` },
                '& .fk-ag-vkachel .fk-ag-ast:last-child::after': { display: 'none' },
                '& .fk-ag-vkname': { fontWeight: 600, fontSize: '1.0625rem' },
                '& .fk-ag-stufe': { fontSize: '0.75rem', fontWeight: 600, lineHeight: 1.5, padding: '0 8px', borderRadius: '10px', border: '1.5px solid', color: f.gut, cursor: 'help', textTransform: 'none', letterSpacing: 0 },
                '& .fk-ag-stufe-pruefung .fk-ag-stufe': { color: f.blass },
                '& .fk-ag-stufe-unsicher .fk-ag-stufe': { color: f.warn },
                '& .fk-ag-vinnen': { display: 'flex', alignItems: 'center', gap: '8px', minHeight: 40, padding: '4px 10px', borderRadius: '9px', border: `1px dashed ${kante}`, fontWeight: 600, fontSize: '0.9375rem' },
                '& .fk-ag-neu': {
                    display: 'flex',
                    alignItems: 'center',
                    gap: '12px',
                    padding: '14px',
                    minHeight: 76,
                    borderStyle: 'dashed',
                    borderWidth: '2px',
                    boxShadow: 'none',
                    backgroundColor: 'transparent',
                    color: f.blass,
                },
                '& .fk-ag-neu b': { display: 'block', color: f.text, fontSize: '0.9375rem' },
                '& .fk-ag-neu span': { fontSize: '0.8125rem' },
                '@media (prefers-reduced-motion: reduce)': { '& .fk-ag-anlage': { transition: 'none' }, '& .fk-ag-dreht .fk-ag-fluegel': { animation: 'none' } },
            }}
        >
            <p className="fk-ag-erkl">{t('erklaerung')}</p>
            <p className="fk-ag-wie">{t('ziehHinweis')}</p>
            {modus ? (
                <div
                    className="fk-ag-band"
                    data-vorschlag="offen"
                    role="status"
                >
                    <Zeichen
                        d={SYMBOL.idee}
                        groesse={30}
                    />
                    <span className="fk-ag-vtext">
                        <b>{t('modusBanner')}</b>
                        <span className="fk-ag-vliste">
                            {offeneVorschlaege.map((v, n) => (
                                <span key={v.schluessel}>{vorschlagZeile(v, n)}</span>
                            ))}
                        </span>
                    </span>
                    <button
                        type="button"
                        className="fk-ag-neben fk-ag-zu"
                        title={t('schliessenTipp')}
                        onClick={() => ablehnen(offeneVorschlaege)}
                    >
                        <Zeichen
                            d={SYMBOL.weg}
                            groesse={20}
                            dick={2.4}
                        />
                        {t('schliessen')}
                    </button>
                </div>
            ) : null}
            {vorschlaege
                .filter(v => v.art === 'widerspruch')
                .map(v => (
                    <div
                        key={v.schluessel}
                        className="fk-ag-vorschlag fk-ag-warn"
                        data-vorschlag="widerspruch"
                    >
                        <Zeichen
                            d={SYMBOL.warn}
                            groesse={28}
                            stil={{ color: f.warn }}
                        />
                        <span className="fk-ag-vtext">{t('vorschlagWiderspruch', aufzaehlung(v.ids.map(nameVon), t('und')))}</span>
                    </div>
                ))}
            {meldung ? (
                <div
                    className="fk-ag-meldung"
                    role="status"
                >
                    <Zeichen
                        d={SYMBOL.haken}
                        groesse={20}
                        dick={2.2}
                    />
                    <span>{meldung.text}</span>
                    <button
                        type="button"
                        className="fk-ag-neben"
                        onClick={() => {
                            props.onListe(meldung.vorher);
                            setMeldung(null);
                        }}
                    >
                        {t('rueckgaengig')}
                    </button>
                </div>
            ) : null}
            {gesucht && props.alive && stand && !vorschlaege.length && !props.abgelehnt.length ? <p className="fk-ag-hinweis fk-ag-nichts">{t('nichtsErkannt')}</p> : null}
            {!props.alive ? <p className="fk-ag-hinweis">{t('nichtAktiv')}</p> : null}
            {props.alive && stand && !geraete.length ? <p className="fk-ag-hinweis">{t('keineGeraete')}</p> : null}

            <div
                className={`fk-ag-flaeche${modus ? ' fk-ag-modus' : ''}`}
                ref={flaeche}
            >
            <div className="fk-ag-stitel">
                <span>
                    {t('titel')}
                    {!hatMulti && !offeneVorschlaege.length ? <span className="fk-ag-sunter">{t('keinMulti')}</span> : null}
                </span>
                {props.alive ? (
                    <button
                        type="button"
                        className="fk-ag-neben fk-ag-such"
                        title={t('vorschlagenTipp')}
                        onClick={vorschlagen}
                    >
                        <Zeichen
                            d={SYMBOL.idee}
                            groesse={18}
                        />
                        {t('vorschlagen')}
                    </button>
                ) : null}
            </div>
            <div className="fk-ag-raster">
                {liste.map(multiKachel)}
                <div
                    className={`fk-ag-anlage fk-ag-neu ${zoneKlasse('neu')}${modus ? ' fk-ag-blass' : ''}`}
                    data-fk-zone="neu"
                >
                    <AussenBild breite={56} />
                    <div>
                        <b>{t('neu')}</b>
                        <span>{t('neuUnter')}</span>
                    </div>
                </div>
            </div>

            {/* Je Vorschlag ein Buendel: oben die vorgeschlagene Kachel, direkt darunter die einzelnen Anlagen, die dorthin
                wandern wuerden - so bleiben die Pfeile kurz und die Gruppen kreuzen sich nicht. Die Anlagen stehen in
                umgekehrter Reihenfolge der Plaetze: die erste (gerade darunter) gehoert zum untersten Platz, die weiter
                rechts stehenden zu den oberen - dann kreuzen sich auch die Pfeile einer Gruppe nicht. */}
            {offeneVorschlaege.map((v, n) => (
                <div
                    className="fk-ag-buendel"
                    key={v.schluessel}
                    style={vStil(vFarbe(n))}
                >
                    <div className="fk-ag-raster">{vorschlagKachel(v, n)}</div>
                    <div className="fk-ag-raster">
                        {[...(v.art === 'dazu' ? v.neu : v.ids)]
                            .reverse()
                            .map(id => vonId.get(id))
                            .filter((g): g is GeraetStand => !!g && !zugeordnet.has(g.id))
                            .map(einzelKachel)}
                    </div>
                </div>
            ))}
            {frei.some(g => !quellen.has(g.id)) ? (
                <>
                    <div className="fk-ag-stitel">
                        <span>
                            {t('einzeln')}
                            <span className="fk-ag-sunter">{t('einzelnUnter')}</span>
                        </span>
                    </div>
                    <div className="fk-ag-raster">{frei.filter(g => !quellen.has(g.id)).map(einzelKachel)}</div>
                </>
            ) : null}
            {pfeile.length ? (
                <svg
                    className="fk-ag-pfeile"
                    aria-hidden="true"
                >
                    {pfeile.map((p, k) => (
                        <g
                            key={p.id}
                            style={{ color: p.farbe }}
                        >
                            <marker
                                id={`fk-ag-spitze-${k}`}
                                viewBox="0 0 10 10"
                                refX="8"
                                refY="5"
                                markerWidth="6"
                                markerHeight="6"
                                orient="auto-start-reverse"
                            >
                                <path
                                    d="M0 0L10 5L0 10z"
                                    fill={p.farbe}
                                />
                            </marker>
                            <path
                                d={p.d}
                                className="fk-ag-pfeil"
                                stroke={p.farbe}
                                markerEnd={`url(#fk-ag-spitze-${k})`}
                            />
                            <path
                                d={p.d}
                                className="fk-ag-pfeilgriff"
                            >
                                <title>{p.titel}</title>
                            </path>
                        </g>
                    ))}
                </svg>
            ) : null}
            </div>
            {geaendert ? <p className="fk-ag-hinweis">{t('speichern')}</p> : null}

            {zug?.aktiv ? (
                <div
                    className="fk-ag-schatten"
                    style={{
                        position: 'fixed',
                        left: zug.x + 10,
                        top: zug.y + 8,
                        zIndex: 3000,
                        pointerEvents: 'none',
                        padding: '8px 14px',
                        borderRadius: 8,
                        fontWeight: 600,
                        fontSize: '0.9375rem',
                        color: '#fff',
                        background: f.akzent,
                        boxShadow: '0 6px 18px rgba(0,0,0,0.4)',
                        whiteSpace: 'nowrap',
                    }}
                >
                    {loestGerade ? `${zug.name} → ${t('loesen')}` : zug.name}
                </div>
            ) : null}
            <Menu
                anchorEl={menue?.anker || null}
                open={!!menue}
                onClose={() => setMenue(null)}
            >
                {liste.map((a, n) => (
                    <MenuItem
                        key={a.id}
                        disabled={!!menue && zugeordnet.get(menue.id) === a.id}
                        onClick={() => {
                            if (menue) {
                                fallen(menue.id, a.id);
                            }
                            setMenue(null);
                        }}
                    >
                        {aussenName(a, n)}
                    </MenuItem>
                ))}
                <MenuItem
                    onClick={() => {
                        if (menue) {
                            fallen(menue.id, 'neu');
                        }
                        setMenue(null);
                    }}
                >
                    {`+ ${t('neu')}`}
                </MenuItem>
                {menue && zugeordnet.has(menue.id) ? (
                    <MenuItem
                        onClick={() => {
                            fallen(menue.id, null);
                            setMenue(null);
                        }}
                    >
                        {t('loesen')}
                    </MenuItem>
                ) : null}
            </Menu>
        </Box>
    );
}

interface Zustand extends ConfigGenericState {
    stand: Stand | null;
}

class Aussengeraete extends ConfigGeneric<ConfigGenericProps, Zustand> {
    private lebt = false;
    private takt: ReturnType<typeof setInterval> | null = null;

    async componentDidMount(): Promise<void> {
        await super.componentDidMount();
        this.lebt = true;
        this.laden();
        this.takt = setInterval(() => this.laden(), 20000);
    }

    componentWillUnmount(): void {
        this.lebt = false;
        if (this.takt) {
            clearInterval(this.takt);
        }
    }

    componentDidUpdate(vorher: ConfigGenericProps): void {
        const d = (this.props.data || {}) as Record<string, unknown>;
        const v = (vorher.data || {}) as Record<string, unknown>;
        if (d.aussengeraete !== v.aussengeraete || d.aussengeraeteAbgelehnt !== v.aussengeraeteAbgelehnt || this.props.alive !== vorher.alive) {
            this.laden();
        }
    }

    liste(): Aussen[] {
        const d = (this.props.data || {}) as Record<string, unknown>;
        return (Array.isArray(d.aussengeraete) ? d.aussengeraete : [])
            .filter((a: unknown) => a && typeof a === 'object')
            .map((a: any) => ({
                // unbekannte Felder (z. B. vortagReferenzW der Gruppenregelung) bleiben erhalten
                ...a,
                id: String(a.id || ''),
                name: String(a.name || ''),
                weitere: Number(a.weitere) || 0,
                innen: (Array.isArray(a.innen) ? a.innen : []).filter((i: any) => i && typeof i.geraet === 'string').map((i: any) => ({ geraet: i.geraet, modulId: i.modulId || null })),
            }));
    }

    abgelehnt(): string[] {
        const d = (this.props.data || {}) as Record<string, unknown>;
        return (Array.isArray(d.aussengeraeteAbgelehnt) ? d.aussengeraeteAbgelehnt : []).filter((s: unknown) => typeof s === 'string');
    }

    laden(): void {
        const socket = this.props.oContext?.socket;
        if (!this.props.alive || !socket || typeof socket.sendTo !== 'function') {
            return;
        }
        const ziel = `${this.props.oContext?.adapterName}.${this.props.oContext?.instance}`;
        Promise.resolve(socket.sendTo(ziel, 'verbundStand', { aussengeraete: this.liste(), abgelehnt: this.abgelehnt() }))
            .then((antwort: unknown) => {
                const a = antwort as Stand | null;
                if (this.lebt && a && Array.isArray(a.geraete)) {
                    this.setState({ stand: a });
                }
            })
            .catch(() => undefined);
    }

    renderItem(): React.JSX.Element {
        const palette = this.props.oContext?.theme?.palette;
        const dunkel = (this.props.oContext?.themeType || palette?.mode) === 'dark';
        const f: Farben = {
            text: palette?.text?.primary || (dunkel ? '#fff' : '#222'),
            blass: palette?.text?.secondary || (dunkel ? '#b0b0b0' : '#666'),
            linie: palette?.divider || (dunkel ? '#555' : '#d0d0d0'),
            flaeche: palette?.background?.paper || (dunkel ? '#1e1e1e' : '#fff'),
            karte: dunkel ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.025)',
            akzent: palette?.primary?.main || '#3399cc',
            gut: dunkel ? '#5cc46f' : '#2e7d3e',
            warn: dunkel ? '#f0b04a' : '#a86a00',
            vorschlag: dunkel ? '#b78cff' : '#7a3fd0',
            dunkel,
        };
        const liste = this.liste();
        const stand = this.props.alive ? this.state.stand || null : null;
        return (
            <AussengeraeteAnsicht
                liste={liste}
                abgelehnt={this.abgelehnt()}
                stand={stand}
                sprache={I18n.getLanguage()}
                f={f}
                alive={!!this.props.alive}
                onNeu={() => this.laden()}
                onListe={neu => void this.onChange('aussengeraete', neu)}
                onAbgelehnt={neu => void this.onChange('aussengeraeteAbgelehnt', neu)}
            />
        );
    }
}

export default Aussengeraete;
