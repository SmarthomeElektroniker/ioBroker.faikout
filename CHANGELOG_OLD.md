# Older changes
## 0.0.13
- On start, names and roles of existing states are updated to the current field description. Objects are only created
  when a value arrives, so rarely reported fields (like `status.reason`) kept their old description after an update.

## 0.0.12
- New state `status.reason`: the disconnect reason the broker publishes from the module's MQTT last will (value `LWT`),
  now described with role and names in all eleven languages (it was created as an unknown field before).

## 0.0.11
- Remaining log messages in English (hour change, client disconnect/error, failed command).
- Stopping the adapter no longer hangs while faikout modules stay connected: open MQTT connections are closed actively,
  with a 2 s upper limit (previously the js-controller killed the process after its stop timeout). New test.

## 0.0.10
- Review findings (PR #6700): all log messages and error texts in English (`main.js`, `lib/broker.js`, `lib/verbrauch.js`).
- `control.swing`: state labels in English (`off`, `on`, `vertical`, `horizontal`, `both`, `comfort`).
- VIS widgets: every visible text goes through a small translation helper – German for a German VIS, English for all other languages; decimal separator and month names follow the VIS language.

## 0.0.9
- Maintenance: `@iobroker/testing` updated to 6.3 (W0037).
- `.gitignore` uses `.vscode/*` so the tracked `.vscode/settings.json` is no longer covered by an ignore rule (W9008).

## 0.0.8
- Object structure fixed for the repository check: all datapoint names now in eleven languages
  (`lib/namen.js`), invalid roles corrected (`info` → `info.name`/`info.address`/`text`,
  `level.mode.*` → `state`), instance objects translated as well. New test `test/namen.js`.
- Shared `@iobroker/eslint-config` and `@alcalzone/release-script` adopted, older changelog
  entries moved to `CHANGELOG_OLD.md`, `.vscode/settings.json` added, contact address in the
  copyright line.

## 0.0.7
- Maintenance release: `@iobroker/adapter-core` 3.4.3 and `@iobroker/testing` 6.2.1, tests also on
  Node.js 26, `testing-action-check` v2, admin translations in the short format
  (`admin/i18n/<lang>.json`), `tsconfig.json` and JSON schemas for VS Code.
- Published through GitHub Actions with provenance (0.0.6 had been published manually).

## 0.0.6
- Released through GitHub Actions with npm provenance (trusted publishing). No functional
  changes; 0.0.5 was published manually and therefore carries no provenance attestation.

## 0.0.5
- Meet the ioBroker repository requirements: updated dev dependencies, removed the deprecated
  `common.main`, fixed responsive column widths, and translated the admin texts into the nine
  remaining languages.

## 0.0.4
- Fix: the admin rejected the whole configuration with "invalid jsonConfig". `instance` fields
  do not allow `visible` (their schema sets `additionalProperties: false`); the condition
  belongs in `hidden`. The configuration is now validated against the official schema.

## 0.0.3
- Fix: consumption tracking crashed on every meter reading after updating from 0.0.1
  ("Cannot read properties of undefined") because the stored state predates the day and month
  buffers. Stored state is merged into a fresh default now.
- Fix: with no month recorded yet, the month rollover booked the whole meter reading as last
  month's consumption (3783 kWh instead of the difference).
- `npm test` only ran the package checks; the unit tests now run with it.

## 0.0.2
- New VIS widget **Energy history**: bar chart switchable between day, month and year, with
  cooling and heating shown separately.
- Consumption now also covers the current and previous month, and keeps three series ready for
  charting: `stundenJson` (48 hours), `tageJson` (62 days) and `monateJson` (24 months).

## 0.0.1
- Initial version: own MQTT broker, dynamically created data points, writable controls.
