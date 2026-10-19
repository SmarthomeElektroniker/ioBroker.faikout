'use strict';

/*
 * Einheiten von comp/fanfreq, Erkennung von ha.enable und Vollstaendigkeit der Feldkunde.
 *
 * Hintergrund (Faikout.c, revk_state_extra): Ab Werk sendet das Modul `comp` in Hz und
 * `fanfreq` in Hz (fanrpm / 60, "%.1f"). Nur mit ha.comprpm bzw. ha.fanrpm kommt rpm.
 * Bis 0.0.16 stand an beiden Objekten fest "rpm".
 */

const { expect } = require('chai');
const felder = require('../lib/fields');

const sensor = (feld, einheit, name = 'Daikin 1OG') =>
    JSON.stringify({
        unique_id: `983DAEF12630${feld}`,
        name: feld,
        stat_t: `state/${name}`,
        avty_t: `state/${name}`,
        unit_of_meas: einheit,
        val_tpl: `{{value_json.${feld}}}`,
    });

describe('Einheiten von comp und fanfreq', () => {
    it('Werksstand ist Hz, rpm ist die Alternative', () => {
        for (const f of ['comp', 'fanfreq']) {
            expect(felder.FELDER[f].unit, f).to.equal('Hz');
            expect(felder.FELDER[f].einheiten, f).to.eql(['Hz', 'rpm']);
        }
    });

    it('liest die Einheit aus der HA-Discovery', () => {
        expect(felder.haSensorAuswerten('homeassistant/sensor/983DAEF12630comp/config', sensor('comp', 'rpm'))).to.eql({
            geraet: 'Daikin 1OG',
            feld: 'comp',
            einheit: 'rpm',
        });
        expect(
            felder.haSensorAuswerten('homeassistant/sensor/983DAEF12630fanfreq/config', sensor('fanfreq', 'Hz')),
        ).to.eql({ geraet: 'Daikin 1OG', feld: 'fanfreq', einheit: 'Hz' });
    });

    it('uebergeht Discoveries anderer Sensoren und kaputte Nachrichten', () => {
        expect(felder.haSensorAuswerten('homeassistant/sensor/Xoutside/config', sensor('outside', '°C'))).to.equal(null);
        expect(felder.haSensorAuswerten('homeassistant/sensor/Xcomp/config', sensor('comp', 'kHz'))).to.equal(null);
        expect(felder.haSensorAuswerten('homeassistant/sensor/Xcomp/config', '{kaputt')).to.equal(null);
        expect(felder.haSensorAuswerten('homeassistant/climate/X/config', sensor('comp', 'rpm'))).to.equal(null);
        expect(felder.haSensorAuswerten('state/Daikin 1OG', sensor('comp', 'rpm'))).to.equal(null);
    });

    it('ein gebrochener Luefterwert ist sicher Hz, ein ganzer sagt nichts', () => {
        expect(felder.einheitAusWert('fanfreq', 12.5)).to.equal('Hz');
        expect(felder.einheitAusWert('fanfreq', 12)).to.equal(null);
        expect(felder.einheitAusWert('fanfreq', 750)).to.equal(null);
        expect(felder.einheitAusWert('outside', 9.5)).to.equal(null);
    });
});

describe('ha.enable', () => {
    it('erkennt ein Modul ohne ha.enable an der fehlenden Solltemperatur', () => {
        expect(felder.ohneHaEnable({ id: 'ABC', up: true, uptime: 10, mem: 1 })).to.equal(true);
    });

    it('meldet nichts bei voller Statusmeldung oder Last Will', () => {
        expect(felder.ohneHaEnable({ id: 'ABC', up: true, target: 21 })).to.equal(false);
        expect(felder.ohneHaEnable({ up: false, reason: 'LWT' })).to.equal(false);
    });
});

describe('Feldkunde vollstaendig', () => {
    /*
     * Alle Felder, die state/<Name> tragen kann: aus revk_state_extra() in Faikout.c und aus der
     * Statusmeldung der RevK-Bibliothek (revk.c). `mqtt-up` als Liste (mehrere Broker) ist eine
     * Struktur und wird uebergangen.
     */
    const AUS_FAIKOUT = [
        'loopback',
        'online',
        'power',
        'target',
        'actarget',
        'temp',
        'hum',
        'achome',
        'inlet',
        'outside',
        'liquid',
        'demand',
        'energy',
        'energyheat',
        'energycool',
        'consumption',
        'fanfreq',
        'comp',
        'bletemp',
        'blehum',
        'blebat',
        'mode',
        'action',
        'fan',
        'streamer',
        'quiet',
        'econo',
        'comfort',
        'powerful',
        'sensor',
        'led',
        'swing',
        'preset',
        'autoe',
    ];
    const AUS_REVK = [
        'id',
        'up',
        'uptime',
        'mqtt-up',
        'restart',
        'reason',
        'secureboot',
        'nvsecryption',
        'app',
        'version',
        'build-suffix',
        'build',
        'flash',
        'rst',
        'mem',
        'spi',
        'dma',
        'ssid',
        'bssid',
        'rssi',
        'chan',
        'ipv4',
        'ipv6',
    ];

    it('beschreibt jedes Feld der Statusmeldung', () => {
        const fehlt = [...AUS_FAIKOUT, ...AUS_REVK].filter(f => !felder.FELDER[f]);
        expect(fehlt).to.eql([]);
    });

    it('jedes bekannte Feld hat Kanal, Typ, Rolle und Namen', () => {
        for (const [feld, def] of Object.entries(felder.FELDER)) {
            expect(['control', 'status', 'info'], feld).to.include(def.kanal);
            expect(['number', 'string', 'boolean'], feld).to.include(def.type);
            expect(def.role, feld).to.be.a('string').and.not.empty;
            expect(def.name && def.name.en, feld).to.be.a('string').and.not.empty;
            expect(def.name && def.name.de, feld).to.be.a('string').and.not.empty;
        }
    });

    it('action kennt alle Werte von hvac_action', () => {
        expect(Object.keys(felder.FELDER.action.states)).to.eql([
            'off',
            'preheating',
            'heating',
            'cooling',
            'drying',
            'fan',
            'idle',
            'defrosting',
        ]);
        expect(felder.FELDER.action.w).to.equal(undefined);
    });

    it('Speicher- und Neustartwerte liegen unter info', () => {
        expect(felder.FELDER.dma.kanal).to.equal('info');
        expect(felder.FELDER.dma.unit).to.equal('B');
        expect(felder.FELDER.restart.kanal).to.equal('info');
        expect(felder.FELDER.restart.unit).to.equal('s');
    });
});
