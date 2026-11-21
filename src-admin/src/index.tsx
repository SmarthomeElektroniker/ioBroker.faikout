// Nur Entwicklung (Einstieg fuer vite): beide Kennlinien ohne ioBroker. Gehoert nicht zum Admin-Build -
// der Admin laedt customComponents.js (Module Federation) und daraus src/Components.tsx.
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { KennlinieAnsicht, type Richtung } from './Kennlinie';

function Probe(props: { richtung: Richtung }): React.JSX.Element {
    const [wert, setWert] = useState<unknown[]>([]);
    return (
        <KennlinieAnsicht
            richtung={props.richtung}
            titel={props.richtung}
            wert={wert}
            vorgabe={props.richtung === 'heizen' ? [{ x: -10, y: 95 }, { x: 15, y: 40 }] : [{ x: 25, y: 40 }, { x: 35, y: 95 }]}
            untergrenze={40}
            obergrenze={95}
            arbeitspunkt={null}
            sprache="de"
            farben={{ flaeche: '#fff', fokus: '#3399cc', fehler: '#d9534f' }}
            mitVorgabe
            onWert={setWert}
        />
    );
}

const wurzel = document.getElementById('root');
if (wurzel) {
    createRoot(wurzel).render(
        <>
            <Probe richtung="heizen" />
            <Probe richtung="kuehlen" />
        </>,
    );
}
