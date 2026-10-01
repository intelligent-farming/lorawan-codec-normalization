// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation

/**
 * Write dist/device-index.json: one entry per authored (non-draft) device, with
 * the metadata a browser needs to search the registry without `fs`.
 *
 * The registry API (`devices()`) reads codecs/ off disk, which a browser bundle
 * cannot do. Consumers such as Leftenant import this file instead:
 *
 *   import index from '@intelligent-farming/lorawan-codec-normalization/dist/device-index.json';
 *
 * Runs after `tsc` in `npm run build`, reusing the compiled `devices()` so the
 * draft filter and sort order match the Node API exactly. Codec source is not
 * included — it stays in codecs/<vendor>/<device>/codec.js.
 */
const fs = require('node:fs');
const path = require('node:path');

const { devices } = require('../dist/index.js');

const OUT = path.join(__dirname, '..', 'dist', 'device-index.json');

const entries = devices().map((d) => ({
  vendor: d.vendor,
  device: d.device,
  name: d.name,
  categories: d.categories,
  sensors: d.sensors,
  provides: d.provides ?? [],
  variantOf: d.variantOf ?? null,
  ttn: d.ttn ? { vendor: d.ttn.vendor, device: d.ttn.device } : null,
}));

fs.writeFileSync(OUT, JSON.stringify(entries));
console.log(`wrote ${path.relative(process.cwd(), OUT)} (${entries.length} devices)`);
