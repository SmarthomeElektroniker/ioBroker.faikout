/*
 * Raumkorrektur zum Anfassen ("Fuer Fortgeschrittene"): Korrekturstaerke (Prozentpunkte je Kelvin,
 * `regelProzentProK`) und Totband (K, `regelTotband`) als Bild mit zwei Griffen - statt zweier Zahlenfelder.
 * Das Bild zeigt, was die Raumtemperatur am Wert der Kennlinie aendert: links "Raum zu kalt" (Punkte
 * dazu), rechts "Raum zu warm" (Punkte weg), in der Mitte das Totband ohne Korrektur.
 *
 * Bedienung wie die Grenzlinien der Kennlinie: Griff ziehen (Staerke senkrecht, Totband waagerecht),
 * Pfeiltasten, Doppelklick auf die Zahl (Finger: antippen; Tastatur: Enter oder F2 am Griff) oeffnet an
 * Ort und Stelle eine Zahleneingabe - Enter uebernimmt, Esc verwirft, Unzulaessiges wird begruendet abgelehnt.
 *
 * Geschrieben wird nur ins Formular (onChange): "Speichern" der Instanz uebernimmt, "Schliessen" verwirft.
 * Die Regeln (Raster, Bereich, Rechnung) stehen in lib/raumkorrekturzug.js.
 */
import React, { useEffect, useId, useRef, useState } from 'react';
import { Box, Button } from '@mui/material';
import { I18n } from '@iobroker/gui-components';
import { ConfigGeneric, type ConfigGenericProps, type ConfigGenericState } from '@iobroker/json-config';

import regelLib from '../../lib/raumkorrekturzug.js';
import zugLib from '../../lib/kennlinienzug.js';
import { t as text, type Schluessel } from './Rechenweg.texte';
import { satzText } from './Rechenweg';

type Welche = 'staerke' | 'totband';
const regel = regelLib as {
    BEREICH: Record<Welche, { min: number; max: number; raster: number; stellen: number; vorgabe: number }>;
    SCHWELLEN: { vollAbK: number; ueberAbK: number };
    rasten(welche: Welche, wert: number): number;
    lesen(welche: Welche, roh: unknown): number;
    korrektur(raumMinusZiel: number, staerke: number, totband: number): number;
    schritt(welche: Welche, wert: number, n: number): number;
    eingabe(welche: Welche, text: string): { wert: number | null; grund: '' | 'zahl' | 'bereich' };
};
const zug = zugLib as { anzeige(n: number, sprache?: string): string };

const TOUCH =
    typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches;

const RAND = { l: 46, r: 14, o: 18, u: 40 };
const X_MAX = 3; // Abweichung von -3 bis +3 K
const FARBE = { kalt: '#3d7fc4', warm: '#c8553a' };

interface AnsichtProps {
    staerke: number;
    totband: number;
    sprache: string;
    farben: { flaeche: string; fokus: string; fehler: string };
    onWert: (welche: Welche, wert: number) => void;
    /** beide Werte in einem Zug (Werksvorgabe) */
    onBeide: (staerke: number, totband: number) => void;
}

/** Bild und Griffe - ohne jsonConfig, damit es sich einzeln rendern und pruefen laesst. */
export function RaumkorrekturAnsicht(props: AnsichtProps): React.JSX.Element {
    const { sprache, farben } = props;
    const t = (s: Schluessel, ...w: (string | number)[]): string => text(sprache, s, ...w);
    const zahl = (n: number): string => zug.anzeige(n, sprache);
    const svg = useRef<SVGSVGElement | null>(null);
    const rahmen = useRef<HTMLDivElement | null>(null);
    const [platz, setPlatz] = useState(560);
    // waehrend des Ziehens gilt der gezogene Wert, sonst der des Formulars
    const zieht = useRef<{ welche: Welche; zeiger: number; yMax: number } | null>(null);
    const [zugWert, setZugWert] = useState<{ welche: Welche; wert: number } | null>(null);
    const [eingabe, setEingabe] = useState<{ welche: Welche; text: string; grund: string } | null>(null);
    const eingabeFeld = useRef<HTMLInputElement | null>(null);
    const eingabeOffen = useRef(false);
    const zeigerArt = useRef('mouse');
    const [notiz, setNotiz] = useState('');
    const grundId = `fk-rk-grund-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;

    const formText = `${props.staerke}/${props.totband}`;
    useEffect(() => {
        if (!zieht.current) {
            setZugWert(null);
        }
    }, [formText]);
    useEffect(() => {
        const el = rahmen.current;
        if (!el || typeof ResizeObserver === 'undefined') {
            return undefined;
        }
        const messen = (): void => setPlatz(el.clientWidth || 560);
        const waechter = new ResizeObserver(messen);
        waechter.observe(el);
        messen();
        return () => waechter.disconnect();
    }, []);
    // Finger auf einem Griff: die Seite darf dabei nicht rollen, sonst bricht der Browser das Ziehen ab
    useEffect(() => {
        const el = svg.current;
        if (!el) {
            return undefined;
        }
        const halten = (e: TouchEvent): void => {
            const ziel = e.target as Element | null;
            if (ziel && typeof ziel.closest === 'function' && ziel.closest('.fk-rk-griff')) {
                e.preventDefault();
            }
        };
        el.addEventListener('touchstart', halten, { passive: false });
        return () => el.removeEventListener('touchstart', halten);
    }, []);

    const staerke = zugWert && zugWert.welche === 'staerke' ? zugWert.wert : props.staerke;
    const totband = zugWert && zugWert.welche === 'totband' ? zugWert.wert : props.totband;

    const B = Math.round(Math.min(680, Math.max(280, platz)));
    const H = B < 420 ? 230 : 250;
    const W = B - RAND.l - RAND.r;
    const HH = H - RAND.o - RAND.u;
    // Hoehe der Achse: Platz fuer den Griff der Staerke; waehrend des Ziehens bleibt sie stehen
    const yMaxFrei = Math.min(60, Math.max(20, Math.ceil((staerke * 1.25 + 2) / 10) * 10));
    const yMax = zieht.current ? zieht.current.yMax : yMaxFrei;
    const X = (k: number): number => RAND.l + ((k + X_MAX) / (2 * X_MAX)) * W;
    const Y = (p: number): number => RAND.o + (1 - (Math.min(yMax, Math.max(-yMax, p)) + yMax) / (2 * yMax)) * HH;

    const setze = (welche: Welche, wert: number): void => {
        const neu = regel.rasten(welche, wert);
        if (neu !== (welche === 'staerke' ? props.staerke : props.totband)) {
            props.onWert(welche, neu);
        }
    };

    // ---- Griffe: der Griff der Staerke sitzt 1 K jenseits des Totbands (dort ist die Korrektur = Staerke)
    const xStaerke = -(totband + 1);
    const yStaerke = regel.korrektur(xStaerke, staerke, totband);
    const stelle = (e: { clientX: number; clientY: number }): { k: number; p: number } => {
        const r = (svg.current as SVGSVGElement).getBoundingClientRect();
        const px = ((e.clientX - r.left) / r.width) * B;
        const py = ((e.clientY - r.top) / r.height) * H;
        const max = zieht.current ? zieht.current.yMax : yMax;
        return { k: ((px - RAND.l) / W) * 2 * X_MAX - X_MAX, p: (1 - (py - RAND.o) / HH) * 2 * max - max };
    };
    const greifen = (welche: Welche) => (e: React.PointerEvent<SVGGElement>) => {
        if (e.pointerType === 'mouse' && e.button !== 0) {
            return;
        }
        zeigerArt.current = e.pointerType || 'mouse';
        e.preventDefault();
        (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
        (e.currentTarget as SVGGElement).focus({ preventScroll: true });
        zieht.current = { welche, zeiger: e.pointerId, yMax };
        setZugWert({ welche, wert: welche === 'staerke' ? staerke : totband });
    };
    const bewegen = (e: React.PointerEvent<SVGGElement>): void => {
        const z = zieht.current;
        if (!z || z.zeiger !== e.pointerId) {
            return;
        }
        const s = stelle(e);
        // Staerke: die Hoehe des Griffs ist die Korrektur 1 K jenseits des Totbands; Totband: Abstand von der Mitte
        const wert = z.welche === 'staerke' ? regel.rasten('staerke', s.p) : regel.rasten('totband', Math.abs(s.k));
        setZugWert(alt => (alt && alt.welche === z.welche && alt.wert === wert ? alt : { welche: z.welche, wert }));
    };
    const loslassen = (e: React.PointerEvent<SVGGElement>): void => {
        const z = zieht.current;
        if (!z || z.zeiger !== e.pointerId) {
            return;
        }
        zieht.current = null;
        (e.currentTarget as Element).releasePointerCapture?.(e.pointerId);
        const wert = zugWert && zugWert.welche === z.welche ? zugWert.wert : null;
        if (wert !== null) {
            setze(z.welche, wert);
        }
        // der Entwurf bleibt, bis das Formular denselben Wert zeigt (useEffect oben); ohne Aenderung sofort weg
        if (wert === null || wert === (z.welche === 'staerke' ? props.staerke : props.totband)) {
            setZugWert(null);
        }
    };
    const abbrechen = (): void => {
        zieht.current = null;
        setZugWert(null);
    };
    // ---- Zahl direkt eingeben
    const oeffnen = (welche: Welche): void => {
        if (zieht.current) {
            return;
        }
        eingabeOffen.current = true;
        setEingabe({ welche, text: zahl(welche === 'staerke' ? props.staerke : props.totband), grund: '' });
    };
    const taste = (welche: Welche) => (e: React.KeyboardEvent<SVGGElement>) => {
        if (e.key === 'Enter' || e.key === 'F2') {
            e.preventDefault();
            oeffnen(welche);
            return;
        }
        const b = regel.BEREICH[welche];
        const jetzt = welche === 'staerke' ? props.staerke : props.totband;
        const schritte: Record<string, number> = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1, PageUp: 5, PageDown: -5 };
        let ziel: number | null = null;
        if (e.key in schritte) {
            ziel = regel.schritt(welche, jetzt, schritte[e.key]);
        } else if (e.key === 'Home') {
            ziel = b.min;
        } else if (e.key === 'End') {
            ziel = b.max;
        }
        if (ziel === null) {
            return;
        }
        e.preventDefault();
        setze(welche, ziel);
    };

    const pruefen = (welche: Welche, roh: string): { wert: number | null; grund: string } => {
        const p = regel.eingabe(welche, roh);
        const b = regel.BEREICH[welche];
        return { wert: p.wert, grund: p.grund ? t(p.grund === 'zahl' ? 'rkEingabeZahl' : 'rkEingabeBereich', zahl(b.min), zahl(b.max)) : '' };
    };
    const zu = (zumGriff: boolean): void => {
        const welche = eingabe?.welche;
        eingabeOffen.current = false;
        setEingabe(null);
        if (zumGriff && welche) {
            svg.current?.querySelector<SVGGElement>(`.fk-rk-griff[data-welche="${welche}"]`)?.focus({ preventScroll: true });
        }
    };
    const eingabeTaste = (e: React.KeyboardEvent<HTMLInputElement>): void => {
        if (!eingabe) {
            return;
        }
        if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            zu(true);
        } else if (e.key === 'Enter') {
            e.preventDefault();
            e.stopPropagation();
            const p = pruefen(eingabe.welche, eingabe.text);
            if (p.wert === null) {
                setEingabe({ ...eingabe, grund: p.grund });
                eingabeFeld.current?.select();
                return;
            }
            zu(true);
            setze(eingabe.welche, p.wert);
        }
    };
    const eingabeVerlassen = (): void => {
        if (!eingabe || !eingabeOffen.current) {
            return;
        }
        const p = pruefen(eingabe.welche, eingabe.text);
        zu(false);
        if (p.wert !== null) {
            setze(eingabe.welche, p.wert);
        } else if (eingabe.text.trim() !== '') {
            setNotiz(p.grund);
        }
    };
    const eingabeWelche = eingabe ? eingabe.welche : null;
    useEffect(() => {
        if (eingabeWelche && eingabeFeld.current) {
            eingabeFeld.current.focus({ preventScroll: true });
            eingabeFeld.current.select();
        }
    }, [eingabeWelche]);
    useEffect(() => {
        if (!notiz) {
            return undefined;
        }
        const uhr = setTimeout(() => setNotiz(''), 4000);
        return () => clearTimeout(uhr);
    }, [notiz]);

    // ---- Zeichnung: Linie der Korrektur ueber der Abweichung
    // wo die Linie den Rand des Bildes erreicht, knickt sie waagerecht ab (sonst stimmte die Steigung nicht)
    const kappe = staerke > 0 ? totband + yMax / staerke : X_MAX;
    const stuetzen = [-X_MAX, ...(kappe < X_MAX ? [-kappe] : []), -totband, totband, ...(kappe < X_MAX ? [kappe] : []), X_MAX];
    const pfad = stuetzen.map((k, i) => `${i ? 'L' : 'M'}${X(k).toFixed(1)} ${Y(regel.korrektur(k, staerke, totband)).toFixed(1)}`).join(' ');
    const xVoll = -regel.SCHWELLEN.vollAbK;
    const xUeber = regel.SCHWELLEN.ueberAbK;
    const ySchritt = yMax <= 20 ? 10 : yMax <= 40 ? 20 : 30;
    const yStriche: number[] = [];
    for (let p = -yMax; p <= yMax; p += ySchritt) {
        yStriche.push(p);
    }
    if (!yStriche.includes(0)) {
        yStriche.push(0);
    }
    const mitVorzeichen = (p: number): string => (p > 0 ? `+${zahl(p)}` : zahl(p));
    const textStaerke = t('rkStaerke', zahl(staerke));
    const textTotband = t('rkTotband', zahl(totband));
    const breite = (s: string): number => s.length * 6.3;
    // Schrift der Staerke: rechts neben ihrem Griff, sonst darunter
    const sx0 = X(xStaerke) + 16;
    const sy0 = Math.max(RAND.o + 12, Math.min(Y(0) - 8, Y(yStaerke) + 4));
    // Schrift des Totbands: unter der Nulllinie in der Mitte
    const tx0 = X(0);
    const ty0 = Y(0) + 30;
    const istWerk = props.staerke === regel.BEREICH.staerke.vorgabe && props.totband === regel.BEREICH.totband.vorgabe;
    const b1 = Math.round(regel.korrektur(-1, staerke, totband));
    const b2 = Math.round(regel.korrektur(1, staerke, totband));
    const eb = eingabe ? regel.BEREICH[eingabe.welche] : null;

    const griff = (welche: Welche, cx: number, cy: number, name: string, wert: number): React.JSX.Element => (
        <g
            className={`fk-rk-griff${zugWert && zugWert.welche === welche && zieht.current ? ' fk-zieht' : ''}`}
            data-welche={welche}
            role="slider"
            tabIndex={0}
            aria-label={name}
            aria-orientation={welche === 'staerke' ? 'vertical' : 'horizontal'}
            aria-valuemin={regel.BEREICH[welche].min}
            aria-valuemax={regel.BEREICH[welche].max}
            aria-valuenow={wert}
            aria-valuetext={welche === 'staerke' ? textStaerke : textTotband}
            onPointerDown={greifen(welche)}
            onPointerMove={bewegen}
            onPointerUp={loslassen}
            onPointerCancel={abbrechen}
            onKeyDown={taste(welche)}
            onDoubleClick={() => oeffnen(welche)}
        >
            {/* grosse unsichtbare Flaeche zum Treffen, darin der sichtbare Griff */}
            <circle
                cx={cx}
                cy={cy}
                r={TOUCH ? 22 : 14}
                fill="transparent"
            />
            <circle
                className="fk-rk-knopf"
                cx={cx}
                cy={cy}
                r="7"
                fill={farben.flaeche}
                stroke={farben.fokus}
                strokeWidth="2.6"
            />
            {welche === 'staerke' ? (
                <path
                    d={`M${cx} ${cy - 15}l-4 5h8zM${cx} ${cy + 15}l-4 -5h8z`}
                    fill={farben.fokus}
                    fillOpacity="0.75"
                />
            ) : (
                <path
                    d={`M${cx - 15} ${cy}l5 -4v8zM${cx + 15} ${cy}l-5 -4v8z`}
                    fill={farben.fokus}
                    fillOpacity="0.75"
                />
            )}
        </g>
    );

    return (
        <Box
            className="fk-raumkorrektur"
            sx={{
                width: '100%',
                maxWidth: 680,
                color: 'text.primary',
                '& .fk-rk-titel': { fontWeight: 600, fontSize: '1rem', mb: 0.25 },
                '& .fk-rk-erklaerung': { fontSize: '0.875rem', color: 'text.secondary', mb: 0.75, maxWidth: 640 },
                '& .fk-rk-bild': { position: 'relative', width: '100%' },
                '& svg': { display: 'block', width: '100%', height: 'auto', overflow: 'visible', fontSize: 11, userSelect: 'none', touchAction: 'pan-y' },
                '& svg text': { fill: 'currentColor' },
                '& .fk-rk-griff': { cursor: 'grab', outline: 'none' },
                '& .fk-rk-griff[data-welche="staerke"]': { cursor: 'ns-resize' },
                '& .fk-rk-griff[data-welche="totband"]': { cursor: 'ew-resize' },
                '& .fk-rk-griff.fk-zieht': { cursor: 'grabbing' },
                '& .fk-rk-griff:hover .fk-rk-knopf, & .fk-rk-griff.fk-zieht .fk-rk-knopf': { strokeWidth: 3.6 },
                '& .fk-rk-griff:focus-visible .fk-rk-knopf': { stroke: farben.fokus, strokeWidth: 4, filter: `drop-shadow(0 0 3px ${farben.fokus})` },
                '& .fk-rk-wahl': { cursor: 'text', fontWeight: 600, fontSize: 12 },
                '& .fk-rk-wahl:hover': { textDecoration: 'underline' },
                '& .fk-rk-eingabe': {
                    position: 'absolute',
                    zIndex: 2,
                    boxSizing: 'border-box',
                    maxWidth: 'min(260px, 100%)',
                    padding: '2px 6px 3px',
                    fontSize: '0.75rem',
                    lineHeight: 1.35,
                    color: 'text.primary',
                    backgroundColor: farben.flaeche,
                    border: `1px solid ${farben.fokus}`,
                    borderRadius: '6px',
                    boxShadow: '0 1px 4px rgba(0, 0, 0, 0.25)',
                },
                '& .fk-rk-eingabe[data-falsch="1"]': { borderColor: farben.fehler },
                '& .fk-rk-eingabe label': { display: 'inline-flex', alignItems: 'baseline', gap: '4px', whiteSpace: 'nowrap' },
                '& .fk-rk-eingabe input': {
                    width: '3.4em',
                    font: 'inherit',
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
                '& .fk-rk-grund': { color: farben.fehler, whiteSpace: 'normal', overflowWrap: 'anywhere' },
                '& .fk-rk-unten': { fontSize: '0.8125rem', color: 'text.secondary', mt: 0.5 },
                // fester Platz fuer die Meldung einer abgelehnten Eingabe
                '& .fk-rk-notiz': { minHeight: '1.3em', color: farben.fehler },
                '& .fk-rk-leiste': { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '4px 12px', mt: 0.25 },
                '& .fk-rk-leiste .MuiButton-root': { textTransform: 'none' },
            }}
        >
            <div className="fk-rk-titel">{t('rkTitel')}</div>
            <div className="fk-rk-erklaerung">{t('rkErklaerung')}</div>
            <div
                className="fk-rk-bild"
                ref={rahmen}
            >
                <svg
                    ref={svg}
                    xmlns="http://www.w3.org/2000/svg"
                    viewBox={`0 0 ${B} ${H}`}
                    role="group"
                    aria-label={t('rkTitel')}
                >
                    {/* Zonen, in denen die Korrektur nicht mehr zaehlt: volle Leistung (links) und Ueberheizschutz (rechts) */}
                    <rect
                        className="fk-rk-zone"
                        x={X(-X_MAX)}
                        y={RAND.o}
                        width={X(xVoll) - X(-X_MAX)}
                        height={HH}
                        fill={FARBE.kalt}
                        fillOpacity="0.1"
                    >
                        <title>{t('rkVoll', zahl(regel.SCHWELLEN.vollAbK))}</title>
                    </rect>
                    <rect
                        className="fk-rk-zone"
                        x={X(xUeber)}
                        y={RAND.o}
                        width={X(X_MAX) - X(xUeber)}
                        height={HH}
                        fill={FARBE.warm}
                        fillOpacity="0.1"
                    >
                        <title>{t('rkUeber', zahl(regel.SCHWELLEN.ueberAbK))}</title>
                    </rect>
                    {/* Totband */}
                    <rect
                        className="fk-rk-band"
                        x={X(-totband)}
                        y={RAND.o}
                        width={Math.max(0, X(totband) - X(-totband))}
                        height={HH}
                        fill="currentColor"
                        fillOpacity="0.07"
                    />
                    {yStriche.map(p => (
                        <g key={p}>
                            <line
                                x1={RAND.l}
                                x2={B - RAND.r}
                                y1={Y(p)}
                                y2={Y(p)}
                                stroke="currentColor"
                                strokeOpacity={p ? 0.12 : 0.4}
                            />
                            <text
                                x={RAND.l - 6}
                                y={Y(p) + 4}
                                textAnchor="end"
                                fillOpacity="0.7"
                            >
                                {mitVorzeichen(p)}
                            </text>
                        </g>
                    ))}
                    {[-3, -2, -1, 0, 1, 2, 3].map(k => (
                        <g key={k}>
                            <line
                                x1={X(k)}
                                x2={X(k)}
                                y1={RAND.o + HH}
                                y2={RAND.o + HH + 4}
                                stroke="currentColor"
                                strokeOpacity="0.35"
                            />
                            <text
                                x={X(k)}
                                y={RAND.o + HH + 16}
                                textAnchor="middle"
                                fillOpacity="0.7"
                            >
                                {k ? mitVorzeichen(k) : '0'}
                            </text>
                        </g>
                    ))}
                    <text
                        x={RAND.l}
                        y={H - 4}
                        fillOpacity="0.75"
                        fill={FARBE.kalt}
                    >
                        ← {t('rkKalt')}
                    </text>
                    <text
                        x={X(0)}
                        y={H - 4}
                        textAnchor="middle"
                        fillOpacity="0.7"
                    >
                        {B >= 420 ? t('rkAchseX') : 'K'}
                    </text>
                    <text
                        x={B - RAND.r}
                        y={H - 4}
                        textAnchor="end"
                        fillOpacity="0.75"
                    >
                        {t('rkWarm')} →
                    </text>
                    <text
                        x={RAND.l + 4}
                        y={RAND.o + 11}
                        fillOpacity="0.6"
                    >
                        {t('rkMehr')}
                    </text>
                    <text
                        x={RAND.l + 4}
                        y={RAND.o + HH - 5}
                        fillOpacity="0.6"
                    >
                        {t('rkWeniger')}
                    </text>
                    <path
                        className="fk-rk-linie"
                        d={pfad}
                        fill="none"
                        stroke={farben.fokus}
                        strokeWidth="2.4"
                        strokeLinejoin="round"
                        strokeLinecap="round"
                    />
                    {/* Gegenstueck des Totband-Griffs (nur Anzeige) */}
                    <circle
                        cx={X(-totband)}
                        cy={Y(0)}
                        r="3.5"
                        fill={farben.flaeche}
                        stroke={farben.fokus}
                        strokeWidth="1.6"
                        pointerEvents="none"
                    />
                    {eingabe && eingabe.welche === 'staerke' ? null : (
                        <text
                            className="fk-rk-wahl"
                            data-welche="staerke"
                            x={Math.min(sx0, B - RAND.r - breite(textStaerke))}
                            y={sy0}
                            stroke={farben.flaeche}
                            strokeWidth="3"
                            strokeLinejoin="round"
                            paintOrder="stroke"
                            onDoubleClick={() => oeffnen('staerke')}
                            onPointerDown={e => {
                                zeigerArt.current = e.pointerType || 'mouse';
                            }}
                            onClick={() => zeigerArt.current !== 'mouse' && oeffnen('staerke')}
                        >
                            <title>{t(TOUCH ? 'rkHinweisTouch' : 'rkEingabeTipp')}</title>
                            {textStaerke}
                        </text>
                    )}
                    {eingabe && eingabe.welche === 'totband' ? null : (
                        <text
                            className="fk-rk-wahl"
                            data-welche="totband"
                            x={tx0}
                            y={ty0}
                            textAnchor="middle"
                            stroke={farben.flaeche}
                            strokeWidth="3"
                            strokeLinejoin="round"
                            paintOrder="stroke"
                            onDoubleClick={() => oeffnen('totband')}
                            onPointerDown={e => {
                                zeigerArt.current = e.pointerType || 'mouse';
                            }}
                            onClick={() => zeigerArt.current !== 'mouse' && oeffnen('totband')}
                        >
                            <title>{t(TOUCH ? 'rkHinweisTouch' : 'rkEingabeTipp')}</title>
                            {textTotband}
                        </text>
                    )}
                    {griff('totband', X(totband), Y(0), t('rkNameTotband'), totband)}
                    {griff('staerke', X(xStaerke), Y(yStaerke), t('rkNameStaerke'), staerke)}
                </svg>
                {eingabe && eb ? (
                    <div
                        className="fk-rk-eingabe"
                        data-falsch={eingabe.grund ? '1' : undefined}
                        data-welche={eingabe.welche}
                        style={
                            eingabe.welche === 'staerke'
                                ? { left: `${(Math.min(sx0, B - 150) / B) * 100}%`, top: `${((sy0 - 16) / H) * 100}%` }
                                : { left: `${((tx0 - 60) / B) * 100}%`, top: `${((ty0 - 16) / H) * 100}%` }
                        }
                    >
                        <label>
                            <span>{t(eingabe.welche === 'staerke' ? 'rkNameStaerke' : 'rkNameTotband')}</span>
                            <input
                                ref={eingabeFeld}
                                type="text"
                                inputMode="decimal"
                                value={eingabe.text}
                                aria-invalid={!!eingabe.grund}
                                aria-describedby={eingabe.grund ? grundId : undefined}
                                onChange={e => setEingabe({ ...eingabe, text: e.target.value, grund: '' })}
                                onKeyDown={eingabeTaste}
                                onBlur={eingabeVerlassen}
                            />
                            <span>{eingabe.welche === 'staerke' ? '%' : 'K'}</span>
                        </label>
                        {eingabe.grund ? (
                            <div
                                id={grundId}
                                className="fk-rk-grund"
                                role="alert"
                            >
                                {eingabe.grund}
                            </div>
                        ) : null}
                    </div>
                ) : null}
            </div>
            <div className="fk-rk-unten">
                <div className="fk-rk-satz">{satzText(staerke, totband, sprache)}</div>
                <div className="fk-rk-beispiel">{t('rkBeispiel', mitVorzeichen(b1), mitVorzeichen(b2))}</div>
                <div>{t('rkHeizen')}</div>
                <div>{t(TOUCH ? 'rkHinweisTouch' : 'rkHinweis')}</div>
                <div
                    className="fk-rk-notiz"
                    role="status"
                >
                    {notiz}
                </div>
            </div>
            <div className="fk-rk-leiste">
                <Button
                    className="fk-rk-werk"
                    size="small"
                    color="inherit"
                    disabled={istWerk}
                    onClick={() => props.onBeide(regel.BEREICH.staerke.vorgabe, regel.BEREICH.totband.vorgabe)}
                >
                    {t('rkZurueck')}
                </Button>
                <span className="fk-rk-werktext">{t('rkWerk', zahl(regel.BEREICH.staerke.vorgabe), zahl(regel.BEREICH.totband.vorgabe))}</span>
            </div>
        </Box>
    );
}

/** jsonConfig-Komponente "Raumkorrektur": Attribut `regelProzentProK`, daneben `regelTotband` (custom.attrTotband). */
class Raumkorrektur extends ConfigGeneric<ConfigGenericProps, ConfigGenericState> {
    attrTotband(): string {
        const roh = (this.props.schema || {}) as unknown as Record<string, unknown>;
        const eigen = (roh.custom || {}) as Record<string, unknown>;
        return typeof eigen.attrTotband === 'string' && eigen.attrTotband ? eigen.attrTotband : 'regelTotband';
    }

    onWert = (welche: Welche, wert: number): void => {
        const attr = welche === 'staerke' ? this.props.attr : this.attrTotband();
        if (attr) {
            void this.onChange(attr, wert);
        }
    };

    /** beide Werte in EINEM Zug: zwei onChange hintereinander wuerden sich ueberschreiben */
    onBeide = (staerke: number, totband: number): void => {
        if (!this.props.attr) {
            return;
        }
        const data = JSON.parse(JSON.stringify(this.props.data || {})) as Record<string, unknown>;
        ConfigGeneric.setValue(data, this.props.attr, staerke);
        ConfigGeneric.setValue(data, this.attrTotband(), totband);
        const attrs = [this.props.attr, this.attrTotband()];
        this.props.onChange(data, undefined, () => this.props.oContext?.forceUpdate?.(attrs, data));
    };

    renderItem(): React.JSX.Element {
        const palette = this.props.oContext?.theme?.palette;
        return (
            <RaumkorrekturAnsicht
                staerke={regel.lesen('staerke', ConfigGeneric.getValue(this.props.data, this.props.attr as string))}
                totband={regel.lesen('totband', ConfigGeneric.getValue(this.props.data, this.attrTotband()))}
                sprache={I18n.getLanguage()}
                farben={{
                    flaeche: palette?.background?.paper || '#fff',
                    fokus: palette?.primary?.main || '#3399cc',
                    fehler: palette?.error?.main || '#d9534f',
                }}
                onWert={this.onWert}
                onBeide={this.onBeide}
            />
        );
    }
}

export default Raumkorrektur;
