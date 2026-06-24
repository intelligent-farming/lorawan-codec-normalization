// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation

/**
 * Compute and maintain the `provides` array in each codecs/<vendor>/<device>/device.json.
 *
 * `provides` is the sorted union of dotted output paths a codec emits across its
 * data vectors — vocabulary keys (e.g. `air.temperature`, `metering.water.total`)
 * plus device-specific camelCase extras (e.g. `lowBattery`). It is derived
 * deterministically by running the codec in a vm sandbox over its vectors; the
 * `history` container is excluded and its element keys merged into the top level
 * (they mirror the current reading).
 *
 * Used as a module (by the scaffold) and as a CLI (by the build):
 *   node scripts/compute-provides.js               # write provides for every device
 *   node scripts/compute-provides.js --check        # verify only; exit 1 on drift
 *   node scripts/compute-provides.js a/b c/d ...     # limit to specific devices
 */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const REPO_ROOT = path.join(__dirname, '..');
const CODECS_DIR = path.join(REPO_ROOT, 'codecs');

function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}
function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Add dotted leaf paths of `obj` under `prefix` to `acc` (recurse plain objects only). */
function leaves(obj, prefix, acc) {
  for (const key of Object.keys(obj)) {
    const p = prefix ? `${prefix}.${key}` : key;
    const val = obj[key];
    if (isPlainObject(val)) leaves(val, p, acc);
    else acc.add(p); // scalar or array -> leaf
  }
}

/** Collect emitted leaf paths from one decoded measurement object into `acc`. */
function collectFromData(data, acc) {
  for (const key of Object.keys(data)) {
    const val = data[key];
    if (key === 'history' && Array.isArray(val)) {
      for (const h of val) if (isPlainObject(h)) leaves(h, '', acc);
      continue;
    }
    if (isPlainObject(val)) leaves(val, key, acc);
    else acc.add(key);
  }
}

function runDecode(src, input) {
  const wrapped =
    `${src}\n;JSON.stringify((function(){var x=decodeUplink(${JSON.stringify(input)});return x===undefined?null:x;})())`;
  return JSON.parse(vm.runInNewContext(wrapped, Object.create(null), { timeout: 2000 }));
}

/**
 * Compute the `provides` array for a device folder by running its codec over its
 * data vectors. Returns a sorted string array, or null if the folder is missing
 * codec.js / vectors.json / device.json.
 */
function computeProvides(dir) {
  const codecPath = path.join(dir, 'codec.js');
  const vecPath = path.join(dir, 'vectors.json');
  if (!fs.existsSync(path.join(dir, 'device.json')) || !fs.existsSync(codecPath) || !fs.existsSync(vecPath)) {
    return null;
  }
  const src = fs.readFileSync(codecPath, 'utf8');
  const vectors = JSON.parse(fs.readFileSync(vecPath, 'utf8'));
  const acc = new Set();
  for (const vec of vectors.uplink || []) {
    if (!(vec.expected && vec.expected.data)) continue;
    let r;
    try { r = runDecode(src, vec.input); } catch { continue; }
    if (r && r.data && isPlainObject(r.data)) collectFromData(r.data, acc);
  }
  return [...acc].sort();
}

/** Rebuild a device.json object with `provides` placed right after `sensors`. */
function withProvides(meta, provides) {
  const out = {};
  let inserted = false;
  for (const k of Object.keys(meta)) {
    if (k === 'provides') continue;
    out[k] = meta[k];
    if (!inserted && (k === 'sensors' || (k === 'categories' && !('sensors' in meta)))) {
      out.provides = provides;
      inserted = true;
    }
  }
  if (!inserted) out.provides = provides;
  return out;
}

/**
 * Compute and write `provides` into a device folder's device.json.
 * Returns { changed, provides } (changed=false if the file already matched).
 */
function writeProvides(dir) {
  const provides = computeProvides(dir);
  if (provides === null) return { changed: false, provides: null };
  const djPath = path.join(dir, 'device.json');
  const meta = JSON.parse(fs.readFileSync(djPath, 'utf8'));
  const before = JSON.stringify(meta.provides);
  const rebuilt = withProvides(meta, provides);
  const next = `${JSON.stringify(rebuilt, null, 2)}\n`;
  const changed = next !== fs.readFileSync(djPath, 'utf8') || before !== JSON.stringify(provides);
  if (changed) fs.writeFileSync(djPath, next);
  return { changed, provides };
}

/** Every device folder under codecs/. */
function allDeviceDirs() {
  const out = [];
  if (!isDir(CODECS_DIR)) return out;
  for (const vendor of fs.readdirSync(CODECS_DIR).sort()) {
    const vdir = path.join(CODECS_DIR, vendor);
    if (!isDir(vdir)) continue;
    for (const device of fs.readdirSync(vdir).sort()) {
      const dir = path.join(vdir, device);
      if (isDir(dir) && fs.existsSync(path.join(dir, 'device.json'))) out.push(dir);
    }
  }
  return out;
}

function main(argv) {
  const check = argv.includes('--check');
  const targets = argv.filter((a) => !a.startsWith('--'));
  const dirs =
    targets.length > 0
      ? targets.map((t) => path.join(CODECS_DIR, t))
      : allDeviceDirs();

  const drifted = [];
  let written = 0;
  for (const dir of dirs) {
    const rel = path.relative(CODECS_DIR, dir);
    if (check) {
      const computed = computeProvides(dir);
      if (computed === null) continue;
      const meta = JSON.parse(fs.readFileSync(path.join(dir, 'device.json'), 'utf8'));
      if (JSON.stringify(meta.provides) !== JSON.stringify(computed)) drifted.push(rel);
    } else {
      const { changed, provides } = writeProvides(dir);
      if (provides === null) continue;
      if (changed) written++;
    }
  }

  if (check) {
    if (drifted.length > 0) {
      console.error(`provides out of date for ${drifted.length} device(s):`);
      for (const d of drifted) console.error(`  ${d}`);
      console.error('run `npm run provides` to regenerate.');
      process.exit(1);
    }
    console.log(`provides in sync (${dirs.length} devices).`);
  } else {
    console.log(`provides written (${written} updated of ${dirs.length} devices).`);
  }
}

module.exports = { computeProvides, writeProvides, allDeviceDirs };

if (require.main === module) main(process.argv.slice(2));
