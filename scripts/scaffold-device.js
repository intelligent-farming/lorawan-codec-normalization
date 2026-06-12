// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation

'use strict';

// Scaffold a new device folder under codecs/<vendor>/<device>/.
//
// Usage:
//   npm run scaffold -- <vendor> <device> <category[,category]> \
//       [--ttn <vendor>/<device> | --no-ttn] [--devices-dir <path>]
//
// With a TTN reference (default: --ttn <vendor>/<device>) the script reads the
// upstream device + codec YAML, snapshots the upstream decoder into reference/,
// records sha256/date provenance, and pre-seeds vectors.json with the upstream
// example inputs (NOT their normalized outputs — you author expected.data
// yourself). It always writes a codec.js stub that returns
// { errors: ['not implemented'] } so the conformance suite stays RED until the
// codec is authored.
//
// The TTN device tree is resolved from (in order): --devices-dir, the
// TTN_DEVICES_DIR env var, or the optional peer
// @intelligent-farming/ttn-to-chirpstack's cachePath().

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const YAML = require('yaml');

const REPO_ROOT = path.join(__dirname, '..');
const CODECS_DIR = path.join(REPO_ROOT, 'codecs');
const CATEGORIES_DIR = path.join(REPO_ROOT, 'definitions', 'categories');

function fail(message) {
  console.error(`scaffold: ${message}`);
  process.exit(1);
}

function knownCategories() {
  return fs
    .readdirSync(CATEGORIES_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.replace(/\.json$/, ''));
}

function parseArgs(argv) {
  const positional = [];
  const opts = { ttn: undefined, noTtn: false, devicesDir: undefined };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--no-ttn') opts.noTtn = true;
    else if (a === '--ttn') opts.ttn = argv[++i];
    else if (a === '--devices-dir') opts.devicesDir = argv[++i];
    else positional.push(a);
  }
  if (positional.length < 3) {
    fail(
      'usage: scaffold-device.js <vendor> <device> <category[,category]> [--ttn <v>/<d> | --no-ttn] [--devices-dir <path>]',
    );
  }
  return {
    vendor: positional[0],
    device: positional[1],
    categories: positional[2].split(',').map((s) => s.trim()).filter(Boolean),
    opts,
  };
}

function resolveDevicesDir(flagDir) {
  if (flagDir) return flagDir;
  if (process.env.TTN_DEVICES_DIR) return process.env.TTN_DEVICES_DIR;
  try {
    // eslint-disable-next-line global-require
    const peer = require('@intelligent-farming/ttn-to-chirpstack');
    if (typeof peer.cachePath === 'function') {
      const p = peer.cachePath();
      if (p && fs.existsSync(p)) return p;
    }
  } catch {
    /* peer not installed */
  }
  fail(
    'could not locate the TTN device tree. Pass --devices-dir <path-to-vendor-dir>, set TTN_DEVICES_DIR, or install @intelligent-farming/ttn-to-chirpstack and run its device update.',
  );
  return null;
}

function loadYaml(file) {
  return YAML.parse(fs.readFileSync(file, 'utf8'));
}

function firstCodecId(deviceDoc) {
  const fws = deviceDoc.firmwareVersions || [];
  for (const fw of fws) {
    const profiles = fw.profiles || {};
    for (const region of Object.keys(profiles)) {
      if (profiles[region] && profiles[region].codec) return profiles[region].codec;
    }
  }
  return null;
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function codecStub(vendor, device, ttnRef) {
  const derivation = ttnRef
    ? `//\n// Wire format to be understood with reference to the upstream Apache-2.0\n// decoder (TheThingsNetwork/lorawan-devices ${ttnRef}, attributed in NOTICE).\n// Author the normalization here; do NOT copy upstream normalizeUplink.`
    : '';
  return `// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for ${vendor}/${device}. STUB — not yet authored.
${derivation}

function decodeUplink(input) {
  return { errors: ['not implemented'] };
}
`;
}

function seedVectors(examples) {
  const uplink = [];
  for (const ex of examples) {
    const out = ex.output || {};
    if (out.errors) {
      uplink.push({
        description: ex.description || 'error example',
        input: ex.input,
        expected: { errors: out.errors },
        source: 'ttn-example',
      });
    } else {
      // Data example: author writes expected.data by running the codec and
      // verifying against the datasheet. The upstream values are kept only as a
      // hint, NOT as the assertion. Conformance stays red until expected.data
      // is filled in.
      uplink.push({
        description: ex.description || 'data example',
        input: ex.input,
        source: 'ttn-example',
        _todo: 'replace this with expected.data after authoring codec.js; verify against the datasheet',
        _upstreamHint: { output: out.data, normalizedOutput: (ex.normalizedOutput || {}).data },
      });
    }
  }
  return { uplink, downlink: [] };
}

function main() {
  const { vendor, device, categories, opts } = parseArgs(process.argv.slice(2));

  const valid = new Set(knownCategories());
  for (const c of categories) {
    if (!valid.has(c)) fail(`unknown category "${c}" (known: ${[...valid].join(', ')})`);
  }

  const targetDir = path.join(CODECS_DIR, vendor, device);
  if (fs.existsSync(targetDir)) fail(`refusing to overwrite existing folder ${targetDir}`);

  let deviceJson = {
    vendor,
    device,
    name: `${vendor}/${device}`,
    categories,
    sensors: [],
    variantOf: null,
    downlink: { encode: false, decode: false },
    ttn: null,
  };
  let vectors = {
    uplink: [],
    downlink: [],
    _todo: 'add >=1 data vector (expected.data) and >=1 error vector (expected.errors)',
  };
  let ttnRef = null;

  if (!opts.noTtn) {
    const ref = opts.ttn || `${vendor}/${device}`;
    const [tv, td] = ref.split('/');
    if (!tv || !td) fail(`--ttn must be <vendor>/<device>, got "${ref}"`);

    const devicesDir = resolveDevicesDir(opts.devicesDir);
    const deviceYamlPath = path.join(devicesDir, tv, `${td}.yaml`);
    if (!fs.existsSync(deviceYamlPath)) {
      fail(`upstream device yaml not found: ${deviceYamlPath}`);
    }
    const deviceDoc = loadYaml(deviceYamlPath);
    const codecId = firstCodecId(deviceDoc);
    if (!codecId) fail(`no codec reference found in ${deviceYamlPath}`);

    const codecYamlPath = path.join(devicesDir, tv, `${codecId}.yaml`);
    if (!fs.existsSync(codecYamlPath)) fail(`upstream codec yaml not found: ${codecYamlPath}`);
    const codecDoc = loadYaml(codecYamlPath);
    const decoder = codecDoc.uplinkDecoder || {};
    const fileName = decoder.fileName;
    if (!fileName) fail(`no uplinkDecoder.fileName in ${codecYamlPath}`);

    const upstreamCodecPath = path.join(devicesDir, tv, fileName);
    if (!fs.existsSync(upstreamCodecPath)) fail(`upstream codec not found: ${upstreamCodecPath}`);
    const upstreamCodec = fs.readFileSync(upstreamCodecPath);
    ttnRef = `vendor/${tv}/${fileName}`;

    fs.mkdirSync(path.join(targetDir, 'reference'), { recursive: true });
    fs.writeFileSync(path.join(targetDir, 'reference', 'upstream-codec.js'), upstreamCodec);
    fs.writeFileSync(
      path.join(targetDir, 'reference', 'upstream-examples.json'),
      `${JSON.stringify(
        {
          _note: `Snapshot from TheThingsNetwork/lorawan-devices vendor/${tv}/${codecId}.yaml (Apache-2.0). Authoring reference only; excluded from the npm tarball.`,
          examples: decoder.examples || [],
        },
        null,
        2,
      )}\n`,
    );

    deviceJson = {
      vendor,
      device,
      name: deviceDoc.name || `${vendor}/${device}`,
      categories,
      sensors: deviceDoc.sensors || [],
      variantOf: null,
      downlink: { encode: false, decode: false },
      ttn: {
        vendor: tv,
        device: td,
        codecId,
        codecFile: fileName,
        codecSha256: sha256(upstreamCodec),
        referencedAt: today(),
      },
    };
    vectors = seedVectors(decoder.examples || []);
  } else {
    fs.mkdirSync(targetDir, { recursive: true });
  }

  fs.writeFileSync(
    path.join(targetDir, 'device.json'),
    `${JSON.stringify(deviceJson, null, 2)}\n`,
  );
  fs.writeFileSync(
    path.join(targetDir, 'vectors.json'),
    `${JSON.stringify(vectors, null, 2)}\n`,
  );
  fs.writeFileSync(
    path.join(targetDir, 'codec.js'),
    codecStub(vendor, device, ttnRef),
  );

  console.log(`scaffolded ${vendor}/${device} -> ${path.relative(REPO_ROOT, targetDir)}`);
  console.log('next: author codec.js, fill expected.data in vectors.json, then `npm test`.');
}

main();
