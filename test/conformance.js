// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation

'use strict';

// Dynamic conformance harness. Walks codecs/<vendor>/<device>/ at load and
// emits a describe() per device, so adding a folder is automatically tested
// with no registration file. See lorawan-codec-normalization-plan.md, the
// "Conformance test suite" section, for the per-device and suite-level rules.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const lib = require('../dist/index.js');
const { lintCodec } = require('../dist/lint.js');
const {
  definesFunction,
  runDecodeUplink,
  runEncodeDownlink,
  runDecodeDownlink,
} = require('./codec-runner.js');
const { validate, styleNotes, resolveVocabularyPath } = require('../dist/validate.js');
const { categories, vocabularySchema } = require('../dist/categories.js');

const _ajv = require('ajv/dist/2020');
const Ajv2020 = _ajv.default || _ajv;
const _af = require('ajv-formats');
const addFormats = _af.default || _af;

const CODECS_DIR = path.join(__dirname, '..', 'codecs');
const KNOWN_CATEGORIES = new Set(categories().map((c) => c.id));

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Enumerate every codecs/<vendor>/<device>/ folder containing device.json. */
function listDevices() {
  const out = [];
  if (!isDir(CODECS_DIR)) return out;
  for (const vendor of fs.readdirSync(CODECS_DIR).sort()) {
    const vdir = path.join(CODECS_DIR, vendor);
    if (!isDir(vdir)) continue;
    for (const device of fs.readdirSync(vdir).sort()) {
      const dir = path.join(vdir, device);
      if (isDir(dir) && fs.existsSync(path.join(dir, 'device.json'))) {
        out.push({ vendor, device, dir });
      }
    }
  }
  return out;
}

function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** All dotted paths (intermediate + leaf) in a measurement, excluding history. */
function collectPaths(obj, prefix, acc) {
  for (const key of Object.keys(obj)) {
    if (key === 'history' && prefix === '') continue;
    const p = prefix ? `${prefix}.${key}` : key;
    acc.add(p);
    if (isPlainObject(obj[key])) collectPaths(obj[key], p, acc);
  }
}

/**
 * Register a test that is skipped (not failed) for draft devices, which are
 * scaffolded but not yet authored. This keeps `npm test` green while the
 * backlog is tracked; the suite-level summary reports the draft count.
 */
function itUnlessDraft(name, isDraft, fn) {
  if (isDraft) it(name, { skip: 'draft — codec not yet authored' }, fn);
  else it(name, fn);
}

const DEVICES = listDevices();

for (const { vendor, device, dir } of DEVICES) {
  describe(`${vendor}/${device}`, () => {
    const codecPath = path.join(dir, 'codec.js');
    const vectorsPath = path.join(dir, 'vectors.json');

    let meta = null;
    let metaError = null;
    try {
      meta = JSON.parse(fs.readFileSync(path.join(dir, 'device.json'), 'utf8'));
    } catch (e) {
      metaError = e;
    }

    const source = fs.existsSync(codecPath)
      ? fs.readFileSync(codecPath, 'utf8')
      : null;

    let vectors = { uplink: [], downlink: [] };
    let vectorsError = null;
    try {
      if (fs.existsSync(vectorsPath)) {
        const parsed = JSON.parse(fs.readFileSync(vectorsPath, 'utf8'));
        vectors = { uplink: parsed.uplink || [], downlink: parsed.downlink || [] };
      }
    } catch (e) {
      vectorsError = e;
    }

    const isDraft = !!(meta && meta.draft);

    // 1. device.json parses; fields match folder; categories exist; provenance.
    it('device.json parses and is consistent', () => {
      assert.equal(metaError, null, `device.json did not parse: ${metaError}`);
      assert.equal(meta.vendor, vendor, 'device.json vendor must match folder');
      assert.equal(meta.device, device, 'device.json device must match folder');
      assert.ok(
        Array.isArray(meta.categories) && meta.categories.length > 0,
        'at least one category required',
      );
      for (const c of meta.categories) {
        assert.ok(KNOWN_CATEGORIES.has(c), `declared category "${c}" does not exist`);
      }
      assert.ok(meta.downlink && typeof meta.downlink === 'object', 'downlink block required');
      if (meta.ttn !== null && meta.ttn !== undefined) {
        for (const f of ['vendor', 'device', 'codecId', 'codecFile', 'codecSha256', 'referencedAt']) {
          assert.ok(meta.ttn[f], `ttn.${f} missing (provenance must be complete)`);
        }
        assert.match(meta.ttn.codecSha256, /^[0-9a-f]{64}$/, 'codecSha256 must be a sha256');
      }
    });

    // 2. Static lint (bans + SPDX header).
    it('codec.js passes the static lint', () => {
      assert.ok(source !== null, 'codec.js is missing');
      const violations = lintCodec(source);
      assert.deepEqual(violations, [], `lint violations: ${violations.join('; ')}`);
    });

    // 3. Compiles; decodeUplink present; downlink functions iff declared.
    it('codec.js compiles with honest function metadata', () => {
      assert.ok(source !== null, 'codec.js is missing');
      assert.ok(definesFunction(source, 'decodeUplink'), 'decodeUplink must be defined');
      const declaredEncode = !!(meta && meta.downlink && meta.downlink.encode);
      const declaredDecode = !!(meta && meta.downlink && meta.downlink.decode);
      assert.equal(
        definesFunction(source, 'encodeDownlink'),
        declaredEncode,
        'encodeDownlink presence must match downlink.encode',
      );
      assert.equal(
        definesFunction(source, 'decodeDownlink'),
        declaredDecode,
        'decodeDownlink presence must match downlink.decode',
      );
    });

    // 4. At least one data vector.
    itUnlessDraft('has at least one data uplink vector', isDraft, () => {
      assert.equal(vectorsError, null, `vectors.json did not parse: ${vectorsError}`);
      const dataVectors = vectors.uplink.filter((v) => v.expected && v.expected.data);
      assert.ok(dataVectors.length > 0, 'need >=1 uplink vector with expected.data');
    });

    // 5 + 6 + 8. Per-vector decode, validation, and style diagnostics.
    itUnlessDraft('every uplink vector decodes and validates', isDraft, (t) => {
      assert.ok(source !== null && meta, 'codec.js / device.json required');
      for (const vec of vectors.uplink) {
        const label = vec.description || JSON.stringify(vec.input);
        const r = runDecodeUplink(source, vec.input);

        if (vec.expected && vec.expected.errors) {
          assert.ok(
            r.errors && r.errors.length > 0,
            `vector "${label}" expected errors but got none`,
          );
          for (const sub of vec.expected.errors) {
            assert.ok(
              r.errors.some((e) => e.includes(sub)),
              `vector "${label}" missing error substring "${sub}" (got ${JSON.stringify(r.errors)})`,
            );
          }
          continue;
        }

        // Data vector.
        assert.ok(
          !r.errors || r.errors.length === 0,
          `vector "${label}" decoded with errors: ${JSON.stringify(r.errors)}`,
        );
        assert.deepStrictEqual(
          r.data,
          vec.expected.data,
          `vector "${label}" data mismatch`,
        );

        // warnings only if declared
        const expW = vec.expected.warnings || [];
        const gotW = r.warnings || [];
        if (expW.length > 0) {
          for (const sub of expW) {
            assert.ok(gotW.some((w) => w.includes(sub)), `vector "${label}" missing warning "${sub}"`);
          }
        } else {
          assert.equal(gotW.length, 0, `vector "${label}" emitted undeclared warnings`);
        }

        // 6. validate for every declared category
        for (const cat of meta.categories) {
          const vr = validate(cat, r.data);
          assert.ok(
            vr.valid,
            `vector "${label}" failed validation for ${cat}: ${JSON.stringify(vr.issues)}`,
          );
        }

        // 8. style diagnostics (non-failing)
        for (const note of styleNotes(r.data)) {
          t.diagnostic(`style: ${note.path} — ${note.message}`);
        }
      }
    });

    // 7. Union of data-vector paths covers each category's requires.
    itUnlessDraft('data vectors cover each declared category requires set', isDraft, () => {
      assert.ok(meta, 'device.json required');
      const union = new Set();
      for (const vec of vectors.uplink) {
        if (!(vec.expected && vec.expected.data)) continue;
        const r = runDecodeUplink(source, vec.input);
        collectPaths(r.data, '', union);
        if (Array.isArray(r.data.history)) {
          for (const h of r.data.history) {
            if (isPlainObject(h)) collectPaths(h, '', union);
          }
        }
      }
      for (const cat of meta.categories) {
        const info = categories().find((c) => c.id === cat);
        for (const req of info.requires) {
          assert.ok(
            union.has(req),
            `category ${cat} requires "${req}" but no data vector produces it`,
          );
        }
      }
    });

    // 9. Downlink vectors (when present).
    it('downlink vectors encode and round-trip', () => {
      if (!vectors.downlink || vectors.downlink.length === 0) return;
      const canDecode = source && definesFunction(source, 'decodeDownlink');
      for (const dvec of vectors.downlink) {
        const enc = runEncodeDownlink(source, dvec.input);
        assert.deepEqual(
          { bytes: enc.bytes, fPort: enc.fPort },
          { bytes: dvec.expected.bytes, fPort: dvec.expected.fPort },
          `downlink "${dvec.description || ''}" encode mismatch`,
        );
        if (canDecode && dvec.roundTrip !== false) {
          const decoded = runDecodeDownlink(source, { bytes: enc.bytes, fPort: enc.fPort });
          const got = decoded && decoded.data !== undefined ? decoded.data : decoded;
          assert.deepEqual(got, dvec.input, 'decode(encode(x)) round-trip mismatch');
        }
      }
    });
  });
}

describe('suite-level', () => {
  it('vocabulary.schema.json compiles under ajv 2020-12', () => {
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    addFormats(ajv);
    assert.doesNotThrow(() => ajv.compile(vocabularySchema()));
  });

  it('every manifest requires/provides path resolves to a vocabulary property', () => {
    for (const c of categories()) {
      for (const p of [...c.requires, ...c.provides]) {
        assert.ok(resolveVocabularyPath(p), `category ${c.id}: path "${p}" does not resolve`);
      }
    }
  });

  it('no case-insensitive device folder collisions', () => {
    const seen = new Map();
    for (const { vendor, device } of DEVICES) {
      const k = `${vendor}/${device}`.toLowerCase();
      assert.ok(!seen.has(k), `folder collision: ${k} vs ${seen.get(k)}`);
      seen.set(k, `${vendor}/${device}`);
    }
  });

  it('category coverage (partial coverage is allowed in 0.1.0)', (t) => {
    const members = new Map();
    for (const c of categories()) members.set(c.id, 0);
    let drafts = 0;
    for (const { vendor, device } of DEVICES) {
      const info = lib.device(vendor, device);
      if (info.draft) {
        drafts += 1;
        continue; // drafts are not counted as members until authored
      }
      for (const c of info.categories) members.set(c, (members.get(c) || 0) + 1);
    }
    if (drafts > 0) {
      t.diagnostic(`${drafts} draft device(s) scaffolded but not yet authored (vector checks skipped)`);
    }
    const empty = [...members.entries()].filter(([, n]) => n === 0).map(([id]) => id);
    if (empty.length > 0) {
      t.diagnostic(`categories with no authored member device yet: ${empty.join(', ')}`);
    }
    const populated = [...members.entries()].filter(([, n]) => n > 0);
    assert.ok(populated.length > 0, 'at least one category must have a member device');
  });
});
