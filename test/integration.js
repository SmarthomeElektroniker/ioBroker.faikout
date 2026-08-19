const path = require('node:path');
const { tests } = require('@iobroker/testing');

// Run integration tests: starts a temporary js-controller instance, installs the adapter
// and verifies that it starts up cleanly (no config required — the adapter must not crash
// when no credentials/devices are configured yet).
tests.integration(path.join(__dirname, '..'));
