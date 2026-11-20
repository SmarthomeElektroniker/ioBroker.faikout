'use strict';

/*
 * Laesst alle Szenarien fuer alle Varianten laufen (je Lauf ein eigener Prozess).
 *   node vergleich/alle.js --aus <ordner> [--eigen <adapterordner>] [--fremd <adapterordner>] [--nur szenario]
 * Ohne --fremd laeuft nur unser Adapter. Fremder Code wird ausschliesslich im Testcontainer geladen.
 */

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const arg = name => {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 ? process.argv[i + 1] : undefined;
};

const SZENARIEN = [
    { name: 'heizenKalterTag' },
    { name: 'heizenKalterTag', fuehler: 'extern' },
    { name: 'uebergang' },
    { name: 'uebergang', fuehler: 'extern' },
    { name: 'sonneAufAussenfuehler' },
    { name: 'fuehlerFriertEin' },
    { name: 'fuehlerNichtNumerisch' },
    { name: 'abtauen' },
    { name: 'geraetLehntDemandAb' },
    { name: 'handeingriff', plan: true },
    { name: 'verbindungsabriss' },
    { name: 'bleAnAus' },
    { name: 'wochenplanZeitumstellung', plan: true, minuten: 480 },
    { name: 'wochenplanZeitumstellungHerbst', plan: true, minuten: 480 },
    { name: 'neustartImEntfeuchten', feuchte: true },
    { name: 'sommerSchwuel', feuchte: true },
];

const aus = arg('aus') || 'ergebnisse';
fs.mkdirSync(aus, { recursive: true });
const eigen = arg('eigen') || path.join(__dirname, '..', '..');
const fremd = arg('fremd');
const nur = arg('nur');
const varianten = [
    { art: 'eigen', variante: 'adapter', ordner: eigen, main: 'main.js' },
    { art: 'eigen', variante: 'faikout', ordner: eigen, main: 'main.js' },
];
if (fremd) {
    varianten.push({ art: 'fremd', variante: 'fremd', ordner: fremd, main: 'build/src/main.js' });
}
for (const s of SZENARIEN) {
    if (nur && s.name !== nur) {
        continue;
    }
    for (const v of varianten) {
        const kennung = `${s.name}${s.fuehler ? '-extern' : ''}__${v.art === 'fremd' ? 'fremd' : `eigen-${v.variante}`}`;
        const a = [
            path.join(__dirname, 'lauf.js'),
            '--art',
            v.art,
            '--variante',
            v.variante,
            '--main',
            path.join(v.ordner, v.main),
            '--iopack',
            path.join(v.ordner, 'io-package.json'),
            '--szenario',
            s.name,
            '--fuehler',
            s.fuehler || 'intern',
            '--plan',
            s.plan ? 'ja' : 'nein',
            '--feuchte',
            s.feuchte ? 'ja' : 'nein',
            '--aus',
            path.join(aus, `${kennung}.json`),
            '--log',
            path.join(aus, `${kennung}.log`),
            '--mess',
            path.join(aus, `${kennung}.jsonl`),
        ];
        if (s.minuten) {
            a.push('--minuten', String(s.minuten));
        }
        const r = spawnSync(process.execPath, a, { encoding: 'utf8', timeout: 600000 });
        const fehler = (r.stderr || '').trim().split('\n').filter(Boolean);
        console.log(
            `${kennung}: ${r.status === 0 ? 'ok' : `FEHLER ${r.status}`}${fehler.length ? ` | stderr: ${fehler.slice(0, 3).join(' / ').slice(0, 300)}` : ''}`,
        );
        if (fehler.length) {
            fs.writeFileSync(path.join(aus, `${kennung}.stderr`), r.stderr);
        }
    }
}
