// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation

/**
 * Integration with the TTN device repository via the optional peer
 * `@intelligent-farming/ttn-to-chirpstack`.
 *
 * This is the ONLY module that touches the peer, and it does so lazily — the
 * registry/validation/lint layers never import it, so codec-only consumers
 * pay nothing. Functions that need the TTN device tree resolve it from (in
 * order) the `TTN_DEVICES_DIR` env var or the peer's `cachePath()`, and throw a
 * friendly error when neither is available.
 *
 * @packageDocumentation
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import * as YAML from 'yaml';
import { devices as registryDevices } from './registry';
import type { MissingDevice, UpstreamDrift } from './types';

const PEER = '@intelligent-farming/ttn-to-chirpstack';

interface Peer {
  updateDevices: () => Promise<string>;
  cachePath: () => string;
}

/** Lazily load the optional peer, with a friendly error when it is absent. */
function loadPeer(): Peer {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require(PEER) as Peer;
  } catch {
    throw new Error(
      `sync features require the optional peer ${PEER}. Install it ` +
        `(npm install ${PEER}) and run updateDeviceList() to populate the device cache.`,
    );
  }
}

/**
 * Resolve the TTN `vendor/` directory: TTN_DEVICES_DIR, else the peer's
 * cachePath() if it exists. Throws a friendly error otherwise.
 */
function resolveDevicesDir(): string {
  const env = process.env.TTN_DEVICES_DIR;
  if (env && fs.existsSync(env)) return env;
  // Throws the friendly "install the peer" error when the peer is absent.
  const cache = loadPeer().cachePath();
  if (cache && fs.existsSync(cache)) return cache;
  throw new Error(
    `no TTN device cache found. Call updateDeviceList() first (requires the ` +
      `optional peer ${PEER}), or set TTN_DEVICES_DIR to a lorawan-devices vendor directory.`,
  );
}

function readYaml<T = Record<string, unknown>>(file: string): T | null {
  if (!fs.existsSync(file)) return null;
  return YAML.parse(fs.readFileSync(file, 'utf8')) as T;
}

/** Map a TTN `sensors` list to candidate category ids (see the plan). */
export function suggestCategories(sensors: string[]): string[] {
  const s = sensors.map((x) => String(x).toLowerCase());
  const has = (...keys: string[]): boolean => keys.some((k) => s.includes(k));
  const out = new Set<string>();

  if (has('moisture', 'soil moisture', 'conductivity', 'salinity', 'ph')) out.add('soil-monitor');
  if (s.includes('temperature') && s.includes('humidity')) out.add('climate');
  if (has('co2', 'co', 'tvoc', 'pm2.5', 'pm10', 'iaq', 'particulate matter')) out.add('air-quality');
  if (has('light', 'uv', 'solar radiation')) out.add('light');
  if (has('barometer', 'pressure')) out.add('weather-station');
  if (has('wind speed', 'wind direction')) {
    out.add('wind');
    out.add('weather-station');
  }
  if (has('rainfall', 'precipitation')) {
    out.add('rain-gauge');
    out.add('weather-station');
  }
  if (has('water')) {
    out.add('water-leak');
    out.add('water-meter');
  }
  if (has('motion', 'pir', 'occupancy', 'accelerometer', 'vibration')) out.add('motion');
  if (has('reed switch', 'hall effect', 'magnetometer')) out.add('contact');
  if (has('gps', 'altitude')) out.add('gps-tracker');

  return [...out];
}

/** The set of `ttn.vendor/ttn.device` provenance keys already covered here. */
function coveredTtnKeys(): Set<string> {
  const set = new Set<string>();
  for (const d of registryDevices()) {
    if (d.ttn) set.add(`${d.ttn.vendor}/${d.ttn.device}`);
  }
  return set;
}

/** First codec id referenced by a device document's firmware profiles. */
function firstCodecId(deviceDoc: Record<string, unknown> | null): string | null {
  const fws = (deviceDoc?.firmwareVersions as Array<Record<string, unknown>>) ?? [];
  for (const fw of fws) {
    const profiles = (fw.profiles as Record<string, { codec?: string }>) ?? {};
    for (const region of Object.keys(profiles)) {
      if (profiles[region]?.codec) return profiles[region].codec as string;
    }
  }
  return null;
}

interface UpstreamCodecMeta {
  hasCodec: boolean;
  hasNormalizedExamples: boolean;
  codecFile: string | null;
}

/** Inspect a device's upstream codec yaml for a decoder + normalized examples. */
function upstreamCodecMeta(
  base: string,
  vendor: string,
  deviceDoc: Record<string, unknown> | null,
): UpstreamCodecMeta {
  const codecId = firstCodecId(deviceDoc);
  if (!codecId) return { hasCodec: false, hasNormalizedExamples: false, codecFile: null };
  const codecDoc = readYaml<{ uplinkDecoder?: { fileName?: string; examples?: Array<Record<string, unknown>> } }>(
    path.join(base, vendor, `${codecId}.yaml`),
  );
  const decoder = codecDoc?.uplinkDecoder;
  if (!decoder?.fileName) return { hasCodec: false, hasNormalizedExamples: false, codecFile: null };
  const fileExists = fs.existsSync(path.join(base, vendor, decoder.fileName));
  const hasNormalized = (decoder.examples ?? []).some((ex) => 'normalizedOutput' in ex);
  return {
    hasCodec: fileExists,
    hasNormalizedExamples: hasNormalized,
    codecFile: decoder.fileName,
  };
}

/**
 * Download/refresh the TTN device repository via the peer. Returns the cache
 * path written. Requires the optional peer.
 */
export function updateDeviceList(): Promise<string> {
  return loadPeer().updateDevices();
}

/**
 * List TTN devices not yet covered by this module (joined on `ttn` provenance).
 *
 * @param opts.vendor - Restrict the scan to one upstream vendor.
 * @param opts.category - Keep only devices whose suggested categories include this.
 * @param opts.limit - Cap the number of results returned.
 */
export function findMissingDevices(opts?: {
  vendor?: string;
  category?: string;
  limit?: number;
}): MissingDevice[] {
  const base = resolveDevicesDir();
  const covered = coveredTtnKeys();
  const result: MissingDevice[] = [];

  const topIndex = readYaml<{ vendors?: Array<{ id: string; draft?: boolean }> }>(
    path.join(base, 'index.yaml'),
  );
  let vendorIds = (topIndex?.vendors ?? []).filter((v) => !v.draft).map((v) => v.id);
  if (opts?.vendor) vendorIds = vendorIds.filter((id) => id === opts.vendor);

  for (const vendor of vendorIds) {
    const vendorIndex = readYaml<{ endDevices?: string[] }>(
      path.join(base, vendor, 'index.yaml'),
    );
    for (const deviceId of vendorIndex?.endDevices ?? []) {
      if (covered.has(`${vendor}/${deviceId}`)) continue;
      const deviceDoc = readYaml<Record<string, unknown>>(
        path.join(base, vendor, `${deviceId}.yaml`),
      );
      const sensors = ((deviceDoc?.sensors as string[]) ?? []).map(String);
      const suggested = suggestCategories(sensors);
      if (opts?.category && !suggested.includes(opts.category)) continue;
      const meta = upstreamCodecMeta(base, vendor, deviceDoc);
      result.push({
        vendor,
        device: deviceId,
        name: (deviceDoc?.name as string) ?? `${vendor}/${deviceId}`,
        sensors,
        hasCodec: meta.hasCodec,
        hasNormalizedExamples: meta.hasNormalizedExamples,
        suggestedCategories: suggested,
      });
      if (opts?.limit && result.length >= opts.limit) return result;
    }
  }
  return result;
}

/** Convenience: refresh the device cache, then diff. Requires the peer. */
export async function checkForNewDevices(opts?: {
  vendor?: string;
  category?: string;
  limit?: number;
}): Promise<MissingDevice[]> {
  await updateDeviceList();
  return findMissingDevices(opts);
}

/**
 * Detect sha256 drift between each covered device's recorded upstream codec and
 * the current upstream file. A non-empty result means an upstream codec changed
 * since it was referenced — re-review the affected normalized codec.
 */
export function findUpstreamChanges(): UpstreamDrift[] {
  const base = resolveDevicesDir();
  const drift: UpstreamDrift[] = [];
  for (const d of registryDevices()) {
    if (!d.ttn) continue;
    const file = path.join(base, d.ttn.vendor, d.ttn.codecFile);
    let currentSha256: string | null = null;
    if (fs.existsSync(file)) {
      currentSha256 = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    }
    drift.push({
      vendor: d.ttn.vendor,
      device: d.ttn.device,
      storedSha256: d.ttn.codecSha256,
      currentSha256,
      changed: currentSha256 !== d.ttn.codecSha256,
    });
  }
  return drift;
}
