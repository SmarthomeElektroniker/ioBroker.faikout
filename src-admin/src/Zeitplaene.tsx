/*
 * Reiter "Zeitplaene": die Wochenplaene aller Geraete auf einen Blick - je Geraet eine Zeile mit
 * Wochenvorschau, Status, Schalter und dem Knopf "Wochenplan bearbeiten". Der Editor selbst ist die
 * vorhandene Seite admin/wochenplan.html; sie laeuft hier als iframe in einem eigenen Dialog.
 *
 * Zwei Wege, zwei Wirkungen - das steht sichtbar oben:
 *   - Wochenplan eines Geraets: Datenpunkt regulation.schedule.weekJson, wirkt SOFORT (sendTo).
 *   - Vorlage (regelPlanVorlage): Formularwert, gilt erst mit "Speichern" der Instanz (onChange).
 *
 * Format eines Plans (weekJson): sieben Tage Mo..So, je Tag Schaltpunkte {t: Minute, s: Stufen-ID};
 * was vor dem ersten Punkt eines Tages gilt, kommt vom letzten Punkt davor (ueber So -> Mo hinweg).
 */
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
    Box,
    Button,
    CircularProgress,
    Dialog,
    DialogActions,
    DialogContent,
    DialogTitle,
    FormControlLabel,
    Switch,
    Tooltip,
    Typography,
    useMediaQuery,
} from '@mui/material';
import { I18n } from '@iobroker/gui-components';
import { ConfigGeneric, type ConfigGenericProps, type ConfigGenericState } from '@iobroker/json-config';

import Werkzeugleiste from './Werkzeugleiste';
import { text as uebersetzt, TEXTE, type Schluessel } from './Zeitplaene.texte';

export interface Stufe {
    id: string;
    name: string;
    /** Balkenfarbe; optional getrennt fuer hell/dunkel */
    farbe?: string | { hell?: string; dunkel?: string };
    farbeDunkel?: string;
    soll?: number;
    power?: boolean;
    mode?: string;
    fan?: string;
    deckel?: number;
    /** steht im Formular, ist aber noch nicht gespeichert */
    neu?: boolean;
}
export interface Balken {
    von: number;
    bis: number;
    stufe: string;
}
export interface PlanGeraet {
    id: string;
    name: string;
    individuell?: boolean;
    /** woher die Temperaturstufen dieser Anlage stammen: eigene (individuell) oder die der Vorlage */
    stufenQuelle?: 'vorlage' | 'eigen';
    /** entfernte Stufen, die der Adapter beim "Speichern" der Instanz im Plan ersetzt */
    ersatz?: { von: string; nach: string; vonName?: string; nachName?: string }[];
    planAktiv: boolean;
    planFehlt: boolean;
    /** Plan hinterlegt, aber nicht lesbar: Klartext des Adapters */
    planFehler?: string;
    naechster: number | null;
    naechsteStufe: string;
    naechsteStufeName?: string;
    stufe: string;
    stufeName?: string;
    woche: Balken[][];
}
export interface PlanListe {
    sprache?: string;
    stufen?: Record<string, Stufe[]>;
    geraete: PlanGeraet[];
    /** Werksplan mit den Stufen der Vorlage, vom Adapter gerechnet */
    werksplan?: { week?: string; woche?: Balken[][] };
}
/** Befehl an den Adapter; lehnt mit Error(Text) ab bei {error}, fehlender Antwort oder Zeitablauf. */
export type Senden = (befehl: string, nachricht: Record<string, unknown>) => Promise<any>;

const TAG = 1440;
const ABFRAGE_MS = 30000;
/** Takt, solange noch kein Geraet in der Liste steht (Adapter gerade gestartet) */
const ABFRAGE_LEER_MS = 3000;
const ANTWORT_MS = 15000;

/** Farben des Editors (lib/oberflaeche.js SZENEN_FARBEN): hell -> dunkel, fuer das dunkle Thema. */
const HELL_ZU_DUNKEL: Record<string, string> = {
    '#a3492f': '#d4896b',
    '#4a7350': '#8fb391',
    '#3e5c8a': '#8ea6cf',
    '#6b6b6b': '#a0a0a0',
    '#7a4a8c': '#c09ad0',
    '#2f7a7a': '#7fc4c4',
    '#8a6a1f': '#d3b56a',
    '#8c2336': '#dd8fa0',
    '#55687a': '#9eacb9',
};
/** Werksstufen - nur fuer die Vorschau der Vorlage, solange der Adapter nicht antwortet. */
const WERK_STUFEN: Stufe[] = [
    { id: 'komfort', name: 'Komfort', farbe: '#a3492f', soll: 21, power: true },
    { id: 'absenken', name: 'Absenken', farbe: '#4a7350', soll: 19, power: true },
    { id: 'abwesend', name: 'Abwesend', farbe: '#3e5c8a', soll: 17, power: true },
    { id: 'aus', name: 'Aus', farbe: '#6b6b6b', soll: 17, power: false },
];
const OHNE_FARBE = '#8a8a8a';
/** Kennung der Vorlage in den sendTo-Befehlen (lib/zeitplaene.js VORLAGE) */
const VORLAGE = 'vorlage';

type Punkt = { t: number; s: string };
type Plan = Punkt[][];

/** Liest einen Plan (JSON-Text oder Liste); null, wenn es kein Wochenplan ist. Leere Plaene gelten nicht. */
export function planLesen(roh: unknown): Plan | null {
    let p = roh;
    if (typeof roh === 'string') {
        if (!roh.trim()) {
            return null;
        }
        try {
            p = JSON.parse(roh);
        } catch {
            return null;
        }
    }
    if (!Array.isArray(p) || p.length !== 7) {
        return null;
    }
    const plan: Plan = [];
    for (const tag of p) {
        if (!Array.isArray(tag)) {
            return null;
        }
        const punkte: Punkt[] = [];
        for (const e of tag) {
            const t = Math.round(Number(e && e.t));
            const s = String((e && e.s) || '');
            if (!Number.isFinite(t) || t < 0 || t >= TAG || !s) {
                return null;
            }
            punkte.push({ t, s });
        }
        punkte.sort((a, b) => a.t - b.t);
        plan.push(punkte.filter((e, i) => i === punkte.length - 1 || punkte[i + 1].t !== e.t));
    }
    return plan.some(tag => tag.length) ? plan : null;
}

/** Plan -> Balken je Tag (fuer die Vorschau). */
export function planZuWoche(plan: Plan): Balken[][] {
    let gilt = '';
    for (let d = 6; d >= 0 && !gilt; d--) {
        if (plan[d].length) {
            gilt = plan[d][plan[d].length - 1].s;
        }
    }
    return plan.map(tag => {
        const balken: Balken[] = [];
        let von = 0;
        for (const p of tag) {
            if (p.t > von) {
                balken.push({ von, bis: p.t, stufe: gilt });
            }
            von = p.t;
            gilt = p.s;
        }
        balken.push({ von, bis: TAG, stufe: gilt });
        return balken;
    });
}

/** Balken -> Plantext (Rueckfall fuer "Kopieren", bis wochenplanKopie geantwortet hat). */
export function wocheZuText(woche: Balken[][]): string {
    return JSON.stringify(
        [0, 1, 2, 3, 4, 5, 6].map(d =>
            (Array.isArray(woche[d]) ? woche[d] : []).map(b => ({ t: Math.max(0, Math.min(TAG - 1, b.von)), s: b.stufe })),
        ),
    );
}

/** Werksplan wie wochenplan.vorgabePlan (lib/regel/wochenplan.js): werktags morgens und abends, am Wochenende tagsueber. */
export function werksplan(stufen: Stufe[]): Plan {
    const ids = stufen.map(s => s.id);
    const k = ids.includes('komfort') ? 'komfort' : ids[0] || 'komfort';
    const a = ids.includes('absenken') ? 'absenken' : ids[Math.min(1, ids.length - 1)] || 'absenken';
    const wt = (): Punkt[] => [
        { t: 0, s: a },
        { t: 360, s: k },
        { t: 510, s: a },
        { t: 990, s: k },
        { t: 1320, s: a },
    ];
    const we = (): Punkt[] => [
        { t: 0, s: a },
        { t: 450, s: k },
        { t: 1380, s: a },
    ];
    return [wt(), wt(), wt(), wt(), wt(), we(), we()];
}

const hhmm = (m: number): string => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

function tagName(d: number, sprache: string, stil: 'short' | 'long' = 'short'): string {
    try {
        // der 1.1.2024 war ein Montag
        return new Intl.DateTimeFormat(sprache, { weekday: stil }).format(new Date(2024, 0, 1 + d));
    } catch {
        return ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'][d];
    }
}

function farbeVon(stufe: Stufe | undefined, dunkel: boolean): string {
    if (!stufe || !stufe.farbe) {
        return OHNE_FARBE;
    }
    if (typeof stufe.farbe === 'object') {
        return (dunkel ? stufe.farbe.dunkel : stufe.farbe.hell) || stufe.farbe.hell || stufe.farbe.dunkel || OHNE_FARBE;
    }
    if (dunkel) {
        return stufe.farbeDunkel || HELL_ZU_DUNKEL[stufe.farbe.toLowerCase()] || stufe.farbe;
    }
    return stufe.farbe;
}

function stufenText(stufe: Stufe | undefined, id: string, sprache: string, name = ''): string {
    if (!stufe) {
        return name || id;
    }
    if (stufe.power === false || !Number.isFinite(Number(stufe.soll))) {
        return stufe.name || id;
    }
    let grad = String(stufe.soll);
    try {
        grad = Number(stufe.soll).toLocaleString(sprache, { maximumFractionDigits: 1 });
    } catch {
        // unbekannte Sprache
    }
    return `${stufe.name || id} ${grad} °C`;
}

/** "heute 16:30", "morgen 06:00", "Sa 07:30" */
function zeitText(ms: number, sprache: string, tx: (s: Schluessel, ...w: (string | number)[]) => string): string {
    const d = new Date(ms);
    const heute = new Date();
    const tage = Math.round(
        (new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() -
            new Date(heute.getFullYear(), heute.getMonth(), heute.getDate()).getTime()) /
            86400000,
    );
    const uhr = hhmm(d.getHours() * 60 + d.getMinutes());
    const tag = tage === 0 ? tx('heute') : tage === 1 ? tx('morgen') : tagName((d.getDay() + 6) % 7, sprache);
    return `${tag} ${uhr}`;
}

/** Die Woche als sieben schmale Zeilen mit farbigen Balken, Zeitachse, Legende und "jetzt"-Marke. */
export function Wochenvorschau(props: {
    woche: Balken[][] | null;
    stufen: Stufe[];
    dunkel: boolean;
    sprache: string;
    name: string;
    /** Marke "jetzt" zeigen (nicht bei der Vorlage) */
    mitJetzt: boolean;
    jetzt: Date;
    /** Legende mit allen Stufen der Liste, nicht nur den im Plan benutzten (eigene Stufen einer Anlage) */
    alleStufen?: boolean;
}): React.JSX.Element {
    const { sprache, dunkel } = props;
    const tx = (s: Schluessel, ...w: (string | number)[]): string => uebersetzt(sprache, s, ...w);
    const nach = useMemo(() => new Map(props.stufen.map(s => [s.id, s])), [props.stufen]);
    const heute = (props.jetzt.getDay() + 6) % 7;
    const minute = props.jetzt.getHours() * 60 + props.jetzt.getMinutes();
    const woche = props.woche;
    const benutzt: string[] = [];
    for (const tag of woche || []) {
        for (const b of Array.isArray(tag) ? tag : []) {
            if (!benutzt.includes(b.stufe)) {
                benutzt.push(b.stufe);
            }
        }
    }
    // Legende in der Reihenfolge der Stufen, unbekannte IDs hinten
    const legende = [
        ...props.stufen.map(s => s.id).filter(id => props.alleStufen || benutzt.includes(id)),
        ...benutzt.filter(id => !nach.has(id)),
    ];
    return (
        <Box
            className="fk-zp-vorschau"
            role="img"
            aria-label={tx('vorschau', props.name)}
            sx={{ minWidth: 0 }}
        >
            {[0, 1, 2, 3, 4, 5, 6].map(d => (
                <Box
                    key={d}
                    className={`fk-zp-tag${props.mitJetzt && d === heute ? ' fk-zp-heute' : ''}`}
                    sx={{ display: 'flex', alignItems: 'center', gap: '6px', height: 12 }}
                >
                    <Box
                        component="span"
                        sx={{
                            width: 24,
                            flex: '0 0 24px',
                            fontSize: 10.5,
                            lineHeight: 1,
                            color: props.mitJetzt && d === heute ? 'text.primary' : 'text.secondary',
                            fontWeight: props.mitJetzt && d === heute ? 700 : 400,
                            whiteSpace: 'nowrap',
                            overflow: 'hidden',
                        }}
                    >
                        {tagName(d, sprache)}
                    </Box>
                    <Box
                        className="fk-zp-spur"
                        sx={{
                            position: 'relative',
                            flex: '1 1 auto',
                            height: 9,
                            borderRadius: '2px',
                            bgcolor: 'action.hover',
                            border: woche ? 'none' : '1px dashed',
                            borderColor: 'divider',
                            boxSizing: 'border-box',
                        }}
                    >
                        {(woche && Array.isArray(woche[d]) ? woche[d] : []).map((b, i) => (
                            <Box
                                key={i}
                                className="fk-zp-balken"
                                data-stufe={b.stufe}
                                title={`${tagName(d, sprache, 'long')} ${hhmm(b.von)}–${b.bis >= TAG ? '24:00' : hhmm(b.bis)} · ${stufenText(nach.get(b.stufe), b.stufe, sprache)}`}
                                sx={{
                                    position: 'absolute',
                                    top: 0,
                                    bottom: 0,
                                    left: `${(b.von / TAG) * 100}%`,
                                    width: `${(Math.max(0, b.bis - b.von) / TAG) * 100}%`,
                                    bgcolor: farbeVon(nach.get(b.stufe), dunkel),
                                    borderLeft: i ? '1px solid' : 'none',
                                    borderColor: 'background.paper',
                                    boxSizing: 'border-box',
                                    '&:first-of-type': { borderRadius: '2px 0 0 2px' },
                                    '&:last-of-type': { borderRadius: '0 2px 2px 0' },
                                }}
                            />
                        ))}
                        {props.mitJetzt && woche && d === heute ? (
                            <Box
                                className="fk-zp-jetzt"
                                title={`${tx('jetzt')} ${hhmm(minute)}`}
                                sx={{
                                    position: 'absolute',
                                    top: -3,
                                    bottom: -3,
                                    left: `calc(${(minute / TAG) * 100}% - 1px)`,
                                    width: '2px',
                                    bgcolor: 'text.primary',
                                    boxShadow: theme => `0 0 0 1px ${theme.palette.background.paper}`,
                                    borderRadius: '1px',
                                    pointerEvents: 'none',
                                }}
                            />
                        ) : null}
                    </Box>
                </Box>
            ))}
            <Box
                aria-hidden="true"
                sx={{
                    position: 'relative',
                    ml: '30px',
                    height: 13,
                    fontSize: 10,
                    color: 'text.secondary',
                }}
            >
                {[0, 6, 12, 18, 24].map(h => (
                    <Box
                        key={h}
                        component="span"
                        sx={{
                            position: 'absolute',
                            top: 2,
                            left: `${(h / 24) * 100}%`,
                            transform: h === 0 ? 'none' : h === 24 ? 'translateX(-100%)' : 'translateX(-50%)',
                            lineHeight: 1,
                        }}
                    >
                        {h}
                    </Box>
                ))}
            </Box>
            {woche ? (
                <Box
                    className="fk-zp-legende"
                    sx={{ display: 'flex', flexWrap: 'wrap', columnGap: 1.5, rowGap: 0.25, mt: 0.5, fontSize: 12, color: 'text.secondary' }}
                >
                    {legende.map(id => (
                        <Box
                            key={id}
                            component="span"
                            className="fk-zp-legende-stufe"
                            data-stufe={id}
                            sx={{ display: 'inline-flex', alignItems: 'center', gap: '5px', whiteSpace: 'nowrap' }}
                        >
                            <Box
                                component="span"
                                sx={{ width: 10, height: 10, borderRadius: '2px', bgcolor: farbeVon(nach.get(id), dunkel) }}
                            />
                            {stufenText(nach.get(id), id, sprache)}
                        </Box>
                    ))}
                    {props.mitJetzt ? (
                        <Box
                            component="span"
                            sx={{ display: 'inline-flex', alignItems: 'center', gap: '5px', whiteSpace: 'nowrap' }}
                        >
                            <Box
                                component="span"
                                sx={{ width: '2px', height: 12, bgcolor: 'text.primary', borderRadius: '1px' }}
                            />
                            {tx('jetzt')}
                        </Box>
                    ) : null}
                </Box>
            ) : null}
        </Box>
    );
}

/** Kasten fuer Hinweise und Fehler - nie leer lassen, immer sagen, was los ist. */
function Meldung(props: {
    art: 'info' | 'fehler' | 'neutral';
    klasse: string;
    children: React.ReactNode;
    knopf?: { text: string; onClick: () => void };
}): React.JSX.Element {
    const farbe = props.art === 'fehler' ? 'error.main' : props.art === 'info' ? 'info.main' : 'divider';
    return (
        <Box
            className={props.klasse}
            role={props.art === 'fehler' ? 'alert' : 'note'}
            sx={{
                display: 'flex',
                alignItems: 'center',
                flexWrap: 'wrap',
                gap: 1,
                px: 1.5,
                py: 1,
                borderRadius: '6px',
                border: '1px solid',
                borderColor: farbe,
                borderLeftWidth: 4,
                color: props.art === 'fehler' ? 'error.main' : 'text.primary',
                fontSize: '0.92em',
                lineHeight: 1.4,
            }}
        >
            <Box sx={{ flex: '1 1 240px', minWidth: 0, overflowWrap: 'anywhere' }}>{props.children}</Box>
            {props.knopf ? (
                <Button
                    size="small"
                    variant="outlined"
                    color={props.art === 'fehler' ? 'error' : 'primary'}
                    onClick={props.knopf.onClick}
                >
                    {props.knopf.text}
                </Button>
            ) : null}
        </Box>
    );
}

interface DialogStand {
    id: string;
    name: string;
    url: string;
    token: string;
    phase: 'bearbeiten' | 'frage';
    laeuft: boolean;
    fehler: string;
}

export interface AnsichtProps {
    /** Formularwert regelPlanVorlage (JSON-Text, leer = Werksplan) */
    vorlage: unknown;
    onVorlage: (text: string) => void;
    /** Temperaturstufen der Vorlage, wie sie im Formular stehen (regelStufen) - auch ungespeichert */
    stufenFormular?: unknown;
    /** Geraetezeilen des Formulars (regelGeraete): Haken "individuell" und eigene Stufen - auch ungespeichert */
    geraeteFormular?: unknown;
    /** Instanz laeuft */
    alive: boolean;
    senden: Senden | null;
    dunkel: boolean;
    sprache: string;
}

/** Die ganze Ansicht - ohne jsonConfig, damit sie sich einzeln rendern und pruefen laesst. */
export function ZeitplaeneAnsicht(props: AnsichtProps): React.JSX.Element {
    const { senden, alive, dunkel } = props;
    const [liste, setListe] = useState<PlanListe | null>(null);
    const [ladeFehler, setLadeFehler] = useState('');
    const [fehler, setFehler] = useState<Record<string, string>>({});
    const [arbeitet, setArbeitet] = useState<Record<string, boolean>>({});
    const [kopien, setKopien] = useState<Record<string, { stand: string; week: string }>>({});
    const [dialog, setDialog] = useState<DialogStand | null>(null);
    const [jetzt, setJetzt] = useState(() => new Date());
    // schmal anfangen: ein zu breiter erster Aufbau weitet auf dem Handy die Seite, und die Messung bliebe breit
    const [breite, setBreite] = useState(0);
    const rahmen = useRef<HTMLDivElement | null>(null);
    const lebt = useRef(true);
    const gefragt = useRef<Record<string, string>>({});
    const handy = useMediaQuery('(max-width:600px)');

    const sprache = (liste && liste.sprache) || props.sprache || 'en';
    const tx = useCallback((s: Schluessel, ...w: (string | number)[]): string => uebersetzt(sprache, s, ...w), [sprache]);

    useEffect(() => {
        lebt.current = true;
        return () => {
            lebt.current = false;
        };
    }, []);
    useLayoutEffect(() => {
        const el = rahmen.current;
        if (!el || typeof ResizeObserver === 'undefined') {
            return undefined;
        }
        const messen = (): void => setBreite(el.clientWidth || 0);
        const waechter = new ResizeObserver(messen);
        waechter.observe(el);
        messen();
        return () => waechter.disconnect();
    }, []);
    useEffect(() => {
        const takt = setInterval(() => setJetzt(new Date()), 60000);
        return () => clearInterval(takt);
    }, []);

    // Die Temperaturstufen, wie sie im Formular stehen (auch ungespeichert): Der Adapter rechnet daraus
    // Namen, Reihenfolge und Farben - fuer diese Liste UND fuer den Editor. So zeigen die Karten der
    // Stufen, die Vorschau hier und der Editor immer dasselbe.
    const formularText = useMemo(
        () =>
            JSON.stringify({
                regelStufen: Array.isArray(props.stufenFormular) ? props.stufenFormular : [],
                regelGeraete: (Array.isArray(props.geraeteFormular) ? props.geraeteFormular : [])
                    .filter(z => z && typeof z === 'object')
                    .map((z: Record<string, unknown>) => ({
                        geraet: z.geraet,
                        individuell: z.individuell === true,
                        stufen: Array.isArray(z.stufen) ? z.stufen : [],
                    })),
            }),
        [props.stufenFormular, props.geraeteFormular],
    );
    const formularRef = useRef(formularText);
    formularRef.current = formularText;

    const laden = useCallback(async (): Promise<void> => {
        if (!senden) {
            return;
        }
        try {
            const antwort = await senden('zeitplaeneListe', { formular: JSON.parse(formularRef.current) });
            if (!antwort || !Array.isArray(antwort.geraete)) {
                throw new Error(uebersetzt(sprache, 'keineAntwort'));
            }
            if (lebt.current) {
                setListe(antwort as PlanListe);
                setLadeFehler('');
                setJetzt(new Date());
            }
        } catch (e) {
            if (lebt.current) {
                setLadeFehler(e instanceof Error && e.message ? e.message : String(e));
            }
        }
    }, [senden, sprache]);

    // beim Oeffnen, alle 30 s und (ueber laden()) nach jeder Aktion
    const ladenRef = useRef(laden);
    ladenRef.current = laden;
    useEffect(() => {
        if (!alive || !senden) {
            setListe(null);
            setLadeFehler('');
            return undefined;
        }
        void ladenRef.current();
        const takt = setInterval(() => void ladenRef.current(), ABFRAGE_MS);
        return () => clearInterval(takt);
    }, [alive, senden]);
    // Stufe angelegt, umbenannt, entfernt oder Haken "individuell" geaendert: gleich neu fragen (kurz
    // warten, solange gezogen oder getippt wird)
    const ersterStand = useRef(formularText);
    useEffect(() => {
        if (!alive || !senden || ersterStand.current === formularText) {
            return undefined;
        }
        ersterStand.current = '';
        const uhr = setTimeout(() => void ladenRef.current(), 250);
        return () => clearTimeout(uhr);
    }, [formularText, alive, senden]);
    // Nach "Speichern" startet der Adapter neu: bis sich die Module wieder gemeldet haben, ist die Liste
    // leer. Dann in kurzem Takt nachfragen statt eine halbe Minute "Noch keine Geraete" zu zeigen.
    const ohneGeraete = !!alive && !!senden && (!liste || !liste.geraete.length);
    useEffect(() => {
        if (!ohneGeraete) {
            return undefined;
        }
        const takt = setInterval(() => void ladenRef.current(), ABFRAGE_LEER_MS);
        return () => clearInterval(takt);
    }, [ohneGeraete]);

    // exakter Plantext je Geraet fuer "Kopieren" - nur wenn sich der Plan geaendert hat
    useEffect(() => {
        if (!senden || !liste) {
            return;
        }
        for (const g of liste.geraete) {
            const stand = g.planFehlt ? '' : JSON.stringify(g.woche);
            if (!stand || gefragt.current[g.id] === stand) {
                continue;
            }
            gefragt.current[g.id] = stand;
            senden('wochenplanKopie', { device: g.id })
                .then(a => {
                    if (lebt.current && a && typeof a.week === 'string' && a.week) {
                        setKopien(alt => ({ ...alt, [g.id]: { stand, week: a.week } }));
                    }
                })
                .catch(() => {
                    // der Rueckfall (aus den Balken) bleibt
                });
        }
    }, [liste, senden]);

    const stufenVorlage: Stufe[] = (liste && liste.stufen && Array.isArray(liste.stufen.vorlage) && liste.stufen.vorlage.length
        ? liste.stufen.vorlage
        : WERK_STUFEN) as Stufe[];
    const stufenVon = (id: string): Stufe[] =>
        liste && liste.stufen && Array.isArray(liste.stufen[id]) && liste.stufen[id].length ? liste.stufen[id] : stufenVorlage;

    // ---------- Vorlage (Formularwert) ----------
    const vorlageRoh = typeof props.vorlage === 'string' ? props.vorlage : props.vorlage ? JSON.stringify(props.vorlage) : '';
    const vorlageEigen = vorlageRoh.trim() !== '';
    const vorlagePlan = vorlageEigen ? planLesen(vorlageRoh) : null;
    const werkVomAdapter = liste && liste.werksplan && planLesen(liste.werksplan.week) ? String(liste.werksplan.week) : '';
    const werkText = useMemo(
        () => JSON.stringify(planLesen(werkVomAdapter) || werksplan(stufenVorlage)),
        [werkVomAdapter, stufenVorlage],
    );
    const vorlageText = vorlagePlan ? JSON.stringify(vorlagePlan) : werkText;
    const vorlageWoche = useMemo(() => planZuWoche(planLesen(vorlageText) as Plan), [vorlageText]);

    const vorlageEinfuegen = (inhalt: unknown): void => {
        if (inhalt === '' || inhalt === null || inhalt === undefined) {
            setFehler(f => ({ ...f, vorlage: '' }));
            props.onVorlage('');
            return;
        }
        const plan = planLesen(inhalt);
        if (!plan) {
            setFehler(f => ({ ...f, vorlage: tx('einfuegenUngueltig') }));
            return;
        }
        setFehler(f => ({ ...f, vorlage: '' }));
        const neu = JSON.stringify(plan);
        props.onVorlage(neu === werkText ? '' : neu);
    };

    // ---------- Aktionen am Geraet (wirken sofort) ----------
    const aktion = async (id: string, befehl: string, nachricht: Record<string, unknown>): Promise<any> => {
        if (!senden) {
            return null;
        }
        setArbeitet(a => ({ ...a, [id]: true }));
        setFehler(f => ({ ...f, [id]: '' }));
        try {
            return await senden(befehl, { device: id, ...nachricht });
        } catch (e) {
            if (lebt.current) {
                setFehler(f => ({ ...f, [id]: tx('fehlerAktion', e instanceof Error && e.message ? e.message : String(e)) }));
            }
            return null;
        } finally {
            if (lebt.current) {
                setArbeitet(a => ({ ...a, [id]: false }));
            }
            await laden();
        }
    };
    /**
     * Schreibt einen Plan sofort ins Geraet. Das Ergebnis (true = geschrieben) geht an die Knopfleiste:
     * sie bestaetigt erst danach - lehnt der Adapter den Plan ab, steht nur die Fehlermeldung da.
     */
    const planSchreiben = async (id: string, inhalt: unknown): Promise<boolean> => {
        const week =
            inhalt === null || inhalt === undefined ? '' : typeof inhalt === 'string' ? inhalt : JSON.stringify(inhalt);
        if (week && !planLesen(week)) {
            setFehler(f => ({ ...f, [id]: tx('einfuegenUngueltig') }));
            return false;
        }
        return (await aktion(id, 'wochenplanEinfuegen', { week })) !== null;
    };
    const schalten = (g: PlanGeraet, an: boolean): void => {
        // sofort zeigen, die naechste Liste bestaetigt oder korrigiert
        setListe(l => (l ? { ...l, geraete: l.geraete.map(x => (x.id === g.id ? { ...x, planAktiv: an } : x)) } : l));
        void aktion(g.id, 'wochenplanSchalten', { aktiv: an });
    };
    const oeffnen = async (g: { id: string; name: string }): Promise<void> => {
        // Der Editor bekommt den Stand des Formulars mit (auch ungespeichert): die Temperaturstufen, die
        // fuer dieses Geraet gelten, und den Plan der Vorlage. Der Adapter waehlt daraus wie fuer die Liste.
        const formular = { ...JSON.parse(formularRef.current), regelPlanVorlage: vorlageRoh };
        const a = await aktion(
            g.id,
            'wochenplanOeffnen',
            g.id === VORLAGE
                ? // leer heisst Werksplan: der Editor zeigt, was gilt - nicht eine leere Woche
                  { week: vorlageText, formular }
                : { formular },
        );
        if (a && lebt.current) {
            if (typeof a.url === 'string' && a.url && typeof a.token === 'string' && a.token) {
                setDialog({ id: g.id, name: g.name || g.id, url: a.url, token: a.token, phase: 'bearbeiten', laeuft: false, fehler: '' });
            } else {
                setFehler(f => ({ ...f, [g.id]: tx('fehlerAktion', tx('keineAntwort')) }));
            }
        }
    };
    const dialogZu = (): void => {
        setDialog(null);
        void laden();
    };
    const uebernehmen = async (): Promise<void> => {
        if (!dialog || !senden || dialog.laeuft) {
            return;
        }
        const d = dialog;
        setDialog({ ...d, laeuft: true, fehler: '' });
        try {
            const a = await senden('wochenplanSpeichern', { device: d.id, token: d.token });
            if (!lebt.current) {
                return;
            }
            if (d.id === VORLAGE) {
                // nichts geschrieben: der gepruefte Plan geht ins Formular und gilt mit "Speichern" der Instanz
                if (a && typeof a.week === 'string' && planLesen(a.week)) {
                    vorlageEinfuegen(a.week);
                }
                dialogZu();
            } else if (a && a.einschaltenNoetig) {
                setDialog({ ...d, phase: 'frage', laeuft: false, fehler: '' });
                void laden();
            } else {
                dialogZu();
            }
        } catch (e) {
            if (lebt.current) {
                setDialog({ ...d, laeuft: false, fehler: tx('fehlerAktion', e instanceof Error && e.message ? e.message : String(e)) });
            }
        }
    };
    const einschalten = async (): Promise<void> => {
        if (!dialog || !senden || dialog.laeuft) {
            return;
        }
        const d = dialog;
        setDialog({ ...d, laeuft: true, fehler: '' });
        try {
            await senden('wochenplanSchalten', { device: d.id, aktiv: true });
            if (lebt.current) {
                dialogZu();
            }
        } catch (e) {
            if (lebt.current) {
                setDialog({ ...d, laeuft: false, fehler: tx('fehlerAktion', e instanceof Error && e.message ? e.message : String(e)) });
            }
        }
    };

    const schmal = breite < 840;
    const zeileSx = {
        display: 'grid',
        gridTemplateColumns: schmal ? 'minmax(0, 1fr)' : '240px minmax(200px, 1fr) 340px',
        columnGap: 3,
        rowGap: 1.25,
        alignItems: 'start',
        p: schmal ? 1.5 : 2,
        border: '1px solid',
        borderColor: 'divider',
        borderRadius: '8px',
        bgcolor: 'background.paper',
    } as const;
    const nameSx = { fontWeight: 600, fontSize: '1.02em', lineHeight: 1.3, overflowWrap: 'anywhere' } as const;

    const geraeteZeile = (g: PlanGeraet): React.JSX.Element => {
        const stufen = stufenVon(g.id);
        const nach = new Map(stufen.map(s => [s.id, s]));
        const name = g.name || g.id;
        const kopie = kopien[g.id];
        const stand = g.planFehlt ? '' : JSON.stringify(g.woche);
        const inhalt = g.planFehlt ? null : kopie && kopie.stand === stand ? kopie.week : wocheZuText(g.woche);
        const beschaeftigt = !!arbeitet[g.id];
        const eigen = g.stufenQuelle ? g.stufenQuelle === 'eigen' : !!g.individuell;
        return (
            <Box
                key={g.id}
                className="fk-zp-zeile fk-zp-geraet"
                data-geraet={g.id}
                sx={zeileSx}
            >
                <Box sx={{ minWidth: 0 }}>
                    <Box
                        className="fk-zp-name"
                        sx={nameSx}
                    >
                        {name}
                    </Box>
                    {g.planFehlt ? (
                        <Box
                            className="fk-zp-status"
                            sx={{ mt: 0.5, fontSize: '0.9em', lineHeight: 1.45 }}
                        >
                            {/* hinterlegt, aber nicht lesbar (eine Stufe gibt es nicht mehr) ist etwas anderes als "noch keiner" */}
                            <Box sx={{ fontWeight: 600, color: g.planFehler ? 'error.main' : undefined }}>
                                {g.planFehler ? tx('planUngueltig') : tx('keinPlan')}
                            </Box>
                            <Box sx={{ color: 'text.secondary' }}>{g.planFehler ? tx('planUngueltigText') : tx('keinPlanText')}</Box>
                        </Box>
                    ) : (
                        <Box
                            className="fk-zp-status"
                            sx={{ mt: 0.5, fontSize: '0.9em', lineHeight: 1.45 }}
                        >
                            <Box sx={{ display: 'flex', alignItems: 'center', gap: '6px', fontWeight: 600 }}>
                                <Box
                                    component="span"
                                    sx={{
                                        width: 9,
                                        height: 9,
                                        borderRadius: '50%',
                                        flex: '0 0 auto',
                                        bgcolor: g.planAktiv ? 'success.main' : 'transparent',
                                        border: '2px solid',
                                        borderColor: g.planAktiv ? 'success.main' : 'text.disabled',
                                        boxSizing: 'border-box',
                                    }}
                                />
                                {g.planAktiv ? tx('planAktiv') : tx('planAus')}
                            </Box>
                            {g.planAktiv && g.stufe ? (
                                <Box sx={{ color: 'text.secondary' }}>
                                    {tx('jetztStufe', stufenText(nach.get(g.stufe), g.stufe, sprache, g.stufeName))}
                                </Box>
                            ) : null}
                            {g.planAktiv && g.naechster ? (
                                <Box sx={{ color: 'text.secondary' }}>
                                    {tx(
                                        'naechste',
                                        zeitText(g.naechster, sprache, tx),
                                        stufenText(nach.get(g.naechsteStufe), g.naechsteStufe, sprache, g.naechsteStufeName),
                                    ).replace(' → ', '\u00a0→ ')}
                                </Box>
                            ) : null}
                        </Box>
                    )}
                    {/* woher die Stufen dieser Anlage stammen - dieselbe Angabe steht im Kopf des Editors */}
                    <Box
                        className="fk-zp-stufenquelle"
                        data-quelle={eigen ? 'eigen' : 'vorlage'}
                        sx={{ mt: 0.5, fontSize: '0.9em', lineHeight: 1.4, color: 'text.secondary' }}
                    >
                        {eigen ? tx('stufenEigen') : tx('stufenVorlage')}
                        {eigen ? <Box sx={{ fontSize: '0.95em' }}>{tx('stufenEigenWo', name)}</Box> : null}
                    </Box>
                </Box>
                <Wochenvorschau
                    woche={g.planFehlt ? null : g.woche}
                    stufen={stufen}
                    dunkel={dunkel}
                    sprache={sprache}
                    name={name}
                    mitJetzt={!g.planFehlt}
                    jetzt={jetzt}
                    alleStufen={eigen}
                />
                <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: schmal ? 'stretch' : 'flex-start', gap: 0.75, minWidth: 0 }}>
                    <Button
                        className="fk-zp-bearbeiten"
                        variant="contained"
                        color="primary"
                        disabled={beschaeftigt}
                        onClick={() => void oeffnen(g)}
                        sx={{ textTransform: 'none', fontWeight: 600 }}
                    >
                        {g.planFehlt ? tx('anlegen') : tx('bearbeiten')}
                    </Button>
                    <Tooltip
                        disableInteractive
                        title={g.planFehlt && !g.planAktiv ? tx('schalterGesperrt') : ''}
                    >
                        <Box
                            component="span"
                            sx={{ display: 'inline-flex', alignItems: 'center', flexWrap: 'wrap' }}
                        >
                            <FormControlLabel
                                sx={{ mr: 1, ml: '-4px' }}
                                control={
                                    <Switch
                                        className="fk-zp-schalter"
                                        size="small"
                                        checked={!!g.planAktiv}
                                        disabled={(g.planFehlt && !g.planAktiv) || beschaeftigt}
                                        onChange={e => schalten(g, e.target.checked)}
                                    />
                                }
                                label={<Box sx={{ fontSize: '0.9em' }}>{tx('schalter')}</Box>}
                            />
                            <Box
                                component="span"
                                sx={{ fontSize: '0.9em', color: 'text.secondary' }}
                            >
                                {tx('schalterHinweis')}
                            </Box>
                        </Box>
                    </Tooltip>
                    <Werkzeugleiste
                        art="wochenplan"
                        inhalt={inhalt}
                        onEinfuegen={neu => planSchreiben(g.id, neu)}
                        onZuruecksetzen={() => planSchreiben(g.id, vorlageText)}
                        zuruecksetzenText={tx('vorlageUebernehmen')}
                        // der Plan ist eine Kopie der Vorlage und steht sofort im Geraet - nicht "es gilt wieder die Vorlage"
                        zurueckMeldung={tx('vorlageUebernommen')}
                        istVorlage={false}
                        quelle={name}
                        sprache={sprache}
                    />
                </Box>
                {Array.isArray(g.ersatz) && g.ersatz.length ? (
                    <Box sx={{ gridColumn: '1 / -1' }}>
                        <Meldung
                            art="info"
                            klasse="fk-zp-ersatz"
                        >
                            {g.ersatz.map(e => tx('ersatzOffen', e.vonName || e.von, e.nachName || e.nach)).join(' ')}
                        </Meldung>
                    </Box>
                ) : null}
                {g.planFehler ? (
                    <Box sx={{ gridColumn: '1 / -1' }}>
                        <Meldung
                            art="fehler"
                            klasse="fk-zp-planfehler"
                        >
                            {g.planFehler}
                        </Meldung>
                    </Box>
                ) : null}
                {fehler[g.id] ? (
                    <Box sx={{ gridColumn: '1 / -1' }}>
                        <Meldung
                            art="fehler"
                            klasse="fk-zp-fehler"
                            knopf={{ text: tx('schliessen'), onClick: () => setFehler(f => ({ ...f, [g.id]: '' })) }}
                        >
                            {fehler[g.id]}
                        </Meldung>
                    </Box>
                ) : null}
            </Box>
        );
    };

    return (
        <Box
            ref={rahmen}
            className={`fk-zeitplaene${schmal ? ' fk-zp-schmal' : ''}`}
            sx={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 1.5 }}
        >
            <Meldung
                art="info"
                klasse="fk-zp-hinweis"
            >
                {tx('hinweisSofort')}
            </Meldung>

            <Typography
                component="div"
                className="fk-zp-titel"
                sx={{ fontWeight: 600, mt: 0.5 }}
            >
                {tx('geraete')}
            </Typography>

            {!alive || !senden ? (
                <Meldung
                    art="neutral"
                    klasse="fk-zp-instanz-aus"
                >
                    {tx('instanzAus')}
                </Meldung>
            ) : null}
            {alive && senden && ladeFehler ? (
                <Meldung
                    art="fehler"
                    klasse="fk-zp-ladefehler"
                    knopf={{ text: tx('nochmal'), onClick: () => void laden() }}
                >
                    {tx('fehlerLaden', ladeFehler)}
                </Meldung>
            ) : null}
            {alive && senden && !liste && !ladeFehler ? (
                <Box
                    className="fk-zp-laden"
                    sx={{ display: 'flex', alignItems: 'center', gap: 1, color: 'text.secondary', py: 1 }}
                >
                    <CircularProgress size={18} />
                    {tx('laden')}
                </Box>
            ) : null}
            {alive && senden && liste && !liste.geraete.length ? (
                <Meldung
                    art="neutral"
                    klasse="fk-zp-leer"
                >
                    {tx('keineGeraete')}
                </Meldung>
            ) : null}
            {alive && senden && liste ? liste.geraete.map(geraeteZeile) : null}

            {/* die Vorlage steht unter den Geraeten: zuerst das, was die meisten suchen - den Wochenplan ihrer Anlage */}
            <Box
                className="fk-zp-zeile fk-zp-vorlage"
                sx={zeileSx}
            >
                <Box sx={{ minWidth: 0 }}>
                    <Box
                        className="fk-zp-name"
                        sx={nameSx}
                    >
                        {tx('vorlage')}
                    </Box>
                    <Box
                        className="fk-zp-status"
                        sx={{ mt: 0.5, fontSize: '0.9em', lineHeight: 1.45 }}
                    >
                        <Box sx={{ fontWeight: 600 }}>{vorlagePlan ? tx('vorlageEigen') : tx('vorlageWerk')}</Box>
                        <Box sx={{ color: 'text.secondary' }}>{tx('vorlageText')}</Box>
                    </Box>
                </Box>
                <Wochenvorschau
                    woche={vorlageWoche}
                    stufen={stufenVorlage}
                    dunkel={dunkel}
                    sprache={sprache}
                    name={tx('vorlage')}
                    mitJetzt={false}
                    jetzt={jetzt}
                />
                <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: schmal ? 'stretch' : 'flex-start', gap: 0.75, minWidth: 0 }}>
                    <Tooltip
                        disableInteractive
                        title={!alive || !senden ? tx('instanzAus') : ''}
                    >
                        <Box
                            component="span"
                            sx={{ display: schmal ? 'flex' : 'inline-flex', flexDirection: 'column' }}
                        >
                            <Button
                                className="fk-zp-bearbeiten fk-zp-vorlage-bearbeiten"
                                variant="outlined"
                                color="primary"
                                disabled={!alive || !senden || !!arbeitet[VORLAGE]}
                                onClick={() => void oeffnen({ id: VORLAGE, name: tx('vorlage') })}
                                sx={{ textTransform: 'none', fontWeight: 600 }}
                            >
                                {tx('vorlageBearbeiten')}
                            </Button>
                        </Box>
                    </Tooltip>
                    <Werkzeugleiste
                        art="wochenplan"
                        inhalt={vorlageText}
                        stand={vorlageRoh}
                        onRueckgaengig={vorher => {
                            setFehler(f => ({ ...f, vorlage: '' }));
                            props.onVorlage(typeof vorher === 'string' ? vorher : '');
                        }}
                        onEinfuegen={vorlageEinfuegen}
                        onZuruecksetzen={() => vorlageEinfuegen('')}
                        istVorlage
                        quelle={tx('vorlage')}
                        sprache={sprache}
                    />
                    <Box sx={{ mt: 0.5, fontSize: '0.9em', color: 'text.secondary' }}>{tx('vorlageAendern')}</Box>
                </Box>
                {vorlageEigen && !vorlagePlan ? (
                    <Box sx={{ gridColumn: '1 / -1' }}>
                        <Meldung
                            art="fehler"
                            klasse="fk-zp-fehler"
                        >
                            {tx('vorlageKaputt')}
                        </Meldung>
                    </Box>
                ) : null}
                {fehler.vorlage ? (
                    <Box sx={{ gridColumn: '1 / -1' }}>
                        <Meldung
                            art="fehler"
                            klasse="fk-zp-fehler"
                            knopf={{ text: tx('schliessen'), onClick: () => setFehler(f => ({ ...f, vorlage: '' })) }}
                        >
                            {fehler.vorlage}
                        </Meldung>
                    </Box>
                ) : null}
            </Box>

            {dialog ? (
                <Dialog
                    open
                    fullWidth
                    // die Rueckfrage ist ein Satz - dafuer kein Dialog ueber die ganze Breite
                    maxWidth={dialog.phase === 'frage' ? 'sm' : 'xl'}
                    fullScreen={handy}
                    className="fk-zp-dialog"
                    // der Dialog haengt ausserhalb des Formulars - Schrift des Themas ausdruecklich setzen
                    sx={{ '& .MuiDialog-paper': { fontFamily: theme => theme.typography.fontFamily } }}
                    onClose={(_e, grund) => {
                        // ein Klick neben den Dialog darf die Bearbeitung nicht wegwerfen
                        if (grund !== 'backdropClick' && !dialog.laeuft) {
                            dialogZu();
                        }
                    }}
                >
                    <DialogTitle sx={{ py: 1.5 }}>{tx('dialogTitel', dialog.name)}</DialogTitle>
                    <DialogContent
                        dividers
                        sx={{ px: handy ? 1 : 2, py: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}
                    >
                        {dialog.phase === 'bearbeiten' ? (
                            <Box
                                component="iframe"
                                className="fk-zp-editor"
                                title={tx('dialogTitel', dialog.name)}
                                src={dialog.url}
                                sx={{
                                    display: 'block',
                                    width: '100%',
                                    border: 0,
                                    flex: handy ? '1 1 auto' : '0 0 auto',
                                    height: handy ? 'auto' : 'min(585px, calc(100vh - 246px))',
                                    minHeight: 320,
                                }}
                            />
                        ) : (
                            <Box
                                className="fk-zp-frage"
                                sx={{ p: 3, fontSize: '1.05em', lineHeight: 1.5 }}
                            >
                                {tx('einschaltenFrage', dialog.name)}
                            </Box>
                        )}
                        {dialog.fehler ? (
                            <Box sx={{ p: 1.5 }}>
                                <Meldung
                                    art="fehler"
                                    klasse="fk-zp-dialogfehler"
                                >
                                    {dialog.fehler}
                                </Meldung>
                            </Box>
                        ) : null}
                    </DialogContent>
                    <DialogActions sx={{ flexWrap: 'wrap', gap: 1, px: 2, py: 1.25 }}>
                        {dialog.phase === 'bearbeiten' ? (
                            <>
                                <Box sx={{ flex: '1 1 200px', fontSize: '0.85em', color: 'text.secondary' }}>
                                    {dialog.id === VORLAGE ? tx('dialogHinweisVorlage') : tx('dialogHinweis')}
                                </Box>
                                <Button
                                    className="fk-zp-verwerfen"
                                    variant="outlined"
                                    disabled={dialog.laeuft}
                                    onClick={dialogZu}
                                    sx={{ textTransform: 'none' }}
                                >
                                    {tx('verwerfen')}
                                </Button>
                                <Button
                                    className="fk-zp-uebernehmen"
                                    variant="contained"
                                    color="primary"
                                    disabled={dialog.laeuft}
                                    onClick={() => void uebernehmen()}
                                    sx={{ textTransform: 'none', fontWeight: 600 }}
                                >
                                    {tx('uebernehmen')}
                                </Button>
                            </>
                        ) : (
                            <>
                                <Button
                                    className="fk-zp-nur-speichern"
                                    variant="outlined"
                                    disabled={dialog.laeuft}
                                    onClick={dialogZu}
                                    sx={{ textTransform: 'none' }}
                                >
                                    {tx('nurSpeichern')}
                                </Button>
                                <Button
                                    className="fk-zp-einschalten"
                                    variant="contained"
                                    color="primary"
                                    disabled={dialog.laeuft}
                                    onClick={() => void einschalten()}
                                    sx={{ textTransform: 'none', fontWeight: 600 }}
                                >
                                    {tx('einschalten')}
                                </Button>
                            </>
                        )}
                    </DialogActions>
                </Dialog>
            ) : null}
        </Box>
    );
}

/** sendTo mit Zeitgrenze; {error} und ausbleibende Antworten werden zu einem Fehler mit Klartext. */
function useSenden(props: ConfigGenericProps, sprache: string): Senden | null {
    const socket = props.oContext?.socket;
    const ziel = `${props.oContext?.adapterName}.${props.oContext?.instance}`;
    return useMemo(() => {
        if (!socket || typeof socket.sendTo !== 'function') {
            return null;
        }
        return (befehl: string, nachricht: Record<string, unknown>): Promise<any> =>
            new Promise((fertig, abgelehnt) => {
                const uhr = setTimeout(() => abgelehnt(new Error(uebersetzt(sprache, 'keineAntwort'))), ANTWORT_MS);
                Promise.resolve(socket.sendTo(ziel, befehl, nachricht))
                    .then((antwort: any) => {
                        clearTimeout(uhr);
                        if (antwort && typeof antwort === 'object' && antwort.error) {
                            abgelehnt(new Error(String(antwort.error)));
                        } else if (antwort === null || antwort === undefined) {
                            abgelehnt(new Error(uebersetzt(sprache, 'keineAntwort')));
                        } else {
                            fertig(antwort);
                        }
                    })
                    .catch((e: unknown) => {
                        clearTimeout(uhr);
                        abgelehnt(e instanceof Error ? e : new Error(String(e)));
                    });
            });
    }, [socket, ziel, sprache]);
}

function ZeitplaeneFeld(props: ConfigGenericProps & { onVorlage: (text: string) => void }): React.JSX.Element {
    const roh = I18n.getLanguage();
    const sprache = TEXTE[roh] ? roh : 'en';
    const senden = useSenden(props, sprache);
    const thema = props.oContext?.theme?.palette?.mode || props.oContext?.themeType;
    return (
        <ZeitplaeneAnsicht
            vorlage={ConfigGeneric.getValue(props.data, props.attr as string)}
            stufenFormular={(props.data as Record<string, unknown>)?.regelStufen}
            geraeteFormular={(props.data as Record<string, unknown>)?.regelGeraete}
            onVorlage={props.onVorlage}
            alive={!!props.alive}
            senden={senden}
            dunkel={thema === 'dark'}
            sprache={sprache}
        />
    );
}

/** jsonConfig-Komponente "Zeitplaene" (attr = regelPlanVorlage) */
export class Zeitplaene extends ConfigGeneric<ConfigGenericProps, ConfigGenericState> {
    /** schreibt die Vorlage ins Formular - gilt mit "Speichern" der Instanz */
    onVorlage = (text: string): void => {
        if (this.props.attr) {
            void this.onChange(this.props.attr, text);
        }
    };

    renderItem(): React.JSX.Element {
        return (
            <ZeitplaeneFeld
                {...this.props}
                onVorlage={this.onVorlage}
            />
        );
    }
}

export default Zeitplaene;
