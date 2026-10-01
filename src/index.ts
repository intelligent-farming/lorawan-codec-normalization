// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation

/**
 * `@intelligent-farming/lorawan-codec-normalization`
 *
 * Curated, standalone normalized LoRaWAN payload codecs for agriculture
 * sensors. Every codec in a category emits the same shared keys, drawn from a
 * fixed vocabulary (see `definitions/vocabulary.schema.json`).
 *
 * @packageDocumentation
 */

/** Package version, kept in sync with package.json. */
export const VERSION = '0.2.3';

export { categories, categorySchema } from './categories';
export { validate } from './validate';
export { devices, devicesProviding, device, codecScript } from './registry';
export { lintCodec } from './lint';
export {
  updateDeviceList,
  findMissingDevices,
  checkForNewDevices,
  findUpstreamChanges,
  suggestCategories,
} from './sync';

export type {
  Measurement,
  ChannelMeasurement,
  SoilMeasurement,
  AirMeasurement,
  WindMeasurement,
  RainMeasurement,
  WaterMeasurement,
  WaterTemperature,
  MeteringMeasurement,
  MotionMeasurement,
  ActionMeasurement,
  PositionMeasurement,
  ValidationRule,
  ValidationIssue,
  ValidationResult,
  CategoryInfo,
  DeviceIndexEntry,
  DeviceInfo,
  TtnProvenance,
  MissingDevice,
  UpstreamDrift,
} from './types';
