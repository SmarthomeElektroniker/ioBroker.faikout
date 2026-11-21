/*
 * Kennlinie der Bedarfsregelung zum Anfassen: das Bild mit ziehbaren Stuetzpunkten und daneben die
 * Tabelle derselben Punkte. Beides zeigt denselben Wert des Formulars - wer zieht, sieht die Zahlen
 * in der Tabelle laufen, wer tippt, sieht den Punkt wandern. Geschrieben wird nur ins Formular
 * (onChange): "Speichern" der Instanz uebernimmt, "Schliessen" verwirft.
 *
 * Die Regeln (Raster, Grenzen durch die Nachbarpunkte, Pruefung) stehen in lib/kennlinienzug.js,
 * Achse und Farben kommen aus derselben Datei wie das Bild der Geraetekarte und der VIS-Baustein
 * (lib/kennlinienbild.js). Der Arbeitspunkt des Geraets kommt vom Adapter (sendTo regelArbeitspunkt).
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    Box,
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

export type Richtung = 'heizen' | 'kuehlen';
interface Punkt {
    x: number;
    y: number;
}
interface Etikett {
    x: number;
    wert: number | null;
    text?: string;
    unterzeile?: string;
}
interface Fehler {
    schluessel: string;
    n?: number;
}

const zug = zugLib as {
    RASTER: { x: number; y: number };
    GRENZEN: { xMin: number; xMax: number; yMin: number; yMax: number };
    VORGABE: Record<Richtung, Punkt[]>;
    punkte(roh: unknown): Punkt[];
    pruefen(p: Punkt[], richtung: Richtung): Fehler | null;
    ziehen(p: Punkt[], i: number, ziel: Partial<Punkt>, richtung: Richtung, rahmen?: object): Punkt[];
    schritt(p: Punkt[], i: number, dx: number, dy: number, richtung: Richtung): Punkt[];
    hinzu(p: Punkt[]): { punkte: Punkt[]; neu: number };
    anzeige(n: number, sprache?: string): string;
    etikett(p: Punkt, sprache?: string): string;
};
const bild = bildLib as {
    FARBEN: Record<Richtung, string>;
    achse(punkte: number[][], x?: number | null): { min: number; max: number; schritt: number };
    wertAuf(punkte: number[][], x: number): number;
};

// Die drei Symbole als Pfade (Material Icons) - so braucht das Paket keine eigene Kopie der Symbolbibliothek.
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
const RestartAltIcon = symbol(
    'M12 5V2L8 6l4 4V7c3.31 0 6 2.69 6 6 0 2.97-2.17 5.43-5 5.91v2.02c3.95-.49 7-3.85 7-7.93 0-4.42-3.58-8-8-8m-6 8c0-1.65.67-3.15 1.76-4.24L6.34 7.34C4.9 8.79 4 10.79 4 13c0 4.08 3.05 7.44 7 7.93v-2.02c-2.83-.48-5-2.94-5-5.91',
);

/** Zeichenflaeche (viewBox) - dieselben Masse wie das bisherige Bild. */
const B = 640;
const H = 300;
const RAND = { l: 44, r: 14, o: 14, u: 28 };
const W = B - RAND.l - RAND.r;
const HH = H - RAND.o - RAND.u;

/** Text der Komponente (admin/custom/i18n), Platzhalter %s. */
export function t(schluessel: string, ...werte: (string | number)[]): string {
    return I18n.t(`fk_${schluessel}`, ...(werte as string[]));
}

const istLeer = (v: unknown): boolean => v === undefined || v === null || v === '';
const zahlOder = (v: unknown, sonst: number): number => (istLeer(v) || !Number.isFinite(Number(v)) ? sonst : Number(v));
const gleich = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

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
    untergrenze: number;
    obergrenze: number;
    /** Arbeitspunkt mit Beschriftung oder null */
    arbeitspunkt: Etikett | null;
    sprache: string;
    /** Farben des Admin-Themas */
    farben: { flaeche: string; fokus: string; fehler: string };
    /** das Geraet darf zur Vorgabe zurueck (Liste leeren) */
    mitVorgabe: boolean;
    onWert: (zeilen: Punkt[]) => void;
}

/** Bild und Tabelle - ohne jsonConfig, damit es sich einzeln rendern und pruefen laesst. */
export function KennlinieAnsicht(props: AnsichtProps): React.JSX.Element {
    const { richtung, sprache, farben } = props;
    const akzent = bild.FARBEN[richtung];
    const svg = useRef<SVGSVGElement | null>(null);
    // Entwurf: was gerade gezogen oder getippt wurde, bis das Formular denselben Stand zeigt
    const [entwurf, setEntwurf] = useState<unknown[] | null>(null);
    const [aktiv, setAktiv] = useState(-1);
    const [zeile, setZeile] = useState(-1);
    const [tastatur, setTastatur] = useState(false);
    const zieht = useRef<{ i: number; achse: { min: number; max: number; schritt: number }; zeiger: number } | null>(
        null,
    );
    const [ziehend, setZiehend] = useState(-1);

    const wertText = JSON.stringify(Array.isArray(props.wert) ? props.wert : []);
    useEffect(() => {
        if (!zieht.current) {
            setEntwurf(null);
        }
    }, [wertText]);

    const roh: unknown[] = entwurf || (Array.isArray(props.wert) ? props.wert : []);
    const eigene = roh.length > 0;
    const zeilen = useMemo(() => zug.punkte(roh), [JSON.stringify(roh)]);
    const fehler = eigene ? zug.pruefen(zeilen, richtung) : null;
    // gezeichnet wird, was gilt: die eigenen Punkte oder - bei leerer Liste - die Vorgabe
    const punkte: Punkt[] = eigene ? zeilen : props.vorgabe;
    const gueltig = !fehler && !zug.pruefen(punkte, richtung);
    const sauber = punkte
        .filter(p => Number.isFinite(p.x) && Number.isFinite(p.y))
        .map(p => [p.x, p.y])
        .sort((a, b) => a[0] - b[0]);
    const ap = gueltig && props.arbeitspunkt && Number.isFinite(Number(props.arbeitspunkt.x)) ? props.arbeitspunkt : null;
    const a = zieht.current ? zieht.current.achse : bild.achse(sauber.length ? sauber : [[0, 0]], ap ? Number(ap.x) : null);
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
    const stelle = (e: React.PointerEvent): Punkt => {
        const r = (svg.current as SVGSVGElement).getBoundingClientRect();
        const px = ((e.clientX - r.left) / r.width) * B;
        const py = ((e.clientY - r.top) / r.height) * H;
        const achse = zieht.current ? zieht.current.achse : a;
        return {
            x: achse.min + ((px - RAND.l) / W) * (achse.max - achse.min),
            y: (1 - (py - RAND.o) / HH) * 100,
        };
    };

    const greifen = (i: number) => (e: React.PointerEvent<SVGGElement>) => {
        if (!gueltig || (e.pointerType === 'mouse' && e.button !== 0)) {
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
        // der erste Zug an einer leeren Liste uebernimmt so die Vorgabe als Startwert
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
    const taste = (i: number) => (e: React.KeyboardEvent<SVGGElement>) => {
        const wege: Record<string, [number, number]> = {
            ArrowLeft: [-1, 0],
            ArrowRight: [1, 0],
            ArrowUp: [0, 1],
            ArrowDown: [0, -1],
        };
        const weg = wege[e.key];
        if (!weg || !gueltig) {
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

    // Tabelle
    const feld = (i: number, achse: 'x' | 'y', wert: number | ''): void => {
        const neu = roh.map((z, n) => {
            const alt = (z || {}) as { x: unknown; y: unknown };
            return n === i ? { x: alt.x, y: alt.y, [achse]: wert } : { x: alt.x, y: alt.y };
        });
        schreiben(neu as Punkt[]);
    };
    const dazu = (): void => {
        if (!eigene) {
            schreiben(props.vorgabe.map(p => ({ x: p.x, y: p.y })));
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

    // Zeichnung
    const linie = sauber.length >= 2 ? [[a.min, sauber[0][1]], ...sauber, [a.max, sauber[sauber.length - 1][1]]] : [];
    const pfad = linie.map(([x, y], i) => `${i ? 'L' : 'M'}${X(x).toFixed(1)} ${Y(y).toFixed(1)}`).join(' ');
    const unter = props.untergrenze;
    const ober = props.obergrenze;
    const blass = !eigene;
    const zeigeEtikett = ziehend >= 0 ? ziehend : tastatur ? aktiv : -1;
    const hervor = ziehend >= 0 ? ziehend : aktiv >= 0 ? aktiv : zeile;

    const xStriche: number[] = [];
    for (let x = a.min; x <= a.max; x += a.schritt) {
        xStriche.push(x);
    }

    let apBild: React.JSX.Element | null = null;
    if (ap && sauber.length >= 2) {
        const x = Math.min(a.max, Math.max(a.min, Number(ap.x)));
        const aufLinie = bild.wertAuf(sauber, x);
        const wert = ap.wert !== null && Number.isFinite(Number(ap.wert)) ? Number(ap.wert) : null;
        const links = X(x) > RAND.l + W * 0.55;
        const tx = X(x) + (links ? -10 : 10);
        const boden = Math.min(...sauber.map(p => p[1]), unter);
        const ty =
            boden >= 22
                ? (Y(boden) + Y(0)) / 2 - 3
                : Math.min(Y(0) - 22, Math.max(RAND.o + 14, Y(wert === null ? aufLinie : wert) + 22));
        apBild = (
            <g pointerEvents="none">
                <line
                    x1={X(x)}
                    x2={X(x)}
                    y1={Y(100)}
                    y2={Y(0)}
                    stroke="currentColor"
                    strokeOpacity="0.5"
                    strokeDasharray="2 3"
                />
                <circle
                    cx={X(x)}
                    cy={Y(aufLinie)}
                    r="5.5"
                    fill="none"
                    stroke={akzent}
                    strokeWidth="2"
                />
                {wert !== null ? (
                    <>
                        <line
                            x1={X(x)}
                            x2={X(x)}
                            y1={Y(aufLinie)}
                            y2={Y(wert)}
                            stroke="currentColor"
                            strokeWidth="1.5"
                        />
                        <circle
                            cx={X(x)}
                            cy={Y(wert)}
                            r="5"
                            fill="currentColor"
                        />
                    </>
                ) : null}
                {ap.text ? (
                    <text
                        x={tx}
                        y={ty}
                        textAnchor={links ? 'end' : 'start'}
                        fontSize="12"
                        fontWeight="700"
                    >
                        {ap.text}
                    </text>
                ) : null}
                {ap.text && ap.unterzeile ? (
                    <text
                        x={tx}
                        y={ty + 14}
                        textAnchor={links ? 'end' : 'start'}
                        fillOpacity="0.75"
                    >
                        {ap.unterzeile}
                    </text>
                ) : null}
            </g>
        );
    }

    let etikett: React.JSX.Element | null = null;
    if (zeigeEtikett >= 0 && gueltig && punkte[zeigeEtikett]) {
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

    const meldungen: string[] = [];
    if (fehler) {
        meldungen.push(fehler.n ? t(fehler.schluessel, fehler.n) : t(fehler.schluessel));
    }
    if (!(unter >= 30 && unter <= ober && ober <= 100)) {
        meldungen.push(t('fGrenzen'));
    }

    return (
        <Box
            className="fk-kennlinie"
            data-richtung={richtung}
            sx={{
                width: '100%',
                color: 'text.primary',
                '& .fk-reihe': { display: 'flex', flexWrap: 'wrap', gap: 2, alignItems: 'flex-start' },
                '& .fk-bild': { flex: '1 1 420px', minWidth: 0, maxWidth: 640 },
                '& .fk-tabelle': { flex: '0 1 300px', minWidth: 220 },
                '& svg': { display: 'block', width: '100%', height: 'auto', userSelect: 'none' },
                '& svg.fk-zieht, & svg.fk-zieht .fk-griff': { cursor: 'grabbing' },
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
                '& .fk-zahl[aria-invalid="true"]': { borderBottomColor: farben.fehler },
                '& tr.fk-hervor': { backgroundColor: 'action.hover' },
                '@media (prefers-reduced-motion: reduce)': {
                    '& .fk-griff .fk-punkt, & .fk-griff .fk-hof': { transition: 'none' },
                },
            }}
        >
            <Typography
                variant="h6"
                component="div"
                sx={{ fontSize: '1.05rem', mb: 0.5 }}
            >
                {props.titel}
            </Typography>
            <div className="fk-reihe">
                <div className="fk-bild">
                    <svg
                        ref={svg}
                        className={ziehend >= 0 ? 'fk-zieht' : undefined}
                        xmlns="http://www.w3.org/2000/svg"
                        viewBox={`0 0 ${B} ${H}`}
                        role="group"
                        aria-label={props.titel}
                        fontSize="11"
                        fill="currentColor"
                    >
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
                                    {zug.anzeige(x, sprache)}
                                    {x + a.schritt > a.max ? ' °C' : ''}
                                </text>
                            </g>
                        ))}
                        {unter > 0 ? (
                            <rect
                                x={RAND.l}
                                y={Y(unter)}
                                width={W}
                                height={Y(0) - Y(unter)}
                                fill="currentColor"
                                fillOpacity="0.08"
                            />
                        ) : null}
                        {ober < 100 ? (
                            <rect
                                x={RAND.l}
                                y={Y(100)}
                                width={W}
                                height={Y(ober) - Y(100)}
                                fill="currentColor"
                                fillOpacity="0.08"
                            />
                        ) : null}
                        {pfad ? (
                            <>
                                <path
                                    d={`${pfad} L${X(a.max)} ${Y(0)} L${X(a.min)} ${Y(0)} Z`}
                                    fill={akzent}
                                    fillOpacity={blass ? 0.06 : 0.12}
                                />
                                <path
                                    className="fk-linie"
                                    d={pfad}
                                    fill="none"
                                    stroke={akzent}
                                    strokeOpacity={blass ? 0.55 : 1}
                                    strokeWidth="2.4"
                                    strokeLinejoin="round"
                                    strokeLinecap="round"
                                    strokeDasharray={blass ? '7 5' : undefined}
                                />
                            </>
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
                        {[
                            [unter, t('untergrenze'), false] as const,
                            [ober, t('obergrenze'), true] as const,
                        ].map(([y, text, oben]) => (
                            <g
                                key={text}
                                pointerEvents="none"
                            >
                                <line
                                    x1={RAND.l}
                                    x2={B - RAND.r}
                                    y1={Y(y)}
                                    y2={Y(y)}
                                    stroke="currentColor"
                                    strokeOpacity="0.55"
                                    strokeDasharray="5 4"
                                />
                                <text
                                    x={B - RAND.r - 4}
                                    y={Y(y) + (oben ? 13 : -5)}
                                    textAnchor="end"
                                    fillOpacity="0.75"
                                >
                                    {text} {zug.anzeige(y, sprache)} %
                                </text>
                            </g>
                        ))}
                        {apBild}
                        {punkte.map((p, i) =>
                            Number.isFinite(p.x) && Number.isFinite(p.y) ? (
                                <g
                                    key={i}
                                    className={`fk-griff${gueltig ? '' : ' fk-starr'}${hervor === i ? ' fk-aktiv' : ''}`}
                                    data-punkt={i}
                                    role={gueltig ? 'slider' : undefined}
                                    tabIndex={gueltig ? 0 : undefined}
                                    aria-label={gueltig ? t('punkt', i + 1) : undefined}
                                    aria-orientation={gueltig ? 'vertical' : undefined}
                                    aria-valuemin={gueltig ? 0 : undefined}
                                    aria-valuemax={gueltig ? 100 : undefined}
                                    aria-valuenow={gueltig ? p.y : undefined}
                                    aria-valuetext={gueltig ? zug.etikett(p, sprache) : undefined}
                                    onPointerDown={greifen(i)}
                                    onPointerMove={bewegen}
                                    onPointerUp={loslassen}
                                    onPointerCancel={loslassen}
                                    onKeyDown={taste(i)}
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
                                        r={gueltig ? 7 : 4.5}
                                        fill={farben.flaeche}
                                        stroke={akzent}
                                        strokeOpacity={blass ? 0.7 : 1}
                                        strokeWidth="2.6"
                                    />
                                </g>
                            ) : null,
                        )}
                        {etikett}
                    </svg>
                </div>
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
                                    {props.mitVorgabe && eigene ? (
                                        <Tooltip title={t('zurVorgabe')}>
                                            <IconButton
                                                size="small"
                                                className="fk-vorgabe"
                                                aria-label={t('zurVorgabe')}
                                                onClick={() => schreiben([])}
                                            >
                                                <RestartAltIcon />
                                            </IconButton>
                                        </Tooltip>
                                    ) : null}
                                    <Tooltip title={t('punktDazu')}>
                                        <IconButton
                                            size="small"
                                            color="primary"
                                            className="fk-dazu"
                                            aria-label={t('punktDazu')}
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
                            {!eigene ? (
                                <TableRow>
                                    <TableCell
                                        colSpan={3}
                                        className="fk-leer"
                                        sx={{ color: 'text.secondary' }}
                                    >
                                        {t('vorgabeGilt')}
                                    </TableCell>
                                </TableRow>
                            ) : null}
                        </TableBody>
                    </Table>
                </div>
            </div>
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
            <Typography
                variant="caption"
                color="text.secondary"
                className="fk-hinweis"
                sx={{ display: 'block', mt: 0.75 }}
            >
                {t('hinweis')}
            </Typography>
        </Box>
    );
}

/** Welche Felder des Formulars zu einer Kennlinie gehoeren. */
function felder(props: ConfigGenericProps, richtung: Richtung): {
    vorgabe: Punkt[];
    untergrenze: number;
    obergrenze: number;
    geraet: string;
    mitVorgabe: boolean;
} {
    const data = (props.data || {}) as Record<string, unknown>;
    const global = (props.globalData || {}) as Record<string, unknown>;
    const vorgabeAttr = richtung === 'kuehlen' ? 'regelKennlinieKuehlen' : 'regelKennlinieHeizen';
    // Zeile eines Geraets (Accordion): leere Liste = Vorgabe der Instanz. In der Vorgabe selbst gilt
    // bei leerer Liste die Werksvorgabe.
    const jeGeraet = !!props.attr && !props.attr.startsWith('regel');
    const liste = jeGeraet ? zug.punkte(global[vorgabeAttr]) : [];
    const vorgabe = liste.length && !zug.pruefen(liste, richtung) ? liste : zug.VORGABE[richtung];
    const grundUnter = zahlOder((jeGeraet ? global : data).regelUntergrenze, 40);
    const grundOber = zahlOder((jeGeraet ? global : data).regelObergrenze, 95);
    return {
        vorgabe,
        untergrenze: jeGeraet ? zahlOder(data.untergrenze, grundUnter) : grundUnter,
        obergrenze: jeGeraet ? zahlOder(data.obergrenze, grundOber) : grundOber,
        geraet: jeGeraet && typeof data.geraet === 'string' ? data.geraet : '',
        mitVorgabe: jeGeraet,
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
                        setPunkt((antwort && antwort.etikett && antwort.etikett[richtung]) || null);
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

function KennlinieFeld(props: ConfigGenericProps & { richtung: Richtung; onWert: (zeilen: Punkt[]) => void }): React.JSX.Element {
    const f = felder(props, props.richtung);
    const punkt = useArbeitspunkt(props, f.geraet, f.obergrenze, props.richtung);
    const palette = props.oContext?.theme?.palette;
    const label = props.schema?.label;
    return (
        <KennlinieAnsicht
            richtung={props.richtung}
            titel={typeof label === 'string' ? I18n.t(label) : ''}
            wert={ConfigGeneric.getValue(props.data, props.attr as string)}
            vorgabe={f.vorgabe}
            untergrenze={f.untergrenze}
            obergrenze={f.obergrenze}
            arbeitspunkt={punkt}
            sprache={I18n.getLanguage()}
            farben={{
                flaeche: palette?.background?.paper || '#fff',
                fokus: palette?.primary?.main || '#3399cc',
                fehler: palette?.error?.main || '#d9534f',
            }}
            mitVorgabe={f.mitVorgabe}
            onWert={props.onWert}
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

    renderItem(): React.JSX.Element {
        return (
            <KennlinieFeld
                {...this.props}
                richtung={this.richtung}
                onWert={this.onWert}
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
