// Rauchtest der Admin-Komponenten (npm run test:admin):
// 1. die gebauten Dateien in admin/custom sind vollstaendig (Einstieg, Manifest, jeder verwiesene Teil)
// 2. die Texte der Komponenten gibt es in allen 11 Sprachen mit denselben Platzhaltern
// 3. jede in admin/jsonConfig.json genannte Komponente wird exportiert
// 4. alle Komponenten rendern in ihren Zustaenden ohne Fehler (braucht src-admin/node_modules)
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const custom = path.join(here, '..', 'admin', 'custom');
const LANGS = ['en', 'de', 'ru', 'pt', 'nl', 'fr', 'it', 'es', 'pl', 'uk', 'zh-cn'];
let checks = 0;
const ok = msg => {
    checks++;
    console.log(`  ✔ ${msg}`);
};

// 1. Build
const entry = path.join(custom, 'customComponents.js');
assert.ok(fs.existsSync(entry), 'admin/custom/customComponents.js fehlt - "npm run build:admin" ausfuehren');
const manifest = JSON.parse(fs.readFileSync(path.join(custom, 'mf-manifest.json'), 'utf8'));
assert.strictEqual(manifest.name, 'ConfigCustomFaikoutSet');
assert.ok(
    manifest.shared.some(s => s.name === '@iobroker/gui-components'),
    'gui-components (GUI API 2) geteilt',
);
assert.ok(!manifest.shared.some(s => s.name === '@iobroker/adapter-react-v5'), 'keine alte Bibliothek');
const exposed = manifest.exposes.find(e => e.name === 'Components');
assert.ok(exposed, 'stellt ./Components bereit');
for (const f of exposed.assets.js.sync) {
    assert.ok(fs.existsSync(path.join(custom, f)), `fehlt: ${f}`);
}
const seen = new Set();
const queue = ['customComponents.js'];
while (queue.length) {
    const rel = queue.shift();
    if (seen.has(rel)) {
        continue;
    }
    seen.add(rel);
    assert.ok(fs.existsSync(path.join(custom, rel)), `fehlender Teil ${rel}`);
    const text = fs.readFileSync(path.join(custom, rel), 'utf8');
    for (const m of text.matchAll(/["'`](\.{1,2}\/[^"'`]+?\.js)["'`]/g)) {
        queue.push(path.posix.normalize(path.posix.join(path.posix.dirname(rel), m[1])));
    }
}
ok(`Build vollstaendig: ${seen.size} Skripte, geteilt: ${manifest.shared.map(s => s.name).join(', ')}`);

// 2. Texte: Quelle (src/i18n) und Auslieferung (admin/custom/i18n) gleich, alle Sprachen vollstaendig
const en = JSON.parse(fs.readFileSync(path.join(custom, 'i18n', 'en.json'), 'utf8'));
const count = s => (String(s).match(/%s/g) || []).length;
for (const l of LANGS) {
    const file = path.join(custom, 'i18n', `${l}.json`);
    assert.ok(fs.existsSync(file), `i18n ${l} fehlt`);
    const text = fs.readFileSync(file, 'utf8');
    assert.strictEqual(text, fs.readFileSync(path.join(here, 'src', 'i18n', `${l}.json`), 'utf8'), `${l}: admin/custom veraltet`);
    const t = JSON.parse(text);
    assert.deepStrictEqual(
        Object.keys(en).filter(k => !t[k]),
        [],
        `${l}: Texte fehlen`,
    );
    assert.deepStrictEqual(
        Object.keys(en).filter(k => count(en[k]) !== count(t[k])),
        [],
        `${l}: Platzhalter weichen ab`,
    );
}
ok(`Texte: ${Object.keys(en).length} in ${LANGS.length} Sprachen`);

// 3. Verweise der jsonConfig
const src = fs.readFileSync(path.join(here, 'src', 'Components.tsx'), 'utf8');
const names = (src.match(/export default \{([^}]+)\}/) || ['', ''])[1]
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
const jsonConfig = JSON.parse(fs.readFileSync(path.join(here, '..', 'admin', 'jsonConfig.json'), 'utf8'));
const used = [];
const walk = o => {
    if (Array.isArray(o)) {
        o.forEach(walk);
    } else if (o && typeof o === 'object') {
        if (o.type === 'custom') {
            used.push(o);
        }
        Object.values(o).forEach(walk);
    }
};
walk(jsonConfig);
const zahl = name => used.filter(u => u.name.endsWith(`/${name}`)).length;
assert.deepStrictEqual(
    Object.fromEntries(names.map(n => [n, zahl(n)])),
    { KennlinieHeizen: 2, KennlinieKuehlen: 2, Stufen: 1, Feuchte: 1, Erklaerung: 1, Zeitplaene: 1, Geraete: 1, Abschnitt: 7, Rechenweg: 2, Raumkorrektur: 1 },
    'Kennlinien je Geraet und in der Vorlage, Temperaturstufen der Vorlage (die je Geraet zeichnet der Reiter Zeitplaene), Feuchte, Erklaerung, Zeitplaene, die Geraeteliste, die sieben aufklappbaren Abschnitte, Rechenweg (Satz bei der Strategie, Zeile bei Vortag) und die ziehbare Raumkorrektur',
);
for (const u of used) {
    const [set, file, comp] = u.name.split('/');
    assert.strictEqual(set, 'ConfigCustomFaikoutSet');
    assert.strictEqual(file, 'Components');
    assert.ok(names.includes(comp), `${comp} wird exportiert`);
    assert.strictEqual(u.url, 'custom/customComponents.js');
    assert.strictEqual(u.i18n, true);
}
ok(`jsonConfig: ${used.map(u => u.name.split('/')[2]).join(', ')}`);

// 4. Rendern auf dem Server - nur wenn die Entwicklungspakete von src-admin da sind
if (process.argv.includes('--render') || fs.existsSync(path.join(here, 'node_modules', 'vite'))) {
    const { createServer } = await import('vite');
    const server = await createServer({
        root: here,
        configFile: path.join(here, 'vite.smoke.config.ts'),
        server: { middlewareMode: true, hmr: false },
        appType: 'custom',
        logLevel: 'error',
        ssr: { noExternal: [/@iobroker\//, /@mui\//] },
    });
    // ein DOM fuer Bibliotheken, die beim Laden window/document anfassen (nach vite: es braucht die Timer von node)
    const { GlobalRegistrator } = await import('@happy-dom/global-registrator');
    GlobalRegistrator.register({ url: 'http://localhost/' });
    try {
        const mod = await server.ssrLoadModule('/src/smokeRender.tsx');
        // React trennt benachbarte Textstuecke mit leeren Kommentaren
        const html = Object.fromEntries(Object.entries(mod.renderAll()).map(([k, h]) => [k, h.replace(/<!-- -->/g, '')]));
        const griffe = h => (h.match(/role="slider"/g) || []).length;
        // Kennlinie: vier Stuetzpunkte und die beiden Grenzlinien sind ziehbar
        assert.strictEqual(griffe(html.eigene), 6, 'vier ziehbare Punkte und zwei Grenzlinien');
        assert.ok(/Jetzt: außen −4,9 °C → 95 %/.test(html.eigene), 'Jetzt-Marker beschriftet');
        assert.ok(/Obergrenze 95 % –/.test(html.eigene) && /Untergrenze 40 % –/.test(html.eigene), 'Grenzen beschriftet');
        assert.ok(/Werte als Tabelle/.test(html.eigene), 'Tabelle nur eingeklappt');
        // die Grenzen haben keine Eingabefelder mehr: Schrift an der Linie, Zahleneingabe erst auf Doppelklick/Enter
        for (const [name, h] of Object.entries({ eigene: html.eigene, leer: html.leer })) {
            assert.ok(!/fk-grenzfeld|fk-grenzwert/.test(h), `${name}: keine Grenzfelder unter dem Bild`);
            assert.ok(!/<input/.test(h), `${name}: kein Eingabefeld, solange nichts geoeffnet ist`);
            assert.strictEqual((h.match(/class="fk-grenzwahl"/g) || []).length, 2, `${name}: beide Grenzwerte lassen sich per Doppelklick oeffnen`);
            assert.ok(/doppelt auf die Zahl klicken/.test(h), `${name}: Hinweis nennt Ziehen, Pfeiltasten und Doppelklick`);
        }
        assert.ok(/Kopieren/.test(html.eigene) && /Einfügen/.test(html.eigene) && /Auf die Vorlage zurücksetzen/.test(html.eigene), 'Werkzeugleiste');
        // "Zuruecksetzen" am Geraet: nur, wenn es etwas Eigenes gibt
        const zurueck = h => (h.match(/<button[^>]*fk-wz-zurueck[^>]*>/) || [''])[0];
        assert.ok(!/disabled/.test(zurueck(html.eigene)) && /disabled/.test(zurueck(html.leer)) && !/disabled/.test(zurueck(html.grenzeEigen)), 'Zuruecksetzen nur mit eigenen Werten');
        // eigene Grenze, Punkte der Vorlage: oben "eigene Kennlinie", im Bild nicht mehr "nicht angepasst"
        assert.ok(/Kennlinie \(eigene Kennlinie\)/.test(html.grenzeEigen) && /Kurve aus der Vorlage \(eigene Grenze\)/.test(html.grenzeEigen) && !/nicht angepasst/.test(html.grenzeEigen), 'eigene Grenze: Etikett im Bild passt zur Klammer');
        // "So entsteht der Wert gerade": am Geraet immer da (fester Platz), an der Vorlage nie
        assert.ok(/class="[^"]*fk-weg[^"]*"[^>]*>.*So entsteht der Wert gerade:.*Kennlinie 87 % → Raum 1,0 K zu kalt: \+7 → 95 %/.test(html.eigene), 'Rechenweg unter dem Bild');
        assert.ok(/So entsteht der Wert gerade:.*Noch kein Wert/.test(html.leer), 'ohne Daten steht die Zeile trotzdem da');
        assert.ok(!/fk-weg/.test(html.werk), 'Vorlage: kein Rechenweg');
        assert.ok(!/fk-jetzt-text/.test(html.eigene + html.leer), 'der alte Satz zur Raumkorrektur ist ersetzt');
        // Geraet ohne eigene Punkte: die Punkte der Vorlage sind direkt ziehbar, kein Hinweisblock, kein Knopf -
        // die Ueberschrift sagt in der Klammer, was gilt
        assert.strictEqual(griffe(html.leer), 4, 'Geraet, leere Liste: Grenzlinien und die zwei Punkte der Vorlage sind ziehbar');
        assert.ok(/Kennlinie \(globale Kennlinie\)/.test(html.leer) && /Vorlage \(nicht angepasst\)/.test(html.leer), 'Geraet leer: Klammer "globale Kennlinie"');
        assert.ok(!/Eigene Kennlinie anlegen|fk-leer"|gilt die Kennlinie der Vorlage/.test(html.leer), 'Geraet leer: kein Hinweis, kein Knopf');
        assert.ok(/Kennlinie \(eigene Kennlinie\)/.test(html.eigene), 'Geraet mit eigenen Punkten: Klammer "eigene Kennlinie"');
        // die Vorlage selbst bleibt, wie sie war: Werksvorgabe blass, Hinweis und Knopf
        assert.strictEqual(griffe(html.werk), 2, 'Vorlage, leere Liste: nur die Grenzlinien sind ziehbar');
        assert.ok(/Es gilt die Werksvorgabe/.test(html.werk) && /Eigene Kennlinie anlegen/.test(html.werk) && !/\(globale Kennlinie\)/.test(html.werk), 'Vorlage leer: Werksvorgabe + Knopf, keine Klammer');
        assert.strictEqual(griffe(html.eingeklappt), 0, 'eingeklappt: nur die Titelzeile');
        assert.ok(/Die Heizkennlinie muss fallen/.test(html.falsch), 'Fehler im Klartext');
        ok('Rendern Kennlinie: eigene Punkte, leere Liste (Vorlage), eingeklappt und ungueltig');
        // Temperaturstufen
        assert.strictEqual(griffe(html.stufenEigen), 2, 'eine eingeschaltete Stufe: Ziel und Hoechstleistung ziehbar');
        assert.ok(/Werksvorgabe/.test(html.stufenEigen) && /Temperaturstufe hinzufügen/.test(html.stufenEigen), 'Stufen der Vorlage');
        assert.ok(griffe(html.stufenWerk) >= 6, 'leere Liste: die Werksstufen');
        // Geraet ohne eigene Stufen: die Stufen der Vorlage sind direkt anfassbar - kein Knopf, eine Zeile sagt, was gilt
        const sichtbar = h => (h.match(/visibility:visible"[^>]*>([^<]*)</) || ['', ''])[1];
        assert.ok(/^Diese Anlage benutzt die Stufen der Vorlage/.test(sichtbar(html.stufenGeraet)) && !/Eigene Temperaturstufen anlegen|fk-st-eigene/.test(html.stufenGeraet), `Geraet ohne eigene Stufen: Hinweis statt Knopf (${sichtbar(html.stufenGeraet)})`);
        assert.ok(/data-quelle="vorlage"/.test(html.stufenGeraet) && /value="Wach"/.test(html.stufenGeraet) && !/<input[^>]*disabled/.test(html.stufenGeraet), 'Stufen der Vorlage sind bearbeitbar');
        assert.strictEqual(griffe(html.stufenGeraet), 2, 'Vorlage-Stufe am Geraet: Ziel und Hoechstleistung ziehbar');
        assert.ok(/<button[^>]*fk-wz-zurueck[^>]*disabled/.test(html.stufenGeraet), 'nichts Eigenes: Zuruecksetzen gesperrt');
        assert.ok(/data-quelle="eigen"/.test(html.stufenGeraetEigen) && /^Eigene Stufen dieser Anlage/.test(sichtbar(html.stufenGeraetEigen)) && /Auf die Vorlage zurücksetzen/.test(html.stufenGeraetEigen), 'Geraet mit eigenen Stufen');
        assert.ok(!/<button[^>]*fk-wz-zurueck[^>]*disabled/.test(html.stufenGeraetEigen), 'eigene Stufen: Zuruecksetzen frei');
        ok('Rendern Stufen je Geraet: Vorlage direkt anfassbar, eigen/Vorlage als Text');
        // Zuruecksetzen, waehrend der Plan eigene Stufen benutzt: Rueckfrage im Formular, je Stufe eine Ersatzwahl
        // mit der naechstliegenden Stufe der Vorlage als Vorgabe (Tag 22 °C -> Komfort, Nacht 18 °C -> Absenken)
        const frage = (html.stufenRueckfrage.match(/<div class="fk-st-rueckfrage[\s\S]*?fk-st-rueckfrage-nein[\s\S]*?<\/button>/) || [''])[0];
        assert.ok(/role="alertdialog"/.test(frage) && /Der Wochenplan von Test benutzt Stufen, die es in der Vorlage nicht gibt:/.test(frage), 'Rueckfrage nennt die Anlage');
        const wahl = [...frage.matchAll(/data-stufe="([^"]*)"[\s\S]*?<span>([^<]*)<\/span>[\s\S]*?<option value="([^"]*)" selected="">([^<]*)</g)].map(m => m.slice(1));
        assert.deepStrictEqual(wahl, [['nacht', '„Nacht“ ersetzen durch:', 'absenken', 'Absenken'], ['tag', '„Tag“ ersetzen durch:', 'komfort', 'Komfort']], `Ersatzwahl je betroffener Stufe (${JSON.stringify(wahl)})`);
        assert.ok(/fk-st-rueckfrage-ja[^>]*>Zurücksetzen</.test(frage) && /fk-st-rueckfrage-nein[^>]*>Abbrechen</.test(frage) && /erst, wenn du die Einstellungen speicherst/.test(frage), 'Knoepfe Zuruecksetzen/Abbrechen, Hinweis auf das Speichern');
        assert.ok(!/fk-st-rueckfrage/.test(html.stufenOhneRueckfrage) && !/fk-st-rueckfrage/.test(html.stufenGeraetEigen), 'Plan nur mit Stufen der Vorlage: keine Rueckfrage');
        // die Ersatzwahl reist im Formularauszug zum Adapter (zeitplaeneListe) - sonst meldet die Vorschau "Stufe gibt es nicht"
        assert.ok(/stufenErsatz: z\.stufenErsatz/.test(fs.readFileSync(path.join(here, 'src', 'Zeitplaene.tsx'), 'utf8')), 'Zeitplaene schickt stufenErsatz mit');
        ok('Rendern Rueckfrage beim Zuruecksetzen der Stufen: Ersatzwahl je Stufe, Vorgabe naechste Temperatur');
        // Rechenweg: jeder Fall als Satz
        const WEG = {
            warm: 'Kennlinie 52 % → Raum 1,0 K zu warm: −7 → 45 %',
            kalt: 'Kennlinie 52 % → Raum 1,7 K zu kalt: +14 → 65 %',
            imZiel: 'Kennlinie 52 % → Raum am Ziel (innerhalb ±0,3 K): ±0 → 50 %',
            ohneRaum: 'Kennlinie 52 % → kein Raumwert: keine Korrektur → 50 %',
            unten: 'Kennlinie 42 % → Raum 0,9 K zu warm: −6 → 40 % (Untergrenze)',
            oben: 'Kennlinie 100 % → Raum 1,0 K zu kalt: +7 → 95 % (Obergrenze)',
            voll: 'Kennlinie 52 % → Raum 2,3 K zu kalt: volle Leistung (ab 2 K) → 100 %',
            ueber: 'Kennlinie 52 % → Raum 1,6 K zu warm: Überheizschutz (ab 1,5 K) → 30 %',
            deckel: 'Kennlinie 86 % → Raum 1,7 K zu kalt: +14 → 100 % → Stufe „Tag“ höchstens 90 %',
            vortag: 'Vortag 48 % + 10 → Raum 1,0 K zu warm: −7 → 55 %',
            kuehlenWarm: 'Kennlinie 65 % → Raum 1,0 K zu warm: +7 → 70 %',
            andereRichtung: 'Die Anlage heizt gerade nicht – diese Kennlinie ist nicht im Einsatz.',
            probelauf: 'Kennlinie 52 % → Raum 1,0 K zu warm: −7 → 45 % (Probelauf – es wird nichts gesendet)',
            aus: 'Bedarfsregelung ist aus – sie würde so rechnen: Kennlinie 52 % → Raum 1,0 K zu warm: −7 → 45 %',
            rueckfall: 'Kein Außenwert – zur Sicherheit volle Leistung: 100 %',
            rueckfallVortag: 'Keine Daten von gestern – zur Sicherheit volle Leistung: 100 %',
            abtauen: 'Abtauen – der Wert bleibt bei 75 %',
            stufeOhne: 'Stufe „Tag“ läuft ohne Leistungsregelung: 100 %',
            ruhtAuto: 'Das Faikout-Modul regelt selbst – der Adapter setzt keine Leistungsgrenze.',
            nichtFaehig: 'Diese Anlage übernimmt keine Leistungsgrenze – der Adapter setzt keine.',
            neutral: 'Die Anlage heizt oder kühlt gerade nicht – kein Wert.',
            neutralHeizen: 'Die Anlage heizt gerade nicht – diese Kennlinie ist nicht im Einsatz.',
            wartet: 'Noch kein Wert – die Regelung hat für diese Anlage noch nicht gerechnet.',
            nochNicht: 'Noch kein Wert – die Regelung hat für diese Anlage noch nicht gerechnet.',
        };
        assert.deepStrictEqual(Object.fromEntries(Object.keys(WEG).map(k => [k, html[`weg_${k}`]])), WEG, 'Rechenweg als Satz');
        assert.strictEqual(Object.keys(html).filter(k => k.startsWith('weg_')).length, Object.keys(WEG).length, 'jeder Fall geprueft');
        assert.ok(/data-art="normal"/.test(html.wegZeile) && /data-art=""/.test(html.wegZeileLeer), 'Art der Zeile am Element');
        // Satz bei der Strategie: Zahlen aus den Einstellungen
        assert.strictEqual(html.satz, 'Die Raumtemperatur korrigiert den Wert: ±10 % je Kelvin Abweichung vom Ziel (ab 0,3 K).');
        assert.strictEqual(html.satzEigen, 'Die Raumtemperatur korrigiert den Wert: ±15 % je Kelvin Abweichung vom Ziel (ab 0,5 K).');
        assert.strictEqual(html.satzEn, 'The room temperature corrects the value: ±10 % per kelvin of deviation from the target (from 0.3 K).');
        assert.strictEqual(html.satzNull, 'Die Raumtemperatur korrigiert den Wert nicht (Korrekturstärke 0).');
        // Raumkorrektur zum Ziehen: zwei Griffe, Zahlen an der Linie, kein Eingabefeld, solange nichts geoeffnet ist
        assert.strictEqual(griffe(html.raumkorrektur), 2, 'Staerke und Totband ziehbar');
        assert.ok(/Stärke 10 % je K/.test(html.raumkorrektur) && /Totband ±0,3 K/.test(html.raumkorrektur) && !/<input/.test(html.raumkorrektur), 'Werte als Schrift, Eingabe erst auf Doppelklick');
        assert.ok(/Beispiel: Raum 1 K zu kalt → \+7 Punkte, 1 K zu warm → −7 Punkte\./.test(html.raumkorrektur), 'Beispiel mit den Zahlen');
        assert.ok(/<button[^>]*fk-rk-werk[^>]*disabled/.test(html.raumkorrektur) && !/<button[^>]*fk-rk-werk[^>]*disabled/.test(html.raumkorrekturEigen), 'Werksvorgabe nur, wenn etwas abweicht');
        assert.ok(/Stärke 25 % je K/.test(html.raumkorrekturEigen) && /Totband ±0,5 K/.test(html.raumkorrekturEigen) && /→ \+13 Punkte/.test(html.raumkorrekturEigen), 'eigene Werte');
        ok('Rendern Rechenweg (alle Faelle), Satz zur Raumkorrektur und ziehbare Raumkorrektur');
        // Feuchte, Erklaerung, Zeitplaene
        assert.strictEqual(griffe(html.feuchte), 4, 'vier ziehbare Feuchte-Grenzen');
        assert.ok(/Wohnzimmer/.test(html.feuchte) && /Abstand 9,4 K/.test(html.feuchte), 'Live-Werte');
        // je Betriebsart steht da, was geschieht - abhaengig von der gewaehlten Massnahme (wie lib/regel/feuchte.js)
        const art = (h, name) => (h.match(new RegExp(`data-art="${name}"[^>]*>.*?</li>`)) || [''])[0].replace(/<[^>]+>/g, '');
        assert.ok(/Heizen: bewusst kein Eingriff, nur eine Meldung/.test(art(html.feuchte, 'heizen')), 'Heizen: bewusst nichts');
        assert.ok(/Kühlen: schaltet auf Entfeuchten und danach wieder zurück/.test(art(html.feuchte, 'kuehlen')), 'Kuehlen: Entfeuchten');
        assert.ok(/Entfeuchten: läuft schon/.test(art(html.feuchte, 'entfeuchten')), 'Entfeuchten laeuft schon');
        assert.ok(/Anlage aus: nur eine Meldung – der Adapter schaltet die Anlage dafür nicht ein/.test(art(html.feuchte, 'aus')), 'Anlage aus');
        assert.ok(/Kühlen: senkt die Zieltemperatur um 1 K und stellt sie danach wieder zurück/.test(art(html.feuchteZiel, 'kuehlen')), 'Ziel senken');
        assert.ok(/Entfeuchten: kein Eingriff/.test(art(html.feuchteZiel, 'entfeuchten')) && /bewusst kein Eingriff/.test(art(html.feuchteZiel, 'heizen')), 'Ziel senken wirkt nur beim Kuehlen');
        for (const name of ['heizen', 'kuehlen', 'entfeuchten']) {
            assert.ok(/nur eine Meldung, kein Eingriff/.test(art(html.feuchteMelden, name)), `nur melden: ${name}`);
        }
        assert.ok(/„Faikout-Modul regelt selbst“ gewählt ist/.test(html.feuchte) && /Frostschutz/.test(html.feuchte) && /Feuchteregelung darf eingreifen/.test(html.feuchte), 'Ausnahmen genannt');
        assert.ok(/Reiter „Zeitpläne“/.test(html.erklaerung) && /Reiter „Regelung“/.test(html.erklaerung), 'Erklaerung nennt die Reiter');
        assert.ok(/Werksplan \(nicht angepasst\)/.test(html.zeitplaeneAus) && /Vorlage bearbeiten/.test(html.zeitplaeneAus), 'Vorlage als eigene Zeile');
        assert.ok(/Die Instanz läuft nicht/.test(html.zeitplaeneAus), 'gestoppte Instanz wird erklaert');
        ok('Rendern Stufen, Feuchte, Erklaerung und Zeitplaene');
    } finally {
        await GlobalRegistrator.unregister();
        await server.close();
    }
}
console.log(`${checks} Pruefungen bestanden`);
