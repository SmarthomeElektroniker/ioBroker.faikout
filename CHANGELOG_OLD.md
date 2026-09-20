# Older changes

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
