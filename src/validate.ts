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
 *  5. Style notes (non-camelCase extras, shadowed concepts) are non-failing and
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
 */
function walkLevel(
  data: JsonObject,
  vocabNode: JsonObject | null,
  base: string,
  issues: ValidationIssue[],
  style: StyleNote[],
): void {
  const defined = definedKeysAt(vocabNode);
  const lcToCanonical = new Map<string, string>();
  for (const k of defined) lcToCanonical.set(k.toLowerCase(), k);

  const props = (vocabNode?.properties as JsonObject | undefined) ?? {};

  for (const key of Object.keys(data)) {
    // `history` is handled specially at the top level by the caller; never
    // treat it as a collision/extra here.
    if (key === 'history' && base === '') continue;

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

/** Schema + collision + reserved-key/history validation of one measurement. */
function validateMeasurement(
  m: unknown,
  base: string,
  isHistoryEntry: boolean,
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
  walkLevel(m, derefNode(measurementSchema()), base, issues, style);

  // 4. Reserved `history` key (top-level measurements only).
  if (!isHistoryEntry && 'history' in m) {
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
        validateMeasurement(entry, entryBase, true, issues, style);
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
    validateMeasurement(m, base, false, issues, style);

    if (opts?.requireAll) {
      // `requires`: every listed path must be present.
      for (const req of info.requires ?? []) {
        if (!hasPath(m, req)) {
          issues.push({
            path: joinPath(base, req),
            message: `missing required "${req}" for category "${info.id}"`,
            rule: 'schema',
          });
        }
      }
      // `atLeastOne`: at least one of the listed paths must be present.
      const anyOf = info.atLeastOne ?? [];
      if (anyOf.length > 0 && !anyOf.some((p) => hasPath(m, p))) {
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
      walkLevel(m, derefNode(measurementSchema()), base, issues, style);
      if ('history' in m && Array.isArray(m.history)) {
        m.history.forEach((entry, j) => {
          if (isPlainObject(entry)) {
            walkLevel(
              entry,
              derefNode(measurementSchema()),
              joinPath(base, `history[${j}]`),
              issues,
              style,
            );
          }
        });
      }
    }
  });
  return style;
}

/** Resolve a dotted vocabulary path (re-exported for the conformance harness). */
export { resolveVocabularyPath };
