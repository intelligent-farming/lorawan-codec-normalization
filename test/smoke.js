// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const lib = require('../dist/index.js');
const { runDecodeUplink } = require('./codec-runner.js');

/** Run a device codec's decodeUplink and return its normalized data (test-only). */
function decodeData(vendor, device, input) {
  return runDecodeUplink(lib.codecScript(vendor, device), input).data;
}

/** Locate a TTN vendor tree for cache-gated sync tests, or null to skip. */
function findTtnBase() {
  if (process.env.TTN_DEVICES_DIR && fs.existsSync(process.env.TTN_DEVICES_DIR)) {
    return process.env.TTN_DEVICES_DIR;
  }
  const sibling = path.join(
    __dirname,
    '..',
    '..',
    'ttn-to-chirpstack',
    'lorawan-devices',
    'vendor',
  );
  return fs.existsSync(sibling) ? sibling : null;
}

test('module loads and exposes a version', () => {
  assert.equal(typeof lib.VERSION, 'string');
  assert.match(lib.VERSION, /^\d+\.\d+\.\d+/);
});

test('categories() returns the 12 defined categories', () => {
  const cats = lib.categories();
  assert.equal(cats.length, 12);
  const ids = cats.map((c) => c.id);
  assert.deepEqual([...ids].sort(), ids); // already sorted
  for (const id of [
    'soil-monitor',
    'climate',
    'air-quality',
    'light',
    'weather-station',
    'wind',
    'rain-gauge',
    'water-leak',
    'water-meter',
    'motion',
    'contact',
    'gps-tracker',
  ]) {
    assert.ok(ids.includes(id), `missing category ${id}`);
  }
  for (const c of cats) {
    assert.equal(typeof c.name, 'string');
    assert.ok(Array.isArray(c.requires));
    assert.ok(Array.isArray(c.provides));
  }
});

test('categorySchema() returns a 2020-12 schema with annotations', () => {
  const schema = lib.categorySchema('soil-monitor');
  assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
  assert.equal(schema.title, 'Soil monitor');
  assert.deepEqual(schema['x-requires'], ['soil.moisture', 'soil.temperature']);
  assert.throws(() => lib.categorySchema('nope'), /unknown category/);
});

test('validate() accepts a well-formed soil measurement with extras', () => {
  const r = lib.validate('soil-monitor', {
    battery: 3.6,
    soil: { moisture: 19.57, temperature: 24.59, ec: 28.2, vendorRaw: 1234 },
    air: { temperature: 24.1 },
  });
  assert.equal(r.valid, true, JSON.stringify(r.issues));
});

test('validate() rejects out-of-bounds values (rule: schema)', () => {
  const r = lib.validate('soil-monitor', { soil: { pH: 15 } });
  assert.equal(r.valid, false);
  assert.ok(r.issues.some((i) => i.rule === 'schema' && /pH/.test(i.path)));
});

test('validate() rejects case collisions (rule: case-collision)', () => {
  const r = lib.validate('soil-monitor', { soil: { Moisture: 10 } });
  assert.equal(r.valid, false);
  assert.ok(
    r.issues.some(
      (i) => i.rule === 'case-collision' && i.path === 'soil.Moisture',
    ),
  );
  // top-level too
  const r2 = lib.validate('soil-monitor', { Battery: 3.6 });
  assert.ok(r2.issues.some((i) => i.rule === 'case-collision'));
});

test('validate() rejects a group with a non-object value (rule: schema)', () => {
  const r = lib.validate('soil-monitor', { soil: 5 });
  assert.equal(r.valid, false);
  assert.ok(r.issues.some((i) => i.rule === 'schema'));
});

test('validate() honours requireAll', () => {
  const partial = { soil: { moisture: 10 } };
  assert.equal(lib.validate('soil-monitor', partial).valid, true);
  const strict = lib.validate('soil-monitor', partial, { requireAll: true });
  assert.equal(strict.valid, false);
  assert.ok(strict.issues.some((i) => /soil\.temperature/.test(i.path)));
  const full = { soil: { moisture: 10, temperature: 20 } };
  assert.equal(
    lib.validate('soil-monitor', full, { requireAll: true }).valid,
    true,
  );
});

test('validate() enforces history rules', () => {
  const ok = lib.validate('climate', {
    air: { temperature: 21, relativeHumidity: 50 },
    history: [
      { time: '2026-06-12T10:00:00Z', air: { temperature: 20 } },
    ],
  });
  assert.equal(ok.valid, true, JSON.stringify(ok.issues));

  const noTime = lib.validate('climate', {
    air: { temperature: 21 },
    history: [{ air: { temperature: 20 } }],
  });
  assert.ok(noTime.issues.some((i) => i.rule === 'history-time'));

  const notArray = lib.validate('climate', {
    air: { temperature: 21 },
    history: { time: '2026-06-12T10:00:00Z' },
  });
  assert.ok(notArray.issues.some((i) => i.rule === 'reserved-key'));

  // bounds + collisions are enforced inside history entries too
  const badEntry = lib.validate('climate', {
    air: { temperature: 21 },
    history: [{ time: '2026-06-12T10:00:00Z', soil: { pH: 99 } }],
  });
  assert.ok(badEntry.issues.some((i) => i.rule === 'schema'));
});

test('validate() accepts a TTN-style array of measurements', () => {
  const r = lib.validate('climate', [
    { air: { temperature: 21, relativeHumidity: 50 } },
    { air: { temperature: 22 } },
  ]);
  assert.equal(r.valid, true, JSON.stringify(r.issues));
});

test('validate() throws on an unknown category', () => {
  assert.throws(() => lib.validate('nope', {}), /unknown category/);
});

// --- registry + decode API ---

test('devices() and device() enumerate the registry', () => {
  const all = lib.devices();
  assert.ok(all.length >= 7);
  const soil = lib.devices({ category: 'soil-monitor' }).map((d) => `${d.vendor}/${d.device}`);
  assert.ok(soil.includes('dragino/lse01'));
  assert.ok(soil.includes('milesight-iot/em500-smtc'));
  assert.equal(lib.device('dragino', 'lse01').name, 'LSE01 - Soil Moisture & EC Sensor');
  assert.throws(() => lib.device('nope', 'nope'), /unknown device/);
});

test('device lookups are case-insensitive', () => {
  // codecScript, device, and friends accept any case for vendor/device.
  assert.equal(lib.codecScript('dragino', 'LSE01'), lib.codecScript('dragino', 'lse01'));
  assert.equal(lib.codecScript('DRAGINO', 'lse01'), lib.codecScript('dragino', 'lse01'));
  const info = lib.device('Dragino', 'Lse01');
  assert.equal(info.vendor, 'dragino'); // canonical case from device.json
  assert.equal(info.device, 'lse01');
  assert.equal(
    lib.codecScript('milesight-iot', 'EM500-SMTC'),
    lib.codecScript('milesight-iot', 'em500-smtc'),
  );
});

test('codecScript() returns the exact console-ready file text (the deliverable)', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const text = lib.codecScript('dragino', 'lse01');
  const onDisk = fs.readFileSync(
    path.join(__dirname, '..', 'codecs', 'dragino', 'lse01', 'codec.js'),
    'utf8',
  );
  assert.equal(text, onDisk);
  assert.ok(text.includes('function decodeUplink'));
});

test('lintCodec accepts shipped codecs and flags banned constructs', () => {
  assert.deepEqual(lib.lintCodec(lib.codecScript('dragino', 'lse01')), []);
  const bad = 'function decodeUplink(i){ console.log(1); return { data: i.bytes[0] ?? 0 }; }';
  const violations = lib.lintCodec(bad);
  assert.ok(violations.some((v) => /SPDX/.test(v)));
  assert.ok(violations.some((v) => /console/.test(v)));
});

// --- the module thesis: two brands, one category, compatible keys ---
// (uses the test-only codec runner to execute the JS this module ships)

test('cross-brand devices in a category emit the same normalized keys', () => {
  // soil-monitor: Dragino LSE01 vs Milesight EM500-SMTC
  const lse01 = decodeData('dragino', 'lse01', {
    fPort: 2,
    bytes: [0xce, 0x29, 0x00, 0xf1, 0x07, 0xa5, 0x09, 0x9b, 0x6e, 0x28, 0x90],
  });
  const em500 = decodeData('milesight-iot', 'em500-smtc', {
    fPort: 85,
    bytes: [1, 117, 92, 3, 103, 52, 1, 4, 104, 101, 5, 127, 240, 0],
  });
  for (const d of [lse01, em500]) {
    assert.equal(typeof d.soil.moisture, 'number');
    assert.equal(typeof d.soil.temperature, 'number');
    assert.equal(typeof d.soil.ec, 'number');
    assert.ok(lib.validate('soil-monitor', d, { requireAll: true }).valid);
  }

  // climate: Dragino LHT65 vs Milesight EM300-TH
  const lht65 = decodeData('dragino', 'lht65', {
    fPort: 2,
    bytes: [203, 246, 11, 13, 3, 118, 1, 10, 221, 127, 255],
  });
  const em300 = decodeData('milesight-iot', 'em300-th', {
    fPort: 1,
    bytes: [1, 117, 50, 3, 103, 200, 0, 4, 104, 60],
  });
  for (const d of [lht65, em300]) {
    assert.equal(typeof d.air.temperature, 'number');
    assert.equal(typeof d.air.relativeHumidity, 'number');
    assert.ok(lib.validate('climate', d, { requireAll: true }).valid);
  }
});

// --- sync (optional peer @intelligent-farming/ttn-to-chirpstack) ---

test('suggestCategories maps TTN sensors to categories', () => {
  assert.ok(lib.suggestCategories(['moisture', 'conductivity']).includes('soil-monitor'));
  assert.ok(lib.suggestCategories(['temperature', 'humidity']).includes('climate'));
  const aq = lib.suggestCategories(['co2', 'temperature', 'humidity']);
  assert.ok(aq.includes('air-quality') && aq.includes('climate'));
  const water = lib.suggestCategories(['water']);
  assert.ok(water.includes('water-leak') && water.includes('water-meter'));
  assert.deepEqual(lib.suggestCategories(['battery', 'rssi']), []);
});

test('sync functions throw a friendly error without the peer or a device tree', () => {
  const saved = process.env.TTN_DEVICES_DIR;
  delete process.env.TTN_DEVICES_DIR;
  try {
    // Skip if the peer happens to be installed with a populated cache.
    let peerCache = null;
    try {
      const peer = require('@intelligent-farming/ttn-to-chirpstack');
      if (typeof peer.cachePath === 'function' && fs.existsSync(peer.cachePath())) {
        peerCache = peer.cachePath();
      }
    } catch {
      /* peer absent — the expected case here */
    }
    if (peerCache) return;
    assert.throws(() => lib.updateDeviceList(), /optional peer/);
    assert.throws(() => lib.findMissingDevices(), /optional peer|TTN_DEVICES_DIR/);
    assert.throws(() => lib.findUpstreamChanges(), /optional peer|TTN_DEVICES_DIR/);
  } finally {
    if (saved !== undefined) process.env.TTN_DEVICES_DIR = saved;
  }
});

test('findUpstreamChanges reports no drift against the referenced tree (cache-gated)', (t) => {
  const base = findTtnBase();
  if (!base) {
    t.skip('no TTN device tree available');
    return;
  }
  const saved = process.env.TTN_DEVICES_DIR;
  process.env.TTN_DEVICES_DIR = base;
  try {
    const drift = lib.findUpstreamChanges();
    assert.ok(drift.length >= 7);
    for (const d of drift) {
      assert.equal(d.changed, false, `unexpected drift for ${d.vendor}/${d.device}`);
      assert.equal(d.currentSha256, d.storedSha256);
    }
  } finally {
    if (saved === undefined) delete process.env.TTN_DEVICES_DIR;
    else process.env.TTN_DEVICES_DIR = saved;
  }
});

test('findUpstreamChanges flags a doctored upstream codec (cache-gated)', (t) => {
  const base = findTtnBase();
  if (!base) {
    t.skip('no TTN device tree available');
    return;
  }
  // Build a temp tree where dragino/lse01.js differs from what was referenced.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lcn-drift-'));
  fs.mkdirSync(path.join(tmp, 'dragino'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'dragino', 'lse01.js'), '// tampered\n');
  const saved = process.env.TTN_DEVICES_DIR;
  process.env.TTN_DEVICES_DIR = tmp;
  try {
    const drift = lib.findUpstreamChanges();
    const lse01 = drift.find((d) => d.vendor === 'dragino' && d.device === 'lse01');
    assert.ok(lse01, 'lse01 should appear in drift report');
    assert.equal(lse01.changed, true);
    assert.notEqual(lse01.currentSha256, lse01.storedSha256);
    assert.match(lse01.currentSha256, /^[0-9a-f]{64}$/);
    // A device whose codec file is absent in the temp tree -> null + changed.
    const missing = drift.find((d) => d.vendor === 'milesight-iot');
    assert.equal(missing.currentSha256, null);
    assert.equal(missing.changed, true);
  } finally {
    if (saved === undefined) delete process.env.TTN_DEVICES_DIR;
    else process.env.TTN_DEVICES_DIR = saved;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('findMissingDevices excludes covered devices and suggests categories (cache-gated)', (t) => {
  const base = findTtnBase();
  if (!base) {
    t.skip('no TTN device tree available');
    return;
  }
  const saved = process.env.TTN_DEVICES_DIR;
  process.env.TTN_DEVICES_DIR = base;
  try {
    const missing = lib.findMissingDevices({ vendor: 'dragino' });
    assert.ok(missing.length > 0);
    const ids = missing.map((m) => `${m.vendor}/${m.device}`);
    for (const covered of ['dragino/lse01', 'dragino/lse01-114', 'dragino/lht65', 'dragino/lwl03a']) {
      assert.ok(!ids.includes(covered), `${covered} should not be reported as missing`);
    }
    for (const m of missing) {
      assert.equal(typeof m.name, 'string');
      assert.ok(Array.isArray(m.suggestedCategories));
      assert.equal(typeof m.hasCodec, 'boolean');
    }
  } finally {
    if (saved === undefined) delete process.env.TTN_DEVICES_DIR;
    else process.env.TTN_DEVICES_DIR = saved;
  }
});
