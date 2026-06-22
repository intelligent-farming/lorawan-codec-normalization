// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation

/**
 * Category manifests and the shared vocabulary schema.
 *
 * The vocabulary (`definitions/vocabulary.schema.json`) is the single source of
 * truth for legal keys, units, and bounds. Per-category manifests
 * (`definitions/categories/*.json`) add an introspectable `requires`/`provides`
 * contract on top of it.
 *
 * @packageDocumentation
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CategoryInfo } from './types';

/** Directory holding `vocabulary.schema.json` and `categories/`. */
const DEFINITIONS_DIR = path.join(__dirname, '..', 'definitions');
const CATEGORIES_DIR = path.join(DEFINITIONS_DIR, 'categories');

type JsonObject = Record<string, unknown>;

let vocabularyCache: JsonObject | null = null;
let manifestCache: Map<string, CategoryInfo> | null = null;

/** Load and cache the raw vocabulary schema document. */
export function vocabularySchema(): JsonObject {
  if (!vocabularyCache) {
    const file = path.join(DEFINITIONS_DIR, 'vocabulary.schema.json');
    vocabularyCache = JSON.parse(fs.readFileSync(file, 'utf8')) as JsonObject;
  }
  return vocabularyCache;
}

/** The `$defs` block of the vocabulary. */
function defs(): JsonObject {
  return (vocabularySchema().$defs as JsonObject) ?? {};
}

/** The `measurement` sub-schema (deref'd root of a single reading). */
export function measurementSchema(): JsonObject {
  return defs().measurement as JsonObject;
}

/**
 * Resolve a local `#/$defs/...` $ref one hop. Non-$ref nodes are returned
 * unchanged. Only intra-document refs are supported (the vocabulary uses no
 * external refs).
 */
function deref(node: unknown): JsonObject | null {
  if (!node || typeof node !== 'object') return null;
  const obj = node as JsonObject;
  const ref = obj.$ref;
  if (typeof ref === 'string' && ref.startsWith('#/$defs/')) {
    const key = ref.slice('#/$defs/'.length);
    const target = defs()[key];
    return target ? (target as JsonObject) : null;
  }
  return obj;
}

/**
 * Resolve a dotted vocabulary path (e.g. `soil.moisture`,
 * `water.temperature.current`, `metering.water.total`) to its sub-schema, or
 * `null` if the path does not exist in the vocabulary.
 */
export function resolveVocabularyPath(dotted: string): JsonObject | null {
  let node: JsonObject | null = deref(measurementSchema());
  for (const segment of dotted.split('.')) {
    if (!node) return null;
    const props = node.properties as JsonObject | undefined;
    if (!props || !(segment in props)) return null;
    node = deref(props[segment]);
  }
  return node;
}

/** The set of vocabulary-defined property names directly under a schema node. */
export function definedKeysAt(node: JsonObject | null): string[] {
  if (!node) return [];
  const props = node.properties as JsonObject | undefined;
  return props ? Object.keys(props) : [];
}

/** True when `dotted` resolves to a real vocabulary property. */
export function isVocabularyPath(dotted: string): boolean {
  return resolveVocabularyPath(dotted) !== null;
}

/** Load and cache all category manifests, keyed by id. */
function manifests(): Map<string, CategoryInfo> {
  if (!manifestCache) {
    const map = new Map<string, CategoryInfo>();
    const files = fs
      .readdirSync(CATEGORIES_DIR)
      .filter((f) => f.endsWith('.json'))
      .sort();
    for (const f of files) {
      const raw = JSON.parse(
        fs.readFileSync(path.join(CATEGORIES_DIR, f), 'utf8'),
      ) as CategoryInfo;
      const expectedId = f.replace(/\.json$/, '');
      if (raw.id !== expectedId) {
        throw new Error(
          `category manifest ${f} has id "${raw.id}" (expected "${expectedId}")`,
        );
      }
      map.set(raw.id, raw);
    }
    manifestCache = map;
  }
  return manifestCache;
}

/**
 * List every category, sorted by id.
 *
 * @example
 * categories().map((c) => c.id); // ['air-quality', 'climate', 'contact', ...]
 */
export function categories(): CategoryInfo[] {
  return [...manifests().values()];
}

/** Look up one category by id, throwing if it does not exist. */
export function category(id: string): CategoryInfo {
  const found = manifests().get(id);
  if (!found) {
    const known = [...manifests().keys()].join(', ');
    throw new Error(`unknown category "${id}" (known: ${known})`);
  }
  return found;
}

/**
 * A self-contained JSON Schema (2020-12) describing a measurement valid in the
 * given category. Value bounds are the global vocabulary bounds (identical in
 * every category); the category's `requires`/`provides` paths are attached as
 * the non-standard `x-requires`/`x-provides` annotations for introspection.
 *
 * @param id - Category id (e.g. `"soil-monitor"`).
 */
export function categorySchema(id: string): Record<string, unknown> {
  const info = category(id);
  const vocab = vocabularySchema();
  const schema: Record<string, unknown> = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: `${String(vocab.$id)}/category/${id}`,
    title: info.name,
    description: info.description,
    $defs: vocab.$defs,
    allOf: [{ $ref: '#/$defs/measurement' }],
    'x-provides': info.provides,
  };
  if (info.requires) schema['x-requires'] = info.requires;
  if (info.atLeastOne) schema['x-atLeastOne'] = info.atLeastOne;
  return schema;
}

/**
 * Reset cached vocabulary/manifests. Test-only; real consumers never mutate the
 * definitions at runtime.
 *
 * @internal
 */
export function _resetCaches(): void {
  vocabularyCache = null;
  manifestCache = null;
}
