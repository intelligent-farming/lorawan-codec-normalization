// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation

/**
 * Lazy enumeration of the device registry under `codecs/<vendor>/<device>/`.
 *
 * A device folder is "real" when it contains a `device.json`. Folder names must
 * match the `vendor`/`device` fields inside that file (enforced by the
 * conformance suite). Nothing here imports the optional
 * `@intelligent-farming/ttn-to-chirpstack` peer.
 *
 * @packageDocumentation
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { DeviceInfo } from './types';

/** Root of the device registry. */
export const CODECS_DIR = path.join(__dirname, '..', 'codecs');

interface DeviceLocation {
  vendor: string;
  device: string;
  dir: string;
}

let locationCache: DeviceLocation[] | null = null;
const infoCache = new Map<string, DeviceInfo>();

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Enumerate every `<vendor>/<device>/` folder that has a `device.json`. */
function locations(): DeviceLocation[] {
  if (locationCache) return locationCache;
  const out: DeviceLocation[] = [];
  if (isDir(CODECS_DIR)) {
    for (const vendor of fs.readdirSync(CODECS_DIR).sort()) {
      const vendorDir = path.join(CODECS_DIR, vendor);
      if (!isDir(vendorDir)) continue;
      for (const device of fs.readdirSync(vendorDir).sort()) {
        const dir = path.join(vendorDir, device);
        if (isDir(dir) && fs.existsSync(path.join(dir, 'device.json'))) {
          out.push({ vendor, device, dir });
        }
      }
    }
  }
  locationCache = out;
  return out;
}

/**
 * Cache key for a device lookup. Lowercased so that lookups are
 * case-insensitive (folder names are guaranteed collision-free at a given case
 * by the conformance suite).
 */
function key(vendor: string, device: string): string {
  return `${vendor}/${device}`.toLowerCase();
}

/** Locate a device folder case-insensitively (e.g. `LSE01` matches `lse01`). */
function locate(vendor: string, device: string): DeviceLocation | undefined {
  const v = vendor.toLowerCase();
  const d = device.toLowerCase();
  return locations().find(
    (l) => l.vendor.toLowerCase() === v && l.device.toLowerCase() === d,
  );
}

/** Absolute path to a device folder. Throws if the device is unknown. */
export function deviceDir(vendor: string, device: string): string {
  const loc = locate(vendor, device);
  if (!loc) throw new Error(`unknown device ${key(vendor, device)}`);
  return loc.dir;
}

/** Parsed `device.json` for one device. Throws if unknown. */
export function device(vendor: string, deviceId: string): DeviceInfo {
  const k = key(vendor, deviceId);
  const cached = infoCache.get(k);
  if (cached) return cached;
  const loc = locate(vendor, deviceId);
  if (!loc) throw new Error(`unknown device ${k}`);
  const info = JSON.parse(
    fs.readFileSync(path.join(loc.dir, 'device.json'), 'utf8'),
  ) as DeviceInfo;
  infoCache.set(k, info);
  return info;
}

/**
 * List registry devices. Authored devices only by default; pass
 * `includeDrafts: true` to also include scaffolded-but-unauthored drafts.
 *
 * @param opts.category - Restrict to devices declaring this category.
 * @param opts.includeDrafts - Include `draft: true` devices (default false).
 */
export function devices(opts?: {
  category?: string;
  includeDrafts?: boolean;
}): DeviceInfo[] {
  let all = locations().map((l) => device(l.vendor, l.device));
  if (!opts?.includeDrafts) all = all.filter((d) => !d.draft);
  if (opts?.category) {
    all = all.filter((d) => d.categories.includes(opts.category as string));
  }
  return all;
}

/**
 * True when a provided path matches a query, segment-aware and case-insensitive.
 *
 * Both are split on `.`; the query matches when its segment run appears as a
 * contiguous run of whole segments in the path. So `"temperature"` matches
 * `"temperature"`, `"air.temperature"`, `"soil.temperature"`, and
 * `"water.temperature.current"`, but not the camelCase extra `"boardTemperature"`
 * (segments are matched whole, not as substrings). A dotted query like
 * `"air.temperature"` matches only paths containing that exact adjacent run.
 */
function providedPathMatches(providedPath: string, query: string): boolean {
  const pSegs = providedPath.toLowerCase().split('.');
  const qSegs = query.toLowerCase().split('.');
  if (qSegs.length === 0 || qSegs[0] === '') return false;
  for (let i = 0; i + qSegs.length <= pSegs.length; i++) {
    let ok = true;
    for (let j = 0; j < qSegs.length; j++) {
      if (pSegs[i + j] !== qSegs[j]) {
        ok = false;
        break;
      }
    }
    if (ok) return true;
  }
  return false;
}

/**
 * List devices whose `provides` includes a path matching `query` (segment-aware,
 * case-insensitive — see {@link providedPathMatches}).
 *
 * A bare segment query returns devices providing it at any namespace depth:
 * `devicesProviding('temperature')` returns devices providing `temperature`,
 * `air.temperature`, `soil.temperature`, `water.temperature.current`, etc. A
 * dotted query narrows to that exact path run: `devicesProviding('air.temperature')`
 * excludes a device that only provides `soil.temperature`.
 *
 * Pass an array to require **all** of its queries (AND): a device is returned only
 * if every query matches one of its provided paths, so
 * `devicesProviding(['air.temperature', 'air.relativeHumidity'])` returns devices
 * providing both. An empty or all-blank array returns `[]`; blank entries within a
 * non-empty array are ignored.
 *
 * Authored devices only by default; honours the same `category`/`includeDrafts`
 * filters as {@link devices}. Returns `[]` for a blank query. Result order matches
 * {@link devices} (vendor then device).
 *
 * @param query - A vocabulary path or segment (e.g. `'temperature'`, `'co2'`,
 *   `'metering.water.total'`), or an array of them to require all (AND).
 * @example
 * devicesProviding('co2').map((d) => `${d.vendor}/${d.device}`);
 * devicesProviding(['air.temperature', 'air.relativeHumidity']); // both required
 */
export function devicesProviding(
  query: string | string[],
  opts?: { category?: string; includeDrafts?: boolean },
): DeviceInfo[] {
  const queries = (Array.isArray(query) ? query : [query])
    .filter((q): q is string => typeof q === 'string' && q.trim() !== '')
    .map((q) => q.trim());
  if (queries.length === 0) return [];
  return devices(opts).filter((d) => {
    const provided = d.provides ?? [];
    return queries.every((q) => provided.some((p) => providedPathMatches(p, q)));
  });
}

/**
 * Raw `codec.js` text for a device (console-ready). Throws if the device is
 * unknown, or if it is a draft (scaffolded but not yet authored) — a draft has
 * only a stub, so callers should treat it as "not available here" and fall back
 * to the upstream codec.
 */
export function codecScript(vendor: string, deviceId: string): string {
  const info = device(vendor, deviceId);
  if (info.draft) {
    throw new Error(
      `${info.vendor}/${info.device} is a draft (codec not yet authored); fall back to the upstream codec`,
    );
  }
  return fs.readFileSync(path.join(deviceDir(vendor, deviceId), 'codec.js'), 'utf8');
}

/** Parsed `vectors.json` for a device (or `{ uplink: [], downlink: [] }`). */
export function vectors(
  vendor: string,
  deviceId: string,
): { uplink: unknown[]; downlink: unknown[] } {
  const file = path.join(deviceDir(vendor, deviceId), 'vectors.json');
  if (!fs.existsSync(file)) return { uplink: [], downlink: [] };
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as {
    uplink?: unknown[];
    downlink?: unknown[];
  };
  return { uplink: parsed.uplink ?? [], downlink: parsed.downlink ?? [] };
}

/**
 * Reset the registry caches. Test-only.
 *
 * @internal
 */
export function _resetCaches(): void {
  locationCache = null;
  infoCache.clear();
}
