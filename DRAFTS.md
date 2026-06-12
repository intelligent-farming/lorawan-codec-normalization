# Draft devices (not yet authored)

A **draft** is a scaffolded device (`device.json` has `"draft": true`) with a
reference snapshot, sha256 provenance, and seeded vectors, but a stub `codec.js`.
Drafts are hidden from `devices()` by default, `codecScript()` throws for them,
and the conformance suite skips their vector checks. See AUTHORING.md to promote
one: author `codec.js`, fill `expected.data` in `vectors.json`, drop the `draft`
flag, then `npm test`.

This file tracks the drafts that were **deliberately not authored** during the
`light`-category pass, with the reason for each. Everything else in the `light`
category that had verifiable example vectors and fit a vocabulary category has
been authored and verified.

## Why these remain drafts

The project's verification standard is: a codec's `expected.data` must be the
normalized form of an **upstream TTN example payload** (input bytes → known
decoded values), so the codec is checked against real ground truth. The drafts
below fail one of two preconditions.

### A. No vocabulary category fits (solar radiation / PAR only) — 3

These devices measure **solar radiation (W/m²)**, **PAR (µmol·m⁻²·s⁻¹)**, or
**UV** as their only environment quantity. The normalized vocabulary
(`definitions/vocabulary.schema.json`) has no key for those — its only light
key is `air.lightIntensity` in **lux** — so a normalized codec could only emit
them as camelCase extras, and the device would satisfy **no** category's
`requires`. The conformance suite requires every authored device to declare ≥1
satisfied category, so these are left as drafts until the vocabulary grows a
solar/PAR/UV concept (an upstream decision — see the vocabulary `$comment`).

- `decentlab/dl-par` — photosynthetically active radiation only
- `decentlab/dl-pyr` — pyranometer (solar irradiance W/m²) only
- `fencyboy/fencyboy` — solar radiation + pulse count + a single temperature (no humidity → no `climate`)

### B. No upstream example vectors to verify against — 44

These ship an upstream decoder but **no example payloads** in their codec YAML,
so there is no ground-truth (input bytes → expected values) to author and verify
`expected.data` against. Authoring them would require either captured real-world
payloads or running the upstream decoder as a synthetic oracle (a weaker basis
that can propagate upstream bugs). They are left as drafts pending real example
data.

- `enginko/` and `mcf88/` (same devices, two vendor IDs): `mcf-lw06davk`, `mcf-lw06davpk`, `mcf-lw12co2`, `mcf-lw12co2e`, `mcf-lw12voc`, `mcf-lwws00`, `mcf-lwws01`, `mcf-lwws02`, `mcf-lwws03`
- `lansitec/`: `badge-tracker`, `compact-bluetooth-gateway`, `contact-tracing-badge`, `socket-sync-bluetooth-gateway`, `tracking-label`
- `moko/`: `lw003-b`, `lw004`, `lw005-mp`
- `sezo/`: `sezoal`, `sezocl`, `sezoel`, `sezosl`
- `nexelec/`: `move`, `sign`
- `sensecap/`: `sensecaps2120-8-in-1`, `sensecapt1000-tracker-ab`
- singles: `ewattch/ambiance`, `greenme/cube`, `hbi/hbi-mla20-3l0606c`, `iothings/iotracker3`, `makerfabs/light-intensity`, `n-fuse/stx`, `rakwireless/wisblock-kit1`, `restotracker/scd18`, `the-things-products/the-things-node`, `thermokon/mcs-lrw`

## Next steps

- **Bucket B** can be authored once real example payloads are obtained (datasheet
  captures or live uplinks), or via an explicit decision to verify against the
  upstream decoder as an oracle.
- **Bucket A** needs a vocabulary addition (solar radiation / PAR / UV) before a
  category can be satisfied.
