// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation

/**
 * Validation of normalized measurements against the vocabulary plus the
 * extras/conflict rules that the JSON Schema alone cannot express.
 *
 * Layered rules (see AUTHORING.md):
 *  1. A vocabulary key must validate against its sub-schema (type/bounds/enum)
 *     — rule `schema`.
 *  2. A non-vocabulary key that case-insensitively collides with a vocabulary
 *     key at the same level fails — rule `case-collision`.
 *  3. Any other key is an allowed extra.
 *  4. `history` is reserved at the measurement top level; a non-array value
 *     fails — rule `reserved-key`. Each entry must carry `time` — rule
 *     `history-time`.
 *  5. `channels` is reserved at the measurement top level and inside history
 *     entries (multi-channel devices: multilayer probes, multi-port
 *     dataloggers); a non-array value fails — rule `reserved-key`. Each entry
 *     must carry a non-empty string `channel` label, unique within its array —
 *     rule `channel-label`. Entries are leaf measurements: a nested `history`
 *     or `channels` inside one fails — rule `reserved-key`.
 *  6. Style notes (non-camelCase extras, shadowed concepts) are non-failing and
 *     surfaced via {@link styleNotes}, not {@link validate}.
 *
 * @packageDocumentation
 */

import Ajv2020, { type ValidateFunction } from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import {
  category,
  definedKeysAt,
  measurementSchema,
  resolveVocabularyPath,
  vocabularySchema,
} from './categories';
import type {
  Measurement,
  StyleNote,
  ValidationIssue,
  ValidationResult,
} from './types';

type JsonObject = Record<string, unknown>;

let compiled: ValidateFunction | null = null;

function measurementValidator(): ValidateFunction {
  if (!compiled) {
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    addFormats(ajv);
    compiled = ajv.compile(vocabularySchema());
  }
  return compiled;
}

function isPlainObject(v: unknown): v is JsonObject {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Join a base path and a dotted sub-path into a single display path. */
function joinPath(base: string, dotted: string): string {
  if (!dotted) return base;
  return base ? `${base}.${dotted}` : dotted;
}

/** Convert an ajv instancePath (`/soil/moisture`) to a dotted path. */
function instanceToDotted(instancePath: string): string {
  if (!instancePath) return '';
  return instancePath
    .slice(1)
    .split('/')
    .map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'))
    .join('.');
}

/** True when a dotted path resolves to a defined value in `obj`. */
function hasPath(obj: unknown, dotted: string): boolean {
  let cur: unknown = obj;
  for (const seg of dotted.split('.')) {
    if (!isPlainObject(cur) || !(seg in cur)) return false;
    cur = (cur as JsonObject)[seg];
  }
  return cur !== undefined;
}

/**
 * True when a dotted path resolves at the top level or inside any top-level
 * `channels[]` entry. Category membership counts channel-scoped readings (a
 * multilayer probe's `soil.*` lives only inside entries), but not `history`
 * entries — those mirror the current reading by contract.
 */
function hasPathWithChannels(obj: unknown, dotted: string): boolean {
  if (hasPath(obj, dotted)) return true;
  if (!isPlainObject(obj)) return false;
  const chans = obj.channels;
  return (
    Array.isArray(chans) &&
    chans.some((e) => isPlainObject(e) && hasPath(e, dotted))
  );
}

/** Local deref of a `#/$defs/...` node within the vocabulary document. */
function derefNode(node: unknown): JsonObject | null {
  if (!isPlainObject(node)) return null;
  const ref = node.$ref;
  if (typeof ref === 'string' && ref.startsWith('#/$defs/')) {
    const key = ref.slice('#/$defs/'.length);
    const defsObj = vocabularySchema().$defs as JsonObject | undefined;
    const target = defsObj ? defsObj[key] : undefined;
    return isPlainObject(target) ? target : null;
  }
  return node;
}

/**
 * Walk an object level mapped to a vocabulary node, collecting case-collision
 * issues (when `collectStyle` is false) or style notes (when true). Recurses
 * into vocabulary group objects only — extras have no defined keys beneath them.
 *
 * `atMeasurementLevel` marks the top of a measurement object (root, array
 * element, history entry or channels entry), where `history`/`channels` are
 * reserved containers handled by the caller; inside a vocabulary group they are
 * ordinary keys.
 */
function walkLevel(
  data: JsonObject,
  vocabNode: JsonObject | null,
  base: string,
  issues: ValidationIssue[],
  style: StyleNote[],
  atMeasurementLevel = false,
): void {
  const defined = definedKeysAt(vocabNode);
  const lcToCanonical = new Map<string, string>();
  for (const k of defined) lcToCanonical.set(k.toLowerCase(), k);

  const props = (vocabNode?.properties as JsonObject | undefined) ?? {};

  for (const key of Object.keys(data)) {
    // `history` and `channels` are handled specially by the caller; never
    // treat them as a collision/extra here.
    if ((key === 'history' || key === 'channels') && atMeasurementLevel) {
      continue;
    }

    if (defined.includes(key)) {
      // Defined vocabulary key: recurse into group objects to check deeper.
      const childVocab = derefNode(props[key]);
      const childData = data[key];
      if (isPlainObject(childData) && childVocab) {
        walkLevel(childData, childVocab, joinPath(base, key), issues, style);
      }
      continue;
    }

    const collision = lcToCanonical.get(key.toLowerCase());
    if (collision !== undefined && collision !== key) {
      issues.push({
        path: joinPath(base, key),
        message: `key "${key}" case-insensitively collides with vocabulary key "${collision}"`,
        rule: 'case-collision',
      });
      continue;
    }

    // Legitimate extra — style advice only.
    if (/^[A-Z]/.test(key) || /[ -]/.test(key)) {
      style.push({
        path: joinPath(base, key),
        message: `extra key "${key}" should be camelCase`,
      });
    }
  }
}

/**
 * Where a measurement object sits in the reserved-container tree: the top
 * level (`root`), a `history[]` entry, or a `channels[]` entry. Decides which
 * reserved keys are processed (`history` at root only; `channels` at root and
 * in history entries) and which are rejected (both, inside channel entries).
 */
type MeasurementKind = 'root' | 'history' | 'channel';

/** Schema + collision + reserved-key (history/channels) validation of one measurement. */
function validateMeasurement(
  m: unknown,
  base: string,
  kind: MeasurementKind,
  issues: ValidationIssue[],
  style: StyleNote[],
): void {
  if (!isPlainObject(m)) {
    issues.push({
      path: base,
      message: 'measurement must be an object',
      rule: 'schema',
    });
    return;
  }

  // 1. JSON Schema (type/bounds/enum). `history` is invisible to the schema
  // (additionalProperties: true) and handled below.
  const validator = measurementValidator();
  if (!validator(m)) {
    for (const err of validator.errors ?? []) {
      const dotted = instanceToDotted(err.instancePath);
      issues.push({
        path: joinPath(base, dotted),
        message: `${dotted || '(root)'} ${err.message ?? 'is invalid'}`.trim(),
        rule: 'schema',
      });
    }
  }

  // 2 + 5. Case collisions and style notes at every object level.
  walkLevel(m, derefNode(measurementSchema()), base, issues, style, true);

  // 4. Reserved `history` key (top-level measurements only).
  if (kind === 'root' && 'history' in m) {
    const hist = m.history;
    if (!Array.isArray(hist)) {
      issues.push({
        path: joinPath(base, 'history'),
        message: '`history` must be an array of measurements',
        rule: 'reserved-key',
      });
    } else {
      hist.forEach((entry, j) => {
        const entryBase = joinPath(base, `history[${j}]`);
        if (isPlainObject(entry) && entry.time === undefined) {
          issues.push({
            path: entryBase,
            message: 'history entry must carry a `time`',
            rule: 'history-time',
          });
        }
        validateMeasurement(entry, entryBase, 'history', issues, style);
      });
    }
  }

  // 5. Reserved `channels` key (top level and history entries). Inside a
  // channel entry, both reserved containers are rejected — entries are leaf
  // measurements.
  if (kind === 'channel') {
    for (const nested of ['history', 'channels'] as const) {
      if (nested in m) {
        issues.push({
          path: joinPath(base, nested),
          message: `\`${nested}\` is not allowed inside a channels entry`,
          rule: 'reserved-key',
        });
      }
    }
  } else if ('channels' in m) {
    const chans = m.channels;
    if (!Array.isArray(chans)) {
      issues.push({
        path: joinPath(base, 'channels'),
        message: '`channels` must be an array of measurements',
        rule: 'reserved-key',
      });
    } else {
      const seenLabels = new Set<string>();
      chans.forEach((entry, j) => {
        const entryBase = joinPath(base, `channels[${j}]`);
        if (isPlainObject(entry)) {
          const label = entry.channel;
          if (typeof label !== 'string' || label === '') {
            issues.push({
              path: entryBase,
              message:
                'channels entry must carry a non-empty string `channel` label',
              rule: 'channel-label',
            });
          } else if (seenLabels.has(label)) {
            issues.push({
              path: joinPath(entryBase, 'channel'),
              message: `duplicate channel label "${label}"`,
              rule: 'channel-label',
            });
          } else {
            seenLabels.add(label);
          }
        }
        validateMeasurement(entry, entryBase, 'channel', issues, style);
      });
    }
  }
}

/**
 * Validate a measurement (or array of measurements) against a category.
 *
 * Bounds and key legality come from the global vocabulary; the category only
 * adds its membership contract, enforced when `opts.requireAll` is true: every
 * `requires` path must be present, and/or at least one `atLeastOne` path must be
 * present. The default (`requireAll: false`) keeps fPort-variant, config, and
 * partial uplinks legal.
 *
 * @param categoryId - Category id (e.g. `"soil-monitor"`). Throws if unknown.
 * @param data - One measurement or a TTN-style array of measurements.
 * @param opts.requireAll - Enforce the category's `requires` / `atLeastOne` contract.
 */
export function validate(
  categoryId: string,
  data: Measurement | Measurement[],
  opts?: { requireAll?: boolean },
): ValidationResult {
  const info = category(categoryId);
  const list = Array.isArray(data) ? data : [data];
  const issues: ValidationIssue[] = [];
  const style: StyleNote[] = [];

  list.forEach((m, i) => {
    const base = Array.isArray(data) ? `[${i}]` : '';
    validateMeasurement(m, base, 'root', issues, style);

    if (opts?.requireAll) {
      // `requires`: every listed path must be present (top level or channels).
      for (const req of info.requires ?? []) {
        if (!hasPathWithChannels(m, req)) {
          issues.push({
            path: joinPath(base, req),
            message: `missing required "${req}" for category "${info.id}"`,
            rule: 'schema',
          });
        }
      }
      // `atLeastOne`: at least one of the listed paths must be present.
      const anyOf = info.atLeastOne ?? [];
      if (anyOf.length > 0 && !anyOf.some((p) => hasPathWithChannels(m, p))) {
        issues.push({
          path: base,
          message: `category "${info.id}" requires at least one of [${anyOf.join(', ')}]`,
          rule: 'schema',
        });
      }
    }
  });

  return { valid: issues.length === 0, issues };
}

/**
 * Non-failing style notes for a measurement (or array): non-camelCase extras
 * and similar advisories. Surfaced by the conformance harness via diagnostics.
 *
 * @internal
 */
export function styleNotes(data: Measurement | Measurement[]): StyleNote[] {
  const list = Array.isArray(data) ? data : [data];
  const issues: ValidationIssue[] = [];
  const style: StyleNote[] = [];
  list.forEach((m, i) => {
    const base = Array.isArray(data) ? `[${i}]` : '';
    if (isPlainObject(m)) {
      walkLevel(m, derefNode(measurementSchema()), base, issues, style, true);
      walkChannelsStyle(m, base, issues, style);
      if ('history' in m && Array.isArray(m.history)) {
        m.history.forEach((entry, j) => {
          if (isPlainObject(entry)) {
            const entryBase = joinPath(base, `history[${j}]`);
            walkLevel(
              entry,
              derefNode(measurementSchema()),
              entryBase,
              issues,
              style,
              true,
            );
            walkChannelsStyle(entry, entryBase, issues, style);
          }
        });
      }
    }
  });
  return style;
}

/** Style-walk each `channels[]` entry of one measurement level. */
function walkChannelsStyle(
  m: JsonObject,
  base: string,
  issues: ValidationIssue[],
  style: StyleNote[],
): void {
  if (!('channels' in m) || !Array.isArray(m.channels)) return;
  m.channels.forEach((entry, j) => {
    if (isPlainObject(entry)) {
      walkLevel(
        entry,
        derefNode(measurementSchema()),
        joinPath(base, `channels[${j}]`),
        issues,
        style,
        true,
      );
    }
  });
}

/** Resolve a dotted vocabulary path (re-exported for the conformance harness). */
export { resolveVocabularyPath };
