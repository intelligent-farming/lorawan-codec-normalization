// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation

/**
 * Shared types for the normalized payload vocabulary and the public API.
 *
 * Every measurement group mirrors `definitions/vocabulary.schema.json` and
 * carries an index signature, because codecs may emit device-specific extras
 * alongside the vocabulary keys (extras are allowed but must not collide with a
 * vocabulary key — see {@link ValidationIssue}).
 *
 * @packageDocumentation
 */

/** Soil group (`soil.*`). */
export interface SoilMeasurement {
  /** Depth of the soil measurement (cm). */
  depth?: number;
  /** Soil moisture (%). */
  moisture?: number;
  /** Soil temperature (°C). */
  temperature?: number;
  /** Soil electrical conductivity (dS/m). */
  ec?: number;
  /** Soil pH level (0–14). */
  pH?: number;
  /** Concentration of Nitrogen in the soil (ppm). */
  n?: number;
  /** Concentration of Phosphorus in the soil (ppm). */
  p?: number;
  /** Concentration of Potassium in the soil (ppm). */
  k?: number;
  [extra: string]: unknown;
}

/** Air group (`air.*`). */
export interface AirMeasurement {
  /** Whether the measurement was taken indoors or outdoors. */
  location?: 'indoor' | 'outdoor';
  /** Air temperature (°C). */
  temperature?: number;
  /** Relative humidity (%). */
  relativeHumidity?: number;
  /** Atmospheric pressure (hPa). */
  pressure?: number;
  /** Concentration of CO2 in the air (ppm). */
  co2?: number;
  /** Light intensity (lux). */
  lightIntensity?: number;
  [extra: string]: unknown;
}

/** Wind group (`wind.*`). */
export interface WindMeasurement {
  /** Wind speed (m/s). */
  speed?: number;
  /** Wind direction (°, 0 to <360). */
  direction?: number;
  [extra: string]: unknown;
}

/** Rain group (`rain.*`). */
export interface RainMeasurement {
  /** Rainfall intensity (mm/hour). */
  intensity?: number;
  /** Cumulative rainfall (mm). */
  cumulative?: number;
  [extra: string]: unknown;
}

/** Water temperature sub-group (`water.temperature.*`). */
export interface WaterTemperature {
  /** Minimum temperature (°C). */
  min?: number;
  /** Maximum temperature (°C). */
  max?: number;
  /** Average temperature (°C). */
  avg?: number;
  /** Current temperature (°C). */
  current?: number;
  [extra: string]: unknown;
}

/** Water group (`water.*`). */
export interface WaterMeasurement {
  /** Leak detected. */
  leak?: boolean;
  /** Water temperature readings (°C). */
  temperature?: WaterTemperature;
  [extra: string]: unknown;
}

/** Metering group (`metering.*`). */
export interface MeteringMeasurement {
  /** Water metering. */
  water?: {
    /** Total volume (L). */
    total?: number;
    [extra: string]: unknown;
  };
  [extra: string]: unknown;
}

/** Motion sub-group (`action.motion.*`). */
export interface MotionMeasurement {
  /** Motion detected. */
  detected?: boolean;
  /** Number of motion events (count). */
  count?: number;
  [extra: string]: unknown;
}

/** Action group (`action.*`). */
export interface ActionMeasurement {
  /** Motion state. */
  motion?: MotionMeasurement;
  /** State of a contact sensor. */
  contactState?: 'open' | 'closed';
  [extra: string]: unknown;
}

/** Position group (`position.*`). */
export interface PositionMeasurement {
  /** Horizontal distance from equator (°), -90..90. */
  latitude?: number;
  /** Vertical distance from prime meridian (°), -180..180. */
  longitude?: number;
  [extra: string]: unknown;
}

/**
 * A single normalized reading. Mirrors `definitions/vocabulary.schema.json`.
 * Datalog/history uplinks place the current reading at the top level and prior
 * readings in {@link Measurement.history}; each history entry must carry a
 * `time`.
 */
export interface Measurement {
  /** Date and time of the measurement (RFC3339). */
  time?: string;
  /** Battery voltage (V). */
  battery?: number;
  soil?: SoilMeasurement;
  air?: AirMeasurement;
  wind?: WindMeasurement;
  rain?: RainMeasurement;
  water?: WaterMeasurement;
  metering?: MeteringMeasurement;
  action?: ActionMeasurement;
  position?: PositionMeasurement;
  /** Prior readings for datalog uplinks; each entry must carry `time`. */
  history?: Measurement[];
  [extra: string]: unknown;
}

/** Why a {@link ValidationIssue} was raised. */
export type ValidationRule =
  | 'schema'
  | 'case-collision'
  | 'reserved-key'
  | 'history-time';

/** A single validation failure. */
export interface ValidationIssue {
  /** Dotted path to the offending value (e.g. `soil.moisture`). */
  path: string;
  /** Human-readable explanation. */
  message: string;
  /** Which rule produced the issue. */
  rule: ValidationRule;
}

/** Result of {@link validate}. */
export interface ValidationResult {
  /** True when there are no issues. */
  valid: boolean;
  /** All failures found (empty when valid). */
  issues: ValidationIssue[];
}

/** A non-failing style note (camelCase / shadowed-concept advice). */
export interface StyleNote {
  path: string;
  message: string;
}

/** Public description of a category, loaded from `definitions/categories/`. */
export interface CategoryInfo {
  /** Stable slug (folder/file name). */
  id: string;
  /** Display name. */
  name: string;
  /** One-line description. */
  description: string;
  /**
   * Dotted paths every member device reports across its uplinks (ALL required).
   * A category defines membership with either `requires` or {@link atLeastOne}.
   */
  requires?: string[];
  /**
   * Dotted paths where a member must report AT LEAST ONE — used instead of
   * `requires` for categories defined by a family of interchangeable
   * measurements rather than a fixed mandatory set (e.g. a soil probe that may
   * report any of moisture / temperature / pH / EC / NPK).
   */
  atLeastOne?: string[];
  /** Documented typical optional paths (informational). */
  provides: string[];
  /** Authoring notes (units, gotchas). */
  notes?: string;
}

/** Provenance linking a registry device back to its TTN upstream entry. */
export interface TtnProvenance {
  vendor: string;
  device: string;
  /** Codec id from the device's firmware reference. */
  codecId: string;
  /** Upstream decoder file name (e.g. `lse01.js`). */
  codecFile: string;
  /** sha256 of the upstream decoder file at authoring time. */
  codecSha256: string;
  /** ISO date the upstream codec was referenced. */
  referencedAt: string;
}

/** Public description of a registry device, from its `device.json`. */
export interface DeviceInfo {
  vendor: string;
  device: string;
  name: string;
  categories: string[];
  sensors: string[];
  /** `<vendor>/<device>` of the base variant, or null. */
  variantOf: string | null;
  downlink: { encode: boolean; decode: boolean };
  /** TTN provenance, or null for devices with no upstream (e.g. Makerfabs). */
  ttn: TtnProvenance | null;
  /**
   * True for a scaffolded-but-not-yet-authored device: the folder, reference
   * snapshot, provenance, and seeded vectors exist, but `codec.js` is still a
   * stub. Drafts are hidden from {@link devices} by default, are not counted as
   * "covered" by the sync diff, and the conformance suite skips their
   * vector/decode checks rather than failing them.
   */
  draft?: boolean;
}

/** A TTN device absent from this module (from {@link findMissingDevices}). */
export interface MissingDevice {
  vendor: string;
  device: string;
  name: string;
  sensors: string[];
  /** Whether the upstream entry ships a decoder. */
  hasCodec: boolean;
  /** Whether the upstream codec yaml carries `normalizedOutput` examples. */
  hasNormalizedExamples: boolean;
  /** Categories inferred from the device's sensors. */
  suggestedCategories: string[];
}

/** sha256 drift of an upstream reference codec (from {@link findUpstreamChanges}). */
export interface UpstreamDrift {
  vendor: string;
  device: string;
  /** sha256 recorded in this module's device.json. */
  storedSha256: string;
  /** Current upstream sha256, or null if the upstream file is gone. */
  currentSha256: string | null;
  /** True when the upstream codec changed since authoring. */
  changed: boolean;
}
