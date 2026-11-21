/*
 * Erklaergrafik der Feuchteregelung mit ziehbaren Grenzen. Zwei Skalen, beide mit "trocken" links
 * und "feucht" rechts: der Abstand zum Taupunkt (Raum - Taupunkt; je kleiner, desto schwueler -
 * deshalb laeuft diese Achse von gross nach klein) und die relative Feuchte. Auf jeder Skala
 * stehen zwei Linien: "Ein" (ab hier greift die Regelung ein) und "Aus" (erst jenseits davon hoert
 * sie auf); dazwischen liegt das schraffierte Band, in dem sich nichts aendert.
 *
 * Bedeutung der Werte wie lib/regel/feuchte.js: Eingriff, wenn Abstand < dtpEin ODER Feuchte > rhEin;
 * Ende, wenn Abstand > dtpAus UND Feuchte < rhAus (und die Mindestlaufzeit um ist).
 *
 * Geschrieben wird nur ins Formular (regelFeuchteDtpEin/-Aus, regelFeuchteRhEin/-Aus); die Massnahme
 * (regelFeuchteMassnahme) wird nur gelesen und je Betriebsart erklaert (Heizen/Kuehlen/Entfeuchten/aus). Die Punkte sind die Messwerte der
 * Geraete (sendTo regelUebersicht, alle 15 s).
 */
import React, { useEffect, useId, useRef, useState } from 'react';
import { Box, Typography } from '@mui/material';
import { I18n } from '@iobroker/gui-components';
import { ConfigGeneric, type ConfigGenericProps, type ConfigGenericState } from '@iobroker/json-config';

import Werkzeugleiste from './Werkzeugleiste';
import { Wertfeld, wertfeldStil, zahl } from './Stufen';
import { t as stufenText } from './Stufen.texte';
import { t as text, type Schluessel } from './Feuchte.texte';

export interface Grenzen {
    dtpEin: number;
    dtpAus: number;
    rhEin: number;
    rhAus: number;
}
/** wie lib/regel/feuchte.js VORGABEN */
export const WERK: Grenzen = { dtpEin: 4, dtpAus: 6, rhEin: 65, rhAus: 58 };
/** Formularfelder der vier Grenzen */
export const ATTR: Record<keyof Grenzen, string> = {
    dtpEin: 'regelFeuchteDtpEin',
    dtpAus: 'regelFeuchteDtpAus',
    rhEin: 'regelFeuchteRhEin',
    rhAus: 'regelFeuchteRhAus',
};
/** Bereiche wie in der bisherigen jsonConfig; `luecke` = kleinster Abstand zwischen Ein und Aus */
const BEREICH = {
    dtp: { ein: [0, 15], aus: [0.5, 20], schritt: 0.5, luecke: 0.5, stellen: 1, einheit: 'K' },
    rh: { ein: [30, 100], aus: [20, 99], schritt: 1, luecke: 1, stellen: 0, einheit: '%' },
} as const;

export interface LiveGeraet {
    id: string;
    name: string;
    raum: number | null;
    feuchte: number | null;
    taupunkt: number | null;
}

interface Farben {
    flaeche: string;
    fokus: string;
    fehler: string;
}

const B_MAX = 760;
const B_MIN = 290;
const RAND = { l: 14, r: 14 };
const H = 100;
const BALKEN = { o: 28, h: 26 };

const endlich = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const runden = (n: number, schritt: number): number => Math.round(Math.round(n / schritt) * schritt * 100) / 100;
const klemmen = (n: number, min: number, max: number): number => Math.min(max, Math.max(min, n));

type Zustand = 'feucht' | 'trocken' | 'band';

/** Wo ein Raum gerade steht - dieselben Vergleiche wie bewerten() in lib/regel/feuchte.js. */
function zustandVon(g: Grenzen, feuchte: number, abstand: number | null): Zustand {
    const zuFeucht = (abstand !== null && abstand < g.dtpEin) || feuchte > g.rhEin;
    const trocken = (abstand === null || abstand > g.dtpAus) && feuchte < g.rhAus;
    return zuFeucht ? 'feucht' : trocken ? 'trocken' : 'band';
}

interface SkalaProps {
    art: 'dtp' | 'rh';
    breite: number;
    achse: [number, number];
    ein: number;
    aus: number;
    punkte: { nr: number; wert: number }[];
    sprache: string;
    farben: Farben;
    farbeEin: string;
    farbeAus: string;
    titel: string;
    textEin: string;
    textAus: string;
    zonen: [string, string, string];
    onEin: (n: number) => void;
    onAus: (n: number) => void;
}

/** Eine Skala mit Band, zwei ziehbaren Linien und den Messpunkten. */
function Skala(props: SkalaProps): React.JSX.Element {
    const { art, sprache, farben } = props;
    const ber = BEREICH[art];
    const B = props.breite;
    const W = B - RAND.l - RAND.r;
    const svg = useRef<SVGSVGElement | null>(null);
    const muster = `fk-schraffur-${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
    const zieht = useRef<{ was: 'ein' | 'aus'; zeiger: number; achse: [number, number] } | null>(null);
    const [ziehend, setZiehend] = useState<'ein' | 'aus' | null>(null);
    // die Achse bleibt waehrend des Ziehens stehen
    const [min, max] = zieht.current ? zieht.current.achse : props.achse;
    // feucht ist immer rechts: der Taupunktabstand laeuft deshalb von gross (links) nach klein (rechts)
    const X = (v: number): number =>
        RAND.l +
        (art === 'dtp' ? (max - klemmen(v, min, max)) / (max - min) : (klemmen(v, min, max) - min) / (max - min)) * W;
    const wertBei = (clientX: number): number => {
        const r = (svg.current as SVGSVGElement).getBoundingClientRect();
        const a = (((clientX - r.left) / r.width) * B - RAND.l) / W;
        return art === 'dtp' ? max - a * (max - min) : min + a * (max - min);
    };
    /** Wert einer Linie begrenzen: eigener Bereich, Achse und der Abstand zur anderen Linie */
    const grenze = (was: 'ein' | 'aus', roh: number): number => {
        const n = runden(roh, ber.schritt);
        const [lo, hi] = ber[was];
        const drueber = art === 'dtp' ? was === 'aus' : was === 'ein'; // diese Linie hat den groesseren Wert
        const andere = was === 'ein' ? props.aus : props.ein;
        return drueber
            ? klemmen(n, Math.max(lo, andere + ber.luecke), Math.min(hi, max))
            : klemmen(n, Math.max(lo, min), Math.min(hi, andere - ber.luecke));
    };
    const setzen = (was: 'ein' | 'aus', roh: number): void => {
        const n = grenze(was, roh);
        if (n !== (was === 'ein' ? props.ein : props.aus)) {
            (was === 'ein' ? props.onEin : props.onAus)(n);
        }
    };

    // Finger auf einem Griff: die Seite darf dabei nicht rollen (wie in der Kennlinie)
    useEffect(() => {
        const el = svg.current;
        if (!el) {
            return undefined;
        }
        const halten = (e: TouchEvent): void => {
            const ziel = e.target as Element | null;
            if (ziel && typeof ziel.closest === 'function' && ziel.closest('.fk-f-griff')) {
                e.preventDefault();
            }
        };
        el.addEventListener('touchstart', halten, { passive: false });
        return () => el.removeEventListener('touchstart', halten);
    }, []);

    const greifen = (was: 'ein' | 'aus') => (e: React.PointerEvent<SVGGElement>) => {
        if (e.pointerType === 'mouse' && e.button !== 0) {
            return;
        }
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        e.currentTarget.focus({ preventScroll: true });
        zieht.current = { was, zeiger: e.pointerId, achse: [min, max] };
        setZiehend(was);
    };
    const bewegen = (e: React.PointerEvent<SVGGElement>): void => {
        const z = zieht.current;
        if (z && z.zeiger === e.pointerId) {
            setzen(z.was, wertBei(e.clientX));
        }
    };
    const loslassen = (e: React.PointerEvent<SVGGElement>): void => {
        if (zieht.current && zieht.current.zeiger === e.pointerId) {
            zieht.current = null;
            setZiehend(null);
        }
    };
    const taste = (was: 'ein' | 'aus') => (e: React.KeyboardEvent<SVGGElement>) => {
        const wert = was === 'ein' ? props.ein : props.aus;
        const rechts = art === 'dtp' ? -1 : 1; // nach rechts = feuchter
        const wege: Record<string, number> = {
            ArrowRight: rechts,
            ArrowLeft: -rechts,
            ArrowUp: 1,
            ArrowDown: -1,
            PageUp: 5,
            PageDown: -5,
        };
        if (!(e.key in wege)) {
            return;
        }
        e.preventDefault();
        setzen(was, wert + wege[e.key] * ber.schritt);
    };

    const xEin = X(props.ein);
    const xAus = X(props.aus);
    const links = RAND.l;
    const rechts = B - RAND.r;
    const mitte = BALKEN.o + BALKEN.h / 2;
    const unten = BALKEN.o + BALKEN.h;
    const zeige = (n: number): string => `${zahl(n, sprache, ber.stellen)} ${ber.einheit}`;

    // Achsenstriche
    const strichSchritt = art === 'dtp' ? 5 : W < 380 ? 20 : 10;
    const striche: number[] = [];
    for (let v = Math.ceil(min / strichSchritt) * strichSchritt; v <= max; v += strichSchritt) {
        striche.push(v);
    }

    // Beschriftung der Zonen, wo sie hineinpasst und kein Messpunkt darauf liegt
    const frei = (von: number, bis: number, inhalt: string): boolean => {
        const halb = (inhalt.length * 6.3) / 2 + 10;
        const m = (von + bis) / 2;
        return bis - von >= 2 * halb - 10 && !props.punkte.some(p => Math.abs(X(p.wert) - m) < halb);
    };
    const zone = (von: number, bis: number, inhalt: string, klasse: string): React.JSX.Element | null =>
        frei(von, bis, inhalt) ? (
            <text
                className={klasse}
                x={(von + bis) / 2}
                y={mitte + 4}
                textAnchor="middle"
                fillOpacity="0.8"
                pointerEvents="none"
            >
                {inhalt}
            </text>
        ) : null;

    // Messpunkte: dicht beieinander liegende gegeneinander versetzen
    const punkte = props.punkte
        .map(p => ({ ...p, x: X(p.wert) }))
        .sort((a, b) => a.x - b.x)
        .map((p, i, alle) => ({ ...p, y: mitte + (i > 0 && p.x - alle[i - 1].x < 15 ? (i % 2 ? 5 : -5) : 0) }));

    const griff = (was: 'ein' | 'aus'): React.JSX.Element => {
        const x = was === 'ein' ? xEin : xAus;
        const wert = was === 'ein' ? props.ein : props.aus;
        const farbe = was === 'ein' ? props.farbeEin : props.farbeAus;
        const inhalt = `${was === 'ein' ? props.textEin : props.textAus} ${zeige(wert)}`;
        // "Ein" hat den Griff oben, "Aus" unten - so kommen sich die beiden Beschriftungen nie in die Quere
        const gy = was === 'ein' ? 13 : unten + 15;
        const breit = inhalt.length * 6.4;
        // Beschriftung auf der Seite, auf der die Linie wirkt (Ein -> feucht/rechts, Aus -> trocken/links), sonst gegenueber
        let rechtsDavon = was === 'ein';
        if (rechtsDavon && x + 20 + breit > B - 2) {
            rechtsDavon = false;
        } else if (!rechtsDavon && x - 20 - breit < 2) {
            rechtsDavon = true;
        }
        const [lo, hi] = ber[was];
        return (
            <g
                key={was}
                className={`fk-f-griff fk-f-${was}${ziehend === was ? ' fk-aktiv' : ''}`}
                data-griff={`${art}-${was}`}
                role="slider"
                tabIndex={0}
                aria-label={`${props.titel}: ${was === 'ein' ? props.textEin : props.textAus}`}
                aria-orientation="horizontal"
                aria-valuemin={lo}
                aria-valuemax={hi}
                aria-valuenow={wert}
                aria-valuetext={zeige(wert)}
                onPointerDown={greifen(was)}
                onPointerMove={bewegen}
                onPointerUp={loslassen}
                onPointerCancel={loslassen}
                onKeyDown={taste(was)}
            >
                {/* grosse unsichtbare Flaechen: Linie und Griff sind mit Maus und Finger sicher zu treffen */}
                <rect
                    x={x - 8}
                    y={BALKEN.o - 4}
                    width="16"
                    height={BALKEN.h + 8}
                    fill="transparent"
                />
                <rect
                    x={x - 22}
                    y={gy - 17}
                    width="44"
                    height="34"
                    fill="transparent"
                />
                <rect
                    className="fk-f-hof"
                    x={x - 20}
                    y={gy - 15}
                    width="40"
                    height="30"
                    rx="10"
                    fill={farbe}
                />
                <line
                    className="fk-f-linie"
                    x1={x}
                    x2={x}
                    y1={was === 'ein' ? gy + 9 : BALKEN.o - 3}
                    y2={was === 'ein' ? unten + 3 : gy - 9}
                    stroke={farbe}
                    strokeWidth="3"
                    strokeLinecap="round"
                    strokeDasharray={was === 'aus' ? '5 4' : undefined}
                />
                <rect
                    className="fk-f-ring"
                    x={x - 17.5}
                    y={gy - 13.5}
                    width="35"
                    height="27"
                    rx="9"
                    fill="none"
                    stroke={farben.fokus}
                    strokeWidth="2.5"
                />
                <rect
                    className="fk-f-knauf"
                    x={x - 14}
                    y={gy - 10}
                    width="28"
                    height="20"
                    rx="6"
                    fill={farben.flaeche}
                    stroke={farbe}
                    strokeWidth="2.4"
                />
                {/* Rillen und Pfeile: zeigen, dass und wohin man ziehen kann */}
                <path
                    d={`M${x - 3} ${gy - 4.5}v9M${x} ${gy - 4.5}v9M${x + 3} ${gy - 4.5}v9`}
                    stroke={farbe}
                    strokeWidth="1.4"
                    fill="none"
                    pointerEvents="none"
                />
                <path
                    d={`M${x - 7.5} ${gy - 3}l-3 3 3 3M${x + 7.5} ${gy - 3}l3 3 -3 3`}
                    stroke={farbe}
                    strokeWidth="1.4"
                    fill="none"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    pointerEvents="none"
                />
                <text
                    className="fk-f-etikett"
                    x={x + (rechtsDavon ? 20 : -20)}
                    y={gy + 4}
                    textAnchor={rechtsDavon ? 'start' : 'end'}
                    fontWeight="600"
                    pointerEvents="none"
                >
                    {inhalt}
                </text>
            </g>
        );
    };

    return (
        <svg
            ref={svg}
            className={`fk-f-zeichnung${ziehend ? ' fk-zieht' : ''}`}
            data-skala={art}
            xmlns="http://www.w3.org/2000/svg"
            viewBox={`0 0 ${B} ${H}`}
            style={{ maxWidth: B }}
            role="group"
            aria-label={props.titel}
            fontSize="11"
            fill="currentColor"
        >
            <defs>
                <pattern
                    id={muster}
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
                        strokeOpacity="0.4"
                        strokeWidth="2"
                    />
                </pattern>
            </defs>
            {/* trocken | Band | feucht */}
            <rect
                className="fk-f-zone-trocken"
                x={links}
                y={BALKEN.o}
                width={Math.max(0, xAus - links)}
                height={BALKEN.h}
                fill={props.farbeAus}
                fillOpacity="0.16"
            />
            <rect
                x={xAus}
                y={BALKEN.o}
                width={Math.max(0, xEin - xAus)}
                height={BALKEN.h}
                fill="currentColor"
                fillOpacity="0.05"
            />
            <rect
                className="fk-f-zone-band"
                x={xAus}
                y={BALKEN.o}
                width={Math.max(0, xEin - xAus)}
                height={BALKEN.h}
                fill={`url(#${muster})`}
            />
            <rect
                className="fk-f-zone-feucht"
                x={xEin}
                y={BALKEN.o}
                width={Math.max(0, rechts - xEin)}
                height={BALKEN.h}
                fill={props.farbeEin}
                fillOpacity="0.3"
            />
            <rect
                x={links}
                y={BALKEN.o}
                width={W}
                height={BALKEN.h}
                rx="4"
                fill="none"
                stroke="currentColor"
                strokeOpacity="0.3"
            />
            {zone(links, xAus, props.zonen[0], 'fk-f-t-trocken')}
            {zone(xAus, xEin, props.zonen[1], 'fk-f-t-band')}
            {zone(xEin, rechts, props.zonen[2], 'fk-f-t-feucht')}
            {striche.map(v => (
                <g
                    key={v}
                    pointerEvents="none"
                >
                    <line
                        x1={X(v)}
                        x2={X(v)}
                        y1={unten}
                        y2={unten + 4}
                        stroke="currentColor"
                        strokeOpacity="0.4"
                    />
                    <text
                        x={X(v)}
                        y={H - 3}
                        textAnchor={
                            v === (art === 'dtp' ? max : min)
                                ? 'start'
                                : v === (art === 'dtp' ? min : max)
                                  ? 'end'
                                  : 'middle'
                        }
                        dx={v === (art === 'dtp' ? max : min) ? -4 : v === (art === 'dtp' ? min : max) ? 4 : 0}
                        fillOpacity="0.7"
                    >
                        {zahl(v, sprache)} {ber.einheit}
                    </text>
                </g>
            ))}
            {punkte.map(p => (
                <g
                    key={p.nr}
                    className="fk-f-punkt"
                    data-nr={p.nr}
                    pointerEvents="none"
                >
                    <circle
                        cx={p.x}
                        cy={p.y}
                        r="7.5"
                        fill={farben.flaeche}
                        stroke="currentColor"
                        strokeWidth="1.6"
                    />
                    <text
                        x={p.x}
                        y={p.y + 3.5}
                        textAnchor="middle"
                        fontSize="10"
                        fontWeight="700"
                    >
                        {p.nr}
                    </text>
                </g>
            ))}
            {griff('aus')}
            {griff('ein')}
        </svg>
    );
}

interface AnsichtProps {
    /** die vier Grenzen des Formulars (leer/ungueltig = Werksvorgabe) */
    werte: Partial<Record<keyof Grenzen, unknown>>;
    /** regelFeuchteMassnahme - nur fuer die erklaerenden Zeilen je Betriebsart */
    massnahme: unknown;
    /** Name der Wahl "Faikout-Modul regelt selbst" auf der Seite (Text der Auswahl "Wer regelt") */
    nameModulRegelt: string;
    /** Messwerte der Geraete oder null (Adapter laeuft nicht / noch keine Antwort) */
    geraete: LiveGeraet[] | null;
    sprache: string;
    dunkel: boolean;
    farben: Farben;
    onWert: (teil: Partial<Grenzen>) => void;
    /** meldet dem Formular ungueltige Grenzen ('' = in Ordnung) */
    onFehler?: (meldung: string) => void;
}

/** Kleines Symbol je Betriebsart: Flamme, Schneeflocke, Tropfen, Ein/Aus. */
function ArtSymbol(props: { art: 'heizen' | 'kuehlen' | 'entfeuchten' | 'aus' }): React.JSX.Element {
    const strich = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round' } as const;
    return (
        <svg
            viewBox="0 0 20 20"
            aria-hidden="true"
        >
            {props.art === 'heizen' ? (
                <path
                    {...strich}
                    d="M10 2.5c.6 3-3.8 4.6-3.8 8.6a3.9 3.9 0 0 0 7.8 0c0-1.6-.8-2.7-1.6-3.6-.3 1.2-.9 1.8-1.6 2.1.5-2.6-.1-5.3-.8-7.1z"
                />
            ) : props.art === 'kuehlen' ? (
                <path
                    {...strich}
                    d="M10 2.5v15M3.5 6.25l13 7.5M16.5 6.25l-13 7.5M8 3.6l2 1.7 2-1.7M8 16.4l2-1.7 2 1.7"
                />
            ) : props.art === 'entfeuchten' ? (
                <path
                    {...strich}
                    d="M10 2.8c2.6 3.3 4.6 5.7 4.6 8.4a4.6 4.6 0 0 1-9.2 0c0-2.7 2-5.1 4.6-8.4z"
                />
            ) : (
                <path
                    {...strich}
                    d="M10 3v6.5M6.2 5.4a6 6 0 1 0 7.6 0"
                />
            )}
        </svg>
    );
}

/** Die Grafik - ohne jsonConfig, damit sie sich einzeln rendern und pruefen laesst. */
export function FeuchteAnsicht(props: AnsichtProps): React.JSX.Element {
    const { sprache, farben } = props;
    const t = (s: Schluessel, ...w: (string | number)[]): string => text(sprache, s, ...w);
    const rahmen = useRef<HTMLDivElement | null>(null);
    const [platz, setPlatz] = useState(B_MAX);
    useEffect(() => {
        const el = rahmen.current;
        if (!el || typeof ResizeObserver === 'undefined') {
            return undefined;
        }
        const messen = (): void => setPlatz(el.clientWidth || B_MAX);
        const waechter = new ResizeObserver(messen);
        waechter.observe(el);
        messen();
        return () => waechter.disconnect();
    }, []);
    const B = Math.round(klemmen(platz, B_MIN, B_MAX));

    const lies = (k: keyof Grenzen): number => {
        const v = props.werte[k];
        return v === undefined || v === null || v === '' || !Number.isFinite(Number(v)) ? WERK[k] : Number(v);
    };
    const form: Grenzen = {
        dtpEin: lies('dtpEin'),
        dtpAus: lies('dtpAus'),
        rhEin: lies('rhEin'),
        rhAus: lies('rhAus'),
    };
    // Entwurf: was gerade gezogen oder getippt wurde, bis das Formular denselben Stand zeigt
    const [entwurf, setEntwurf] = useState<Grenzen | null>(null);
    const formText = JSON.stringify(form);
    useEffect(() => setEntwurf(null), [formText]);
    const g = entwurf || form;
    const schreiben = (teil: Partial<Grenzen>): void => {
        setEntwurf({ ...g, ...teil });
        props.onWert(teil);
    };

    const fehlerText = !(g.dtpAus > g.dtpEin) ? t('fDtp') : !(g.rhAus < g.rhEin) ? t('fRh') : '';
    const onFehler = props.onFehler;
    useEffect(() => {
        if (onFehler) {
            onFehler(fehlerText);
        }
    }, [fehlerText, onFehler]);

    const farbeEin = props.dunkel ? '#7fb6e6' : '#2a6aa6';
    const farbeAus = props.dunkel ? '#8fc79b' : '#3b7a4b';
    const farbeBand = props.dunkel ? '#d3b56a' : '#8a6a1f';

    // Messwerte: nummeriert in der Reihenfolge des Adapters
    const mitWert = (props.geraete || []).filter(d => endlich(d.feuchte));
    const ohne = (props.geraete || []).filter(d => !endlich(d.feuchte));
    const live = mitWert.map((d, i) => {
        const abstand = endlich(d.raum) && endlich(d.taupunkt) ? Math.round((d.raum - d.taupunkt) * 10) / 10 : null;
        return {
            ...d,
            nr: i + 1,
            feuchte: d.feuchte as number,
            abstand,
            zustand: zustandVon(g, d.feuchte as number, abstand),
        };
    });

    const mass = String(props.massnahme || 'entfeuchten');
    // Was je Betriebsart geschieht - wie lib/regel/feuchte.js (Massnahme waehlen) und koordinator.js
    const nurMelden = mass === 'melden';
    const zielSenken = mass === 'zielSenken';
    const arten: { art: 'heizen' | 'kuehlen' | 'entfeuchten' | 'aus'; name: string; text: string; greift: boolean }[] = [
        { art: 'heizen', name: t('artHeizen'), text: nurMelden ? t('nurMelden') : t('heizenNichts'), greift: false },
        {
            art: 'kuehlen',
            name: t('artKuehlen'),
            text: nurMelden ? t('nurMelden') : zielSenken ? t('kuehlenZiel') : t('kuehlenEntfeuchten'),
            greift: !nurMelden,
        },
        {
            art: 'entfeuchten',
            name: t('artEntfeuchten'),
            text: nurMelden ? t('nurMelden') : zielSenken ? t('entfZiel') : t('entfEntfeuchten'),
            greift: false,
        },
        { art: 'aus', name: t('artAus'), text: t('ausSatz'), greift: false },
    ];
    const zonen: [string, string, string] = [t('trocken'), t('band'), t('feucht')];
    const zustandText: Record<Zustand, string> = { feucht: t('feucht'), trocken: t('trocken'), band: t('band') };
    const zustandFarbe: Record<Zustand, string> = { feucht: farbeEin, trocken: farbeAus, band: farbeBand };

    const felder = (art: 'dtp' | 'rh'): React.JSX.Element => {
        const ber = BEREICH[art];
        const ein = art === 'dtp' ? g.dtpEin : g.rhEin;
        const aus = art === 'dtp' ? g.dtpAus : g.rhAus;
        const kEin = art === 'dtp' ? 'dtpEin' : 'rhEin';
        const kAus = art === 'dtp' ? 'dtpAus' : 'rhAus';
        const falsch = art === 'dtp' ? !(aus > ein) : !(aus < ein);
        return (
            <div className="fk-f-felder">
                <label className="fk-f-feld">
                    <span
                        className="fk-f-marke fk-f-marke-ein"
                        style={{ background: farbeEin }}
                    />
                    <span>{t(kEin)}</span>
                    <Wertfeld
                        wert={ein}
                        min={ber.ein[0]}
                        max={ber.ein[1]}
                        schritt={ber.schritt}
                        stellen={ber.stellen}
                        einheit={ber.einheit}
                        name={`${t(art === 'dtp' ? 'dtpTitel' : 'rhTitel')}: ${t(kEin)}`}
                        sprache={sprache}
                        fehler={falsch}
                        erlaubt={n => (art === 'dtp' ? n < aus : n > aus)}
                        onWert={n => schreiben({ [kEin]: n })}
                    />
                </label>
                <label className="fk-f-feld">
                    <span
                        className="fk-f-marke fk-f-marke-aus"
                        style={{ borderColor: farbeAus }}
                    />
                    <span>{t(kAus)}</span>
                    <Wertfeld
                        wert={aus}
                        min={ber.aus[0]}
                        max={ber.aus[1]}
                        schritt={ber.schritt}
                        stellen={ber.stellen}
                        einheit={ber.einheit}
                        name={`${t(art === 'dtp' ? 'dtpTitel' : 'rhTitel')}: ${t(kAus)}`}
                        sprache={sprache}
                        fehler={falsch}
                        erlaubt={n => (art === 'dtp' ? n > ein : n < ein)}
                        onWert={n => schreiben({ [kAus]: n })}
                    />
                </label>
            </div>
        );
    };

    return (
        <Box
            className="fk-feuchte"
            ref={rahmen}
            sx={{
                width: '100%',
                maxWidth: B_MAX,
                color: 'text.primary',
                colorScheme: props.dunkel ? 'dark' : 'light',
                ...wertfeldStil(farben),
                '& .fk-f-block': {
                    border: '1px solid',
                    borderColor: 'divider',
                    borderRadius: '10px',
                    background: farben.flaeche,
                    padding: '10px 10px 8px',
                    mb: 1.25,
                },
                '& .fk-f-massnahme': { mb: 1.25 },
                '& .fk-f-arten': { listStyle: 'none', m: 0, p: 0, display: 'grid', gap: '3px', fontSize: '0.875rem' },
                '& .fk-f-art': { display: 'flex', alignItems: 'flex-start', gap: '8px', lineHeight: 1.4 },
                '& .fk-f-art svg': { flex: '0 0 auto', width: 18, height: 18, mt: '1px' },
                '& .fk-f-art-heizen svg': { color: props.dunkel ? '#f0a27a' : '#b4532a' },
                '& .fk-f-art-kuehlen svg': { color: props.dunkel ? '#7fbbe6' : '#1f6fa8' },
                '& .fk-f-art-entfeuchten svg': { color: props.dunkel ? '#7fd0c4' : '#1d7a70' },
                '& .fk-f-art-aus svg': { color: 'text.secondary' },
                '& .fk-f-art:not(.fk-f-greift) > span': { color: 'text.secondary' },
                '& .fk-f-art:not(.fk-f-greift) b': { color: 'text.primary' },
                '& .fk-f-titel': { fontWeight: 600, fontSize: '0.95rem', lineHeight: 1.3 },
                '& .fk-f-unter': { fontSize: '0.8rem', color: 'text.secondary', mb: 0.5 },
                '& .fk-f-zeichnung': {
                    display: 'block',
                    width: '100%',
                    height: 'auto',
                    userSelect: 'none',
                    overflow: 'visible',
                },
                '& .fk-f-zeichnung.fk-zieht, & .fk-f-zeichnung.fk-zieht .fk-f-griff': { cursor: 'grabbing' },
                '& .fk-f-griff': { cursor: 'ew-resize', outline: 'none', touchAction: 'none' },
                '& .fk-f-hof': { opacity: 0, transition: 'opacity 0.12s' },
                '& .fk-f-griff:hover .fk-f-hof, & .fk-f-griff.fk-aktiv .fk-f-hof': { opacity: 0.25 },
                '& .fk-f-linie': { transition: 'stroke-width 0.12s' },
                '& .fk-f-griff:hover .fk-f-linie, & .fk-f-griff.fk-aktiv .fk-f-linie': { strokeWidth: 4.5 },
                '& .fk-f-ring': { opacity: 0 },
                '& .fk-f-griff:focus-visible .fk-f-ring': { opacity: 1 },
                '& .fk-f-felder': { display: 'flex', flexWrap: 'wrap', gap: '6px 22px', mt: 0.5, fontSize: '0.88rem' },
                '& .fk-f-feld': { display: 'inline-flex', alignItems: 'center', gap: '6px' },
                '& .fk-f-marke': {
                    flex: '0 0 auto',
                    width: 14,
                    height: 4,
                    borderRadius: '2px',
                    boxSizing: 'border-box',
                },
                '& .fk-f-marke-aus': { height: 0, borderTop: '3px dashed', borderRadius: 0 },
                '& .fk-f-live': { listStyle: 'none', m: 0, p: 0, fontSize: '0.86rem', display: 'grid', gap: '4px' },
                '& .fk-f-live li': { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '2px 8px' },
                '& .fk-f-nr': {
                    flex: '0 0 auto',
                    width: 18,
                    height: 18,
                    borderRadius: '50%',
                    border: '1.6px solid currentColor',
                    fontSize: '0.68rem',
                    fontWeight: 700,
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                },
                '& .fk-f-geraet': { fontWeight: 600 },
                '& .fk-f-mess': { color: 'text.secondary', fontVariantNumeric: 'tabular-nums' },
                '& .fk-f-zustand': {
                    fontSize: '0.75rem',
                    fontWeight: 600,
                    border: '1.5px solid',
                    borderRadius: '10px',
                    padding: '0 7px',
                    lineHeight: 1.5,
                    whiteSpace: 'nowrap',
                },
                '@media (prefers-reduced-motion: reduce)': { '& .fk-f-hof, & .fk-f-linie': { transition: 'none' } },
            }}
        >
            <Typography
                variant="body2"
                className="fk-f-einleitung"
                sx={{ mb: 0.75 }}
            >
                {t('einleitung')}
            </Typography>
            <div
                className="fk-f-massnahme"
                data-massnahme={mass}
            >
                <Typography
                    variant="body2"
                    sx={{ mb: 0.5 }}
                >
                    {t('wasTitel')}
                </Typography>
                <ul className="fk-f-arten">
                    {arten.map(a => (
                        <li
                            key={a.art}
                            className={`fk-f-art fk-f-art-${a.art}${a.greift ? ' fk-f-greift' : ''}`}
                            data-art={a.art}
                        >
                            <ArtSymbol art={a.art} />
                            <span>
                                <b>{a.name}:</b> {a.text}
                            </span>
                        </li>
                    ))}
                </ul>
                <Typography
                    variant="body2"
                    className="fk-f-ausnahmen"
                    sx={{ color: 'text.secondary', fontSize: '0.8rem', mt: 0.5 }}
                >
                    {t('ausnahmen', props.nameModulRegelt, stufenText(sprache, 'feuchte'))} {t('massWo')}
                </Typography>
            </div>
            <div className="fk-f-block">
                <div className="fk-f-titel">{t('dtpTitel')}</div>
                <div className="fk-f-unter">{t('dtpKurz')}</div>
                <Skala
                    art="dtp"
                    breite={B - 22}
                    achse={[0, Math.max(g.dtpAus, g.dtpEin) > 14 ? 20 : 15]}
                    ein={g.dtpEin}
                    aus={g.dtpAus}
                    punkte={live.filter(d => d.abstand !== null).map(d => ({ nr: d.nr, wert: d.abstand as number }))}
                    sprache={sprache}
                    farben={farben}
                    farbeEin={farbeEin}
                    farbeAus={farbeAus}
                    titel={t('dtpTitel')}
                    textEin={t('dtpEin')}
                    textAus={t('dtpAus')}
                    zonen={zonen}
                    onEin={n => schreiben({ dtpEin: n })}
                    onAus={n => schreiben({ dtpAus: n })}
                />
                {felder('dtp')}
            </div>
            <div className="fk-f-block">
                <div
                    className="fk-f-titel"
                    style={{ marginBottom: 4 }}
                >
                    {t('rhTitel')}
                </div>
                <Skala
                    art="rh"
                    breite={B - 22}
                    achse={[20, 100]}
                    ein={g.rhEin}
                    aus={g.rhAus}
                    punkte={live.map(d => ({ nr: d.nr, wert: d.feuchte }))}
                    sprache={sprache}
                    farben={farben}
                    farbeEin={farbeEin}
                    farbeAus={farbeAus}
                    titel={t('rhTitel')}
                    textEin={t('rhEin')}
                    textAus={t('rhAus')}
                    zonen={zonen}
                    onEin={n => schreiben({ rhEin: n })}
                    onAus={n => schreiben({ rhAus: n })}
                />
                {felder('rh')}
            </div>
            {fehlerText ? (
                <Box
                    className="fk-fehler-text"
                    role="alert"
                    sx={{
                        mb: 1,
                        px: 1.25,
                        py: 0.75,
                        borderRadius: '6px',
                        border: `1px solid ${farben.fehler}`,
                        color: farben.fehler,
                        fontSize: '0.9em',
                    }}
                >
                    {fehlerText}
                </Box>
            ) : null}
            <div className="fk-f-block fk-f-liveblock">
                <div
                    className="fk-f-titel"
                    style={{ marginBottom: 6 }}
                >
                    {t('live')}
                </div>
                {live.length ? (
                    <ul className="fk-f-live">
                        {live.map(d => (
                            <li
                                key={d.id}
                                data-geraet={d.id}
                                data-zustand={d.zustand}
                            >
                                <span className="fk-f-nr">{d.nr}</span>
                                <span className="fk-f-geraet">{d.name || d.id}</span>
                                <span className="fk-f-mess">
                                    {[
                                        endlich(d.raum) ? t('liveRaum', zahl(d.raum, sprache, 1)) : '',
                                        t('liveFeuchte', zahl(d.feuchte, sprache)),
                                        endlich(d.taupunkt) ? t('liveTaupunkt', zahl(d.taupunkt, sprache, 1)) : '',
                                        d.abstand !== null ? t('liveAbstand', zahl(d.abstand, sprache, 1)) : '',
                                    ]
                                        .filter(Boolean)
                                        .join(' · ')}
                                </span>
                                <span
                                    className="fk-f-zustand"
                                    style={{ color: zustandFarbe[d.zustand], borderColor: zustandFarbe[d.zustand] }}
                                >
                                    {zustandText[d.zustand]}
                                </span>
                            </li>
                        ))}
                    </ul>
                ) : (
                    <Typography
                        variant="body2"
                        color="text.secondary"
                        className="fk-f-keine"
                    >
                        {t('liveKeine')}
                    </Typography>
                )}
                {live.length && ohne.length ? (
                    <Typography
                        variant="caption"
                        color="text.secondary"
                        className="fk-f-ohne"
                        sx={{ display: 'block', mt: 0.75 }}
                    >
                        {t('ohneFuehler', ohne.map(d => d.name || d.id).join(', '))}
                    </Typography>
                ) : null}
            </div>
            <Typography
                variant="caption"
                color="text.secondary"
                className="fk-f-fuss"
                sx={{ display: 'block' }}
            >
                {t('ziehHinweis')}
            </Typography>
            <Werkzeugleiste
                art="feuchte"
                inhalt={g}
                onEinfuegen={inhalt => {
                    const z = (inhalt && typeof inhalt === 'object' ? inhalt : {}) as Record<string, unknown>;
                    const neu: Partial<Grenzen> = {};
                    for (const k of Object.keys(WERK) as (keyof Grenzen)[]) {
                        if (endlich(z[k])) {
                            neu[k] = z[k] as number;
                        }
                    }
                    if (Object.keys(neu).length) {
                        schreiben(neu);
                    }
                }}
                onZuruecksetzen={() => schreiben({ ...WERK })}
                istVorlage
                quelle={t('quelle')}
                sprache={sprache}
            />
        </Box>
    );
}

/** Messwerte der Geraete vom Adapter - beim Oeffnen und alle 15 s. */
function useUebersicht(props: ConfigGenericProps): LiveGeraet[] | null {
    const [geraete, setGeraete] = useState<LiveGeraet[] | null>(null);
    const socket = props.oContext?.socket;
    const ziel = `${props.oContext?.adapterName}.${props.oContext?.instance}`;
    useEffect(() => {
        if (!props.alive || !socket || typeof socket.sendTo !== 'function') {
            setGeraete(null);
            return undefined;
        }
        let lebt = true;
        const fragen = (): void => {
            Promise.resolve(socket.sendTo(ziel, 'regelUebersicht', {}))
                .then((antwort: any) => {
                    if (lebt) {
                        setGeraete(
                            antwort && !antwort.error && Array.isArray(antwort.geraete) ? antwort.geraete : null,
                        );
                    }
                })
                .catch(() => lebt && setGeraete(null));
        };
        fragen();
        const takt = setInterval(fragen, 15000);
        return () => {
            lebt = false;
            clearInterval(takt);
        };
    }, [props.alive, socket, ziel]);
    return geraete;
}

function FeuchteFeld(
    props: ConfigGenericProps & { onWert: (teil: Partial<Grenzen>) => void; onFehler: (meldung: string) => void },
): React.JSX.Element {
    const data = (props.data || {}) as Record<string, unknown>;
    const geraete = useUebersicht(props);
    const palette = props.oContext?.theme?.palette;
    return (
        <FeuchteAnsicht
            werte={{
                dtpEin: data[ATTR.dtpEin],
                dtpAus: data[ATTR.dtpAus],
                rhEin: data[ATTR.rhEin],
                rhAus: data[ATTR.rhAus],
            }}
            massnahme={data.regelFeuchteMassnahme}
            nameModulRegelt={I18n.t('optBetriebFaikout')}
            geraete={geraete}
            sprache={I18n.getLanguage()}
            dunkel={(props.oContext?.themeType || palette?.mode) === 'dark'}
            farben={{
                flaeche: palette?.background?.paper || '#fff',
                fokus: palette?.primary?.main || '#3399cc',
                fehler: palette?.error?.main || '#d9534f',
            }}
            onWert={props.onWert}
            onFehler={props.onFehler}
        />
    );
}

/**
 * jsonConfig-Komponente "Feuchte". Das eigene Attribut ist nur ein Platzhalter (z. B. `_feuchteGrafik`);
 * geschrieben werden die vier Felder regelFeuchteDtpEin/-Aus und regelFeuchteRhEin/-Aus des Formulars.
 */
class Feuchte extends ConfigGeneric<ConfigGenericProps, ConfigGenericState> {
    onWert = (teil: Partial<Grenzen>): void => {
        const paare = (Object.keys(teil) as (keyof Grenzen)[]).map(k => [ATTR[k], teil[k]] as const);
        if (paare.length === 1 || this.props.custom) {
            // in einer Tabellen-/Accordionzeile nimmt der Admin nur einzelne Felder an
            paare.forEach(([attr, wert]) => void this.onChange(attr, wert));
        } else if (paare.length > 1) {
            // mehrere Felder auf einmal (Einfuegen, Werksvorgabe): ein gemeinsamer Stand, sonst
            // ueberschriebe jeder Aufruf den vorigen mit den alten Formulardaten
            const data = JSON.parse(JSON.stringify(this.props.data || {}));
            for (const [attr, wert] of paare) {
                ConfigGeneric.setValue(data, attr, wert);
            }
            (this.props.onChange as (data: Record<string, unknown>) => void)(data);
        }
    };

    letzterFehler = '';
    onFehler = (meldung: string): void => {
        if (meldung !== this.letzterFehler) {
            this.letzterFehler = meldung;
            this.onError(ATTR.dtpEin, meldung || undefined);
        }
    };

    componentWillUnmount(): void {
        if (this.letzterFehler) {
            this.letzterFehler = '';
            this.onError(ATTR.dtpEin, undefined);
        }
        super.componentWillUnmount?.();
    }

    renderItem(): React.JSX.Element {
        return (
            <FeuchteFeld
                {...this.props}
                onWert={this.onWert}
                onFehler={this.onFehler}
            />
        );
    }
}

export default Feuchte;
