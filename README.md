![Logo](admin/faikout.png)

# ioBroker.faikout

Connect Daikin air conditioners equipped with a [faikout](https://codeberg.org/RevK/ESP32-Faikout)
module to ioBroker — purely over MQTT, entirely local, no cloud and no vendor API.

The adapter brings **its own MQTT broker**. You point the faikout modules at it and that is all;
no separate broker, no `mqtt` adapter instance, and no interference with any MQTT setup you
already run.

## Why a dedicated adapter

A faikout module also emulates the old local Daikin HTTP API, so it can be used with the
`daikin` adapter. Over MQTT, however, it exposes considerably more — in particular values the
HTTP API does not provide at all:

| Value | HTTP (`daikin` adapter) | MQTT (this adapter) |
|---|---|---|
| Indoor humidity | not reported | yes |
| Energy counters (total / heating / cooling) | not reported | yes |
| Current power draw | not reported | yes |
| Compressor speed | reported as 0 | yes |
| Fan speed | not reported | yes |
| Refrigerant temperature | not reported | yes |
| Demand limit, louvre angle, presets | not reported | yes |
| WiFi and device diagnostics | version only | yes |

## Data points are created dynamically

A faikout module only publishes a field when the attached air conditioner actually supports it,
and its own settings can hide further ones. There is therefore **no fixed list of fields**: the
adapter creates exactly the data points it receives and silently omits the rest. Two units of
different models will legitimately end up with different object trees.

Fields the adapter does not know yet are still created, with a type derived from the value, and
noted in the log.

Objects are grouped per device:

- `<device>.control.*` — writable: power, mode, target temperature, fan, swing, preset, demand,
  econo, powerful, comfort, streamer, sensor, LED, quiet, humidify
- `<device>.status.*` — readings: temperatures, humidity, energy, power, compressor and fan speed
- `<device>.info.*` — device diagnostics: IP, WiFi signal, uptime, firmware

## Setup

1. Install the adapter and open the instance configuration.
2. Choose the broker port (default `1888`). It must not collide with another MQTT broker.
   Optionally set a user name and password; leaving the user name empty accepts unauthenticated
   connections, which is the usual case inside a home network.
3. Open the web interface of each faikout module, go to **Settings → Basic** and set
   **MQTT host** to `<ioBroker IP>:<port>`. The module reconnects on its own.

### Running ioBroker in Docker

The broker port has to be published by the container, otherwise the modules cannot reach it.
Add a port mapping for the configured port.

### Faster feedback

Out of the box a module reports its state every 60 seconds (`reporting` setting), so a command
is only confirmed with the next report — expect up to a minute. Enabling `livestatus` in the
module's **Extra** settings makes it report immediately.

## Changelog

<!--
	Placeholder for the next version (at the beginning of the line):
	### **WORK IN PROGRESS**
-->

### 0.0.8
- Object structure fixed for the repository check: all datapoint names now in eleven languages
  (`lib/namen.js`), invalid roles corrected (`info` → `info.name`/`info.address`/`text`,
  `level.mode.*` → `state`), instance objects translated as well. New test `test/namen.js`.
- Shared `@iobroker/eslint-config` and `@alcalzone/release-script` adopted, older changelog
  entries moved to `CHANGELOG_OLD.md`, `.vscode/settings.json` added, contact address in the
  copyright line.

### 0.0.7
- Maintenance release: `@iobroker/adapter-core` 3.4.3 and `@iobroker/testing` 6.2.1, tests also on
  Node.js 26, `testing-action-check` v2, admin translations in the short format
  (`admin/i18n/<lang>.json`), `tsconfig.json` and JSON schemas for VS Code.
- Published through GitHub Actions with provenance (0.0.6 had been published manually).

### 0.0.6
- Released through GitHub Actions with npm provenance (trusted publishing). No functional
  changes; 0.0.5 was published manually and therefore carries no provenance attestation.

### 0.0.5
- Meet the ioBroker repository requirements: updated dev dependencies, removed the deprecated
  `common.main`, fixed responsive column widths, and translated the admin texts into the nine
  remaining languages.

[Older changelog entries can be found here](CHANGELOG_OLD.md)

## Trademark and relationship to the hardware project

*Faikout* is a registered trademark of Andrews & Arnold Ltd. This adapter is an independent
piece of software and is neither affiliated with nor endorsed by Andrews & Arnold Ltd or the
authors of [ESP32-Faikout](https://codeberg.org/RevK/ESP32-Faikout). The name is used solely to
state which hardware the adapter talks to.

No source code from the hardware project is included. The adapter was written from scratch
against the MQTT interface; field names and value lists necessarily match, because that is what
the protocol prescribes. The hardware project is licensed under the GPL, this adapter under MIT
— they are separate works that communicate over a network protocol.

## License

MIT License

Copyright (c) 2026 Immanuel <github@freitag.online>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
