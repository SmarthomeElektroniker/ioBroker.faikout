// Rauchtest (node, Rendern auf dem Server): die Kennlinie in ihren Zustaenden, ohne ioBroker.
import React from 'react';
import { renderToString } from 'react-dom/server';
import { ThemeProvider } from '@mui/material/styles';
import { I18n, Theme } from '@iobroker/gui-components';
import { KennlinieAnsicht, type Richtung } from './Kennlinie';
import de from './i18n/de.json';

export function renderAll(): Record<string, string> {
    I18n.extendTranslations(de as any, 'de');
    I18n.setLanguage('de');
    const theme = Theme('light' as any);
    const bild = (richtung: Richtung, wert: unknown, arbeitspunkt: any = null): string =>
        renderToString(
            <ThemeProvider theme={theme}>
                <KennlinieAnsicht
                    richtung={richtung}
                    titel="Kennlinie"
                    wert={wert}
                    vorgabe={richtung === 'heizen' ? [{ x: -10, y: 95 }, { x: 0, y: 75 }, { x: 15, y: 40 }] : [{ x: 25, y: 40 }, { x: 35, y: 95 }]}
                    untergrenze={40}
                    obergrenze={95}
                    arbeitspunkt={arbeitspunkt}
                    sprache="de"
                    farben={{ flaeche: '#fff', fokus: '#3399cc', fehler: '#d9534f' }}
                    mitVorgabe
                    onWert={() => {}}
                />
            </ThemeProvider>,
        );
    return {
        eigene: bild('heizen', [{ x: -10, y: 95 }, { x: 0, y: 80 }, { x: 8, y: 60 }, { x: 15, y: 40 }], { x: -4.9, wert: 95, text: 'Leistungsgrenze 95 %', unterzeile: 'roh 99,4 %' }),
        leer: bild('kuehlen', []),
        falsch: bild('heizen', [{ x: 0, y: 50 }, { x: 5, y: 70 }]),
    };
}
