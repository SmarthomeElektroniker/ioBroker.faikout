/*
 * "So entsteht der Wert gerade": der Rechenweg der Leistungsgrenze als EINE dezente Zeile - z. B.
 * "Kennlinie 52 % → Raum 1,0 K zu warm: −7 → 45 %" oder "Vortag 48 % + 10 → ...". Die Raumtemperatur
 * wird beruecksichtigt, man sah es vorher nur nicht (Nutzerfrage 21.11.2026).
 *
 * Die Daten liefert der Adapter (sendTo regelArbeitspunkt, Feld `weg` - gerechnet in lib/regel/bedarf.js,
 * ergaenzt vom Koordinator); geschrieben wird der Satz hier, in der Sprache des Admins. Die Zeile hat einen
 * festen Platz (Mindesthoehe fuer zwei Zeilen): ob gerade ein Wert da ist oder nicht, verschiebt nichts.
 *
 * Dazu der Satz bei der Strategie ("Die Raumtemperatur korrigiert den Wert: ±10 % je Kelvin ... (ab 0,3 K)")
 * mit den Zahlen aus dem Formular.
 *
 * jsonConfig-Komponente `Rechenweg` (ohne eigenen Wert, nur Anzeige), Art unter `custom.art`:
 *   'weg'   Rechenweg des Geraets der Zeile (data.geraet) - fuer die Strategie "Vortag", wo es kein Kennlinienbild gibt
 *   'satz'  Satz zur Raumkorrektur (Vorlage der Instanz)
 */
import React, { useEffect, useState } from 'react';
import { Box } from '@mui/material';
import { I18n } from '@iobroker/gui-components';
import { ConfigGeneric, type ConfigGenericProps, type ConfigGenericState } from '@iobroker/json-config';

import zugLib from '../../lib/kennlinienzug.js';
import { t as text, type Schluessel } from './Rechenweg.texte';

const zug = zugLib as {
    anzeige(n: number, sprache?: string): string;
    anzeigeFest(n: number, stellen: number, sprache?: string): string;
    einheitFest(text: unknown): string;
};

export type Richtung = 'heizen' | 'kuehlen';

/** Rechenweg aus dem letzten Durchlauf der Regelung (lib/regel/bedarf.js `weg`, lib/regel/koordinator.js) */
export interface Weg {
    art: string;
    strategie?: 'kennlinie' | 'vortag';
    richtung?: Richtung;
    /** Grundwert in % (Kennlinie bzw. Vortag + Zuschlag) */
    basis?: number;
    vortag?: { prozent: number; zuschlag: number } | null;
    raum?: number | null;
    /** > 0: der Raum liegt hinter dem Ziel zurueck (Heizen: zu kalt, Kuehlen: zu warm) */
    abweichung?: number | null;
    /** Raumkorrektur in Prozentpunkten */
    korrektur?: number;
    totband?: number;
    grenze?: 'unter' | 'ober' | null;
    /** die greifende Grenze stammt aus der Strategie "Auto" (Vortag), nicht von der Anlage */
    grenzeVortag?: boolean;
    /** die Stufung hat den Wert geaendert: Schrittweite in % (aus lib/regel/bedarf.js), auf = aufgerundet */
    rundung?: { stufe: number; auf?: boolean } | null;
    /** Schwelle in K, ab der "volle Leistung" bzw. der Ueberheizschutz greift */
    schwelle?: number | null;
    sollwert?: number | null;
    /** Hoechstleistung der Temperaturstufe hat begrenzt */
    deckel?: { stufe: string; wert: number };
    /** Stufe ohne Leistungsregelung */
    stufe?: string;
    /** Bedarfsregelung ist ausgeschaltet - der Weg zeigt, was sie rechnen wuerde */
    aus?: boolean;
    probelauf?: boolean;
    /** der Wert ist noch nicht gesendet - fertiger Text des Adapters (Haltezeit bis ..., Mindestabstand bis ...) */
    wartet?: string;
}

/** Vorgaben der Raumkorrektur (lib/regel/bedarf.js VORGABEN) */
export const RAUM_VORGABE = { prozentProK: 10, totband: 0.3 };

/**
 * Der Rechenweg als Satz in der Sprache.
 *
 * @param weg       Rechenweg des Adapters; null/undefined: noch nicht gerechnet
 * @param sprache   Sprache des Admins
 * @param richtung  Richtung des Bildes, an dem die Zeile steht (eine Heizkennlinie sagt beim Kuehlen "nicht im Einsatz")
 */
export function wegText(weg: Weg | null | undefined, sprache: string, richtung?: Richtung): string {
    const t = (s: Schluessel, ...w: (string | number)[]): string => text(sprache, s, ...w);
    const zahl = (n: unknown): string => zug.anzeige(Number(n), sprache);
    const prozent = (n: unknown): string => `${zahl(n)}\u00a0%`;
    if (!weg || typeof weg !== 'object' || !weg.art) {
        return t('wartet');
    }
    if (weg.art === 'ruhtAuto') {
        return t('ruhtAuto');
    }
    if (weg.art === 'nichtFaehig') {
        return t('nichtFaehig');
    }
    const fremd = richtung === 'kuehlen' ? 'nichtKuehlen' : 'nichtHeizen';
    if (weg.art === 'neutral') {
        return t(richtung ? fremd : 'neutral');
    }
    if (weg.art === 'stufeOhne') {
        return t('stufeOhne', String(weg.stufe ?? ''), zahl(weg.sollwert ?? 100));
    }
    if (richtung && weg.richtung && weg.richtung !== richtung) {
        return t(fremd);
    }
    const vorn = weg.aus ? `${t('aus')} ` : '';
    const wartet = typeof weg.wartet === 'string' && weg.wartet && !weg.aus ? ` · ${weg.wartet}` : '';
    const hinten = `${weg.probelauf && !weg.aus ? ` ${t('probelauf')}` : ''}${wartet}`;
    if (weg.art === 'rueckfall') {
        return `${vorn}${t(weg.strategie === 'vortag' ? 'rueckfallVortag' : 'rueckfallAussen', zahl(weg.sollwert ?? 100))}${hinten}`;
    }
    if (weg.art === 'abtauen') {
        return Number.isFinite(Number(weg.sollwert)) && weg.sollwert !== null
            ? `${vorn}${t('abtauen', zahl(weg.sollwert))}${hinten}`
            : t(richtung ? fremd : 'neutral');
    }
    // normal, voll, ueber: Grundwert → Raum → Ergebnis (→ Hoechstleistung der Stufe)
    const teile: string[] = [];
    teile.push(weg.strategie === 'vortag' && weg.vortag ? t('vortag', zahl(weg.vortag.prozent), zahl(weg.vortag.zuschlag)) : t('kennlinie', zahl(weg.basis)));
    const abw = weg.abweichung;
    if (abw === null || abw === undefined || !Number.isFinite(Number(abw))) {
        teile.push(t('ohneRaum'));
    } else {
        // > 0 heisst "liegt zurueck": beim Heizen zu kalt, beim Kuehlen zu warm
        const kalt = (weg.richtung === 'kuehlen') !== abw > 0;
        const betrag = zug.anzeigeFest(Math.abs(abw), 1, sprache);
        const korrektur = Math.round(Number(weg.korrektur) || 0);
        if (weg.art === 'voll') {
            teile.push(t(kalt ? 'zuKalt' : 'zuWarm', betrag, t('voll', zahl(weg.schwelle))));
        } else if (weg.art === 'ueber') {
            teile.push(t(kalt ? 'zuKalt' : 'zuWarm', betrag, t('ueber', zahl(weg.schwelle))));
        } else if (!korrektur && Math.abs(abw) <= Number(weg.totband ?? RAUM_VORGABE.totband)) {
            teile.push(t('imZiel', zahl(weg.totband ?? RAUM_VORGABE.totband)));
        } else {
            teile.push(t(kalt ? 'zuKalt' : 'zuWarm', betrag, korrektur > 0 ? `+${zahl(korrektur)}` : korrektur < 0 ? zahl(korrektur) : '±0'));
        }
    }
    const vt = weg.grenzeVortag === true;
    teile.push(
        weg.grenze === 'unter'
            ? t(vt ? 'grenzeVortagUnter' : 'grenzeUnter', zahl(weg.sollwert))
            : weg.grenze === 'ober'
              ? t(vt ? 'grenzeVortagOber' : 'grenzeOber', zahl(weg.sollwert))
              : weg.rundung && Number.isFinite(Number(weg.rundung.stufe))
                ? t(weg.rundung.auf ? 'aufgerundet' : 'gerundet', zahl(weg.rundung.stufe), zahl(weg.sollwert))
                : prozent(weg.sollwert),
    );
    if (weg.deckel && Number.isFinite(Number(weg.deckel.wert))) {
        teile.push(t('deckel', String(weg.deckel.stufe ?? ''), zahl(weg.deckel.wert)));
    }
    // der Adapter liefert `wartet` als fertigen Text mit gewoehnlichem Leerzeichen
    return zug.einheitFest(`${vorn}${teile.join(' → ')}${hinten}`);
}

/** Der Satz zur Raumkorrektur mit den Zahlen der Einstellungen. */
export function satzText(prozentProK: unknown, totband: unknown, sprache: string): string {
    const zahlOder = (v: unknown, sonst: number): number => (v === undefined || v === null || v === '' || !Number.isFinite(Number(v)) ? sonst : Number(v));
    const p = zahlOder(prozentProK, RAUM_VORGABE.prozentProK);
    const tb = zahlOder(totband, RAUM_VORGABE.totband);
    return p > 0 ? text(sprache, 'satz', zug.anzeige(p, sprache), zug.anzeige(tb, sprache)) : text(sprache, 'satzOhne');
}

/** Die Zeile mit festem Platz: Ueberschrift + Rechenweg. */
export function RechenwegZeile(props: { weg: Weg | null | undefined; sprache: string; richtung?: Richtung }): React.JSX.Element {
    return (
        <Box
            className="fk-weg"
            data-art={props.weg?.art || ''}
            sx={{
                // fester Platz: zwei Zeilen, auf dem Handy vier - ein kurzer oder langer Satz verschiebt nichts darunter
                minHeight: { xs: '5.8em', sm: '2.9em' },
                mt: 0.5,
                fontSize: '0.82rem',
                lineHeight: 1.45,
                color: 'text.secondary',
                overflowWrap: 'anywhere',
            }}
        >
            <Box
                component="span"
                className="fk-weg-titel"
                sx={{ fontWeight: 600, mr: 0.75 }}
            >
                {text(props.sprache, 'titel')}
            </Box>
            <span className="fk-weg-text">{wegText(props.weg, props.sprache, props.richtung)}</span>
        </Box>
    );
}

/** Rechenweg eines Geraets vom Adapter - beim Oeffnen und alle 15 s. `undefined`: (noch) keine Antwort. */
function useWeg(props: ConfigGenericProps, geraet: string): Weg | null | undefined {
    const [weg, setWeg] = useState<Weg | null | undefined>(undefined);
    const socket = props.oContext?.socket;
    const ziel = `${props.oContext?.adapterName}.${props.oContext?.instance}`;
    useEffect(() => {
        if (!geraet || !props.alive || !socket || typeof socket.sendTo !== 'function') {
            setWeg(undefined);
            return undefined;
        }
        let lebt = true;
        const fragen = (): void => {
            Promise.resolve(socket.sendTo(ziel, 'regelArbeitspunkt', { geraet }))
                .then((antwort: any) => lebt && setWeg(antwort && antwort.geraet ? (antwort.weg as Weg) || null : undefined))
                .catch(() => lebt && setWeg(undefined));
        };
        fragen();
        const takt = setInterval(fragen, 15000);
        return () => {
            lebt = false;
            clearInterval(takt);
        };
    }, [geraet, props.alive, socket, ziel]);
    return weg;
}

function RechenwegFeld(props: ConfigGenericProps): React.JSX.Element {
    const data = (props.data || {}) as Record<string, unknown>;
    const weg = useWeg(props, typeof data.geraet === 'string' ? data.geraet : '');
    return (
        <RechenwegZeile
            weg={weg}
            sprache={I18n.getLanguage()}
        />
    );
}

class Rechenweg extends ConfigGeneric<ConfigGenericProps, ConfigGenericState> {
    renderItem(): React.JSX.Element {
        const roh = (this.props.schema || {}) as unknown as Record<string, unknown>;
        const art = ((roh.custom as Record<string, unknown>) || {}).art;
        if (art === 'satz') {
            // die Werte gelten fuer alle Anlagen: Vorlage der Instanz (in einer Geraetezeile: globalData)
            const data = ((this.props.custom ? this.props.globalData : this.props.data) || {}) as Record<string, unknown>;
            const sprache = I18n.getLanguage();
            return (
                <Box
                    className="fk-raumsatz"
                    sx={{ width: '100%', fontSize: '0.875rem', lineHeight: 1.45, color: 'text.secondary' }}
                >
                    <span className="fk-raumsatz-text">{satzText(data.regelProzentProK, data.regelTotband, sprache)}</span>{' '}
                    <span className="fk-raumsatz-wo">{text(sprache, 'satzWo')}</span>
                </Box>
            );
        }
        return <RechenwegFeld {...this.props} />;
    }
}

export default Rechenweg;
