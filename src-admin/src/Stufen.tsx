/*
 * Temperaturstufen (frueher "Szenen") zum Anfassen: je Stufe eine Karte in der Farbe, die die Stufe
 * auch als Balken im Wochenplan hat. Die Zieltemperatur und die Hoechstleistung werden gezogen,
 * daneben steht klein der Wert zum Eintippen. Geschrieben wird nur ins Formular (onChange):
 * "Speichern" der Instanz uebernimmt, "Schliessen" verwirft.
 *
 * Formularwert: Liste {id, name, power, mode, soll, fan, deckel, bedarf, feuchte} in `regelStufen`
 * (Vorlage; leer = vier Werksstufen) bzw. `stufen` (Geraetezeile; leer = es gilt die Vorlage).
 * Die `id` wird immer mitgeschrieben: an ihr haengt der Wochenplan - so bleibt ein Plan gueltig,
 * wenn eine Stufe umbenannt wird oder die Werksstufen in einer anderen Sprache angelegt wurden.
 *
 * Werksstufen, Grenzen und Farben muessen zu lib/regel/wochenplan.js (VORGABE_SZENEN, szenenLesen)
 * und lib/oberflaeche.js (SZENEN_FARBEN, szenenFarben) passen.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
    Box,
    Button,
    Checkbox,
    FormControlLabel,
    IconButton,
    SvgIcon,
    Switch,
    Tooltip,
    Typography,
} from '@mui/material';
import { I18n } from '@iobroker/gui-components';
import { ConfigGeneric, type ConfigGenericProps, type ConfigGenericState } from '@iobroker/json-config';

import Werkzeugleiste from './Werkzeugleiste';
import { t as text, type Schluessel } from './Stufen.texte';

export interface Stufe {
    id: string;
    name: string;
    power: boolean;
    mode: string;
    soll: number;
    fan: string;
    deckel: number;
    bedarf: boolean;
    feuchte: boolean;
}

export const MODI = ['heat', 'cool', 'heat_cool', 'dry', 'fan_only'] as const;
export const LUEFTER = ['auto', 'night', 'low', 'lowMedium', 'medium', 'mediumHigh', 'high'] as const;
export const ZIEL = { min: 10, max: 32, schritt: 0.5 };
export const DECKEL = { min: 30, max: 100, schritt: 5 };

/** wie lib/regel/wochenplan.js VORGABE_SZENEN (die Namen kommen in der Systemsprache dazu) */
const WERK: Omit<Stufe, 'name'>[] = [
    { id: 'komfort', power: true, mode: 'heat', soll: 21, fan: 'auto', bedarf: true, feuchte: true, deckel: 100 },
    { id: 'absenken', power: true, mode: 'heat', soll: 19, fan: 'night', bedarf: true, feuchte: true, deckel: 60 },
    { id: 'abwesend', power: true, mode: 'heat', soll: 17, fan: 'auto', bedarf: true, feuchte: false, deckel: 50 },
    { id: 'aus', power: false, mode: 'heat', soll: 17, fan: 'auto', bedarf: false, feuchte: false, deckel: 95 },
];

/** wie lib/oberflaeche.js SZENEN_FARBEN */
const FARBEN = {
    hell: { komfort: '#a3492f', absenken: '#4a7350', abwesend: '#3e5c8a', aus: '#6b6b6b' } as Record<string, string>,
    dunkel: { komfort: '#d4896b', absenken: '#8fb391', abwesend: '#8ea6cf', aus: '#a0a0a0' } as Record<string, string>,
    weitereHell: ['#7a4a8c', '#2f7a7a', '#8a6a1f', '#8c2336', '#55687a'],
    weitereDunkel: ['#c09ad0', '#7fc4c4', '#d3b56a', '#dd8fa0', '#9eacb9'],
};

/** Farbe je Stufe in der Reihenfolge der Liste - dieselbe Regel wie szenenFarben() des Adapters. */
export function stufenFarben(ids: string[], dunkel: boolean): string[] {
    const fest = dunkel ? FARBEN.dunkel : FARBEN.hell;
    const weitere = dunkel ? FARBEN.weitereDunkel : FARBEN.weitereHell;
    let n = 0;
    return ids.map(id => fest[id] || weitere[n++ % weitere.length]);
}

/** Zahl fuer die Anzeige: Komma ausser en/zh-cn, echtes Minus. */
export function zahl(n: number, sprache: string, stellen = 0): string {
    if (!Number.isFinite(n)) {
        return '';
    }
    const s = Math.abs(n).toFixed(stellen);
    const punkt = sprache === 'en' || sprache.startsWith('zh');
    return (n < 0 && Number(s) !== 0 ? '−' : '') + (punkt ? s : s.replace('.', ','));
}

/** Getippte Zahl lesen (Komma oder Punkt, echtes oder einfaches Minus); NaN, wenn es keine ist. */
export function zahlLesen(roh: string): number {
    const s = roh.trim().replace('−', '-').replace(',', '.');
    return s === '' || !/^-?\d*\.?\d*$/.test(s) ? NaN : Number(s);
}

const aufRaster = (n: number, min: number, max: number, schritt: number): number =>
    Math.min(max, Math.max(min, Math.round(Math.round(n / schritt) * schritt * 100) / 100));

/** ID wie szenenLesen() des Adapters: aus `id`, sonst aus dem Namen. */
export function idVon(s: { id?: unknown; name?: unknown }): string {
    return String(s.id || s.name || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, '_');
}

/** Die vier Werksstufen mit Namen in der Sprache. */
export function werksStufen(sprache: string): Stufe[] {
    return WERK.map(s => ({ ...s, name: text(sprache, s.id as Schluessel) }));
}

/** Eine Zeile des Formulars nachsichtig lesen (wie der Adapter), ohne sie zu veraendern. */
function lesen(roh: unknown): Stufe {
    const s = (roh && typeof roh === 'object' ? roh : {}) as Record<string, unknown>;
    const soll = Number(s.soll);
    const deckel = s.deckel === undefined || s.deckel === null || s.deckel === '' ? 100 : Number(s.deckel);
    return {
        id: idVon(s),
        name: typeof s.name === 'string' ? s.name : String(s.name ?? s.id ?? ''),
        power: s.power !== false && s.power !== 'false',
        mode: (MODI as readonly string[]).includes(String(s.mode)) ? String(s.mode) : 'heat',
        soll: Number.isFinite(soll) ? soll : 20,
        fan: (LUEFTER as readonly string[]).includes(String(s.fan)) ? String(s.fan) : 'auto',
        deckel: Number.isFinite(deckel) ? deckel : 100,
        bedarf: s.bedarf !== false && s.bedarf !== 'false',
        feuchte: s.feuchte !== false && s.feuchte !== 'false',
    };
}

const liste = (roh: unknown): unknown[] => (Array.isArray(roh) ? roh : []);
const gleich = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

// Symbole als Pfade (Material Icons) - so braucht das Paket keine eigene Kopie der Symbolbibliothek.
const symbol = (pfad: string) =>
    function Symbol(props: { klein?: boolean }): React.JSX.Element {
        return (
            <SvgIcon sx={{ fontSize: props.klein ? 15 : 20 }}>
                <path d={pfad} />
            </SvgIcon>
        );
    };
const AddIcon = symbol('M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6z');
const DeleteIcon = symbol('M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6zM19 4h-3.5l-1-1h-5l-1 1H5v2h14z');
const EditIcon = symbol(
    'M3 17.25V21h3.75L17.81 9.94l-3.75-3.75zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34a.996.996 0 0 0-1.41 0l-1.83 1.83 3.75 3.75z',
);

/**
 * Kleines Eingabefeld neben einem Regler: zeigt den Wert in der Schreibweise der Sprache, nimmt
 * Komma oder Punkt und schreibt erst, wenn die Zahl im Bereich liegt (Zwischenstaende beim Tippen
 * bleiben stehen). Pfeil hoch/runter verstellt um einen Schritt.
 */
export function Wertfeld(props: {
    wert: number;
    min: number;
    max: number;
    schritt: number;
    stellen: number;
    einheit: string;
    name: string;
    sprache: string;
    gesperrt?: boolean;
    fehler?: boolean;
    /** eigene Pruefung ueber den Bereich hinaus (z. B. "Aus" muss ueber "Ein" liegen) */
    erlaubt?: (n: number) => boolean;
    onWert: (n: number) => void;
}): React.JSX.Element {
    const { wert, min, max, schritt, stellen, sprache } = props;
    const zeige = (n: number): string => zahl(n, sprache, stellen);
    const [getippt, setGetippt] = useState<string | null>(null);
    const inhalt = getippt === null ? zeige(wert) : getippt;
    const n = getippt === null ? wert : zahlLesen(getippt);
    const passt = Number.isFinite(n) && n >= min && n <= max && (!props.erlaubt || props.erlaubt(n));
    return (
        <span className={`fk-wert${props.gesperrt ? ' fk-gesperrt' : ''}`}>
            <input
                className="fk-wert-feld"
                type="text"
                inputMode="decimal"
                autoComplete="off"
                aria-label={props.name}
                aria-invalid={props.fehler || (getippt !== null && !passt) || undefined}
                disabled={props.gesperrt}
                value={inhalt}
                size={4}
                onFocus={e => e.target.select()}
                onBlur={() => setGetippt(null)}
                onChange={e => {
                    const neu = e.target.value;
                    setGetippt(neu);
                    const z = zahlLesen(neu);
                    if (Number.isFinite(z) && z >= min && z <= max && (!props.erlaubt || props.erlaubt(z))) {
                        const r = aufRaster(z, min, max, schritt);
                        if (r !== wert) {
                            props.onWert(r);
                        }
                    }
                }}
                onKeyDown={e => {
                    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
                        e.preventDefault();
                        const r = aufRaster(wert + (e.key === 'ArrowUp' ? schritt : -schritt), min, max, schritt);
                        setGetippt(null);
                        if (r !== wert && (!props.erlaubt || props.erlaubt(r))) {
                            props.onWert(r);
                        }
                    } else if (e.key === 'Enter') {
                        (e.target as HTMLInputElement).blur();
                    } else if (e.key === 'Escape') {
                        setGetippt(null);
                    }
                }}
            />
            <span className="fk-wert-einheit">{props.einheit}</span>
        </span>
    );
}

/** Gestaltung von Wertfeld - fuer jede Komponente, die es benutzt (sx des umgebenden Kastens). */
export function wertfeldStil(farben: { fokus: string; fehler: string }): Record<string, object> {
    return {
        '& .fk-wert': { display: 'inline-flex', alignItems: 'baseline', gap: '4px', whiteSpace: 'nowrap' },
        '& .fk-wert-feld': {
            width: '4.2em',
            font: 'inherit',
            fontVariantNumeric: 'tabular-nums',
            fontWeight: 600,
            textAlign: 'right',
            color: 'inherit',
            background: 'transparent',
            border: '1px solid',
            borderColor: 'divider',
            borderRadius: '6px',
            padding: '3px 7px',
            outline: 'none',
            transition: 'border-color 0.12s, box-shadow 0.12s',
        },
        '& .fk-wert-feld:hover:not(:disabled)': { borderColor: 'text.secondary' },
        '& .fk-wert-feld:focus': { borderColor: farben.fokus, boxShadow: `0 0 0 2px ${farben.fokus}55` },
        '& .fk-wert-feld[aria-invalid="true"]': {
            borderColor: farben.fehler,
            boxShadow: `0 0 0 2px ${farben.fehler}44`,
        },
        '& .fk-wert-feld:disabled': { opacity: 0.55 },
        '& .fk-wert-einheit': { color: 'text.secondary', fontSize: '0.85em' },
    };
}

/**
 * Waagerechter Regler zum Ziehen: Bahn mit farbiger Fuellung, runder Griff mit Rillen. Klick auf die
 * Bahn springt hin, Ziehen verstellt im Raster, Pfeiltasten um einen Schritt (Bild auf/ab: vier).
 */
function Schieber(props: {
    wert: number;
    min: number;
    max: number;
    schritt: number;
    farbe: string;
    name: string;
    wertText: string;
    striche: number[];
    einheit: string;
    sprache: string;
    gesperrt?: boolean;
    klein?: boolean;
    onWert: (n: number) => void;
}): React.JSX.Element {
    const { wert, min, max, schritt } = props;
    const bahn = useRef<HTMLDivElement | null>(null);
    const griff = useRef<HTMLDivElement | null>(null);
    const zieht = useRef<{ zeiger: number; scharf: boolean; x: number; y: number } | null>(null);
    const [ziehend, setZiehend] = useState(false);
    const R = props.klein ? 9 : 11;
    const anteil = Math.min(1, Math.max(0, (wert - min) / (max - min)));
    const stelle = (a: number): string => `calc(${R}px + ${a} * (100% - ${2 * R}px))`;

    const wertBei = (clientX: number): number => {
        const r = (bahn.current as HTMLDivElement).getBoundingClientRect();
        const a = (clientX - r.left - R) / Math.max(1, r.width - 2 * R);
        return aufRaster(min + a * (max - min), min, max, schritt);
    };
    const setzen = (n: number): void => {
        if (n !== wert) {
            props.onWert(n);
        }
    };
    const runter = (e: React.PointerEvent<HTMLDivElement>): void => {
        if (props.gesperrt || (e.pointerType === 'mouse' && e.button !== 0)) {
            return;
        }
        const aufGriff = !!(e.target as Element).closest?.('.fk-s-griff');
        e.currentTarget.setPointerCapture(e.pointerId);
        // Finger: erst eine waagerechte Bewegung zaehlt - wer nur die Seite rollt, verstellt nichts
        zieht.current = { zeiger: e.pointerId, scharf: e.pointerType !== 'touch', x: e.clientX, y: e.clientY };
        setZiehend(true);
        if (e.pointerType !== 'touch') {
            e.preventDefault();
            griff.current?.focus({ preventScroll: true });
            if (!aufGriff) {
                setzen(wertBei(e.clientX));
            }
        }
    };
    const bewegen = (e: React.PointerEvent<HTMLDivElement>): void => {
        const z = zieht.current;
        if (!z || z.zeiger !== e.pointerId) {
            return;
        }
        if (!z.scharf) {
            const dx = Math.abs(e.clientX - z.x);
            const dy = Math.abs(e.clientY - z.y);
            if (dy > 10 && dy >= dx) {
                // der Finger rollt die Seite
                zieht.current = null;
                setZiehend(false);
                return;
            }
            if (dx < 6 || dx <= dy) {
                return;
            }
            z.scharf = true;
        }
        setzen(wertBei(e.clientX));
    };
    const hoch = (e: React.PointerEvent<HTMLDivElement>): void => {
        const z = zieht.current;
        if (!z || z.zeiger !== e.pointerId) {
            return;
        }
        if (!z.scharf && e.type === 'pointerup') {
            setzen(wertBei(e.clientX)); // Antippen der Bahn
        }
        zieht.current = null;
        setZiehend(false);
    };
    const taste = (e: React.KeyboardEvent<HTMLDivElement>): void => {
        const wege: Record<string, number> = {
            ArrowLeft: -1,
            ArrowDown: -1,
            ArrowRight: 1,
            ArrowUp: 1,
            PageDown: -4,
            PageUp: 4,
        };
        let neu: number | null = null;
        if (e.key in wege) {
            neu = aufRaster(wert + wege[e.key] * schritt, min, max, schritt);
        } else if (e.key === 'Home') {
            neu = min;
        } else if (e.key === 'End') {
            neu = max;
        }
        if (neu === null || props.gesperrt) {
            return;
        }
        e.preventDefault();
        setzen(neu);
    };

    return (
        <div className={`fk-s${props.klein ? ' fk-s-klein' : ''}${props.gesperrt ? ' fk-gesperrt' : ''}`}>
            <div
                ref={bahn}
                className={`fk-s-bahn${ziehend ? ' fk-zieht' : ''}`}
                onPointerDown={runter}
                onPointerMove={bewegen}
                onPointerUp={hoch}
                onPointerCancel={hoch}
            >
                <div className="fk-s-schiene" />
                <div
                    className="fk-s-fuellung"
                    style={{ width: stelle(anteil), background: props.farbe }}
                />
                {props.striche.map(s => (
                    <div
                        key={s}
                        className="fk-s-strich"
                        style={{ left: stelle((s - min) / (max - min)) }}
                    />
                ))}
                <div
                    ref={griff}
                    className="fk-s-griff"
                    role="slider"
                    tabIndex={props.gesperrt ? -1 : 0}
                    aria-label={props.name}
                    aria-valuemin={min}
                    aria-valuemax={max}
                    aria-valuenow={wert}
                    aria-valuetext={props.wertText}
                    aria-disabled={props.gesperrt || undefined}
                    style={{
                        left: stelle(anteil),
                        borderColor: props.farbe,
                        width: 2 * R,
                        height: 2 * R,
                        marginLeft: -R,
                    }}
                    onKeyDown={taste}
                >
                    <span className="fk-s-rillen" />
                </div>
            </div>
            <div
                className="fk-s-skala"
                aria-hidden="true"
            >
                {props.striche.map((s, i) => (
                    <span
                        key={s}
                        style={s === max ? { right: 0, transform: 'none' } : { left: stelle((s - min) / (max - min)) }}
                    >
                        {zahl(s, props.sprache)}
                        {i === props.striche.length - 1 ? ` ${props.einheit}` : ''}
                    </span>
                ))}
            </div>
        </div>
    );
}

interface Farben {
    flaeche: string;
    fokus: string;
    fehler: string;
}

interface AnsichtProps {
    /** Wert des Formulars: Liste der eigenen Stufen (leer = Vorlage bzw. Werksstufen) */
    wert: unknown;
    /** Stufen der Vorlage (`regelStufen`) - nur in der Geraetezeile gebraucht */
    vorlage?: unknown;
    /** Geraetezeile (leere Liste = es gilt die Vorlage) statt Vorlage (leere Liste = Werksstufen) */
    jeGeraet: boolean;
    /** woher eine Kopie stammt (Geraetename bzw. "Vorlage") */
    quelle: string;
    sprache: string;
    dunkel: boolean;
    farben: Farben;
    onWert: (stufen: Record<string, unknown>[]) => void;
    /** meldet dem Formular eine ungueltige Liste ('' = in Ordnung) - der Admin sperrt dann "Speichern" */
    onFehler?: (meldung: string) => void;
}

/** Die Karten - ohne jsonConfig, damit es sich einzeln rendern und pruefen laesst. */
export function StufenAnsicht(props: AnsichtProps): React.JSX.Element {
    const { sprache, farben, jeGeraet } = props;
    const t = (s: Schluessel, ...w: (string | number)[]): string => text(sprache, s, ...w);
    // Entwurf: was gerade gezogen oder getippt wurde, bis das Formular denselben Stand zeigt
    const [entwurf, setEntwurf] = useState<unknown[] | null>(null);
    const wertText = JSON.stringify(liste(props.wert));
    useEffect(() => setEntwurf(null), [wertText]);

    const eigeneRoh = entwurf || liste(props.wert);
    const eigene = eigeneRoh.length > 0;
    const vorlageRoh = liste(props.vorlage);
    const werk = useMemo(() => werksStufen(sprache), [sprache]);
    // gezeigt wird, was gilt: die eigenen Stufen, sonst die Vorlage, sonst die Werksstufen
    const roh: unknown[] = eigene ? eigeneRoh : jeGeraet && vorlageRoh.length ? vorlageRoh : werk;
    const nurLesen = jeGeraet && !eigene;
    const stufen = roh.map(lesen);
    const farbe = stufenFarben(
        stufen.map(s => s.id),
        props.dunkel,
    );

    /** Zeilen so, wie sie ins Formular gehoeren: unbekannte Felder bleiben, die ID steht fest drin */
    const zeilen = (): Record<string, unknown>[] =>
        roh.map((z, i) => ({ ...(z && typeof z === 'object' ? (z as object) : {}), ...stufen[i] }));
    const schreiben = (neu: Record<string, unknown>[]): void => {
        setEntwurf(neu);
        props.onWert(neu);
    };
    const aendern = (i: number, teil: Partial<Stufe>): void => {
        const alle = zeilen();
        alle[i] = { ...alle[i], ...teil };
        schreiben(alle);
    };
    const dazu = (): void => {
        const alle = zeilen();
        const ids = new Set(stufen.map(s => s.id));
        let n = alle.length + 1;
        while (ids.has(`stufe_${n}`)) {
            n++;
        }
        const neu: Stufe = {
            id: `stufe_${n}`,
            name: t('neuName', n),
            power: true,
            mode: 'heat',
            soll: 20,
            fan: 'auto',
            deckel: 100,
            bedarf: true,
            feuchte: true,
        };
        schreiben([...alle, { ...neu }]);
    };
    const weg = (i: number): void => schreiben(zeilen().filter((_z, n) => n !== i));

    // Pruefung wie szenenLesen() des Adapters - nur die eigene Liste kann falsch sein
    let fehlerText = '';
    let fehlerBei = -1;
    if (eigene) {
        // gleiche ID lehnt der Adapter ab; gleiche Namen waeren im Wochenplan nicht zu unterscheiden
        const gesehen = new Set<string>();
        for (const [i, s] of stufen.entries()) {
            const nameKlein = `name:${s.name.trim().toLowerCase()}`;
            if (!s.name.trim() || !s.id) {
                fehlerText = t('fName');
            } else if (gesehen.has(s.id) || gesehen.has(nameKlein)) {
                fehlerText = t('fDoppelt', s.name.trim());
            } else if (s.power && !(s.soll >= ZIEL.min && s.soll <= ZIEL.max)) {
                fehlerText = t('fZiel', s.name, zahl(ZIEL.min, sprache), zahl(ZIEL.max, sprache));
            } else if (!(s.deckel >= DECKEL.min && s.deckel <= DECKEL.max)) {
                fehlerText = t('fDeckel', s.name, zahl(DECKEL.min, sprache), zahl(DECKEL.max, sprache));
            }
            if (fehlerText) {
                fehlerBei = i;
                break;
            }
            gesehen.add(s.id);
            gesehen.add(nameKlein);
        }
    }
    const onFehler = props.onFehler;
    useEffect(() => {
        if (onFehler) {
            onFehler(fehlerText);
        }
    }, [fehlerText, onFehler]);

    return (
        <Box
            className={`fk-stufen${nurLesen ? ' fk-vorlage' : ''}`}
            sx={{
                width: '100%',
                color: 'text.primary',
                colorScheme: props.dunkel ? 'dark' : 'light',
                ...wertfeldStil(farben),
                '& .fk-st-raster': {
                    display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 250px), 1fr))',
                    gap: '12px',
                    alignItems: 'start',
                },
                '& .fk-st-karte': {
                    position: 'relative',
                    minWidth: 0,
                    border: '1px solid',
                    borderColor: 'divider',
                    borderLeft: '6px solid var(--fk-farbe)',
                    borderRadius: '10px',
                    background: farben.flaeche,
                    padding: '8px 12px 10px 10px',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '8px',
                },
                '& .fk-st-karte.fk-fehler': { borderColor: farben.fehler, borderLeftColor: 'var(--fk-farbe)' },
                '&.fk-vorlage .fk-st-karte': {
                    border: '1.5px dashed',
                    borderColor: 'text.secondary',
                    borderLeft: '6px solid var(--fk-farbe)',
                    opacity: 0.62,
                },
                '& .fk-st-kopf': { display: 'flex', alignItems: 'center', gap: '6px', minHeight: 34 },
                '& .fk-st-farbe': {
                    flex: '0 0 auto',
                    width: 14,
                    height: 14,
                    borderRadius: '50%',
                    background: 'var(--fk-farbe)',
                },
                '& .fk-st-name': {
                    position: 'relative',
                    flex: '1 1 auto',
                    minWidth: 0,
                    display: 'flex',
                    alignItems: 'center',
                },
                '& .fk-st-name input': {
                    width: '100%',
                    minWidth: 0,
                    font: 'inherit',
                    fontWeight: 600,
                    fontSize: '1.05rem',
                    color: 'inherit',
                    background: 'transparent',
                    border: 0,
                    borderBottom: '1px dashed transparent',
                    borderRadius: 0,
                    padding: '3px 20px 3px 2px',
                    outline: 'none',
                    textOverflow: 'ellipsis',
                },
                '& .fk-st-name input:hover:not(:disabled)': { borderBottomColor: 'text.secondary', cursor: 'text' },
                '& .fk-st-name input:focus': {
                    borderBottom: `1px solid ${farben.fokus}`,
                    boxShadow: `0 1px 0 0 ${farben.fokus}`,
                },
                '& .fk-st-name input[aria-invalid="true"]': { borderBottom: `1px solid ${farben.fehler}` },
                '& .fk-st-stift': {
                    position: 'absolute',
                    right: 2,
                    display: 'flex',
                    opacity: 0.4,
                    pointerEvents: 'none',
                    transition: 'opacity 0.12s',
                },
                '& .fk-st-name:hover .fk-st-stift, & .fk-st-name:focus-within .fk-st-stift': { opacity: 0.9 },
                '& .fk-st-zeile': {
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: '8px',
                },
                '& .fk-st-marke': { fontSize: '0.82rem', color: 'text.secondary' },
                '& .fk-st-hinweis': { fontSize: '0.75rem', color: 'text.secondary', lineHeight: 1.3 },
                '& .fk-st-deckelhinweis': { marginTop: '5px' },
                '& .fk-st-wahl': { display: 'flex', gap: '10px' },
                '& .fk-st-wahl label': {
                    flex: '1 1 0',
                    minWidth: 0,
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '2px',
                },
                '& .fk-st-wahl select': {
                    width: '100%',
                    minWidth: 0,
                    font: 'inherit',
                    fontSize: '0.9rem',
                    color: 'inherit',
                    background: 'transparent',
                    border: '1px solid',
                    borderColor: 'divider',
                    borderRadius: '6px',
                    padding: '4px 4px',
                    cursor: 'pointer',
                    outline: 'none',
                    textOverflow: 'ellipsis',
                },
                '& .fk-st-wahl select:hover:not(:disabled)': { borderColor: 'text.secondary' },
                '& .fk-st-wahl select:focus-visible': {
                    borderColor: farben.fokus,
                    boxShadow: `0 0 0 2px ${farben.fokus}55`,
                },
                '& .fk-st-wahl select:disabled': { cursor: 'default', opacity: 0.7 },
                '& .fk-st-wahl option': { background: farben.flaeche, color: 'inherit' },
                '& .fk-st-haken': { marginLeft: '-9px', marginRight: 0 },
                '& .fk-st-haken .MuiFormControlLabel-label': { fontSize: '0.88rem', lineHeight: 1.25 },
                '& .fk-st-schalter .MuiFormControlLabel-label': { fontSize: '0.9rem', marginLeft: '6px' },
                // Regler
                '& .fk-s': { width: '100%' },
                '& .fk-s-bahn': {
                    position: 'relative',
                    height: 30,
                    cursor: 'pointer',
                    touchAction: 'pan-y',
                    userSelect: 'none',
                },
                '& .fk-s-klein .fk-s-bahn': { height: 24 },
                '& .fk-s-schiene, & .fk-s-fuellung': {
                    position: 'absolute',
                    left: 0,
                    top: '50%',
                    height: 8,
                    marginTop: '-4px',
                    borderRadius: '4px',
                },
                '& .fk-s-klein .fk-s-schiene, & .fk-s-klein .fk-s-fuellung': { height: 6, marginTop: '-3px' },
                '& .fk-s-schiene': { right: 0, background: 'currentColor', opacity: 0.16 },
                '& .fk-s-strich': {
                    position: 'absolute',
                    top: '50%',
                    width: '1px',
                    height: 14,
                    marginTop: '-7px',
                    background: 'currentColor',
                    opacity: 0.22,
                    pointerEvents: 'none',
                },
                '& .fk-s-griff': {
                    position: 'absolute',
                    top: '50%',
                    transform: 'translateY(-50%)',
                    boxSizing: 'border-box',
                    borderRadius: '50%',
                    border: '3px solid',
                    background: farben.flaeche,
                    boxShadow: '0 1px 3px rgba(0,0,0,0.35)',
                    cursor: 'grab',
                    outline: 'none',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    transition: 'box-shadow 0.12s, transform 0.12s',
                },
                // Rillen: zeigen, dass man hier anfassen kann
                '& .fk-s-rillen': {
                    width: 6,
                    height: 8,
                    borderLeft: '1.5px solid currentColor',
                    borderRight: '1.5px solid currentColor',
                    opacity: 0.55,
                },
                '& .fk-s-klein .fk-s-rillen': { width: 4, height: 6 },
                '& .fk-s-bahn:hover .fk-s-griff': {
                    boxShadow:
                        '0 1px 3px rgba(0,0,0,0.35), 0 0 0 6px color-mix(in srgb, var(--fk-farbe) 25%, transparent)',
                    transform: 'translateY(-50%) scale(1.1)',
                },
                '& .fk-s-griff:focus-visible': { boxShadow: `0 0 0 2px ${farben.flaeche}, 0 0 0 5px ${farben.fokus}` },
                '& .fk-s-bahn.fk-zieht, & .fk-s-bahn.fk-zieht .fk-s-griff': { cursor: 'grabbing' },
                '& .fk-s-bahn.fk-zieht .fk-s-griff': {
                    boxShadow:
                        '0 2px 6px rgba(0,0,0,0.4), 0 0 0 8px color-mix(in srgb, var(--fk-farbe) 32%, transparent)',
                    transform: 'translateY(-50%) scale(1.15)',
                },
                '& .fk-s.fk-gesperrt .fk-s-bahn, & .fk-s.fk-gesperrt .fk-s-griff': { cursor: 'default' },
                '& .fk-s.fk-gesperrt .fk-s-bahn:hover .fk-s-griff': {
                    boxShadow: '0 1px 3px rgba(0,0,0,0.35)',
                    transform: 'translateY(-50%)',
                },
                '& .fk-s.fk-gesperrt .fk-s-rillen': { visibility: 'hidden' },
                '& .fk-s-skala': { position: 'relative', height: 14, fontSize: '0.68rem', color: 'text.secondary' },
                '& .fk-s-skala span': { position: 'absolute', transform: 'translateX(-50%)', whiteSpace: 'nowrap' },
                '& .fk-st-dazu': {
                    minHeight: 96,
                    border: '2px dashed',
                    borderColor: 'divider',
                    borderRadius: '10px',
                    color: 'text.secondary',
                    textTransform: 'none',
                    fontSize: '0.95rem',
                    gap: '6px',
                },
                '& .fk-st-dazu:hover': { borderColor: farben.fokus, color: farben.fokus },
                '& .fk-st-band': {
                    display: 'flex',
                    flexWrap: 'wrap',
                    alignItems: 'center',
                    gap: '8px 14px',
                    mb: 1.25,
                    px: 1.5,
                    py: 1,
                    border: '1px dashed',
                    borderColor: 'divider',
                    borderRadius: '8px',
                },
                '@media (prefers-reduced-motion: reduce)': { '& .fk-s-griff': { transition: 'none' } },
            }}
        >
            <Typography
                variant="body2"
                color="text.secondary"
                className="fk-st-einleitung"
                sx={{ mb: 1.25, maxWidth: 760 }}
            >
                {t('einleitung')}
            </Typography>
            {nurLesen ? (
                <div className="fk-st-band">
                    <Typography
                        variant="body2"
                        sx={{ flex: '1 1 240px' }}
                    >
                        {t('vorlageGilt')}
                    </Typography>
                    <Button
                        className="fk-st-eigene"
                        variant="contained"
                        size="small"
                        sx={{ textTransform: 'none' }}
                        onClick={() => schreiben(zeilen())}
                    >
                        {t('eigene')}
                    </Button>
                </div>
            ) : null}
            <div className="fk-st-raster">
                {stufen.map((s, i) => {
                    const an = s.power;
                    const nameFehler =
                        fehlerBei === i && (fehlerText === t('fName') || fehlerText === t('fDoppelt', s.name.trim()));
                    return (
                        <div
                            key={i}
                            className={`fk-st-karte${fehlerBei === i ? ' fk-fehler' : ''}`}
                            data-stufe={s.id}
                            style={{ '--fk-farbe': farbe[i] } as React.CSSProperties}
                        >
                            <div className="fk-st-kopf">
                                <span className="fk-st-farbe" />
                                <Tooltip
                                    title={nurLesen ? '' : t('umbenennen')}
                                    enterDelay={600}
                                >
                                    <span className="fk-st-name">
                                        <input
                                            type="text"
                                            aria-label={t('name')}
                                            aria-invalid={nameFehler || undefined}
                                            disabled={nurLesen}
                                            value={s.name}
                                            maxLength={40}
                                            onChange={e => aendern(i, { name: e.target.value })}
                                            onKeyDown={e => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
                                        />
                                        {nurLesen ? null : (
                                            <span className="fk-st-stift">
                                                <EditIcon klein />
                                            </span>
                                        )}
                                    </span>
                                </Tooltip>
                                {nurLesen ? null : (
                                    <Tooltip title={stufen.length > 1 ? t('entfernen') : t('entfernenLetzte')}>
                                        <span>
                                            <IconButton
                                                size="small"
                                                className="fk-st-weg"
                                                aria-label={`${t('entfernen')}: ${s.name}`}
                                                disabled={stufen.length <= 1}
                                                onClick={() => weg(i)}
                                            >
                                                <DeleteIcon />
                                            </IconButton>
                                        </span>
                                    </Tooltip>
                                )}
                            </div>
                            <FormControlLabel
                                className="fk-st-schalter"
                                sx={{ ml: '-6px', mr: 0 }}
                                control={
                                    <Switch
                                        size="small"
                                        checked={an}
                                        disabled={nurLesen}
                                        onChange={e => aendern(i, { power: e.target.checked })}
                                    />
                                }
                                label={an ? t('anlageAn') : t('anlageAus')}
                            />
                            {an ? (
                                <>
                                    <div>
                                        <div className="fk-st-zeile">
                                            <span className="fk-st-marke">{t('ziel')}</span>
                                            <Wertfeld
                                                wert={s.soll}
                                                min={ZIEL.min}
                                                max={ZIEL.max}
                                                schritt={ZIEL.schritt}
                                                stellen={1}
                                                einheit="°C"
                                                name={`${t('ziel')}: ${s.name}`}
                                                sprache={sprache}
                                                gesperrt={nurLesen}
                                                fehler={!(s.soll >= ZIEL.min && s.soll <= ZIEL.max)}
                                                onWert={n => aendern(i, { soll: n })}
                                            />
                                        </div>
                                        <Schieber
                                            wert={s.soll}
                                            min={ZIEL.min}
                                            max={ZIEL.max}
                                            schritt={ZIEL.schritt}
                                            farbe={farbe[i]}
                                            name={`${t('ziel')}: ${s.name}`}
                                            wertText={`${zahl(s.soll, sprache, 1)} °C`}
                                            striche={[10, 15, 20, 25, 30]}
                                            einheit="°C"
                                            sprache={sprache}
                                            gesperrt={nurLesen}
                                            onWert={n => aendern(i, { soll: n })}
                                        />
                                    </div>
                                    <div className="fk-st-wahl">
                                        <label>
                                            <span className="fk-st-marke">{t('betriebsart')}</span>
                                            <select
                                                className="fk-st-mode"
                                                value={s.mode}
                                                disabled={nurLesen}
                                                onChange={e => aendern(i, { mode: e.target.value })}
                                            >
                                                {MODI.map(m => (
                                                    <option
                                                        key={m}
                                                        value={m}
                                                    >
                                                        {t(`mode_${m}`)}
                                                    </option>
                                                ))}
                                            </select>
                                        </label>
                                        <label>
                                            <span className="fk-st-marke">{t('luefter')}</span>
                                            <select
                                                className="fk-st-fan"
                                                value={s.fan}
                                                disabled={nurLesen}
                                                onChange={e => aendern(i, { fan: e.target.value })}
                                            >
                                                {LUEFTER.map(f => (
                                                    <option
                                                        key={f}
                                                        value={f}
                                                    >
                                                        {t(`fan_${f}`)}
                                                    </option>
                                                ))}
                                            </select>
                                        </label>
                                    </div>
                                    <div>
                                        <Tooltip
                                            title={t('bedarfTipp')}
                                            enterDelay={400}
                                            placement="top-start"
                                        >
                                            <FormControlLabel
                                                className="fk-st-haken fk-st-bedarf"
                                                control={
                                                    <Checkbox
                                                        size="small"
                                                        checked={s.bedarf}
                                                        disabled={nurLesen}
                                                        onChange={e => aendern(i, { bedarf: e.target.checked })}
                                                    />
                                                }
                                                label={t('bedarf')}
                                            />
                                        </Tooltip>
                                        {s.bedarf ? (
                                            <>
                                                <div className="fk-st-zeile">
                                                    <span className="fk-st-marke">{t('deckel')}</span>
                                                    <Wertfeld
                                                        wert={s.deckel}
                                                        min={DECKEL.min}
                                                        max={DECKEL.max}
                                                        schritt={DECKEL.schritt}
                                                        stellen={0}
                                                        einheit="%"
                                                        name={`${t('deckel')}: ${s.name}`}
                                                        sprache={sprache}
                                                        gesperrt={nurLesen}
                                                        fehler={!(s.deckel >= DECKEL.min && s.deckel <= DECKEL.max)}
                                                        onWert={n => aendern(i, { deckel: n })}
                                                    />
                                                </div>
                                                <Schieber
                                                    klein
                                                    wert={s.deckel}
                                                    min={DECKEL.min}
                                                    max={DECKEL.max}
                                                    schritt={DECKEL.schritt}
                                                    farbe={farbe[i]}
                                                    name={`${t('deckel')}: ${s.name}`}
                                                    wertText={`${zahl(s.deckel, sprache)} %`}
                                                    striche={[30, 50, 75, 100]}
                                                    einheit="%"
                                                    sprache={sprache}
                                                    gesperrt={nurLesen}
                                                    onWert={n => aendern(i, { deckel: n })}
                                                />
                                                <div className="fk-st-hinweis fk-st-deckelhinweis">
                                                    {t('deckelHinweis')}
                                                </div>
                                            </>
                                        ) : (
                                            <div className="fk-st-hinweis fk-st-ungeregelt">{t('ungeregelt')}</div>
                                        )}
                                    </div>
                                    <Tooltip
                                        title={t('feuchteTipp')}
                                        enterDelay={400}
                                        placement="top-start"
                                    >
                                        <FormControlLabel
                                            className="fk-st-haken fk-st-feuchte"
                                            control={
                                                <Checkbox
                                                    size="small"
                                                    checked={s.feuchte}
                                                    disabled={nurLesen}
                                                    onChange={e => aendern(i, { feuchte: e.target.checked })}
                                                />
                                            }
                                            label={t('feuchte')}
                                        />
                                    </Tooltip>
                                </>
                            ) : (
                                <div className="fk-st-hinweis fk-st-aushinweis">{t('ausHinweis')}</div>
                            )}
                        </div>
                    );
                })}
                {nurLesen ? null : (
                    <Button
                        className="fk-st-dazu"
                        onClick={dazu}
                    >
                        <AddIcon />
                        {t('hinzu')}
                    </Button>
                )}
            </div>
            {fehlerText ? (
                <Box
                    className="fk-fehler-text"
                    role="alert"
                    sx={{
                        mt: 1,
                        px: 1.25,
                        py: 0.75,
                        maxWidth: 640,
                        borderRadius: '6px',
                        border: `1px solid ${farben.fehler}`,
                        color: farben.fehler,
                        fontSize: '0.9em',
                    }}
                >
                    {fehlerText}
                </Box>
            ) : null}
            {nurLesen ? null : (
                <Typography
                    variant="caption"
                    color="text.secondary"
                    className="fk-st-fuss"
                    sx={{ display: 'block', mt: 1 }}
                >
                    {!eigene && !jeGeraet ? `${t('werk')} ` : ''}
                    {t('ziehHinweis')} {t('planHinweis')}
                </Typography>
            )}
            <Werkzeugleiste
                art="stufen"
                inhalt={zeilen()}
                onEinfuegen={inhalt => {
                    if (Array.isArray(inhalt) && inhalt.length) {
                        schreiben(inhalt.map(z => ({ ...(z as object), ...lesen(z) })));
                    }
                }}
                onZuruecksetzen={() => schreiben([])}
                zuruecksetzenText={jeGeraet ? t('zuruecksetzenGeraet') : t('zuruecksetzenVorlage')}
                istVorlage={!jeGeraet}
                quelle={props.quelle}
                sprache={sprache}
            />
        </Box>
    );
}

/** jsonConfig-Komponente "Stufen": Attribut `regelStufen` (Vorlage) oder `stufen` (Geraetezeile). */
class Stufen extends ConfigGeneric<ConfigGenericProps, ConfigGenericState> {
    onWert = (stufen: Record<string, unknown>[]): void => {
        if (this.props.attr) {
            void this.onChange(this.props.attr, stufen);
        }
    };

    letzterFehler = '';
    onFehler = (meldung: string): void => {
        if (this.props.attr && meldung !== this.letzterFehler) {
            this.letzterFehler = meldung;
            this.onError(this.props.attr, meldung || undefined);
        }
    };

    componentWillUnmount(): void {
        // ein zugeklappter oder geloeschter Eintrag darf das Formular nicht gesperrt zuruecklassen
        if (this.props.attr && this.letzterFehler) {
            this.letzterFehler = '';
            this.onError(this.props.attr, undefined);
        }
        super.componentWillUnmount?.();
    }

    renderItem(): React.JSX.Element {
        const props = this.props;
        const data = (props.data || {}) as Record<string, unknown>;
        const global = (props.globalData || {}) as Record<string, unknown>;
        const sprache = I18n.getLanguage();
        // Zeile eines Geraets (Accordion): leere Liste = Vorlage der Instanz
        const jeGeraet = !!props.attr && !props.attr.startsWith('regel');
        const palette = props.oContext?.theme?.palette;
        const label = props.schema?.label;
        return (
            <Box sx={{ width: '100%' }}>
                {typeof label === 'string' && label ? (
                    <Typography
                        variant="h6"
                        component="div"
                        sx={{ fontSize: '1.05rem', mb: 0.5 }}
                    >
                        {I18n.t(label)}
                    </Typography>
                ) : null}
                <StufenAnsicht
                    wert={ConfigGeneric.getValue(props.data, props.attr as string)}
                    vorlage={jeGeraet ? global.regelStufen : undefined}
                    jeGeraet={jeGeraet}
                    quelle={jeGeraet ? String(data.name || data.geraet || '') : text(sprache, 'quelleVorlage')}
                    sprache={sprache}
                    dunkel={(props.oContext?.themeType || palette?.mode) === 'dark'}
                    farben={{
                        flaeche: palette?.background?.paper || '#fff',
                        fokus: palette?.primary?.main || '#3399cc',
                        fehler: palette?.error?.main || '#d9534f',
                    }}
                    onWert={this.onWert}
                    onFehler={this.onFehler}
                />
            </Box>
        );
    }
}

export default Stufen;
