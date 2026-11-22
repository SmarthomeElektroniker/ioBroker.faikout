/*
 * Kalibrierung im Reiter "Effizienz": gefuehrter Assistent (Sensor waehlen -> messen -> Ergebnis), Handmessung
 * und die Liste der Kalibrierungen eines Geraets. Alles hier wirkt SOFORT ueber Befehle an den Adapter
 * (effizienzMessung, effizienzHand, effizienzKalibrierung) - nicht ueber "Speichern" der Instanz. Der Zustand
 * der Messung liegt im Adapter und uebersteht dessen Neustart.
 */
import React, { useState } from 'react';

import { t, type Schluessel } from './Effizienz.texte';
import { AbdeckungBild, EpsBild, STUFEN, stufenName, zahl, type Abdeckung, type Art, type EpsSatz, type Farben } from './EffizienzGrafik';

export interface Auswertung {
    heizen: EpsSatz | null;
    kuehlen: EpsSatz | null;
    abdeckung: { heizen: Abdeckung; kuehlen: Abdeckung };
}
export interface Messung extends Auswertung {
    id: string;
    status: 'laeuft' | 'fertig';
    start: number;
    austrittDp: string;
    feuchteDp: string;
    sensorWert: number | null;
    sensorAlter: number | null;
    punkte: number;
    verworfen: Record<string, number>;
    letzterGrund: string;
}
export interface Handpunkt {
    zeit: number;
    art: Art | null;
    stufe: string | null;
    tEin: number | null;
    tRef: number | null;
    tAus: number;
}
export interface Kalibrierung {
    id: string;
    zeit: number;
    quelle: 'sensor' | 'hand';
    n: number;
    heizen: EpsSatz | null;
    kuehlen: EpsSatz | null;
    aktiv: boolean;
}
export interface KalStand {
    id: string;
    name: string;
    eps: Record<Art, EpsSatz>;
    vorgabe: Record<Art, EpsSatz>;
    kalibrierungen: Kalibrierung[];
    aktiv: string | null;
    messung: Messung | null;
    hand: Auswertung & { punkte: Handpunkt[] };
}

export interface KalProps {
    g: KalStand;
    sprache: string;
    f: Farben;
    /** Punkte, ab denen eine Stufe als gut abgedeckt gilt */
    ziel: number;
    /** vorbelegter Sensor aus den Einstellungen */
    austrittDp: string;
    feuchteDp: string;
    dauerhaft: boolean;
    befehl: (name: string, nachricht: Record<string, unknown>) => Promise<{ error?: string; [k: string]: unknown }>;
    /** oeffnet die Objektauswahl des Admins; ohne sie bleibt nur das Textfeld */
    objektWahl?: (aktuell: string, fertig: (id: string) => void) => void;
    onSensor: (teil: { austrittDp?: string; feuchteDp?: string; dauerhaft?: boolean }) => void;
}

const datum = (ms: number, sprache: string, mitZeit = true): string =>
    new Date(ms).toLocaleString(sprache, mitZeit ? { dateStyle: 'short', timeStyle: 'short' } : { dateStyle: 'short' });

const prozent = (x: number | null | undefined): string => (typeof x === 'number' ? String(Math.round(x * 100)) : '–');

/** Ergebnis einer Auswertung: Bild je Betriebsart, Restfehler, Begruendung */
function Ergebnis(props: { a: Auswertung; vorgabe: Record<Art, EpsSatz>; sprache: string; f: Farben }): React.JSX.Element | null {
    const { a, sprache, f } = props;
    const arten = (['heizen', 'kuehlen'] as Art[]).filter(art => a[art]);
    if (!arten.length) {
        return null;
    }
    return (
        <div data-teil="ergebnis">
            {arten.map(art => {
                const e = a[art] as EpsSatz;
                const name = t(sprache, art);
                return (
                    <div key={art}>
                        <div className="fk-e-untertitel">
                            {e.restfehler === null || e.restfehler === undefined
                                ? t(sprache, 'ergebnisOhneFehler', name, prozent(e.unsicherheit))
                                : t(sprache, 'ergebnisZeile', name, prozent(e.restfehler))}
                        </div>
                        <EpsBild
                            satz={e}
                            vergleich={props.vorgabe[art]}
                            sprache={sprache}
                            f={f}
                            art={art}
                        />
                        {typeof e.unterschied === 'number' ? (
                            <div className="fk-e-blass">{t(sprache, e.zusammengefasst ? 'zusammengefasst' : 'jeStufe', prozent(e.unterschied))}</div>
                        ) : null}
                    </div>
                );
            })}
        </div>
    );
}

const VERWORFEN: Record<string, Schluessel> = {
    abtauen: 'vAbtauen',
    steht: 'vSteht',
    anlauf: 'vAnlauf',
    kleinerAbstand: 'vKleinerAbstand',
    sensorAlt: 'vSensorAlt',
};

export function KalibrierungAnsicht(props: KalProps): React.JSX.Element {
    const { g, sprache, f } = props;
    const m = g.messung;
    const [austritt, setAustritt] = useState(m ? m.austrittDp : props.austrittDp);
    const [feuchte, setFeuchte] = useState(m ? m.feuchteDp : props.feuchteDp);
    const [laeuft, setLaeuft] = useState(false);
    const [fehler, setFehler] = useState('');
    const [frage, setFrage] = useState(false);
    const [hand, setHand] = useState<{
        offen: boolean;
        zeit: string;
        tAus: string;
        gefunden: Record<string, unknown> | null;
        quelle: string;
        werte: Record<string, string>;
    }>({ offen: false, zeit: '', tAus: '', gefunden: null, quelle: '', werte: {} });

    const senden = async (name: string, nachricht: Record<string, unknown>): Promise<{ error?: string; [k: string]: unknown } | null> => {
        setLaeuft(true);
        setFehler('');
        try {
            const antwort = await props.befehl(name, { geraet: g.id, ...nachricht });
            if (antwort && antwort.error) {
                setFehler(String(antwort.error));
                return null;
            }
            return antwort;
        } catch (e) {
            setFehler(String((e as Error).message || e));
            return null;
        } finally {
            setLaeuft(false);
        }
    };
    const schritt = !m ? 1 : m.status === 'laeuft' ? 2 : 3;
    const hauptArt: Art = m && m.abdeckung.kuehlen.gesamt > m.abdeckung.heizen.gesamt ? 'kuehlen' : 'heizen';
    const abdeckung = m ? m.abdeckung[hauptArt] : null;
    const verworfen = m
        ? Object.entries(m.verworfen)
              .filter(([, n]) => n > 0)
              .map(([grund, n]) => t(sprache, VERWORFEN[grund] || 'vSonst', n))
        : [];
    const zahlFeld = (text: string): number => Number(String(text).replace(',', '.'));
    const handNachricht = (): Record<string, unknown> => ({
        zeit: new Date(hand.zeit).getTime(),
        tAus: zahlFeld(hand.tAus),
        werte: Object.fromEntries(Object.entries(hand.werte).map(([k, v]) => [k, ['art', 'stufe'].includes(k) ? v : v === '' ? '' : zahlFeld(v)])),
    });
    const handBereit = !!hand.zeit && hand.tAus !== '' && isFinite(zahlFeld(hand.tAus));
    const handFeld = (name: string, text: Schluessel): React.JSX.Element => (
        <label>
            {t(sprache, text)}
            <input
                className="fk-e-feld fk-e-feld-kurz"
                inputMode="decimal"
                data-hand={name}
                value={hand.werte[name] ?? (hand.gefunden && hand.gefunden[name] !== null && hand.gefunden[name] !== undefined ? String(hand.gefunden[name]) : '')}
                onChange={e => setHand({ ...hand, werte: { ...hand.werte, [name]: e.target.value } })}
            />
        </label>
    );

    return (
        <div
            className="fk-e-kal"
            data-schritt={schritt}
        >
            <div className="fk-e-blass">{t(sprache, 'kalAnleitung')}</div>
            <div className="fk-e-hinweis fk-e-hinweis-gut">{t(sprache, 'kalSofort')}</div>
            <div className="fk-e-schritte">
                {(['schritt1', 'schritt2', 'schritt3'] as Schluessel[]).map((s, i) => (
                    <span
                        key={s}
                        className={`fk-e-schritt${schritt === i + 1 ? ' fk-e-schritt-an' : ''}`}
                        aria-current={schritt === i + 1 ? 'step' : undefined}
                    >
                        {t(sprache, s)}
                    </span>
                ))}
            </div>

            {schritt === 1 ? (
                <div>
                    <div className="fk-e-zeile">
                        <label style={{ flex: '0 1 420px' }}>
                            {t(sprache, 'austrittDp')}
                            <input
                                className="fk-e-feld fk-e-feld-lang"
                                data-feld="austrittDp"
                                value={austritt}
                                placeholder="hm-rpc.0.ABC123.1.ACTUAL_TEMPERATURE"
                                onChange={e => setAustritt(e.target.value)}
                                onBlur={() => props.dauerhaft && props.onSensor({ austrittDp: austritt.trim() })}
                            />
                        </label>
                        {props.objektWahl ? (
                            <button
                                type="button"
                                className="fk-e-knopf fk-e-knopf-still"
                                onClick={() => props.objektWahl?.(austritt, setAustritt)}
                            >
                                {t(sprache, 'auswaehlen')}
                            </button>
                        ) : null}
                    </div>
                    <div className="fk-e-zeile">
                        <label style={{ flex: '0 1 420px' }}>
                            {t(sprache, 'feuchteDp')}
                            <input
                                className="fk-e-feld fk-e-feld-lang"
                                data-feld="feuchteDp"
                                value={feuchte}
                                onChange={e => setFeuchte(e.target.value)}
                            />
                        </label>
                        {props.objektWahl ? (
                            <button
                                type="button"
                                className="fk-e-knopf fk-e-knopf-still"
                                onClick={() => props.objektWahl?.(feuchte, setFeuchte)}
                            >
                                {t(sprache, 'auswaehlen')}
                            </button>
                        ) : null}
                    </div>
                    <div className="fk-e-blass">{t(sprache, 'feuchteHinweis')}</div>
                    <div className="fk-e-knoepfe">
                        <button
                            type="button"
                            className="fk-e-knopf fk-e-knopf-voll"
                            data-aktion="start"
                            disabled={laeuft || !austritt.trim()}
                            onClick={() => void senden('effizienzMessung', { aktion: 'start', austrittDp: austritt.trim(), feuchteDp: feuchte.trim() })}
                        >
                            {t(sprache, 'messungStarten')}
                        </button>
                    </div>
                </div>
            ) : null}

            {m && abdeckung ? (
                <div>
                    <div data-teil="messstand">
                        {t(sprache, 'laeuftSeit', datum(m.start, sprache))}
                        {' · '}
                        {m.sensorAlter !== null && m.sensorAlter > 15 * 60000
                            ? t(sprache, 'sensorAlt', Math.round(m.sensorAlter / 60000))
                            : t(sprache, 'sensorJetzt', zahl(m.sensorWert, 1, sprache))}
                    </div>
                    <div className="fk-e-blass">{m.austrittDp}</div>
                    <AbdeckungBild
                        a={abdeckung}
                        ziel={props.ziel}
                        sprache={sprache}
                        f={f}
                    />
                    {verworfen.length ? <div className="fk-e-blass">{t(sprache, 'ausgenommen', verworfen.join(', '))}</div> : null}
                    {m.status === 'laeuft' ? (
                        <div
                            className="fk-e-hinweis"
                            data-teil="empfehlung"
                        >
                            {!m.punkte
                                ? t(sprache, 'nochKeinPunkt')
                                : abdeckung.fertig && !abdeckung.naechste
                                  ? t(sprache, 'genug')
                                  : `${abdeckung.fertig ? `${t(sprache, 'genug')} ` : ''}${abdeckung.naechste ? t(sprache, 'naechste', stufenName(sprache, abdeckung.naechste)) : ''}`}
                        </div>
                    ) : null}
                    {m.punkte ? (
                        <Ergebnis
                            a={m}
                            vorgabe={g.vorgabe}
                            sprache={sprache}
                            f={f}
                        />
                    ) : null}
                    {frage ? (
                        <div className="fk-e-hinweis fk-e-hinweis-fehler">
                            {t(sprache, 'verwerfenFrage', m.punkte)}
                            <div className="fk-e-knoepfe">
                                <button
                                    type="button"
                                    className="fk-e-knopf"
                                    data-aktion="verwerfenJa"
                                    onClick={() => {
                                        setFrage(false);
                                        void senden('effizienzMessung', { aktion: 'verwerfen' });
                                    }}
                                >
                                    {t(sprache, 'ja')}
                                </button>
                                <button
                                    type="button"
                                    className="fk-e-knopf fk-e-knopf-still"
                                    onClick={() => setFrage(false)}
                                >
                                    {t(sprache, 'nein')}
                                </button>
                            </div>
                        </div>
                    ) : (
                        <div className="fk-e-knoepfe">
                            {m.status === 'laeuft' ? (
                                <button
                                    type="button"
                                    className="fk-e-knopf fk-e-knopf-voll"
                                    data-aktion="stopp"
                                    disabled={laeuft}
                                    onClick={() => void senden('effizienzMessung', { aktion: 'stopp' })}
                                >
                                    {t(sprache, 'messungBeenden')}
                                </button>
                            ) : (
                                <>
                                    <button
                                        type="button"
                                        className="fk-e-knopf fk-e-knopf-voll"
                                        data-aktion="uebernehmen"
                                        disabled={laeuft || !m.punkte}
                                        onClick={() => void senden('effizienzMessung', { aktion: 'uebernehmen' })}
                                    >
                                        {t(sprache, 'uebernehmen')}
                                    </button>
                                    <button
                                        type="button"
                                        className="fk-e-knopf"
                                        data-aktion="weiter"
                                        disabled={laeuft}
                                        onClick={() => void senden('effizienzMessung', { aktion: 'weiter' })}
                                    >
                                        {t(sprache, 'messungWeiter')}
                                    </button>
                                </>
                            )}
                            <button
                                type="button"
                                className="fk-e-knopf fk-e-knopf-still"
                                data-aktion="verwerfen"
                                disabled={laeuft}
                                onClick={() => (m.punkte ? setFrage(true) : void senden('effizienzMessung', { aktion: 'verwerfen' }))}
                            >
                                {t(sprache, 'verwerfen')}
                            </button>
                        </div>
                    )}
                </div>
            ) : null}

            {fehler ? (
                <div
                    className="fk-e-hinweis fk-e-hinweis-fehler"
                    role="alert"
                >
                    {t(sprache, 'fehler', fehler)}
                </div>
            ) : null}

            {/* ---- Handmessung */}
            <div className="fk-e-abschnitt">
                <button
                    type="button"
                    className="fk-e-knopf fk-e-knopf-still"
                    data-aktion="handOffen"
                    aria-expanded={hand.offen}
                    onClick={() => setHand({ ...hand, offen: !hand.offen })}
                >
                    {t(sprache, 'handTitel')}
                </button>
                {hand.offen ? (
                    <div data-teil="hand">
                        <div className="fk-e-blass">{t(sprache, 'handAnleitung')}</div>
                        <div className="fk-e-zeile">
                            <label>
                                {t(sprache, 'handZeit')}
                                <input
                                    type="datetime-local"
                                    className="fk-e-feld"
                                    data-hand="zeit"
                                    value={hand.zeit}
                                    onChange={e => setHand({ ...hand, zeit: e.target.value, gefunden: null, werte: {} })}
                                />
                            </label>
                            <label>
                                {t(sprache, 'handTemp')}
                                <input
                                    className="fk-e-feld fk-e-feld-kurz"
                                    inputMode="decimal"
                                    data-hand="tAus"
                                    value={hand.tAus}
                                    onChange={e => setHand({ ...hand, tAus: e.target.value })}
                                />
                            </label>
                            <button
                                type="button"
                                className="fk-e-knopf"
                                data-aktion="handSuchen"
                                disabled={laeuft || !handBereit}
                                onClick={async () => {
                                    const r = await senden('effizienzHand', { aktion: 'suchen', ...handNachricht() });
                                    if (r) {
                                        setHand({ ...hand, gefunden: (r.gefunden as Record<string, unknown>) || {}, quelle: String(r.quelle || 'keine'), werte: {} });
                                    }
                                }}
                            >
                                {t(sprache, 'handSuchen')}
                            </button>
                        </div>
                        {hand.gefunden ? (
                            <div>
                                <div className="fk-e-blass">
                                    {t(sprache, hand.quelle === 'verlauf' ? 'handQuelleVerlauf' : hand.quelle === 'history' ? 'handQuelleHistory' : 'handQuelleKeine')}
                                </div>
                                <div className="fk-e-zeile">
                                    <label>
                                        {t(sprache, 'handBetriebsart')}
                                        <select
                                            className="fk-e-feld"
                                            data-hand="art"
                                            value={hand.werte.art ?? String(hand.gefunden.art || '')}
                                            onChange={e => setHand({ ...hand, werte: { ...hand.werte, art: e.target.value } })}
                                        >
                                            <option value="">–</option>
                                            <option value="heizen">{t(sprache, 'heizen')}</option>
                                            <option value="kuehlen">{t(sprache, 'kuehlen')}</option>
                                        </select>
                                    </label>
                                    <label>
                                        {t(sprache, 'handStufe')}
                                        <select
                                            className="fk-e-feld"
                                            data-hand="stufe"
                                            value={hand.werte.stufe ?? String(hand.gefunden.stufe || '')}
                                            onChange={e => setHand({ ...hand, werte: { ...hand.werte, stufe: e.target.value } })}
                                        >
                                            <option value="">{t(sprache, 'handStufeOhne')}</option>
                                            {STUFEN.map(s => (
                                                <option
                                                    key={s}
                                                    value={s}
                                                >
                                                    {stufenName(sprache, s)}
                                                </option>
                                            ))}
                                        </select>
                                    </label>
                                    {handFeld('tEin', 'handAnsaug')}
                                    {handFeld('tRef', 'handRegister')}
                                </div>
                                <div className="fk-e-knoepfe">
                                    <button
                                        type="button"
                                        className="fk-e-knopf fk-e-knopf-voll"
                                        data-aktion="handHinzufuegen"
                                        disabled={laeuft || !handBereit}
                                        onClick={async () => {
                                            const r = await senden('effizienzHand', { aktion: 'hinzufuegen', ...handNachricht() });
                                            if (r && Array.isArray(r.fehlt) && r.fehlt.length) {
                                                setHand({ ...hand, gefunden: (r.gefunden as Record<string, unknown>) || {}, quelle: String(r.quelle || 'keine') });
                                            } else if (r) {
                                                setHand({ offen: true, zeit: '', tAus: '', gefunden: null, quelle: '', werte: {} });
                                            }
                                        }}
                                    >
                                        {t(sprache, 'handHinzufuegen')}
                                    </button>
                                </div>
                            </div>
                        ) : null}
                        {g.hand.punkte.length ? (
                            <div>
                                <div className="fk-e-untertitel">{t(sprache, 'handListe')}</div>
                                <ul
                                    className="fk-e-liste"
                                    data-teil="handliste"
                                >
                                    {g.hand.punkte.map(p => (
                                        <li key={p.zeit}>
                                            <span>
                                                {t(
                                                    sprache,
                                                    'handPunkt',
                                                    datum(p.zeit, sprache),
                                                    stufenName(sprache, p.stufe),
                                                    zahl(p.tAus, 1, sprache),
                                                    p.tEin !== null && p.tRef !== null ? zahl((p.tAus - p.tEin) / (p.tRef - p.tEin), 2, sprache) : '–',
                                                )}
                                            </span>
                                            <button
                                                type="button"
                                                className="fk-e-knopf fk-e-knopf-still"
                                                disabled={laeuft}
                                                onClick={() => void senden('effizienzHand', { aktion: 'entfernen', zeit: p.zeit })}
                                            >
                                                {t(sprache, 'entfernen')}
                                            </button>
                                        </li>
                                    ))}
                                </ul>
                                <Ergebnis
                                    a={g.hand}
                                    vorgabe={g.vorgabe}
                                    sprache={sprache}
                                    f={f}
                                />
                                <div className="fk-e-knoepfe">
                                    <button
                                        type="button"
                                        className="fk-e-knopf fk-e-knopf-voll"
                                        data-aktion="handUebernehmen"
                                        disabled={laeuft}
                                        onClick={() => void senden('effizienzHand', { aktion: 'uebernehmen' })}
                                    >
                                        {t(sprache, 'handUebernehmen')}
                                    </button>
                                </div>
                            </div>
                        ) : null}
                    </div>
                ) : null}
            </div>

            {/* ---- Liste: was gilt */}
            <div className="fk-e-abschnitt">
                <div className="fk-e-titel">{t(sprache, 'listeTitel')}</div>
                <ul
                    className="fk-e-liste"
                    data-teil="kalibrierungen"
                >
                    <li className={g.aktiv ? '' : 'fk-e-gilt'}>
                        <span>
                            {t(sprache, 'listeDatenblatt')} <span className="fk-e-blass">ε ±{prozent(g.vorgabe.heizen.unsicherheit)} %</span>
                        </span>
                        {g.aktiv ? (
                            <button
                                type="button"
                                className="fk-e-knopf"
                                data-aktion="datenblatt"
                                disabled={laeuft}
                                onClick={() => void senden('effizienzKalibrierung', { aktion: 'datenblatt' })}
                            >
                                {t(sprache, 'zuruecksetzenDatenblatt')}
                            </button>
                        ) : (
                            <span className="fk-e-marke">{t(sprache, 'listeGilt')}</span>
                        )}
                    </li>
                    {g.kalibrierungen.map(k => {
                        const e = k.heizen || k.kuehlen;
                        return (
                            <li
                                key={k.id}
                                className={k.aktiv ? 'fk-e-gilt' : ''}
                                data-kal={k.id}
                            >
                                <span>
                                    {t(sprache, k.quelle === 'hand' ? 'listeHand' : 'listeSensor', datum(k.zeit, sprache), k.n)}{' '}
                                    <span className="fk-e-blass">ε ±{prozent(e && e.unsicherheit)} %</span>
                                </span>
                                {k.aktiv ? (
                                    <span className="fk-e-marke">{t(sprache, 'listeGilt')}</span>
                                ) : (
                                    <button
                                        type="button"
                                        className="fk-e-knopf"
                                        data-aktion="aktivieren"
                                        disabled={laeuft}
                                        onClick={() => void senden('effizienzKalibrierung', { aktion: 'aktivieren', id: k.id })}
                                    >
                                        {t(sprache, 'listeNehmen')}
                                    </button>
                                )}
                                <button
                                    type="button"
                                    className="fk-e-knopf fk-e-knopf-still"
                                    data-aktion="loeschen"
                                    disabled={laeuft}
                                    onClick={() => void senden('effizienzKalibrierung', { aktion: 'loeschen', id: k.id })}
                                >
                                    {t(sprache, 'listeLoeschen')}
                                </button>
                            </li>
                        );
                    })}
                </ul>
                {g.kalibrierungen.some(k => k.quelle === 'sensor') || props.dauerhaft ? (
                    <div>
                        <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                            <input
                                type="checkbox"
                                data-feld="dauerhaft"
                                checked={props.dauerhaft}
                                onChange={e => props.onSensor({ dauerhaft: e.target.checked, austrittDp: austritt.trim(), feuchteDp: feuchte.trim() })}
                            />
                            <span>
                                {t(sprache, 'dauerhaft')}
                                <span
                                    className="fk-e-blass"
                                    style={{ display: 'block' }}
                                >
                                    {t(sprache, 'dauerhaftHinweis')}
                                </span>
                            </span>
                        </label>
                    </div>
                ) : null}
            </div>
        </div>
    );
}
