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
- Use only vocabulary keys (see the schema) with their correct units. Anything
  else is an **extra**: allowed, but it must be camelCase and must not
  case-insensitively collide with a vocabulary key (`Battery`, `soil.Moisture`,
  `soil.ph` all fail). Extras are for genuine device data the vocabulary does not
  model (status flags, raw counters, vendor diagnostics).

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
   checks both directions), and `ttn` provenance (or `ttn: null`).
4. Write `vectors.json` covering all `requires` plus ≥1 error input.
5. `npm test` until green. The suite tests your folder automatically — there is
   no registration file.
