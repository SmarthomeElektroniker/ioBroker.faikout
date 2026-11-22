/*
 * Grafiken des Reiters "Effizienz": Erklaerbild (wie wird gerechnet), Luftstrom je Luefterstufe (Balken, ziehbar),
 * Wirksamkeit ε je Stufe und die Abdeckung einer Kalibriermessung. Reine Darstellung - Daten und Rueckrufe
 * kommen von aussen (Effizienz.tsx).
 */
import React, { useEffect, useRef, useState } from 'react';

import { t, type Schluessel } from './Effizienz.texte';

export const STUFEN = ['SL', 'L', 'ML', 'M', 'MH', 'H'] as const;
export type Stufe = (typeof STUFEN)[number];
export type Art = 'heizen' | 'kuehlen';

export interface Farben {
    text: string;
    blass: string;
    linie: string;
    flaeche: string;
    karte: string;
    akzent: string;
    gut: string;
    warn: string;
    fehler: string;
    heizen: string;
    kuehlen: string;
}

/** Zahl in Landesschreibweise mit fester Stellenzahl */
export function zahl(wert: number | null | undefined, stellen: number, sprache: string): string {
    if (typeof wert !== 'number' || !isFinite(wert)) {
        return '–';
    }
    return wert.toLocaleString(sprache, { minimumFractionDigits: stellen, maximumFractionDigits: stellen });
}

export const stufenName = (sprache: string, s: string | null | undefined): string =>
    s && (STUFEN as readonly string[]).includes(s) ? t(sprache, `s${s}` as Schluessel) : '–';

// ------------------------------------------------------------------ Erklaerbild

export function Erklaerbild(props: { sprache: string; f: Farben }): React.JSX.Element {
    const { sprache, f } = props;
    const teile: [Schluessel, Schluessel, string, string][] = [
        ['gAnsaug', 'gAnsaugWert', 'M4 12h10M10 8l4 4-4 4', f.blass],
        ['gRegister', 'gRegisterWert', 'M6 5v14M10 5v14M14 5v14M18 5v14M4 9h16M4 15h16', f.heizen],
        ['gLuefter', 'gLuefterWert', 'M12 12c0-5 4-6 5-3s-2 4-5 3zm0 0c5 0 6 4 3 5s-4-2-3-5zm0 0c0 5-4 6-5 3s2-4 5-3zm0 0c-5 0-6-4-3-5s4 2 3 5z', f.akzent],
        ['gAustritt', 'gAustrittWert', 'M4 8c3-3 5 3 8 0s5 3 8 0M4 14c3-3 5 3 8 0s5 3 8 0', f.heizen],
    ];
    return (
        <div
            className="fk-e-erkl"
            role="img"
            aria-label={`${t(sprache, 'gFormelWaerme')}. ${t(sprache, 'gFormelCop')}`}
        >
            <div className="fk-e-erkl-reihe">
                {teile.map(([titel, wert, pfad, farbe], i) => (
                    <React.Fragment key={titel}>
                        {i > 0 ? (
                            <span
                                className="fk-e-erkl-pfeil"
                                aria-hidden="true"
                            >
                                →
                            </span>
                        ) : null}
                        <div className="fk-e-erkl-teil">
                            <svg
                                viewBox="0 0 24 24"
                                width="28"
                                height="28"
                                aria-hidden="true"
                                fill="none"
                                stroke={farbe}
                                strokeWidth="1.7"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                            >
                                <path d={pfad} />
                            </svg>
                            <div>
                                <div className="fk-e-erkl-titel">{t(sprache, titel)}</div>
                                <div className="fk-e-blass">{t(sprache, wert)}</div>
                            </div>
                        </div>
                    </React.Fragment>
                ))}
            </div>
            <div className="fk-e-erkl-formeln">
                <span className="fk-e-formel">{t(sprache, 'gFormelWaerme')}</span>
                <span className="fk-e-formel">{t(sprache, 'gFormelCop')}</span>
            </div>
            <div className="fk-e-blass">{t(sprache, 'gHinweis')}</div>
        </div>
    );
}

// ------------------------------------------------------------------ Luftstrom je Stufe (ziehbar)

const BREIT = 600;
const H = 230;

/**
 * Breite des Bildes in echten Pixeln: Auf schmalen Fenstern wird das Bild nicht verkleinert (die Schrift
 * waere unlesbar), sondern schmaler gezeichnet.
 */
function useBreite(): [React.RefObject<HTMLDivElement | null>, number] {
    const huelle = useRef<HTMLDivElement>(null);
    const [breite, setBreite] = useState(BREIT);
    useEffect(() => {
        const messen = (): void => {
            const w = huelle.current ? huelle.current.clientWidth : BREIT;
            setBreite(Math.max(280, Math.min(BREIT, Math.round(w))));
        };
        messen();
        window.addEventListener('resize', messen);
        return () => window.removeEventListener('resize', messen);
    }, []);
    return [huelle, breite];
}

/** Beschriftung einer Stufe unter dem Bild: passt sie nicht in ihr Feld, bricht sie an Bindestrich oder Leerzeichen um */
function StufenText(props: { x: number; y: number; text: string; platz: number; farbe: string }): React.JSX.Element {
    const teile = props.text.length * 6.3 > props.platz ? props.text.split(/(?<=-)| /).filter(Boolean) : [props.text];
    return (
        <text
            x={props.x}
            y={props.y}
            textAnchor="middle"
            fontSize={teile.length > 1 ? 10.5 : 11.5}
            fill={props.farbe}
        >
            {teile.slice(0, 2).map((teil, i) => (
                <tspan
                    key={i}
                    x={props.x}
                    dy={i ? 11.5 : 0}
                >
                    {teil}
                </tspan>
            ))}
        </text>
    );
}
const RAND = { l: 38, r: 8, o: 26, u: 48 };

export interface LuftstromProps {
    werte: Partial<Record<Stufe, number>>;
    herkunft: Partial<Record<Stufe, string>>;
    /** Stufe, auf der die Anlage gerade laeuft */
    jetzt?: string | null;
    art: Art;
    sprache: string;
    f: Farben;
    /** neuer eigener Wert (m³/min) einer Stufe */
    onWert?: (stufe: Stufe, wert: number) => void;
}

const HERKUNFT_TEXT: Record<string, Schluessel> = {
    datenblatt: 'lDatenblatt',
    interpoliert: 'lInterpoliert',
    eigen: 'lEigen',
    generisch: 'lGenerisch',
};

export function LuftstromBild(props: LuftstromProps): React.JSX.Element {
    const { werte, herkunft, sprache, f } = props;
    const svg = useRef<SVGSVGElement>(null);
    const [huelle, B] = useBreite();
    const [zug, setZug] = useState<{ stufe: Stufe; wert: number; hoechst: number } | null>(null);
    const [eingabe, setEingabe] = useState<{ stufe: Stufe; text: string } | null>(null);
    // waehrend des Ziehens bleibt die Achse stehen - sonst liefe der Wert unter dem Zeiger davon
    const hoechst = zug ? zug.hoechst : Math.max(12, Math.ceil(Math.max(...STUFEN.map(s => werte[s] || 0)) * 1.2));
    const breite = (B - RAND.l - RAND.r) / STUFEN.length;
    const y = (v: number): number => RAND.o + (1 - v / hoechst) * (H - RAND.o - RAND.u);
    const farbe = props.art === 'heizen' ? f.heizen : f.kuehlen;
    const ziehbar = !!props.onWert;

    const wertBei = (clientY: number): number => {
        const r = svg.current?.getBoundingClientRect();
        if (!r) {
            return 0;
        }
        const yy = ((clientY - r.top) / r.height) * H;
        const v = (1 - (yy - RAND.o) / (H - RAND.o - RAND.u)) * hoechst;
        return Math.round(Math.min(hoechst, Math.max(1, v)) * 10) / 10;
    };
    const setzen = (stufe: Stufe, wert: number): void => {
        if (props.onWert && isFinite(wert)) {
            props.onWert(stufe, Math.round(Math.min(40, Math.max(1, wert)) * 10) / 10);
        }
    };
    const tasten = (e: React.KeyboardEvent, stufe: Stufe): void => {
        const schritt = { ArrowUp: 0.1, ArrowDown: -0.1, PageUp: 1, PageDown: -1 }[e.key];
        if (schritt && ziehbar) {
            e.preventDefault();
            setzen(stufe, (werte[stufe] || 0) + schritt);
        } else if (e.key === 'Enter' && ziehbar) {
            e.preventDefault();
            setEingabe({ stufe, text: String(werte[stufe] ?? '') });
        }
    };
    const linien = [];
    for (let v = 0; v <= hoechst; v += hoechst > 20 ? 5 : 2) {
        linien.push(v);
    }
    const benutzt = [...new Set(STUFEN.map(s => herkunft[s]).filter(Boolean))] as string[];

    return (
        <div
            className="fk-e-bild"
            ref={huelle}
        >
            <svg
                ref={svg}
                viewBox={`0 0 ${B} ${H}`}
                className="fk-e-svg"
                style={{ touchAction: 'none' }}
            >
                {linien.map(v => (
                    <g key={v}>
                        <line
                            x1={RAND.l}
                            x2={B - RAND.r}
                            y1={y(v)}
                            y2={y(v)}
                            stroke={f.linie}
                            strokeWidth="1"
                        />
                        <text
                            x={RAND.l - 6}
                            y={y(v) + 4}
                            textAnchor="end"
                            fontSize="11"
                            fill={f.blass}
                        >
                            {v}
                        </text>
                    </g>
                ))}
                <text
                    x={4}
                    y={14}
                    fontSize="11"
                    fill={f.blass}
                >
                    {t(sprache, 'luftAchse')}
                </text>
                {STUFEN.map((s, i) => {
                    const w = zug && zug.stufe === s ? zug.wert : werte[s];
                    if (typeof w !== 'number') {
                        return null;
                    }
                    const x = RAND.l + i * breite + breite * 0.18;
                    const b = breite * 0.64;
                    const art = herkunft[s] || 'datenblatt';
                    const gerechnet = art === 'interpoliert';
                    return (
                        <g key={s}>
                            <rect
                                x={x}
                                y={y(w)}
                                width={b}
                                height={Math.max(0, y(0) - y(w))}
                                rx="3"
                                fill={farbe}
                                fillOpacity={gerechnet ? 0.3 : art === 'generisch' ? 0.45 : 0.8}
                                stroke={art === 'eigen' ? f.text : 'none'}
                                strokeWidth="1.5"
                                strokeDasharray={gerechnet ? '4 3' : undefined}
                            />
                            {props.jetzt === s ? (
                                <g>
                                    <circle
                                        cx={x + b / 2 - 10}
                                        cy={y(0) + 36}
                                        r="4"
                                        fill={f.akzent}
                                    />
                                    <text
                                        x={x + b / 2 - 3}
                                        y={y(0) + 40}
                                        fontSize="11"
                                        fill={f.akzent}
                                    >
                                        {t(sprache, 'lJetzt')}
                                    </text>
                                </g>
                            ) : null}
                            <text
                                x={x + b / 2}
                                y={y(w) - 7}
                                textAnchor="middle"
                                fontSize="13"
                                fontWeight="600"
                                fill={f.text}
                                className={ziehbar ? 'fk-e-zahl' : undefined}
                                onDoubleClick={ziehbar ? () => setEingabe({ stufe: s, text: String(w) }) : undefined}
                            >
                                {zahl(w, 1, sprache)}
                            </text>
                            <StufenText
                                x={x + b / 2}
                                y={y(0) + 15}
                                text={stufenName(sprache, s)}
                                platz={breite - 4}
                                farbe={f.text}
                            />
                            {ziehbar ? (
                                <rect
                                    x={x - 3}
                                    y={y(w) - 9}
                                    width={b + 6}
                                    height={18}
                                    rx="4"
                                    fill="transparent"
                                    className="fk-e-griff"
                                    role="slider"
                                    tabIndex={0}
                                    aria-label={t(sprache, 'luftWert', stufenName(sprache, s), zahl(w, 1, sprache))}
                                    aria-valuemin={1}
                                    aria-valuemax={40}
                                    aria-valuenow={w}
                                    data-stufe={s}
                                    onKeyDown={e => tasten(e, s)}
                                    onDoubleClick={() => setEingabe({ stufe: s, text: String(w) })}
                                    onPointerDown={e => {
                                        (e.target as Element).setPointerCapture(e.pointerId);
                                        setZug({ stufe: s, wert: w, hoechst });
                                    }}
                                    onPointerMove={e => {
                                        if (zug && zug.stufe === s) {
                                            setZug({ ...zug, wert: wertBei(e.clientY) });
                                        }
                                    }}
                                    onPointerUp={() => {
                                        if (zug && zug.stufe === s) {
                                            if (zug.wert !== werte[s]) {
                                                setzen(s, zug.wert);
                                            }
                                            setZug(null);
                                        }
                                    }}
                                    onPointerCancel={() => setZug(null)}
                                />
                            ) : null}
                        </g>
                    );
                })}
            </svg>
            {eingabe ? (
                <form
                    className="fk-e-eingabe"
                    onSubmit={e => {
                        e.preventDefault();
                        setzen(eingabe.stufe, Number(eingabe.text.replace(',', '.')));
                        setEingabe(null);
                    }}
                >
                    <label>
                        {stufenName(sprache, eingabe.stufe)}{' '}
                        <input
                            autoFocus
                            className="fk-e-feld fk-e-feld-kurz"
                            inputMode="decimal"
                            value={eingabe.text}
                            onChange={e => setEingabe({ stufe: eingabe.stufe, text: e.target.value })}
                            onKeyDown={e => e.key === 'Escape' && setEingabe(null)}
                        />{' '}
                        {t(sprache, 'luftAchse')}
                    </label>
                    <button
                        type="submit"
                        className="fk-e-knopf"
                    >
                        OK
                    </button>
                </form>
            ) : null}
            <div className="fk-e-legende">
                {benutzt.map(h => (
                    <span key={h}>
                        <span
                            className="fk-e-probe"
                            style={{
                                background: farbe,
                                opacity: h === 'interpoliert' ? 0.3 : h === 'generisch' ? 0.45 : 0.8,
                                outline: h === 'eigen' ? `1.5px solid ${f.text}` : undefined,
                            }}
                        />
                        {t(sprache, HERKUNFT_TEXT[h] || 'lDatenblatt')}
                    </span>
                ))}
            </div>
        </div>
    );
}

// ------------------------------------------------------------------ Wirksamkeit je Stufe

export interface EpsStufe {
    eps: number;
    herkunft: string;
    n?: number;
}
export interface EpsSatz {
    stufen: Partial<Record<Stufe, EpsStufe>>;
    unsicherheit: number;
    guete: string;
    zusammengefasst?: boolean;
    unterschied?: number | null;
    restfehler?: number | null;
    n?: number | null;
    bf?: number | null;
    generisch?: boolean;
}

const EPS_TEXT: Record<string, Schluessel> = {
    datenblatt: 'eDatenblatt',
    generisch: 'eGenerisch',
    gemessen: 'eGemessen',
    interpoliert: 'eInterpoliert',
    uebertragen: 'eUebertragen',
    zusammengefasst: 'eZusammengefasst',
};

export function EpsBild(props: { satz: EpsSatz; vergleich?: EpsSatz | null; sprache: string; f: Farben; art: Art }): React.JSX.Element {
    const { satz, vergleich, sprache, f } = props;
    const hoehe = 200;
    const [huelle, B] = useBreite();
    const alle = [...Object.values(satz.stufen), ...Object.values((vergleich && vergleich.stufen) || {})].map(s => (s ? s.eps : 1));
    const oben = Math.max(1.3, Math.ceil((Math.max(...alle, 1) * (1 + satz.unsicherheit) + 0.05) * 10) / 10);
    const unten = Math.min(0.5, Math.floor(Math.min(...alle, 1) * (1 - satz.unsicherheit) * 10) / 10);
    const breite = (B - RAND.l - RAND.r) / STUFEN.length;
    const y = (v: number): number => 14 + (1 - (v - unten) / (oben - unten)) * (hoehe - 14 - 44);
    const x = (i: number): number => RAND.l + (i + 0.5) * breite;
    const farbe = props.art === 'heizen' ? f.heizen : f.kuehlen;
    const gemessen = (h: string): boolean => h === 'gemessen';
    const marken = [];
    for (let v = Math.ceil(unten * 5) / 5; v <= oben + 1e-9; v += 0.2) {
        marken.push(Math.round(v * 10) / 10);
    }
    const punkte = STUFEN.map((s, i) => ({ s, i, e: satz.stufen[s] })).filter(p => p.e) as { s: Stufe; i: number; e: EpsStufe }[];
    const band =
        punkte.length > 1
            ? `M${punkte.map(p => `${x(p.i)},${y(p.e.eps * (1 + satz.unsicherheit))}`).join(' L')} L${[...punkte]
                  .reverse()
                  .map(p => `${x(p.i)},${y(p.e.eps * (1 - satz.unsicherheit))}`)
                  .join(' L')} Z`
            : '';
    const benutzt = [...new Set(punkte.map(p => p.e.herkunft))];
    return (
        <div
            className="fk-e-bild"
            ref={huelle}
        >
            <svg
                viewBox={`0 0 ${B} ${hoehe}`}
                className="fk-e-svg"
                role="img"
                aria-label={t(sprache, 'epsTitel')}
            >
                {marken.map(v => (
                    <g key={v}>
                        <line
                            x1={RAND.l}
                            x2={B - RAND.r}
                            y1={y(v)}
                            y2={y(v)}
                            stroke={f.linie}
                            strokeWidth={v === 1 ? 1.6 : 1}
                            strokeDasharray={v === 1 ? undefined : '2 4'}
                        />
                        <text
                            x={RAND.l - 6}
                            y={y(v) + 4}
                            textAnchor="end"
                            fontSize="11"
                            fill={f.blass}
                        >
                            {zahl(v, 1, sprache)}
                        </text>
                    </g>
                ))}
                <text
                    x={4}
                    y={12}
                    fontSize="11"
                    fill={f.blass}
                >
                    ε
                </text>
                {band ? (
                    <path
                        d={band}
                        fill={farbe}
                        fillOpacity="0.13"
                    />
                ) : null}
                {vergleich
                    ? STUFEN.map((s, i) =>
                          vergleich.stufen[s] ? (
                              <circle
                                  key={s}
                                  cx={x(i)}
                                  cy={y(vergleich.stufen[s].eps)}
                                  r="4"
                                  fill="none"
                                  stroke={f.blass}
                                  strokeWidth="1.5"
                                  strokeDasharray="2 2"
                              />
                          ) : null,
                      )
                    : null}
                {punkte.length > 1 ? (
                    <polyline
                        points={punkte.map(p => `${x(p.i)},${y(p.e.eps)}`).join(' ')}
                        fill="none"
                        stroke={farbe}
                        strokeWidth="1.5"
                        strokeOpacity="0.6"
                    />
                ) : null}
                {punkte.map(p => (
                    <g key={p.s}>
                        <circle
                            cx={x(p.i)}
                            cy={y(p.e.eps)}
                            r={gemessen(p.e.herkunft) ? 6 : 5}
                            fill={gemessen(p.e.herkunft) ? farbe : f.flaeche}
                            stroke={farbe}
                            strokeWidth="2"
                        />
                        <text
                            x={x(p.i)}
                            y={y(p.e.eps) - 11}
                            textAnchor="middle"
                            fontSize="12.5"
                            fontWeight="600"
                            fill={f.text}
                        >
                            {zahl(p.e.eps, 2, sprache)}
                        </text>
                    </g>
                ))}
                {STUFEN.map((s, i) => (
                    <StufenText
                        key={s}
                        x={x(i)}
                        y={hoehe - 24}
                        text={stufenName(sprache, s)}
                        platz={breite - 4}
                        farbe={f.text}
                    />
                ))}
            </svg>
            <div className="fk-e-legende">
                {benutzt.map(h => (
                    <span key={h}>
                        <span
                            className="fk-e-probe fk-e-probe-rund"
                            style={{ background: gemessen(h) ? farbe : f.flaeche, border: `2px solid ${farbe}` }}
                        />
                        {t(sprache, EPS_TEXT[h] || 'eDatenblatt')}
                    </span>
                ))}
                {vergleich ? (
                    <span>
                        <span
                            className="fk-e-probe fk-e-probe-rund"
                            style={{ border: `1.5px dashed ${f.blass}` }}
                        />
                        {t(sprache, vergleich.generisch ? 'eGenerisch' : 'eDatenblatt')}
                    </span>
                ) : null}
            </div>
        </div>
    );
}

// ------------------------------------------------------------------ Abdeckung der Messung

export interface Abdeckung {
    gesamt: number;
    stufen: Record<Stufe, { n: number; stand: 'ok' | 'knapp' | 'wenig' }>;
    aussen: { von: number; bis: number; n: number }[];
    naechste: Stufe | null;
    fertig: boolean;
}

export function AbdeckungBild(props: { a: Abdeckung; ziel: number; sprache: string; f: Farben }): React.JSX.Element {
    const { a, ziel, sprache, f } = props;
    const voll = Math.max(ziel * 2, ...STUFEN.map(s => a.stufen[s].n));
    const farbe = { ok: f.gut, knapp: f.warn, wenig: f.blass };
    const standText = { ok: 'aOk', knapp: 'aKnapp', wenig: 'aWenig' } as const;
    const aussenVoll = Math.max(1, ...a.aussen.map(b => b.n));
    const bereich = (b: { von: number; bis: number }): string =>
        b.von < -40 ? t(sprache, 'aussenUnter', b.bis) : b.bis > 40 ? t(sprache, 'aussenUeber', b.von) : t(sprache, 'aussenBis', b.von, b.bis);
    return (
        <div className="fk-e-abdeckung">
            <div>
                <div className="fk-e-untertitel">{t(sprache, 'abdeckungStufen')}</div>
                {STUFEN.map(s => (
                    <div
                        key={s}
                        className="fk-e-balkenzeile"
                        data-stufe={s}
                        data-stand={a.stufen[s].stand}
                    >
                        <div className="fk-e-balkentext">
                            {t(sprache, 'stufeZeile', stufenName(sprache, s), a.stufen[s].n, t(sprache, standText[a.stufen[s].stand]))}
                        </div>
                        <div
                            className="fk-e-balken"
                            style={{ background: f.linie }}
                        >
                            <div style={{ width: `${Math.min(100, (a.stufen[s].n / voll) * 100)}%`, background: farbe[a.stufen[s].stand] }} />
                            <span
                                className="fk-e-ziel"
                                style={{ left: `${(ziel / voll) * 100}%`, background: f.text }}
                            />
                        </div>
                    </div>
                ))}
            </div>
            <div>
                <div className="fk-e-untertitel">{t(sprache, 'abdeckungAussen')}</div>
                {a.aussen.map(b => (
                    <div
                        key={b.von}
                        className="fk-e-balkenzeile"
                    >
                        <div className="fk-e-balkentext">
                            {bereich(b)}: {b.n}
                        </div>
                        <div
                            className="fk-e-balken"
                            style={{ background: f.linie }}
                        >
                            <div style={{ width: `${(b.n / aussenVoll) * 100}%`, background: b.n ? f.akzent : 'transparent' }} />
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
}

/** Gemeinsame Stile des Reiters (einmal je Seite eingehaengt) */
export function Stile(props: { f: Farben }): React.JSX.Element {
    const f = props.f;
    return (
        <style>{`
.fk-e { color: ${f.text}; font-size: 14px; line-height: 1.45; max-width: 1100px; }
.fk-e-blass { color: ${f.blass}; font-size: 12.5px; }
.fk-e-erkl { border: 1px solid ${f.linie}; border-radius: 8px; padding: 12px 14px; margin: 10px 0 14px; background: ${f.karte}; }
.fk-e-erkl-reihe { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 10px; }
.fk-e-erkl-teil { display: flex; align-items: center; gap: 8px; min-width: 150px; }
.fk-e-erkl-titel { font-weight: 600; }
.fk-e-erkl-pfeil { color: ${f.blass}; font-size: 18px; }
.fk-e-erkl-formeln { display: flex; flex-wrap: wrap; gap: 8px; margin: 10px 0 6px; }
.fk-e-formel { border: 1px solid ${f.akzent}; border-radius: 14px; padding: 2px 10px; font-weight: 600; }
.fk-e-karte { border: 1px solid ${f.linie}; border-radius: 8px; margin: 10px 0; background: ${f.karte}; overflow: hidden; }
.fk-e-kopf { display: flex; align-items: center; gap: 10px; width: 100%; padding: 10px 12px; background: none; border: 0; color: inherit; font: inherit; text-align: left; cursor: pointer; }
.fk-e-kopf:focus-visible, .fk-e-griff:focus-visible, .fk-e-knopf:focus-visible { outline: 2px solid ${f.akzent}; outline-offset: 2px; }
.fk-e-kopf svg { flex: none; }
.fk-e-name { font-weight: 600; font-size: 15px; }
.fk-e-kopftext { flex: 1; min-width: 0; }
.fk-e-pfeil { transition: transform .2s; color: ${f.blass}; }
.fk-e-offen > .fk-e-kopf .fk-e-pfeil { transform: rotate(180deg); }
.fk-e-inhalt { padding: 4px 14px 14px; border-top: 1px solid ${f.linie}; }
.fk-e-marke { display: inline-block; border-radius: 10px; padding: 0 8px; font-size: 12px; border: 1px solid ${f.linie}; margin-left: 6px; white-space: nowrap; }
.fk-e-kacheln { display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 8px; margin: 12px 0 6px; }
.fk-e-kachel { border: 1px solid ${f.linie}; border-radius: 8px; padding: 8px 10px; background: ${f.flaeche}; }
.fk-e-kachel b { display: block; font-size: 22px; font-weight: 600; line-height: 1.2; }
.fk-e-abschnitt { margin-top: 16px; }
.fk-e-titel { font-weight: 600; margin-bottom: 2px; }
.fk-e-untertitel { font-weight: 600; font-size: 13px; margin: 8px 0 4px; }
.fk-e-hinweis { border-left: 3px solid ${f.warn}; padding: 4px 10px; margin: 8px 0; background: ${f.flaeche}; }
.fk-e-hinweis-fehler { border-left-color: ${f.fehler}; }
.fk-e-hinweis-gut { border-left-color: ${f.gut}; }
.fk-e-bild { max-width: 640px; }
.fk-e-svg { width: 100%; height: auto; display: block; user-select: none; }
.fk-e-griff { cursor: ns-resize; }
.fk-e-griff:hover { fill: ${f.akzent}; fill-opacity: .18; }
.fk-e-zahl { cursor: text; }
.fk-e-legende { display: flex; flex-wrap: wrap; gap: 4px 14px; font-size: 12px; color: ${f.blass}; margin-top: 2px; }
.fk-e-probe { display: inline-block; width: 12px; height: 10px; border-radius: 2px; margin-right: 5px; vertical-align: -1px; box-sizing: border-box; }
.fk-e-probe-rund { width: 11px; height: 11px; border-radius: 50%; }
.fk-e-knopf { font: inherit; font-size: 13px; padding: 5px 12px; border-radius: 4px; border: 1px solid ${f.akzent}; background: none; color: ${f.akzent}; cursor: pointer; }
.fk-e-knopf:disabled { opacity: .45; cursor: default; }
.fk-e-knopf-voll { background: ${f.akzent}; color: #fff; }
.fk-e-knopf-still { border-color: ${f.linie}; color: ${f.text}; }
.fk-e-knoepfe { display: flex; flex-wrap: wrap; gap: 8px; margin: 10px 0 4px; align-items: center; }
.fk-e-feld { font: inherit; font-size: 13.5px; padding: 6px 8px; border-radius: 4px; border: 1px solid ${f.linie}; background: ${f.flaeche}; color: ${f.text}; min-width: 0; box-sizing: border-box; }
.fk-e-feld-kurz { width: 84px; }
.fk-e-feld-lang { width: 100%; max-width: 420px; }
.fk-e-zeile { display: flex; flex-wrap: wrap; gap: 8px 12px; align-items: flex-end; margin: 8px 0; }
.fk-e-zeile label { display: flex; flex-direction: column; gap: 2px; font-size: 12.5px; color: ${f.blass}; min-width: 0; }
.fk-e-eingabe { display: flex; gap: 8px; align-items: center; margin: 4px 0; }
.fk-e-modelle { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 8px; margin: 8px 0; max-height: 360px; overflow: auto; }
.fk-e-modell { text-align: left; font: inherit; color: inherit; border: 1px solid ${f.linie}; border-radius: 6px; padding: 6px 9px; background: ${f.flaeche}; cursor: pointer; }
.fk-e-modell:hover, .fk-e-modell:focus-visible { border-color: ${f.akzent}; outline: none; }
.fk-e-modell b { display: block; }
.fk-e-modell-gewaehlt { border: 2px solid ${f.akzent}; }
.fk-e-schritte { display: flex; flex-wrap: wrap; gap: 6px; margin: 10px 0; }
.fk-e-schritt { border-radius: 14px; padding: 2px 12px; border: 1px solid ${f.linie}; color: ${f.blass}; font-size: 13px; }
.fk-e-schritt-an { border-color: ${f.akzent}; color: ${f.text}; font-weight: 600; }
.fk-e-abdeckung { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 6px 24px; max-width: 760px; }
.fk-e-balkenzeile { margin: 5px 0; }
.fk-e-balkentext { font-size: 12.5px; }
.fk-e-balken { position: relative; height: 9px; border-radius: 5px; overflow: hidden; }
.fk-e-balken > div { height: 100%; border-radius: 5px; }
.fk-e-ziel { position: absolute; top: 0; width: 2px; height: 100%; opacity: .55; }
.fk-e-liste { list-style: none; padding: 0; margin: 6px 0; }
.fk-e-liste li { display: flex; flex-wrap: wrap; gap: 6px 10px; align-items: center; padding: 6px 8px; border: 1px solid ${f.linie}; border-radius: 6px; margin: 4px 0; background: ${f.flaeche}; }
.fk-e-liste li > span:first-child { flex: 1; min-width: 180px; }
.fk-e-gilt { border-color: ${f.gut} !important; }
.fk-e-wahl { display: inline-flex; border: 1px solid ${f.linie}; border-radius: 6px; overflow: hidden; }
.fk-e-wahl button { font: inherit; font-size: 13px; padding: 3px 12px; border: 0; background: none; color: ${f.text}; cursor: pointer; }
.fk-e-wahl button[aria-pressed="true"] { background: ${f.akzent}; color: #fff; }
.fk-e a { color: ${f.akzent}; }
@media (max-width: 500px) { .fk-e-inhalt { padding: 4px 10px 12px; } .fk-e-erkl-pfeil { display: none; } .fk-e-kachel b { font-size: 19px; } }
`}</style>
    );
}
