const path = require('node:path');
const net = require('node:net');
const { tests } = require('@iobroker/testing');

/** A free TCP port, so the broker does not collide with services on the test machine. */
function freePort() {
    return new Promise((resolve, reject) => {
        const s = net.createServer();
        s.listen(0, () => {
            const p = s.address().port;
            s.close(() => resolve(p));
        });
        s.on('error', reject);
    });
}

// Run integration tests: starts a temporary js-controller instance, installs the adapter
// and verifies that it starts up cleanly (no config required — the adapter must not crash
// when no credentials/devices are configured yet).
tests.integration(path.join(__dirname, '..'), {
    // Locally the default controller version ("dev" on Node > 20) may not install; set
    // IOB_CONTROLLER=latest to test against the current release. CI keeps the default.
    controllerVersion: process.env.IOB_CONTROLLER || undefined,

    defineAdditionalTests({ suite }) {
        // 0.0.17: comp/fanfreq are sent in Hz by default and in rpm only with ha.comprpm/ha.fanrpm.
        // The adapter takes the unit from the module's HA discovery; a fractional fan value is Hz.
        suite('Units of compressor and fan speed (0.0.17)', getHarness => {
            it('takes the unit from the HA discovery and from fractional values', async function () {
                this.timeout(60000);
                const harness = getHarness();
                const port = await freePort();
                await harness.changeAdapterConfig('faikout', { native: { port } });
                await harness.startAdapterAndWait();
                await new Promise(r => setTimeout(r, 2000));

                const mqtt = require('mqtt');
                const client = mqtt.connect(`mqtt://127.0.0.1:${port}`, { clientId: 'unit-test', reconnectPeriod: 0 });
                await new Promise((res, rej) => {
                    client.on('connect', res);
                    client.on('error', rej);
                    setTimeout(() => rej(new Error('connect timeout')), 10000);
                });
                const pub = (topic, obj) =>
                    new Promise((res, rej) => client.publish(topic, JSON.stringify(obj), e => (e ? rej(e) : res())));
                const sensor = (field, unit) => ({
                    unique_id: `ABC${field}`,
                    stat_t: 'state/Unit AC',
                    avty_t: 'state/Unit AC',
                    unit_of_meas: unit,
                    val_tpl: `{{value_json.${field}}}`,
                });

                await pub('homeassistant/sensor/ABCcomp/config', sensor('comp', 'rpm'));
                await pub('state/Unit AC', { up: true, id: 'ABC', target: 21, comp: 2640, fanfreq: 12.5, dma: 1000 });
                await new Promise(r => setTimeout(r, 2000));

                const dev = 'faikout.0.Unit_AC';
                const comp = await harness.objects.getObjectAsync(`${dev}.status.comp`);
                const fan = await harness.objects.getObjectAsync(`${dev}.status.fanfreq`);
                const dma = await harness.objects.getObjectAsync(`${dev}.info.dma`);
                if (!comp || comp.common.unit !== 'rpm') {
                    throw new Error(`comp unit wrong: ${JSON.stringify(comp && comp.common)}`);
                }
                if (!fan || fan.common.unit !== 'Hz') {
                    throw new Error(`fanfreq unit wrong: ${JSON.stringify(fan && fan.common)}`);
                }
                if (!dma || dma.common.unit !== 'B') {
                    throw new Error(`dma not described: ${JSON.stringify(dma && dma.common)}`);
                }

                // The module switches to rpm (ha.fanrpm on) and announces it in a new discovery.
                await pub('homeassistant/sensor/ABCfanfreq/config', sensor('fanfreq', 'rpm'));
                await new Promise(r => setTimeout(r, 1500));
                const fan2 = await harness.objects.getObjectAsync(`${dev}.status.fanfreq`);
                const device = await harness.objects.getObjectAsync(dev);
                client.end(true);
                if (fan2.common.unit !== 'rpm') {
                    throw new Error(`fanfreq unit not updated: ${fan2.common.unit}`);
                }
                if (!device.native.einheiten || device.native.einheiten.fanfreq !== 'rpm' || device.native.einheiten.comp !== 'rpm') {
                    throw new Error(`units not remembered: ${JSON.stringify(device.native)}`);
                }
            });
        });

        // Up to 0.0.16 dma and restart were unknown fields and landed in status.*; they belong in info.*.
        suite('Known fields in the wrong channel (0.0.16 -> 0.0.17)', getHarness => {
            it('moves status.dma to info.dma and keeps the value', async function () {
                this.timeout(60000);
                const harness = getHarness();
                const dev = 'faikout.0.Move_AC';
                await harness.objects.setObjectAsync(dev, { type: 'device', common: { name: 'Move AC' }, native: {} });
                await harness.objects.setObjectAsync(`${dev}.status.dma`, {
                    type: 'state',
                    common: { name: 'dma', type: 'number', role: 'value', read: true, write: false },
                    native: { feld: 'dma' },
                });
                await harness.states.setStateAsync(`${dev}.status.dma`, { val: 158003, ack: true });

                await harness.startAdapterAndWait();
                await new Promise(r => setTimeout(r, 3000));

                const old = await harness.objects.getObjectAsync(`${dev}.status.dma`);
                const moved = await harness.objects.getObjectAsync(`${dev}.info.dma`);
                const value = await harness.states.getStateAsync(`${dev}.info.dma`);
                if (old) {
                    throw new Error('status.dma was not removed');
                }
                if (!moved || moved.common.unit !== 'B') {
                    throw new Error(`info.dma missing: ${JSON.stringify(moved)}`);
                }
                if (!value || value.val !== 158003) {
                    throw new Error(`value not kept: ${JSON.stringify(value)}`);
                }
            });
        });

        // 0.0.14 renamed the consumption subtree to English IDs. An existing installation must
        // keep its values: the old states are copied and only then deleted.
        suite('Migration of the consumption subtree (0.0.13 -> 0.0.14)', getHarness => {
            it('moves verbrauch.* to consumption.* and keeps the values', async function () {
                this.timeout(60000);
                const harness = getHarness();
                const dev = 'faikout.0.Test_AC';
                const create = (id, type, common) => harness.objects.setObjectAsync(id, { type, common, native: {} });
                const number = { type: 'number', role: 'value.energy.consumed', read: true, write: false };

                await create(dev, 'device', { name: 'Test AC' });
                await create(`${dev}.verbrauch`, 'channel', { name: 'Verbrauch' });
                await create(`${dev}.verbrauch.gesamt`, 'channel', { name: 'Gesamt' });
                await create(`${dev}.verbrauch.gesamt.heute`, 'state', { ...number, name: 'Heute' });
                await create(`${dev}.verbrauch.gesamt.gestern`, 'state', { ...number, name: 'Gestern' });
                await create(`${dev}.verbrauch.gesamt.stundenJson`, 'state', {
                    type: 'string',
                    role: 'json',
                    read: true,
                    write: false,
                    name: 'Stunden',
                });
                await harness.states.setStateAsync(`${dev}.verbrauch.gesamt.heute`, { val: 3.2, ack: true });
                await harness.states.setStateAsync(`${dev}.verbrauch.gesamt.gestern`, { val: 7.5, ack: true });
                await harness.states.setStateAsync(`${dev}.verbrauch.gesamt.stundenJson`, {
                    val: JSON.stringify([{ stunde: '2026-10-11T10', kwh: 0.4 }]),
                    ack: true,
                });

                await harness.startAdapterAndWait();
                await new Promise(r => setTimeout(r, 3000));

                const today = await harness.states.getStateAsync(`${dev}.consumption.total.today`);
                const yesterday = await harness.states.getStateAsync(`${dev}.consumption.total.yesterday`);
                const hours = await harness.states.getStateAsync(`${dev}.consumption.total.hoursJson`);
                const oldState = await harness.objects.getObjectAsync(`${dev}.verbrauch.gesamt.heute`);
                const oldChannel = await harness.objects.getObjectAsync(`${dev}.verbrauch`);

                if (!today || today.val !== 3.2) {
                    throw new Error(`today not migrated: ${JSON.stringify(today)}`);
                }
                if (!yesterday || yesterday.val !== 7.5) {
                    throw new Error(`yesterday not migrated: ${JSON.stringify(yesterday)}`);
                }
                if (!hours || hours.val !== JSON.stringify([{ hour: '2026-10-11T10', kwh: 0.4 }])) {
                    throw new Error(`hoursJson not migrated: ${JSON.stringify(hours)}`);
                }
                if (oldState || oldChannel) {
                    throw new Error('old verbrauch.* objects were not removed');
                }
            });
        });
    },
});
