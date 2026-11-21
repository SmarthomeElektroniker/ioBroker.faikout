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
import de from './i18n/de.json';

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
    const stufen = (wert: unknown, jeGeraet: boolean): string =>
        mit(
            <StufenAnsicht
                wert={wert}
                vorlage={jeGeraet ? [] : undefined}
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
            arbeitspunkt: { x: -4.9, wert: 95, text: 'Jetzt: außen −4,9 °C → 95 %', unterzeile: 'roh 99,4 %' },
        }),
        leer: bild('kuehlen', []),
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
        stufenGeraet: stufen([], true),
        feuchte: mit(
            <FeuchteAnsicht
                werte={{ dtpEin: 4, dtpAus: 6, rhEin: 65, rhAus: 58 }}
                massnahme="entfeuchten"
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
