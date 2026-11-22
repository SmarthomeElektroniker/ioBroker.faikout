/*
 * Reiter "Effizienz": Waermeleistung und COP je Anlage - wichtige Dinge zuerst (Live-Werte, Modell), dahinter
 * Luftstromkennlinie, Wirksamkeit und Kalibrierung.
 *
 * Geschrieben wird ins Formular (gilt nach "Speichern"): effizienzGeraete (je Anlage Modell, eigene
 * Luftstromwerte, dauerhafter Sensor), effizienzModelle (eigene Modelle), effizienzPreis. Live-Werte,
 * Messung und Kalibrierungen kommen vom Adapter (sendTo effizienzStand ...) und wirken sofort.
 * Der Adapter rechnet den Stand mit den UNGESPEICHERTEN Werten des Formulars, damit eine Modellwahl sofort
 * sichtbar wird.
 */
import React, { useState } from 'react';
import { DialogSelectID, I18n } from '@iobroker/gui-components';
import { ConfigGeneric, type ConfigGenericProps, type ConfigGenericState } from '@iobroker/json-config';

import modelleLib from '../../lib/effizienz/modelle.js';
import { t, type Schluessel } from './Effizienz.texte';
import { EpsBild, Erklaerbild, LuftstromBild, STUFEN, Stile, stufenName, zahl, type Art, type EpsSatz, type Farben, type Stufe } from './EffizienzGrafik';
import { KalibrierungAnsicht, type KalStand } from './EffizienzKalibrierung';

export interface Modell {
    hersteller: string;
    reihe?: string | null;
    modell: string;
    bauform?: string;
    nennKuehlenKW?: number | null;
    nennHeizenKW?: number | null;
    seer?: number | null;
    scop?: number | null;
    luftstromHeizen: Partial<Record<string, number | null>>;
    luftstromKuehlen: Partial<Record<string, number | null>>;
    quelle?: string;
    quelleLeistung?: string | null;
    quelleLeistungstabelle?: string;
    geprueft?: string;
    luecken?: string[];
    hinweis?: string;
    eigen?: boolean;
}
const modelle = modelleLib as {
    alle(eigene?: unknown[]): Modell[];
    finde(name: unknown, eigene?: unknown[]): Modell | null;
    filtern(liste: Modell[], f: { text?: string; hersteller?: string; reihe?: string; bauform?: string; groesse?: number }): Modell[];
    baugroesse(modell: string): number | null;
    luecken(m: Modell): string[];
};

export interface Zeile {
    geraet?: string;
    modell?: string;
    luftstromHeizen?: Partial<Record<string, number>>;
    luftstromKuehlen?: Partial<Record<string, number>>;
    austrittDp?: string;
    feuchteDp?: string;
    dauerhaft?: boolean;
}
interface Kennlinie {
    werte: Partial<Record<Stufe, number>>;
    herkunft: Partial<Record<Stufe, string>>;
    generisch: boolean;
}
export interface GeraetStand extends KalStand {
    online: boolean;
    verfuegbar: boolean;
    fehlt: string[];
    wartet: boolean;
    modell: string | null;
    generisch: boolean;
    kennlinie: Record<Art, Kennlinie>;
    drehzahlen: Record<Art, Partial<Record<Stufe, number>>>;
    live: {
        art: string;
        leistungKW: number | null;
        cop: number | null;
        luftstromM3h: number | null;
        stufe: string | null;
        tAus: number | null;
        guete: string;
        unsicherheit: number | null;
        unsicher: string[];
        abtauen: boolean;
        nurFuehlbar: boolean;
    } | null;
    mengen: {
        heat: Record<string, number | null>;
        cold: Record<string, number | null>;
        cop: Record<string, number | null>;
        eer: Record<string, number | null>;
    } | null;
}
export interface Stand {
    sprache: string;
    geraete: GeraetStand[];
    history: boolean;
    grenzen: { ok: number; knapp: number; abstandK: number };
}

export interface AnsichtProps {
    stand: Stand | null;
    zeilen: Zeile[];
    eigene: Modell[];
    preis: number;
    sprache: string;
    f: Farben;
    alive: boolean;
    waehrung?: string;
    /** fuer Tests: diese Karten sind von Anfang an offen */
    offen?: string[];
    onZeilen: (zeilen: Zeile[]) => void;
    onPreis: (preis: number) => void;
    /** Zeilen und eigene Modelle in EINEM Schritt (zwei Aufrufe nacheinander ueberschrieben einander) */
    onBeides: (zeilen: Zeile[], eigene: Modell[]) => void;
    befehl: (name: string, nachricht: Record<string, unknown>) => Promise<{ error?: string; [k: string]: unknown }>;
    objektWahl?: (aktuell: string, fertig: (id: string) => void) => void;
}

const BAUFORM: Record<string, Schluessel> = { wand: 'bWand', truhe: 'bTruhe', kanal: 'bKanal', kassette: 'bKassette', decke: 'bDecke' };
const GUETE: Record<string, Schluessel> = { estimated: 'geschaetzt', calibrated: 'kalibriert', measured: 'gemessen', unavailable: 'nichtVerfuegbar' };
const HOECHSTENS = 30;

/** Zeile einer Anlage in der Liste (nach ID oder Name) */
export function zeileVon(zeilen: Zeile[], g: { id: string; name: string }): Zeile | null {
    return zeilen.find(z => z && (z.geraet === g.id || z.geraet === g.name)) || null;
}

/** Liste mit geaenderter Zeile einer Anlage; eine Zeile ohne Inhalt verschwindet */
export function zeileSetzen(zeilen: Zeile[], g: { id: string; name: string }, teil: Partial<Zeile>): Zeile[] {
    const alt = zeileVon(zeilen, g);
    const neu: Zeile = { ...(alt || { geraet: g.name }), ...teil };
    for (const k of ['luftstromHeizen', 'luftstromKuehlen'] as const) {
        if (neu[k] && !Object.keys(neu[k]).length) {
            delete neu[k];
        }
    }
    for (const k of ['modell', 'austrittDp', 'feuchteDp', 'dauerhaft'] as const) {
        if (!neu[k]) {
            delete neu[k];
        }
    }
    const leer = Object.keys(neu).filter(k => k !== 'geraet').length === 0;
    const rest = zeilen.filter(z => z !== alt);
    return leer ? rest : alt ? zeilen.map(z => (z === alt ? neu : z)) : [...rest, neu];
}

function Pfeil(): React.JSX.Element {
    return (
        <svg
            className="fk-e-pfeil"
            viewBox="0 0 24 24"
            width="22"
            height="22"
            aria-hidden="true"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
        >
            <path d="M6 9l6 6 6-6" />
        </svg>
    );
}

/** Kurzangaben eines Modells: Bauform, Nennleistung, SEER/SCOP */
function ModellZeile(props: { m: Modell; sprache: string }): React.JSX.Element {
    const { m, sprache } = props;
    const teile = [
        m.bauform && BAUFORM[m.bauform] ? t(sprache, BAUFORM[m.bauform]) : '',
        typeof m.nennKuehlenKW === 'number' || typeof m.nennHeizenKW === 'number'
            ? t(sprache, 'nennWerte', zahl(m.nennKuehlenKW, 1, sprache), zahl(m.nennHeizenKW, 1, sprache))
            : '',
        typeof m.seer === 'number' ? `SEER ${zahl(m.seer, 2, sprache)}` : '',
        typeof m.scop === 'number' ? `SCOP ${zahl(m.scop, 2, sprache)}` : '',
    ].filter(Boolean);
    return <span className="fk-e-blass">{teile.join(' · ')}</span>;
}

/** Was die Quelle eines Modells nicht nennt - in Worten */
function lueckenText(m: Modell, sprache: string): string {
    const l = m.luecken || modelle.luecken(m);
    const teile: string[] = [];
    if (l.some(x => x.startsWith('nenn'))) {
        teile.push(t(sprache, 'lNenn'));
    }
    for (const k of ['seer', 'scop']) {
        if (l.includes(k)) {
            teile.push(k.toUpperCase());
        }
    }
    const stufen = [...new Set(l.filter(x => x.startsWith('luftstrom')).map(x => x.split('.')[1]))];
    for (const s of stufen) {
        teile.push(t(sprache, 'lLuft', stufenName(sprache, s)));
    }
    return teile.join(', ');
}

/** Modellwahl: Suchfeld, Filter, Trefferliste, eigenes Modell */
function ModellWahl(props: { eigene: Modell[]; gewaehlt: string | null; sprache: string; onWahl: (name: string) => void; onNeu: (m: Modell) => void; onZu: () => void }): React.JSX.Element {
    const { sprache } = props;
    const [f, setF] = useState({ text: '', reihe: '', bauform: '', groesse: '' });
    const [neu, setNeu] = useState<null | { modell: string; hersteller: string; h: Record<string, string>; k: Record<string, string> }>(null);
    const alle = modelle.alle(props.eigene);
    const reihen = [...new Set(alle.map(m => m.reihe).filter(Boolean))] as string[];
    const bauformen = [...new Set(alle.map(m => m.bauform).filter(Boolean))] as string[];
    const groessen = [...new Set(alle.map(m => modelle.baugroesse(m.modell)).filter(Boolean))].sort((a, b) => (a as number) - (b as number)) as number[];
    const treffer = modelle.filtern(alle, { text: f.text, reihe: f.reihe, bauform: f.bauform, groesse: f.groesse ? Number(f.groesse) : undefined });
    const wahl = (name: keyof typeof f, leer: Schluessel, optionen: [string, string][]): React.JSX.Element => (
        <select
            className="fk-e-feld"
            data-filter={name}
            aria-label={t(sprache, leer)}
            value={f[name]}
            onChange={e => setF({ ...f, [name]: e.target.value })}
        >
            <option value="">{t(sprache, leer)}</option>
            {optionen.map(([wert, label]) => (
                <option
                    key={wert}
                    value={wert}
                >
                    {label}
                </option>
            ))}
        </select>
    );
    const stufenFelder = (seite: 'h' | 'k', titel: Schluessel): React.JSX.Element | null =>
        neu ? (
            <div className="fk-e-zeile">
                <span style={{ minWidth: 70 }}>{t(sprache, titel)}</span>
                {['SL', 'L', 'M', 'H'].map(s => (
                    <label key={s}>
                        {stufenName(sprache, s)}
                        <input
                            className="fk-e-feld fk-e-feld-kurz"
                            inputMode="decimal"
                            data-eigen={`${seite}${s}`}
                            value={neu[seite][s] || ''}
                            onChange={e => setNeu({ ...neu, [seite]: { ...neu[seite], [s]: e.target.value } })}
                        />
                    </label>
                ))}
            </div>
        ) : null;
    const zahlen = (o: Record<string, string>): Record<string, number> =>
        Object.fromEntries(
            Object.entries(o)
                .map(([k, v]) => [k, Number(String(v).replace(',', '.'))] as [string, number])
                .filter(([, v]) => isFinite(v) && v >= 1 && v <= 40),
        );
    const neuGueltig = !!neu && !!neu.modell.trim() && (Object.keys(zahlen(neu.h)).length > 0 || Object.keys(zahlen(neu.k)).length > 0);
    return (
        <div
            className="fk-e-wahlfeld"
            data-teil="modellwahl"
        >
            <div className="fk-e-zeile">
                <input
                    className="fk-e-feld"
                    style={{ flex: '1 1 220px' }}
                    type="search"
                    data-feld="suche"
                    placeholder={t(sprache, 'suchen')}
                    aria-label={t(sprache, 'suchen')}
                    value={f.text}
                    autoFocus
                    onChange={e => setF({ ...f, text: e.target.value })}
                />
                {wahl(
                    'reihe',
                    'alleReihen',
                    reihen.map(r => [r, r]),
                )}
                {wahl(
                    'bauform',
                    'alleBauformen',
                    bauformen.map(b => [b, BAUFORM[b] ? t(sprache, BAUFORM[b]) : b]),
                )}
                {wahl(
                    'groesse',
                    'alleGroessen',
                    groessen.map(g => [String(g), String(g)]),
                )}
            </div>
            <div className="fk-e-blass">
                {t(sprache, 'treffer', treffer.length)}
                {treffer.length > HOECHSTENS ? ` – ${t(sprache, 'trefferMehr', HOECHSTENS)}` : ''}
            </div>
            {treffer.length ? (
                <div className="fk-e-modelle">
                    {treffer.slice(0, HOECHSTENS).map(m => (
                        <button
                            type="button"
                            key={m.modell}
                            className={`fk-e-modell${props.gewaehlt === m.modell ? ' fk-e-modell-gewaehlt' : ''}`}
                            data-modell={m.modell}
                            onClick={() => props.onWahl(m.modell)}
                        >
                            <b>{m.modell}</b>
                            <span className="fk-e-blass">
                                {[m.hersteller, m.eigen ? t(sprache, 'gEigen') : m.reihe].filter(Boolean).join(' · ')}
                                <br />
                                {t(sprache, 'luftstromH')}: {zahl(m.luftstromHeizen.H ?? m.luftstromKuehlen.H ?? null, 1, sprache)} {t(sprache, 'luftAchse')}
                                {typeof m.nennHeizenKW === 'number' ? ` · ${zahl(m.nennHeizenKW, 1, sprache)} kW` : ''}
                            </span>
                        </button>
                    ))}
                </div>
            ) : (
                <div className="fk-e-hinweis">{t(sprache, 'keinTreffer')}</div>
            )}
            {neu ? (
                <div
                    className="fk-e-kachel"
                    data-teil="eigen"
                >
                    <div className="fk-e-zeile">
                        <label>
                            {t(sprache, 'eigenBezeichnung')}
                            <input
                                className="fk-e-feld"
                                data-eigen="modell"
                                value={neu.modell}
                                onChange={e => setNeu({ ...neu, modell: e.target.value })}
                            />
                        </label>
                        <label>
                            {t(sprache, 'eigenHersteller')}
                            <input
                                className="fk-e-feld"
                                data-eigen="hersteller"
                                value={neu.hersteller}
                                onChange={e => setNeu({ ...neu, hersteller: e.target.value })}
                            />
                        </label>
                    </div>
                    <div className="fk-e-untertitel">{t(sprache, 'eigenLuft')}</div>
                    {stufenFelder('h', 'heizen')}
                    {stufenFelder('k', 'kuehlen')}
                    <div className="fk-e-blass">{t(sprache, 'eigenHinweis')}</div>
                    <div className="fk-e-knoepfe">
                        <button
                            type="button"
                            className="fk-e-knopf fk-e-knopf-voll"
                            data-aktion="eigenAnlegen"
                            disabled={!neuGueltig}
                            onClick={() => {
                                const name = neu.modell.trim();
                                const eintrag: Modell = {
                                    hersteller: neu.hersteller.trim(),
                                    modell: name,
                                    luftstromHeizen: zahlen(neu.h),
                                    luftstromKuehlen: zahlen(neu.k),
                                };
                                props.onNeu(eintrag);
                            }}
                        >
                            {t(sprache, 'eigenAnlegen')}
                        </button>
                        <button
                            type="button"
                            className="fk-e-knopf fk-e-knopf-still"
                            onClick={() => setNeu(null)}
                        >
                            {t(sprache, 'abbrechen')}
                        </button>
                    </div>
                </div>
            ) : (
                <div className="fk-e-knoepfe">
                    <button
                        type="button"
                        className="fk-e-knopf"
                        data-aktion="eigenNeu"
                        onClick={() => setNeu({ modell: f.text.trim(), hersteller: '', h: {}, k: {} })}
                    >
                        {t(sprache, 'eigenesModell')}
                    </button>
                    <button
                        type="button"
                        className="fk-e-knopf fk-e-knopf-still"
                        onClick={props.onZu}
                    >
                        {t(sprache, 'abbrechen')}
                    </button>
                </div>
            )}
        </div>
    );
}

/** Karte einer Anlage */
function Karte(props: AnsichtProps & { g: GeraetStand; start: boolean }): React.JSX.Element {
    const { g, sprache, f } = props;
    const merk = `faikout.effizienz.${g.id}`;
    const [offen, setOffen] = useState(() => {
        if (props.start) {
            return true;
        }
        try {
            return window.localStorage.getItem(merk) === 'true';
        } catch {
            return false;
        }
    });
    const [wahl, setWahl] = useState(false);
    const [art, setArt] = useState<Art | null>(null);
    const [kal, setKal] = useState(props.start);
    const zeile = zeileVon(props.zeilen, g) || {};
    const modell = modelle.finde(zeile.modell, props.eigene);
    const live = g.live;
    const kuehlt = live ? live.art === 'kuehlen' : false;
    const seite: Art = art || (kuehlt ? 'kuehlen' : 'heizen');
    const guete = live && g.verfuegbar ? live.guete : g.eps.heizen.guete;
    const gueteText = t(sprache, GUETE[guete] || 'geschaetzt');
    const laeuft = !!live && ['heizen', 'kuehlen'].includes(live.art);
    const mitUnsicherheit = (): string => (live && typeof live.unsicherheit === 'number' ? t(sprache, 'plusminus', gueteText, live.unsicherheit) : gueteText);

    // ---- Kopfzeile: das Wichtigste in einem Satz
    let kurz: string;
    if (!g.verfuegbar) {
        kurz = t(sprache, 'nichtVerfuegbar');
    } else if (g.wartet || !live) {
        kurz = t(sprache, 'wartet');
    } else if (laeuft) {
        kurz = `${kuehlt ? 'EER' : 'COP'} ${zahl(live.cop, 1, sprache)} · ${zahl(live.leistungKW, 2, sprache)} kW · ${mitUnsicherheit()}`;
    } else {
        const heute = g.mengen ? g.mengen.cop.today : null;
        kurz = t(sprache, live.art === 'abtauen' ? 'zAbtauen' : live.art === 'stillstand' ? 'zStillstand' : 'zAus').split(/[.–-] /)[0].replace(/\.$/, '');
        if (typeof heute === 'number') {
            kurz += ` · ${t(sprache, 'copHeute')} ${zahl(heute, 1, sprache)}`;
        }
    }
    const schalten = (): void => {
        try {
            window.localStorage.setItem(merk, offen ? 'false' : 'true');
        } catch {
            // ohne Speicher des Browsers bleibt die Karte nur fuer diese Sitzung offen
        }
        setOffen(!offen);
    };
    const eigeneWerte = (zeile[seite === 'heizen' ? 'luftstromHeizen' : 'luftstromKuehlen'] || {}) as Partial<Record<string, number>>;
    const kennlinie = g.kennlinie[seite];
    const eps = g.eps[seite];
    const aktiveKal = g.kalibrierungen.find(k => k.aktiv);
    const kosten = props.preis > 0 && g.mengen && typeof g.mengen.cop.today === 'number' && g.mengen.cop.today > 0 ? props.preis / g.mengen.cop.today : null;
    const m = g.messung;
    const kalKurz = m
        ? t(sprache, m.status === 'laeuft' ? 'kalVorschauLaeuft' : 'kalVorschauFertig', m.punkte)
        : aktiveKal
          ? t(sprache, 'kalVorschauAktiv', new Date(aktiveKal.zeit).toLocaleDateString(sprache))
          : t(sprache, 'kalVorschauOhne');

    return (
        <div
            className={`fk-e-karte${offen ? ' fk-e-offen' : ''}`}
            data-geraet={g.id}
        >
            <button
                type="button"
                className="fk-e-kopf"
                aria-expanded={offen}
                title={t(sprache, offen ? 'ausblenden' : 'einblenden')}
                onClick={schalten}
            >
                <svg
                    viewBox="0 0 24 24"
                    width="26"
                    height="26"
                    aria-hidden="true"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.7"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                >
                    <rect
                        x="3"
                        y="5"
                        width="18"
                        height="8"
                        rx="2"
                    />
                    <path d="M6.5 10h11M8 16.5c0 1-.6 1.6-1.4 2.2M12 16.5v2.7M16 16.5c0 1 .6 1.6 1.4 2.2" />
                </svg>
                <span className="fk-e-kopftext">
                    <span className="fk-e-name">{g.name}</span>
                    {g.verfuegbar && !modell ? <span className="fk-e-marke">{t(sprache, 'modellFehlt')}</span> : null}
                    {modell ? <span className="fk-e-marke">{modell.modell}</span> : null}
                    <span
                        className="fk-e-blass"
                        style={{ display: 'block' }}
                        data-teil="kurz"
                    >
                        {kurz}
                    </span>
                </span>
                <Pfeil />
            </button>
            {offen ? (
                <div className="fk-e-inhalt">
                    {!g.verfuegbar ? (
                        <div
                            className="fk-e-hinweis"
                            data-teil="nichtVerfuegbar"
                        >
                            {t(sprache, 'nichtVerfuegbarLang', g.fehlt.join(', '))}
                        </div>
                    ) : (
                        <>
                            {/* ---- Live */}
                            <div
                                className="fk-e-kacheln"
                                data-teil="live"
                            >
                                <div className="fk-e-kachel">
                                    <span className="fk-e-blass">{t(sprache, kuehlt ? 'kaelteleistung' : 'waermeleistung')}</span>
                                    <b>{laeuft && live ? `${zahl(live.leistungKW, 2, sprache)} kW` : '–'}</b>
                                    <span className="fk-e-blass">{laeuft ? mitUnsicherheit() : ''}</span>
                                </div>
                                <div className="fk-e-kachel">
                                    <span className="fk-e-blass">{t(sprache, kuehlt ? 'eerJetzt' : 'copJetzt')}</span>
                                    <b>{laeuft && live ? zahl(live.cop, 1, sprache) : '–'}</b>
                                    <span className="fk-e-blass">{laeuft ? gueteText : ''}</span>
                                </div>
                                <div className="fk-e-kachel">
                                    <span className="fk-e-blass">{t(sprache, kuehlt ? 'eerHeute' : 'copHeute')}</span>
                                    <b>{g.mengen ? zahl(kuehlt ? g.mengen.eer.today : g.mengen.cop.today, 1, sprache) : '–'}</b>
                                    <span className="fk-e-blass">{gueteText}</span>
                                </div>
                                <div className="fk-e-kachel">
                                    <span className="fk-e-blass">{t(sprache, kuehlt ? 'kaelteHeute' : 'waermeHeute')}</span>
                                    <b>{g.mengen ? `${zahl(kuehlt ? g.mengen.cold.today : g.mengen.heat.today, 1, sprache)} kWh` : '–'}</b>
                                    <span className="fk-e-blass">
                                        {g.mengen && typeof g.mengen.heat.thisMonth === 'number' && !kuehlt
                                            ? t(sprache, 'monat', zahl(g.mengen.heat.thisMonth, 0, sprache), zahl(g.mengen.cop.thisMonth, 1, sprache))
                                            : ''}
                                    </span>
                                </div>
                            </div>
                            {live && laeuft ? (
                                <div className="fk-e-blass">
                                    {t(sprache, 'zeileLuft', zahl(live.luftstromM3h, 0, sprache), stufenName(sprache, live.stufe), zahl(live.tAus, 1, sprache))}
                                </div>
                            ) : live ? (
                                <div className="fk-e-blass">{t(sprache, live.art === 'abtauen' ? 'zAbtauen' : live.art === 'stillstand' ? 'zStillstand' : 'zAus')}</div>
                            ) : null}
                            {live && laeuft
                                ? live.unsicher.map(u => (
                                      <div
                                          key={u}
                                          className="fk-e-hinweis"
                                      >
                                          {t(sprache, u === 'kleineLast' ? 'uKleineLast' : u === 'anlauf' ? 'uAnlauf' : 'uLuefterAuto')}
                                      </div>
                                  ))
                                : null}
                            {live && laeuft && live.nurFuehlbar ? <div className="fk-e-hinweis">{t(sprache, 'nurFuehlbar')}</div> : null}
                            {kosten !== null ? (
                                <div data-teil="kosten">
                                    {t(sprache, 'waermeKostet', `${zahl(kosten, 3, sprache)} ${props.waehrung || '€'}`)}
                                </div>
                            ) : null}

                            {/* ---- Modell */}
                            <div
                                className="fk-e-abschnitt"
                                data-teil="modell"
                            >
                                <div className="fk-e-titel">{t(sprache, 'modell')}</div>
                                {modell ? (
                                    <div>
                                        <b>{[modell.hersteller, modell.reihe, modell.modell].filter(Boolean).join(' ')}</b> <ModellZeile
                                            m={modell}
                                            sprache={sprache}
                                        />
                                        <div className="fk-e-blass">
                                            {modell.eigen ? (
                                                t(sprache, 'gEigen')
                                            ) : (
                                                <>
                                                    {t(sprache, 'quelle')}:{' '}
                                                    <a
                                                        href={modell.quelle}
                                                        target="_blank"
                                                        rel="noreferrer"
                                                    >
                                                        {t(sprache, 'herstellertabelle')}
                                                    </a>
                                                    {modell.quelleLeistungstabelle ? (
                                                        <>
                                                            {', '}
                                                            <a
                                                                href={modell.quelleLeistungstabelle}
                                                                target="_blank"
                                                                rel="noreferrer"
                                                            >
                                                                {t(sprache, 'leistungstabelle')}
                                                            </a>
                                                        </>
                                                    ) : null}
                                                    {' · '}
                                                    {t(sprache, modell.geprueft === 'original' ? 'gOriginal' : 'gZusammenfassung')}
                                                </>
                                            )}
                                        </div>
                                        {lueckenText(modell, sprache) && !modell.eigen ? (
                                            <div
                                                className="fk-e-blass"
                                                data-teil="luecken"
                                            >
                                                {t(sprache, 'luecken', lueckenText(modell, sprache))}
                                            </div>
                                        ) : null}
                                    </div>
                                ) : (
                                    <div className="fk-e-hinweis">{t(sprache, 'modellOhne')}</div>
                                )}
                                {wahl ? (
                                    <ModellWahl
                                        eigene={props.eigene}
                                        gewaehlt={modell ? modell.modell : null}
                                        sprache={sprache}
                                        onNeu={eintrag => {
                                            props.onBeides(
                                                zeileSetzen(props.zeilen, g, { modell: eintrag.modell, luftstromHeizen: {}, luftstromKuehlen: {} }),
                                                [...props.eigene.filter(e => e.modell.toUpperCase() !== eintrag.modell.toUpperCase()), eintrag],
                                            );
                                            setWahl(false);
                                        }}
                                        onZu={() => setWahl(false)}
                                        onWahl={name => {
                                            // ein anderes Modell hat andere Luftstroeme: eigene Werte gehoeren zum alten
                                            props.onZeilen(zeileSetzen(props.zeilen, g, { modell: name, luftstromHeizen: {}, luftstromKuehlen: {} }));
                                            setWahl(false);
                                        }}
                                    />
                                ) : (
                                    <div className="fk-e-knoepfe">
                                        <button
                                            type="button"
                                            className={`fk-e-knopf${modell ? '' : ' fk-e-knopf-voll'}`}
                                            data-aktion="modellWahl"
                                            onClick={() => setWahl(true)}
                                        >
                                            {t(sprache, modell ? 'modellAendern' : 'modellWaehlen')}
                                        </button>
                                        {modell ? (
                                            <button
                                                type="button"
                                                className="fk-e-knopf fk-e-knopf-still"
                                                data-aktion="modellEntfernen"
                                                onClick={() => props.onZeilen(zeileSetzen(props.zeilen, g, { modell: '', luftstromHeizen: {}, luftstromKuehlen: {} }))}
                                            >
                                                {t(sprache, 'modellEntfernen')}
                                            </button>
                                        ) : null}
                                        {modell && modell.eigen ? (
                                            <button
                                                type="button"
                                                className="fk-e-knopf fk-e-knopf-still"
                                                data-aktion="eigenLoeschen"
                                                onClick={() => {
                                                    props.onBeides(
                                                        zeileSetzen(props.zeilen, g, { modell: '', luftstromHeizen: {}, luftstromKuehlen: {} }),
                                                        props.eigene.filter(e => e.modell !== modell.modell),
                                                    );
                                                }}
                                            >
                                                {t(sprache, 'eigenLoeschen')}
                                            </button>
                                        ) : null}
                                    </div>
                                )}
                            </div>

                            {/* ---- Luftstrom */}
                            <div
                                className="fk-e-abschnitt"
                                data-teil="luftstrom"
                            >
                                <div
                                    className="fk-e-zeile"
                                    style={{ alignItems: 'center' }}
                                >
                                    <span className="fk-e-titel">
                                        {t(sprache, 'luftTitel')}{' '}
                                        <span
                                            className="fk-e-blass"
                                            data-teil="luftArt"
                                        >
                                            {t(sprache, Object.keys(eigeneWerte).length ? 'luftEigen' : kennlinie.generisch ? 'luftGenerisch' : 'luftDatenblatt')}
                                        </span>
                                    </span>
                                    <span className="fk-e-wahl">
                                        {(['heizen', 'kuehlen'] as Art[]).map(a => (
                                            <button
                                                type="button"
                                                key={a}
                                                data-art={a}
                                                aria-pressed={seite === a}
                                                onClick={() => setArt(a)}
                                            >
                                                {t(sprache, a)}
                                            </button>
                                        ))}
                                    </span>
                                </div>
                                <LuftstromBild
                                    werte={kennlinie.werte}
                                    herkunft={kennlinie.herkunft}
                                    jetzt={laeuft && live && (live.art === seite) ? live.stufe : null}
                                    art={seite}
                                    sprache={sprache}
                                    f={f}
                                    onWert={(stufe, wert) =>
                                        props.onZeilen(
                                            zeileSetzen(props.zeilen, g, {
                                                [seite === 'heizen' ? 'luftstromHeizen' : 'luftstromKuehlen']: { ...eigeneWerte, [stufe]: wert },
                                            }),
                                        )
                                    }
                                />
                                <div className="fk-e-blass">{t(sprache, 'luftHinweis')}</div>
                                <div className="fk-e-knoepfe">
                                    <button
                                        type="button"
                                        className="fk-e-knopf"
                                        data-aktion="luftZurueck"
                                        disabled={!Object.keys(eigeneWerte).length}
                                        onClick={() => props.onZeilen(zeileSetzen(props.zeilen, g, { [seite === 'heizen' ? 'luftstromHeizen' : 'luftstromKuehlen']: {} }))}
                                    >
                                        {t(sprache, modell ? 'luftZuruecksetzen' : 'luftZuruecksetzenGenerisch')}
                                    </button>
                                </div>
                                <div className="fk-e-blass">
                                    {Object.keys(g.drehzahlen[seite] || {}).length
                                        ? t(
                                              sprache,
                                              'drehzahlGelernt',
                                              STUFEN.filter(s => g.drehzahlen[seite][s])
                                                  .map(s => stufenName(sprache, s))
                                                  .join(', '),
                                          )
                                        : t(sprache, 'drehzahlOffen')}
                                </div>
                            </div>

                            {/* ---- Wirksamkeit */}
                            <div
                                className="fk-e-abschnitt"
                                data-teil="eps"
                            >
                                <div className="fk-e-titel">{t(sprache, 'epsTitel')}</div>
                                <div className="fk-e-blass">{t(sprache, 'epsErklaerung')}</div>
                                <EpsBild
                                    satz={eps as EpsSatz}
                                    vergleich={eps.guete === 'calibrated' ? g.vorgabe[seite] : null}
                                    sprache={sprache}
                                    f={f}
                                    art={seite}
                                />
                                <div
                                    className="fk-e-blass"
                                    data-teil="epsGilt"
                                >
                                    {t(
                                        sprache,
                                        'epsGilt',
                                        eps.guete === 'calibrated' && aktiveKal
                                            ? t(sprache, 'epsGiltKalibrierung', new Date(aktiveKal.zeit).toLocaleDateString(sprache), Math.round(eps.unsicherheit * 100))
                                            : t(sprache, eps.generisch ? 'epsGiltGenerisch' : 'epsGiltDatenblatt', Math.round(eps.unsicherheit * 100)),
                                    )}
                                </div>
                            </div>

                            {/* ---- Kalibrierung */}
                            <div
                                className={`fk-e-karte${kal ? ' fk-e-offen' : ''}`}
                                style={{ marginTop: 16 }}
                                data-teil="kalibrierung"
                            >
                                <button
                                    type="button"
                                    className="fk-e-kopf"
                                    aria-expanded={kal}
                                    data-aktion="kalOffen"
                                    onClick={() => setKal(!kal)}
                                >
                                    <svg
                                        viewBox="0 0 24 24"
                                        width="24"
                                        height="24"
                                        aria-hidden="true"
                                        fill="none"
                                        stroke="currentColor"
                                        strokeWidth="1.7"
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                    >
                                        <path d="M10 4v9.5a4 4 0 104 0V4a2 2 0 10-4 0zM12 9v7" />
                                    </svg>
                                    <span className="fk-e-kopftext">
                                        <span className="fk-e-name">{t(sprache, 'kalTitel')}</span>
                                        <span
                                            className="fk-e-blass"
                                            style={{ display: 'block' }}
                                        >
                                            {kalKurz}
                                        </span>
                                    </span>
                                    <Pfeil />
                                </button>
                                {kal ? (
                                    <div className="fk-e-inhalt">
                                        {props.alive ? (
                                            <KalibrierungAnsicht
                                                g={g}
                                                sprache={sprache}
                                                f={f}
                                                ziel={props.stand ? props.stand.grenzen.ok : 20}
                                                austrittDp={zeile.austrittDp || ''}
                                                feuchteDp={zeile.feuchteDp || ''}
                                                dauerhaft={!!zeile.dauerhaft}
                                                befehl={props.befehl}
                                                objektWahl={props.objektWahl}
                                                onSensor={teil => props.onZeilen(zeileSetzen(props.zeilen, g, teil))}
                                            />
                                        ) : (
                                            <div className="fk-e-hinweis">{t(sprache, 'adapterAus')}</div>
                                        )}
                                    </div>
                                ) : null}
                            </div>
                        </>
                    )}
                </div>
            ) : null}
        </div>
    );
}

export function EffizienzAnsicht(props: AnsichtProps): React.JSX.Element {
    const { sprache, f, stand } = props;
    const [preisText, setPreisText] = useState<string | null>(null);
    return (
        <div className="fk-e">
            <Stile f={f} />
            <div>{t(sprache, 'einleitung')}</div>
            <Erklaerbild
                sprache={sprache}
                f={f}
            />
            {!props.alive ? <div className="fk-e-hinweis">{t(sprache, 'adapterAus')}</div> : null}
            {props.alive && !stand ? <div className="fk-e-blass">{t(sprache, 'laedt')}</div> : null}
            {stand && !stand.geraete.length ? <div className="fk-e-hinweis">{t(sprache, 'keineGeraete')}</div> : null}
            {stand
                ? stand.geraete.map(g => (
                      <Karte
                          key={g.id}
                          {...props}
                          g={g}
                          start={(props.offen || []).includes(g.id)}
                      />
                  ))
                : null}
            <div className="fk-e-zeile">
                <label>
                    {t(sprache, 'preis')}
                    <span>
                        <input
                            className="fk-e-feld fk-e-feld-kurz"
                            inputMode="decimal"
                            data-feld="preis"
                            value={preisText ?? (props.preis > 0 ? String(props.preis).replace('.', sprache === 'en' || sprache === 'zh-cn' ? '.' : ',') : '')}
                            onChange={e => setPreisText(e.target.value)}
                            onBlur={() => {
                                if (preisText !== null) {
                                    const p = Number(preisText.replace(',', '.'));
                                    const neu = isFinite(p) && p > 0 ? Math.round(p * 10000) / 10000 : 0;
                                    if (neu !== (props.preis || 0)) {
                                        props.onPreis(neu);
                                    }
                                    setPreisText(null);
                                }
                            }}
                        />{' '}
                        {props.waehrung || '€'}
                    </span>
                </label>
                <span className="fk-e-blass">{t(sprache, 'preisHinweis')}</span>
            </div>
        </div>
    );
}

interface Zustand extends ConfigGenericState {
    stand: Stand | null;
    wahl: { aktuell: string; fertig: (id: string) => void } | null;
}

class Effizienz extends ConfigGeneric<ConfigGenericProps, Zustand> {
    takt: ReturnType<typeof setInterval> | null = null;
    lebt = true;

    async componentDidMount(): Promise<void> {
        await super.componentDidMount();
        this.laden();
        this.takt = setInterval(() => this.laden(), 5000);
    }

    componentWillUnmount(): void {
        this.lebt = false;
        if (this.takt) {
            clearInterval(this.takt);
        }
        super.componentWillUnmount?.();
    }

    componentDidUpdate(vorher: ConfigGenericProps): void {
        const d = (this.props.data || {}) as Record<string, unknown>;
        const v = (vorher.data || {}) as Record<string, unknown>;
        if (d.effizienzGeraete !== v.effizienzGeraete || d.effizienzModelle !== v.effizienzModelle || this.props.alive !== vorher.alive) {
            this.laden();
        }
    }

    ziel(): string {
        return `${this.props.oContext?.adapterName}.${this.props.oContext?.instance}`;
    }

    befehl = async (name: string, nachricht: Record<string, unknown>): Promise<{ error?: string; [k: string]: unknown }> => {
        const socket = this.props.oContext?.socket;
        if (!socket || typeof socket.sendTo !== 'function') {
            return { error: 'no connection' };
        }
        const antwort = ((await socket.sendTo(this.ziel(), name, nachricht)) || {}) as { error?: string; [k: string]: unknown };
        if (!antwort.error) {
            this.laden();
        }
        return antwort;
    };

    laden(): void {
        const socket = this.props.oContext?.socket;
        if (!this.props.alive || !socket || typeof socket.sendTo !== 'function') {
            return;
        }
        const d = (this.props.data || {}) as Record<string, unknown>;
        Promise.resolve(socket.sendTo(this.ziel(), 'effizienzStand', { zeilen: d.effizienzGeraete || [], modelle: d.effizienzModelle || [] }))
            .then((antwort: unknown) => {
                const a = antwort as Stand | null;
                if (this.lebt && a && Array.isArray(a.geraete)) {
                    this.setState({ stand: a });
                }
            })
            .catch(() => undefined);
    }

    renderItem(): React.JSX.Element {
        const d = (this.props.data || {}) as Record<string, unknown>;
        const palette = this.props.oContext?.theme?.palette;
        const dunkel = (this.props.oContext?.themeType || palette?.mode) === 'dark';
        const f: Farben = {
            text: palette?.text?.primary || (dunkel ? '#fff' : '#222'),
            blass: palette?.text?.secondary || (dunkel ? '#b0b0b0' : '#666'),
            linie: palette?.divider || (dunkel ? '#555' : '#d0d0d0'),
            flaeche: palette?.background?.paper || (dunkel ? '#1e1e1e' : '#fff'),
            karte: dunkel ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.025)',
            akzent: palette?.primary?.main || '#3399cc',
            gut: '#3d9a50',
            warn: '#d98a00',
            fehler: palette?.error?.main || '#d9534f',
            heizen: dunkel ? '#ff8a5c' : '#d8572a',
            kuehlen: dunkel ? '#5cb8ff' : '#2a7fd8',
        };
        const wahl = this.state.wahl;
        return (
            <>
                <EffizienzAnsicht
                    stand={this.state.stand || null}
                    zeilen={Array.isArray(d.effizienzGeraete) ? (d.effizienzGeraete as Zeile[]) : []}
                    eigene={Array.isArray(d.effizienzModelle) ? (d.effizienzModelle as Modell[]) : []}
                    preis={Number(d.effizienzPreis) || 0}
                    sprache={I18n.getLanguage()}
                    f={f}
                    alive={!!this.props.alive}
                    onZeilen={zeilen => void this.onChange('effizienzGeraete', zeilen)}
                    onPreis={preis => void this.onChange('effizienzPreis', preis)}
                    onBeides={(zeilen, eigene) => {
                        // ein gemeinsamer Stand: zwei onChange nacheinander ueberschrieben einander mit den alten Formulardaten
                        const data = JSON.parse(JSON.stringify(this.props.data || {}));
                        ConfigGeneric.setValue(data, 'effizienzGeraete', zeilen);
                        ConfigGeneric.setValue(data, 'effizienzModelle', eigene);
                        (this.props.onChange as (data: Record<string, unknown>) => void)(data);
                    }}
                    befehl={this.befehl}
                    objektWahl={(aktuell, fertig) => this.setState({ wahl: { aktuell, fertig } })}
                />
                {wahl && this.props.oContext ? (
                    <DialogSelectID
                        imagePrefix={this.props.oContext.imagePrefix ?? '../..'}
                        dialogName={`admin.${this.props.oContext.adapterName}`}
                        themeType={this.props.oContext.themeType}
                        theme={this.props.oContext.theme}
                        types={['state']}
                        socket={this.props.oContext.socket}
                        selected={wahl.aktuell}
                        onClose={() => this.setState({ wahl: null })}
                        onOk={sel => {
                            const id = Array.isArray(sel) ? sel[0] : sel;
                            if (id) {
                                wahl.fertig(String(id));
                            }
                            this.setState({ wahl: null });
                        }}
                    />
                ) : null}
            </>
        );
    }
}

export default Effizienz;
