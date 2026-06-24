# @intelligent-farming/lorawan-codec-normalization

Curated, standalone **normalized** LoRaWAN payload codecs for agriculture
sensors, grouped by device category. Every codec in a category emits the same
shared keys (drawn from a fixed vocabulary), so two devices of the same type
from different vendors produce interchangeable data.

This module **provides codec JavaScript** to install into a ChirpStack device
profile (or a TTN payload formatter); the network server runs the codec, so its
output is decoded and normalized automatically. The module does **not** decode
payloads itself. Each codec is a self-contained, console-paste-able `codec.js`
whose `decodeUplink(input)` returns normalized data directly. The codecs are
original works; upstream [TheThingsNetwork/lorawan-devices][ttn] codecs are used
only as reference for each device's wire format (see [NOTICE](NOTICE) and
[AUTHORING.md](AUTHORING.md)).

[ttn]: https://github.com/TheThingsNetwork/lorawan-devices

## Install

```sh
npm install @intelligent-farming/lorawan-codec-normalization
```

Requires Node.js >= 18. The package has runtime dependencies `ajv`,
`ajv-formats`, and `yaml`. The sync features (see below) additionally need the
optional peer `@intelligent-farming/ttn-to-chirpstack`.

## Get a codec for a device

`codecScript` returns the exact, dependency-free `codec.js` text to install in a
ChirpStack device profile (or paste into a TTN payload-formatter console):

```js
const { codecScript, device } = require('@intelligent-farming/lorawan-codec-normalization');

const js = codecScript('milesight-iot', 'em500-smtc'); // the ChirpStack codec text
device('milesight-iot', 'em500-smtc');                 // metadata: categories, sensors, ttn provenance, ...
```

The codec output is a **single measurement object** (never a top-level array —
ChirpStack's protobuf Struct rejects arrays). Datalog uplinks put the current
reading at the top level and prior readings in a `history` array. The codecs are
plain ES2017-max JavaScript with no modules, Node APIs, or async constructs
(enforced by the conformance suite's static lint), so they run unmodified on
either network server.

### Intended consumption pattern

A provisioner (e.g. Leftenant) resolves a device's codec in priority order:

1. **This module** — `codecScript(vendor, device)` for a curated normalized codec.
2. **`@intelligent-farming/ttn-to-chirpstack`** — fall back to the upstream TTN
   codec when no normalized codec exists here.
3. **Manual entry** — fall back to a user-supplied codec when the device is not
   in TTN either. `lintCodec(source)` vets that text for console-safety before
   it is installed.

The registry supports a `draft` flag for scaffolded-but-unauthored devices, but
the published package ships **none** — every codec here is authored and verified
by its conformance vectors, which run the codec in a sandbox and validate the
output against the vocabulary. Expected outputs are derived from the device's
upstream TTN decoder used as an oracle: real TTN example payloads where the
upstream provides them, otherwise synthetic in-bounds inputs. If a draft is ever
present, `devices()` hides it by default (`devices({ includeDrafts: true })`
lists them), `codecScript` **throws** for it so the fallback proceeds to step 2,
and `device(v, d).draft` detects it.

## Lint a codec

`lintCodec` is static analysis (no execution). It returns an array of violations
(empty = clean): a missing SPDX header, Node APIs, async constructs, or
post-ES2017 syntax that would not run in a network-server console.

```js
const { lintCodec } = require('@intelligent-farming/lorawan-codec-normalization');
lintCodec(userSuppliedCodecText); // [] when safe to install
```

## Validate normalized data

Use this to check that a codec's output (e.g. what ChirpStack produced) conforms
to the vocabulary:

```js
const { validate } = require('@intelligent-farming/lorawan-codec-normalization');

const reading = { soil: { moisture: 19.57, temperature: 24.59, ec: 28.2 }, battery: 3.625 };
validate('soil-monitor', reading);                       // { valid: true, issues: [] }
validate('soil-monitor', reading, { requireAll: true }); // require every `requires` path
```

Value bounds come from `definitions/vocabulary.schema.json`. Device-specific
extras are allowed but must be camelCase and must not case-insensitively collide
with a vocabulary key. Issues are rated `schema`, `case-collision`,
`reserved-key`, or `history-time`. `requireAll` defaults to `false`, which keeps
fPort-variant, config, and partial uplinks legal.

## Categories

`categories()` lists all 13; `categorySchema(id)` returns the JSON Schema for a
category. Coverage grows over time — devices are added incrementally. Use
`devices({ category })` for the live member list; the counts below are a snapshot.

Membership is either `requires` (every listed path present) or `atLeastOne` (≥1
of the listed paths present).

| Category | membership | Authored members |
|---|---|---|
| `soil-monitor` | `atLeastOne`: `soil.moisture` / `soil.temperature` / `soil.ec` / `soil.pH` / … | 19 |
| `climate` | `air.temperature`, `air.relativeHumidity` | 265 |
| `air-quality` | `air.co2` | 84 |
| `light` | `air.lightIntensity` | 72 |
| `weather-station` | `air.temperature`, `air.pressure` | 72 |
| `wind` | `wind.speed` | 12 |
| `rain-gauge` | `rain.cumulative` | 10 |
| `water-meter` | `metering.water.total` | 7 |
| `motion` | `action.motion` | 83 |
| `contact` | `action.contactState` | 22 |
| `gps-tracker` | `position.latitude`, `position.longitude` | 46 |
| `water-leak` | `water.leak` | 36 |
| `groundwater` | `atLeastOne`: `water.level` / `water.pressure` | 7 |

`devices()` / `devices({ category })` enumerate registered devices;
`device(vendor, device)` returns one device's metadata. Each device's metadata
includes a `provides` array — the dotted output paths its codec emits
(vocabulary keys plus device-specific camelCase extras).

`devicesProviding(value)` finds devices by what they output, matching whole
dotted segments case-insensitively:

```js
const { devicesProviding } = require('@intelligent-farming/lorawan-codec-normalization');

devicesProviding('temperature'); // anything providing air./soil./water. temperature
devicesProviding('air.temperature'); // narrower: only that exact path
devicesProviding('co2', { category: 'air-quality' }); // honours the devices() filters
```

A bare segment (`'temperature'`) matches that value at any depth; a dotted query
(`'air.temperature'`) matches only that exact run. Segments match whole, not as
substrings — `'battery'` does not match the `batteryPercent` extra.

## Units and conventions

Normalized values use the vocabulary's units (e.g. `soil.ec` in dS/m,
`air.pressure` in hPa). Water-column quantities are deliberately distinct from
their air/soil counterparts: `water.pressure` is hydrostatic (kPa, vs the
atmospheric `air.pressure` in hPa), `water.ec` is in µS/cm (vs `soil.ec` in
dS/m), and `water.level` is in m. Note that the vocabulary's `battery` is
**voltage (V)**;
devices that report battery as a percentage (e.g. all Milesight sensors) emit
the camelCase extra `batteryPercent` instead. See [AUTHORING.md](AUTHORING.md)
for the full conversion table.

## Firmware variants

Firmware revisions with different wire formats live in separate folders linked
by `variantOf` (e.g. `dragino/lse01-114` has `variantOf: "dragino/lse01"`),
mirroring TTN's own codec split. **Selecting the right variant for a given unit
is the caller's responsibility** — match it to the device's reported firmware
version.

## Sync with the TTN device repository (optional)

These functions detect TTN devices not yet covered here and drift in the
upstream reference codecs. They require the optional peer
`@intelligent-farming/ttn-to-chirpstack` (its postinstall downloads the TTN
vendor tree, which is why it is not a hard dependency):

```sh
npm install @intelligent-farming/ttn-to-chirpstack
```

```js
const lcn = require('@intelligent-farming/lorawan-codec-normalization');

await lcn.updateDeviceList();          // refresh the local TTN device cache
lcn.findMissingDevices({ category: 'soil-monitor' });
                                       // TTN soil devices not yet in this module
await lcn.checkForNewDevices();        // updateDeviceList() + findMissingDevices()
lcn.findUpstreamChanges();             // sha256 drift of referenced upstream codecs
```

Without the peer, these throw a clear error. Alternatively, point
`TTN_DEVICES_DIR` at a local `lorawan-devices/vendor` directory. The codec-text,
validation, and lint APIs above never touch the peer.

## Contributing a codec

See [AUTHORING.md](AUTHORING.md) for the codec contract, then scaffold a folder:

```sh
npm run scaffold -- <vendor> <device> <category[,category]> [--ttn <v>/<d> | --no-ttn]
npm test   # the conformance suite tests every codecs/<vendor>/<device>/ automatically
```

Each device.json's `provides` array is generated, not hand-edited: the scaffold
seeds it, and `npm run build` (which `npm test` runs first) recomputes it from
each codec's output over its vectors. After changing a codec or its vectors,
`npm run build` keeps `provides` in sync; `npm run provides` regenerates it on
demand, and `npm run provides:check` verifies it is current (non-zero exit on
drift — suitable for CI).

## License

GNU AGPL-3.0-or-later. See [LICENSE](LICENSE). TTN-derived material (vector
inputs, reference snapshots) is Apache-2.0; see [NOTICE](NOTICE).
