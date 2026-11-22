// Rauchtest (node, Rendern auf dem Server): alle Komponenten der Einstellungsseite in ihren Zustaenden, ohne ioBroker.
import React from 'react';
import { renderToString } from 'react-dom/server';
import { ThemeProvider } from '@mui/material/styles';
import { I18n, Theme } from '@iobroker/gui-components';
import { KennlinieAnsicht, type Richtung } from './Kennlinie';
import { StufenAnsicht } from './Stufen';
import { FeuchteAnsicht } from './Feuchte';
import { ErklaerungAnsicht } from './Erklaerung';
import { ZeitplaeneAnsicht } from './Zeitplaene';
import { RechenwegZeile, satzText, wegText, type Weg } from './Rechenweg';
import { RaumkorrekturAnsicht } from './Raumkorrektur';
import { EffizienzAnsicht, zeileSetzen, type Stand } from './Effizienz';
import effizienzKern from '../../lib/effizienz/index.js';
import de from './i18n/de.json';

/** Rechenwege, wie sie der Adapter liefert (lib/regel/bedarf.js, koordinator.js) - [Weg, Richtung des Bildes] */
const basis = { art: 'normal', strategie: 'kennlinie', richtung: 'heizen', basis: 52, totband: 0.3, grenze: null } as const;
const WEGE: Record<string, [Weg | null | undefined, ('heizen' | 'kuehlen')?]> = {
    warm: [{ ...basis, abweichung: -1, korrektur: -7, sollwert: 45 }, 'heizen'],
    kalt: [{ ...basis, abweichung: 1.7, korrektur: 14, sollwert: 65 }],
    imZiel: [{ ...basis, abweichung: 0.2, korrektur: 0, sollwert: 50 }],
    ohneRaum: [{ ...basis, abweichung: null, korrektur: 0, sollwert: 50 }],
    unten: [{ ...basis, basis: 42, abweichung: -0.9, korrektur: -6, grenze: 'unter', sollwert: 40 }],
    oben: [{ ...basis, basis: 100, abweichung: 1, korrektur: 7, grenze: 'ober', sollwert: 95 }],
    voll: [{ ...basis, art: 'voll', abweichung: 2.3, korrektur: 20, schwelle: 2, sollwert: 100 }],
    ueber: [{ ...basis, art: 'ueber', abweichung: -1.6, korrektur: -13, schwelle: 1.5, sollwert: 30 }],
    deckel: [{ ...basis, basis: 86, abweichung: 1.7, korrektur: 14, sollwert: 100, deckel: { stufe: 'Tag', wert: 90 } }],
    vortag: [{ ...basis, strategie: 'vortag', basis: 58, vortag: { prozent: 48, zuschlag: 10 }, abweichung: -1, korrektur: -7, sollwert: 55 }],
    kuehlenWarm: [{ ...basis, richtung: 'kuehlen', basis: 65, abweichung: 1, korrektur: 7, sollwert: 70 }, 'kuehlen'],
    andereRichtung: [{ ...basis, richtung: 'kuehlen', basis: 65, abweichung: 1, korrektur: 7, sollwert: 70 }, 'heizen'],
    probelauf: [{ ...basis, abweichung: -1, korrektur: -7, sollwert: 45, probelauf: true }],
    aus: [{ ...basis, abweichung: -1, korrektur: -7, sollwert: 45, aus: true, probelauf: true }],
    rueckfall: [{ art: 'rueckfall', strategie: 'kennlinie', richtung: 'heizen', sollwert: 100 }],
    rueckfallVortag: [{ art: 'rueckfall', strategie: 'vortag', richtung: 'heizen', sollwert: 100 }],
    abtauen: [{ art: 'abtauen', richtung: 'heizen', sollwert: 75 }],
    stufeOhne: [{ art: 'stufeOhne', stufe: 'Tag', sollwert: 100 }],
    ruhtAuto: [{ art: 'ruhtAuto' }],
    nichtFaehig: [{ art: 'nichtFaehig' }],
    neutral: [{ art: 'neutral' }],
    neutralHeizen: [{ art: 'neutral' }, 'heizen'],
    wartet: [undefined],
    nochNicht: [null, 'kuehlen'],
};

/** Stand des Reiters Effizienz, wie ihn der Adapter liefert - aus der echten Laufzeit ueber einer Attrappe */
async function effizienzStand(mitMessung: boolean): Promise<Stand> {
    const { Effizienz } = effizienzKern as any;
    const objekte: Record<string, any> = {};
    const a: any = {
        namespace: 'faikout.0',
        config: { effizienzGeraete: [{ geraet: 'Truhe', modell: 'FVXM35A' }], effizienzModelle: [] },
        geraete: new Map([
            ['Truhe', { name: 'Truhe', angelegt: new Set(), up: true }],
            ['Wand', { name: 'Wand', angelegt: new Set(), up: true }],
            ['IR', { name: 'IR', angelegt: new Set(), up: true }],
        ]),
        einheiten: new Map([['Truhe', { fanfreq: 'rpm' }]]),
        log: { info() {}, debug() {}, warn() {} },
        sprache: async () => 'de',
        getObjectAsync: async (id: string) => objekte[id] || null,
        extendObject: async (id: string, o: any) => {
            objekte[id] = { ...(objekte[id] || {}), ...o };
        },
        zaehlerObjekt: async () => {},
        wertSchreiben: async () => {},
        getForeignStateAsync: async () => ({ val: 35.2, ts: Date.now() }),
        geraetNochDa: async () => true,
    };
    const e = new Effizienz(a);
    const heizt = { power: true, mode: 'heat', fan: 'mediumHigh', fanfreq: 980, comp: 2400, achome: 22, liquid: 34, outside: 2, consumption: 600, energy: 5000000 };
    const echt = Date.now;
    let uhr = new Date(2026, 10, 22, 10, 0, 0).getTime();
    Date.now = () => uhr;
    try {
        if (mitMessung) {
            await e.befehl('effizienzMessung', { geraet: 'Truhe', aktion: 'start', austrittDp: 'sensor.0.austritt', abstandSek: 60, anlaufSek: 0 });
        }
        for (let i = 0; i < 45; i++) {
            await e.status('Truhe', a.geraete.get('Truhe'), { ...heizt, energy: 5000000 + i * 10 });
            await e.status('IR', a.geraete.get('IR'), { power: true, mode: 'heat', fan: 'auto' });
            await e.takt();
            uhr += 60000;
        }
        return (await e.befehl('effizienzStand', {})) as Stand;
    } finally {
        Date.now = echt;
    }
}

export async function renderEffizienz(): Promise<Record<string, string>> {
    I18n.extendTranslations(de as any, 'de');
    I18n.setLanguage('de');
    const theme = Theme('light' as any);
    const f = { text: '#222', blass: '#666', linie: '#ccc', flaeche: '#fff', karte: '#f7f7f7', akzent: '#3399cc', gut: '#3d9a50', warn: '#d98a00', fehler: '#d9534f', heizen: '#d8572a', kuehlen: '#2a7fd8' };
    const ansicht = (stand: Stand | null, mehr: Record<string, unknown> = {}): string =>
        renderToString(
            <ThemeProvider theme={theme}>
                <EffizienzAnsicht
                    stand={stand}
                    zeilen={[{ geraet: 'Truhe', modell: 'FVXM35A' }]}
                    eigene={[]}
                    preis={0}
                    sprache="de"
                    f={f}
                    alive
                    offen={['Truhe', 'Wand', 'IR']}
                    onZeilen={() => {}}
                    onPreis={() => {}}
                    onBeides={() => {}}
                    befehl={async () => ({})}
                    {...mehr}
                />
            </ThemeProvider>,
        ).replace(/<!-- -->/g, '');
    const stand = await effizienzStand(false);
    const zeilen = [{ geraet: 'Truhe', modell: 'FVXM35A' }];
    return {
        effizienz: ansicht(stand),
        effizienzPreis: ansicht(stand, { preis: 0.3 }),
        effizienzMessung: ansicht(await effizienzStand(true)),
        effizienzLaedt: ansicht(null),
        effizienzAus: ansicht(null, { alive: false }),
        effizienzEn: ansicht(stand, { sprache: 'en' }),
        zeilen: JSON.stringify({
            eigen: zeileSetzen(zeilen, { id: 'Truhe', name: 'Truhe' }, { luftstromHeizen: { H: 10.5 } }),
            neu: zeileSetzen(zeilen, { id: 'Wand', name: 'Wand' }, { modell: 'FTXM35R' }),
            leer: zeileSetzen(zeilen, { id: 'Truhe', name: 'Truhe' }, { modell: '', luftstromHeizen: {} }),
        }),
    };
}

export function renderAll(): Record<string, string> {
    I18n.extendTranslations(de as any, 'de');
    I18n.setLanguage('de');
    const theme = Theme('light' as any);
    const farben = { flaeche: '#fff', fokus: '#3399cc', fehler: '#d9534f', akzent: '#3399cc' };
    const mit = (kind: React.JSX.Element): string => renderToString(<ThemeProvider theme={theme}>{kind}</ThemeProvider>);
    const bild = (richtung: Richtung, wert: unknown, mehr: Record<string, unknown> = {}): string =>
        mit(
            <KennlinieAnsicht
                richtung={richtung}
                titel="Kennlinie"
                wert={wert}
                vorgabe={richtung === 'heizen' ? [{ x: -10, y: 100 }, { x: 0, y: 75 }, { x: 15, y: 40 }] : [{ x: 25, y: 40 }, { x: 35, y: 95 }]}
                untergrenze={40}
                obergrenze={95}
                arbeitspunkt={null}
                sprache="de"
                farben={farben}
                mitVorgabe
                onWert={() => {}}
                onGrenze={() => {}}
                {...mehr}
            />,
        );
    const stufen = (wert: unknown, jeGeraet: boolean, vorlage: unknown[] = [], planStufen?: string[]): string =>
        mit(
            <StufenAnsicht
                wert={wert}
                planStufen={planStufen}
                ruecksetzFrageOffen={!!planStufen}
                vorlage={jeGeraet ? vorlage : undefined}
                jeGeraet={jeGeraet}
                quelle="Test"
                sprache="de"
                dunkel={false}
                farben={farben as any}
                onWert={() => {}}
            />,
        );
    return {
        eigene: bild('heizen', [{ x: -10, y: 95 }, { x: 0, y: 80 }, { x: 8, y: 60 }, { x: 15, y: 40 }], {
            arbeitspunkt: {
                x: -4.9,
                wert: 95,
                text: 'Jetzt: außen −4,9 °C → 95 %',
                unterzeile: 'roh 99,4 %',
                weg: { art: 'normal', strategie: 'kennlinie', richtung: 'heizen', basis: 87, abweichung: 1, korrektur: 7, totband: 0.3, grenze: null, sollwert: 95 },
            },
        }),
        // eigene Grenze, aber die Punkte der Vorlage
        grenzeEigen: bild('heizen', [], { grenzenEigen: { untergrenze: 45, obergrenze: '' } }),
        leer: bild('kuehlen', []),
        werk: bild('kuehlen', [], { mitVorgabe: false }),
        eingeklappt: bild('kuehlen', [], { eingeklappt: true }),
        falsch: bild('heizen', [{ x: 0, y: 50 }, { x: 5, y: 70 }]),
        stufenWerk: stufen([], false),
        stufenEigen: stufen(
            [
                { id: 'komfort', name: 'Komfort', power: true, mode: 'heat', soll: 22.5, fan: 'auto', deckel: 100, bedarf: true, feuchte: true },
                { id: 'aus', name: 'Aus', power: false, mode: 'heat', soll: 17, fan: 'auto', deckel: 95, bedarf: false, feuchte: false },
            ],
            false,
        ),
        stufenGeraet: stufen([], true, [{ id: 'wach', name: 'Wach', power: true, mode: 'heat', soll: 20, fan: 'auto', deckel: 100, bedarf: true, feuchte: true }]),
        stufenGeraetEigen: stufen([{ id: 'tag', name: 'Tag', power: true, mode: 'heat', soll: 22, fan: 'auto', deckel: 90, bedarf: true, feuchte: true }], true),
        // Zuruecksetzen, waehrend der Plan der Anlage eigene Stufen benutzt: Rueckfrage mit Ersatzwahl
        stufenRueckfrage: stufen(
            [
                { id: 'tag', name: 'Tag', power: true, mode: 'heat', soll: 22, fan: 'auto', deckel: 90, bedarf: true, feuchte: true },
                { id: 'nacht', name: 'Nacht', power: true, mode: 'heat', soll: 18, fan: 'night', deckel: 60, bedarf: true, feuchte: false },
            ],
            true,
            [],
            ['nacht', 'tag', 'komfort'],
        ),
        // der Plan benutzt nur Stufen der Vorlage: keine Rueckfrage
        stufenOhneRueckfrage: stufen([{ id: 'komfort', name: 'Komfort', power: true, mode: 'heat', soll: 22, fan: 'auto', deckel: 90, bedarf: true, feuchte: true }], true, [], ['komfort']),
        // Rechenweg: alle Arten als Satz (Schluessel = Fall)
        ...Object.fromEntries(
            Object.entries(WEGE).map(([name, [weg, richtung]]) => [`weg_${name}`, wegText(weg, 'de', richtung)]),
        ),
        wegZeile: mit(
            <RechenwegZeile
                weg={WEGE.warm[0]}
                sprache="de"
                richtung="heizen"
            />,
        ),
        wegZeileLeer: mit(
            <RechenwegZeile
                weg={undefined}
                sprache="de"
            />,
        ),
        satz: satzText(10, 0.3, 'de'),
        satzEigen: satzText('15', 0.5, 'de'),
        satzEn: satzText(undefined, '', 'en'),
        satzNull: satzText(0, 0.3, 'de'),
        raumkorrektur: mit(
            <RaumkorrekturAnsicht
                staerke={10}
                totband={0.3}
                sprache="de"
                farben={farben}
                onWert={() => {}}
                onBeide={() => {}}
            />,
        ),
        raumkorrekturEigen: mit(
            <RaumkorrekturAnsicht
                staerke={25}
                totband={0.5}
                sprache="de"
                farben={farben}
                onWert={() => {}}
                onBeide={() => {}}
            />,
        ),
        feuchte: mit(
            <FeuchteAnsicht
                werte={{ dtpEin: 4, dtpAus: 6, rhEin: 65, rhAus: 58 }}
                massnahme="entfeuchten"
                nameModulRegelt="Faikout-Modul regelt selbst"
                geraete={[{ id: 'a', name: 'Wohnzimmer', raum: 21, feuchte: 55, taupunkt: 11.6 } as any]}
                sprache="de"
                dunkel={false}
                farben={farben as any}
                onWert={() => {}}
            />,
        ),
        feuchteZiel: mit(
            <FeuchteAnsicht
                werte={{ dtpEin: 4, dtpAus: 6, rhEin: 65, rhAus: 58 }}
                massnahme="zielSenken"
                nameModulRegelt="Faikout-Modul regelt selbst"
                geraete={[{ id: 'a', name: 'Wohnzimmer', raum: 21, feuchte: 55, taupunkt: 11.6 } as any]}
                sprache="de"
                dunkel={false}
                farben={farben as any}
                onWert={() => {}}
            />,
        ),
        feuchteMelden: mit(
            <FeuchteAnsicht
                werte={{ dtpEin: 4, dtpAus: 6, rhEin: 65, rhAus: 58 }}
                massnahme="melden"
                nameModulRegelt="Faikout-Modul regelt selbst"
                geraete={[{ id: 'a', name: 'Wohnzimmer', raum: 21, feuchte: 55, taupunkt: 11.6 } as any]}
                sprache="de"
                dunkel={false}
                farben={farben as any}
                onWert={() => {}}
            />,
        ),
        erklaerung: mit(
            <ErklaerungAnsicht
                sprache="de"
                dunkel={false}
                farben={farben}
                reiterZeitplaene="Zeitpläne"
                reiterRegelung="Regelung"
            />,
        ),
        zeitplaeneAus: mit(
            <ZeitplaeneAnsicht
                vorlage=""
                onVorlage={() => {}}
                alive={false}
                senden={null}
                dunkel={false}
                sprache="de"
            />,
        ),
    };
}
