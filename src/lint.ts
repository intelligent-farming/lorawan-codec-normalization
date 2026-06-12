// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation

/**
 * Static lint for codec source text.
 *
 * This module performs **no execution** — it is pure static analysis that
 * checks a `codec.js` is console-paste-able: a valid SPDX header plus no banned
 * constructs (Node APIs, async, post-ES2017 syntax). It is useful both for the
 * conformance suite and for vetting a manually-entered codec before installing
 * it into a ChirpStack device profile.
 *
 * @packageDocumentation
 */

/** A banned construct (regex) and the message reported when it is found. */
interface BannedRule {
  re: RegExp;
  message: string;
}

const BANNED: BannedRule[] = [
  { re: /\brequire\s*\(/, message: 'require() is not allowed' },
  { re: /\bimport\b/, message: 'ES module import is not allowed' },
  { re: /\bexport\b/, message: 'ES module export is not allowed' },
  { re: /\bmodule\s*\.\s*exports\b/, message: 'module.exports is not allowed' },
  { re: /\bexports\s*\./, message: 'exports.* is not allowed' },
  { re: /\bprocess\s*\./, message: 'process.* is not allowed' },
  { re: /\bBuffer\b/, message: 'Buffer is not allowed' },
  { re: /\bglobalThis\b/, message: 'globalThis is not allowed' },
  { re: /\beval\s*\(/, message: 'eval() is not allowed' },
  { re: /\bnew\s+Function\b/, message: 'new Function is not allowed' },
  {
    re: /\b(setTimeout|setInterval|setImmediate|clearTimeout|clearInterval|queueMicrotask)\s*\(/,
    message: 'timers are not allowed',
  },
  { re: /\bconsole\s*\./, message: 'console.* is not allowed' },
  { re: /\bfetch\s*\(/, message: 'fetch() is not allowed' },
  { re: /\b(async|await)\b/, message: 'async/await is not allowed' },
  { re: /\bPromise\b/, message: 'Promise is not allowed (codecs must be synchronous)' },
  // post-ES2017 syntax
  { re: /\?\./, message: 'optional chaining (?.) requires > ES2017' },
  { re: /\?\?/, message: 'nullish coalescing (??) requires > ES2017' },
  { re: /\.\.\./, message: 'spread/rest (...) is not allowed (ES2017 console target)' },
  { re: /\bBigInt\b/, message: 'BigInt is not allowed' },
  { re: /\b\d+n\b/, message: 'BigInt literals are not allowed' },
  { re: /#[A-Za-z_]/, message: 'private class fields (#x) require > ES2017' },
  { re: /\bstatic\s*\{/, message: 'static class blocks require > ES2017' },
];

const SPDX_RE = /SPDX-License-Identifier:\s*AGPL-3\.0-or-later/;

/**
 * Strip comments and string/template contents so banned-construct matching does
 * not trip on tokens that appear inside comments or string literals.
 */
function stripCommentsAndStrings(src: string): string {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];
    if (c === '/' && c2 === '/') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && c2 === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      i++;
      while (i < n) {
        if (src[i] === '\\') {
          i += 2;
          continue;
        }
        if (src[i] === quote) {
          i++;
          break;
        }
        i++;
      }
      out += '""';
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/**
 * Statically lint a `codec.js`. Returns an array of human-readable violations;
 * an empty array means the codec passes. Checks the SPDX header on the raw
 * source and banned constructs on a comment/string-stripped copy.
 *
 * @param source - Raw `codec.js` text (e.g. from {@link codecScript}).
 */
export function lintCodec(source: string): string[] {
  const violations: string[] = [];
  if (!SPDX_RE.test(source.slice(0, 400))) {
    violations.push('missing SPDX-License-Identifier: AGPL-3.0-or-later header');
  }
  const code = stripCommentsAndStrings(source);
  for (const rule of BANNED) {
    if (rule.re.test(code)) violations.push(rule.message);
  }
  return violations;
}
