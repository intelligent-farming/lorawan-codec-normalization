# Authoring a normalized codec

This is the contract for adding a device under `codecs/<vendor>/<device>/`. It is
written for both human contributors and AI coding agents. Read it fully before
writing a `codec.js`. The conformance suite (`test/conformance.js`) enforces most
of this mechanically — `npm test` is the gate.

## What you are building

A **standalone, normalized** payload codec: one self-contained `codec.js` whose
`decodeUplink(input)` returns normalized measurement data directly, using the
shared vocabulary in `definitions/vocabulary.schema.json`. The point of the
module is that **every device in a category emits the same keys**, so two soil
probes from different vendors produce interchangeable data.

We **author** the normalization ourselves, per device. Upstream TheThingsNetwork
codecs are **reference only** — read them to understand the wire format, then
write your own decode. **Never** copy an upstream `normalizeUplink` /
`normalizedOutput` as the codec output; upstream normalization is frequently
buggy (see "Verify against the datasheet" below).

## Folder layout

```
codecs/<vendor>/<device>/
├── codec.js              # the product (ships in the npm tarball)
├── device.json           # metadata + TTN provenance
├── vectors.json          # test vectors
└── reference/            # upstream snapshot + examples — NOT shipped
    ├── upstream-codec.js
    └── upstream-examples.json
```

Scaffold a new folder with:

```
npm run scaffold -- <vendor> <device> <category[,category]> [--ttn <v>/<d> | --no-ttn] [--devices-dir <path>]
```

The scaffold copies the upstream decoder into `reference/`, records its sha256,
seeds `vectors.json` with the upstream example **inputs** (not outputs), and
writes a `codec.js` stub that returns `{ errors: ['not implemented'] }` so the
suite stays red until you author the codec.

## Output contract

- `decodeUplink(input)` returns **either** `{ data: <measurement> }` **or**
  `{ errors: [<string>, ...] }`. Never return a bare `{}`. Optionally include
  `warnings: [<string>, ...]` on success.
- `data` is a **single measurement object**, never a top-level array (ChirpStack's
  protobuf Struct rejects arrays — this is why we diverge from TTN's array
  `normalizeUplink`). Datalog/history uplinks put the current reading at the top
  level and prior readings in a `history` array; every history entry must carry a
  `time` (RFC3339).
- Devices reporting the **same quantity at multiple sub-sensor positions** (a
  multilayer soil probe's depths, a datalogger's ports) put one measurement
  object per position in the reserved `channels` array; every entry must carry
  a `channel` label. See "Multi-channel devices" below.
- Use only vocabulary keys (see the schema) with their correct units. Anything
  else is an **extra**: allowed, but it must be camelCase and must not
  case-insensitively collide with a vocabulary key (`Battery`, `soil.Moisture`,
  `soil.ph` all fail). Extras are for genuine device data the vocabulary does not
  model (status flags, raw counters, vendor diagnostics). One extra name is
  banned outright: a measurement-level key named `channel` (reserved as the
  `channels[]` entry label — see "Multi-channel devices" below).
- Every successful `data` object carries `make` and `model` device-identity
  strings equal to the `<vendor>` and `<device>` folder names (e.g.
  `{ make: "dragino", model: "lds02" }`). The scaffold seeds this via a thin
  wrapper around `decodeUplinkCore`; keep that wrapper and put your decoding in
  `decodeUplinkCore`. The conformance suite enforces both keys, and they are
  excluded from the generated `provides`. If a device reports its own hardware
  model string, name that extra `deviceModel` (not `model`) to avoid the clash.

### Multi-channel devices (`channels[]`)

When one uplink carries the same physical quantity at several sub-sensor
positions — a multilayer probe reporting `soil.moisture` at each depth, a
datalogger with instruments behind several ports — do **not** invent suffixed
extras (`moisture2`, `soilMoistureChannels: […]`); emit the reserved
`channels` array:

```json
{
  "battery": 3.6,
  "channels": [
    { "channel": "depth0", "soil": { "moisture": 5,   "temperature": 20 } },
    { "channel": "depth1", "soil": { "moisture": 5.5, "temperature": 21 } }
  ]
}
```

Rules — the first three are enforced by `validate()` and the conformance
suite, the rest are authoring conventions a reviewer checks:

- Each entry is a measurement object plus a required **`channel` label**: a
  non-empty string, unique within the array. Label with the most stable
  positional identifier the device gives you — the vendor's own term plus an
  index (`depth0`, `level3`, `port1`), or the physical position when the
  payload/datasheet fixes it (`15cm`). Never a bare number.
- Entries hold vocabulary keys and camelCase extras exactly like a top-level
  measurement, and may carry their own `time` (RFC3339). They are **leaf**
  measurements: no nested `history` or `channels` inside an entry.
- The label's *name* is reserved with it: a key called `channel` at the top
  level or in a `history` entry **fails validation** — downstream flatteners
  would read it as positional scoping they cannot honor. Scope the readings
  with a channels entry instead; if the value identifies something that is not
  a measured position (an alarm output, a config field), name the extra for
  what it identifies (`outputChannel`, …) or nest it inside its own extra
  group, where `channel` is an ordinary key.
- A value emitted inside an entry must **not** also appear at the top level —
  downstream stores keep top-level readings under the empty channel label and
  would double-count. Whole-device readings (`battery`, diagnostics) stay
  top-level.
- Omit the `channels` key when no positions are connected, and skip a position
  whose values read as disconnected/sentinel; document the sentinel policy in
  the codec header.
- Put `soil.depth` inside an entry only when the codec truly knows the physical
  depth — probes with configurable lengths report indices, not centimetres.
- `channels[]` is also legal inside a `history` entry (a datalogged profile
  scan). Category membership and the generated `provides` see through entries:
  a probe whose `soil.*` lives only in channels still satisfies `soil-monitor`,
  and `provides` lists the merged keys (never `channels` itself, never the
  `channel` labels). Membership (`validate(..., { requireAll: true })`) looks at
  the top level and **top-level** channel entries only — as with `history`, a
  reading that exists only inside a history entry does not satisfy a category,
  so always emit the current scan at the top level.

Any *other* array-valued extra is legal but opaque to downstream consumers (it
produces no per-metric readings) — prefer `channels[]` wherever the array is
really per-position measurements.

## Console-compatibility rules (statically linted)

`codec.js` must paste cleanly into the TTN and ChirpStack consoles. The lint
(`src/lint.ts` `lintCodec`) **bans**: `require(`, ES `import`/`export`,
`module.exports`, `exports.`, `process.`, `Buffer`, `globalThis`, `eval(`,
`new Function`, timers, `console.`, `fetch(`, `async`/`await`, `Promise`, and
post-ES2017 syntax: optional chaining `?.`, nullish `??`, spread/rest `...`,
`BigInt`/`123n`, private fields `#x`, static class blocks. Every file needs the
SPDX header.

Write ES5-style: `var`, function declarations, plain `if`/`for`, `Math`, `JSON`,
`Date`. The codec runs in a bare `node:vm` context (JS intrinsics only, no Node
globals) with a 1-second timeout, and its result is JSON-round-tripped — so emit
only JSON-serializable values (numbers, strings, booleans, arrays, plain
objects).

## Unit conversion table (normalize to vocabulary units)

| Source | Target | Conversion |
|---|---|---|
| Electrical conductivity µS/cm | `soil.ec` dS/m | ÷ 1000 |
| Pressure kPa | `air.pressure` hPa | × 10 |
| Wind speed knots | `wind.speed` m/s | × 0.514444 |
| Temperature °F | `*.temperature` °C | (°F − 32) × 5/9 |
| Battery mV | `battery` V | ÷ 1000 |
| Volume m³ | `metering.water.total` L | × 1000 |

Round to the sensor's real resolution with a helper
(`Math.round(value * 10^d) / 10^d`); the conformance suite asserts decoded values
**exactly**, so silent rounding drift is a real failure.

### Battery is volts, not percent

The vocabulary `battery` is **voltage (V)**. Many devices (e.g. all Milesight
sensors) report battery as a **percentage**. Do **not** push a percentage into
`battery` — emit it as the camelCase extra `batteryPercent`.

## Vectors (`vectors.json`)

```json
{
  "uplink": [
    { "description": "...", "input": { "fPort": 2, "bytes": [/* ints */] },
      "expected": { "data": { /* exact normalized measurement */ } },
      "source": "ttn-example" },
    { "description": "...", "input": { "fPort": 42, "bytes": [/* ints */] },
      "expected": { "errors": ["substring"] }, "source": "ttn-example" }
  ],
  "downlink": []
}
```

- Provide **≥1 data vector** (`expected.data`) and **≥1 error vector**
  (`expected.errors`). Data vectors are matched with `deepStrictEqual`; error
  vectors assert each expected string is a **substring** of some returned error.
- Across all data vectors, the union of produced key paths must satisfy **every**
  declared category's membership: cover **every** `requires` path, and (for a
  category defined with `atLeastOne`, e.g. `soil-monitor`) produce **at least one**
  of its `atLeastOne` paths.
- `bytes` are decimal integers (JSON has no hex). `source` ranks the vector's
  provenance, best first: `ttn-example` > `datasheet` > `captured` > `synthetic`.
  Use upstream example **inputs** freely; author the `expected.data` yourself.

## Verify against the datasheet — upstream is often wrong

Cross-check every value against the device datasheet, not just the upstream
codec. Verified upstream bugs already encountered in this repo:

- **`milesight-iot/em500-smtc`**: upstream advances its index by 2 on the 1-byte
  humidity channel, misaligning the stream and silently dropping the
  conductivity reading. Our codec advances by 1 and recovers `soil.ec`.
- **`dragino/lse01` / `lse01-114`**: upstream decodes negative soil temperature
  as `(value − 0xffff)`, off by one count (0.01 °C). Our codecs use the correct
  two's-complement `(value − 0x10000)`.
- **`browan/tbdw100`** (per the plan): a door sensor that upstream normalizes to
  `action.motion` instead of `action.contactState` — a copy-paste bug from
  `tbms100`. Author the correct key.

## Checklist

1. `npm run scaffold -- …` (or create the folder by hand).
2. Author `codec.js` (output contract + console rules + correct units).
3. Fill `device.json`: `categories`, `sensors`, `variantOf`, `downlink` (set
   `encode`/`decode` true **only** if you implement those functions — the suite
   checks both directions), and `ttn` provenance (or `ttn: null`). Do **not**
   hand-edit `provides` — it is generated from your codec's output by
   `npm run build` (`npm run provides` to regenerate on demand).
4. Write `vectors.json` covering all `requires` plus ≥1 error input.
5. `npm test` until green. The suite tests your folder automatically — there is
   no registration file.
