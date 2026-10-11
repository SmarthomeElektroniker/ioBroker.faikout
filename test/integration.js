const path = require('node:path');
const { tests } = require('@iobroker/testing');

// Run integration tests: starts a temporary js-controller instance, installs the adapter
// and verifies that it starts up cleanly (no config required — the adapter must not crash
// when no credentials/devices are configured yet).
tests.integration(path.join(__dirname, '..'), {
    // Locally the default controller version ("dev" on Node > 20) may not install; set
    // IOB_CONTROLLER=latest to test against the current release. CI keeps the default.
    controllerVersion: process.env.IOB_CONTROLLER || undefined,

    defineAdditionalTests({ suite }) {
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
