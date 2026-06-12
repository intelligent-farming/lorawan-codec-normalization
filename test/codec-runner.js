// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation

'use strict';

// TEST-ONLY codec runner. This is NOT part of the shipped package — the module
// provides codec JavaScript text for ChirpStack to execute; it does not decode
// payloads at runtime. The conformance suite uses this helper to execute each
// codec against its vectors and prove the shipped JS is correct.
//
// A codec is run in a fresh node:vm context that exposes JS intrinsics (Math,
// JSON, ...) but none of Node's globals (require, process, console, Buffer,
// fetch, timers), with a 1-second timeout, and the result is JSON-round-tripped
// so it lands in the caller's realm with plain prototypes and JSON-only values.

const vm = require('node:vm');

const TIMEOUT_MS = 1000;

/** Run a named codec function with `arg` embedded as a JSON literal. */
function runFunction(source, fnName, arg) {
  const argLiteral = JSON.stringify(arg === undefined ? null : arg);
  const wrapper = `${source}
;JSON.stringify((function () {
  if (typeof ${fnName} !== 'function') {
    throw new Error('codec does not define ${fnName}');
  }
  var __r = ${fnName}(${argLiteral});
  return __r === undefined ? null : __r;
})());`;
  const out = vm.runInNewContext(wrapper, Object.create(null), {
    timeout: TIMEOUT_MS,
    contextName: 'codec',
  });
  return JSON.parse(out);
}

/** True when the codec source defines a top-level function `fnName`. */
function definesFunction(source, fnName) {
  const wrapper = `${source}\n;(typeof ${fnName} === 'function');`;
  try {
    return (
      vm.runInNewContext(wrapper, Object.create(null), { timeout: TIMEOUT_MS }) === true
    );
  } catch {
    return false;
  }
}

/** Run `decodeUplink(input)` and return its raw (JSON-round-tripped) result. */
function runDecodeUplink(source, input) {
  const r = runFunction(source, 'decodeUplink', input);
  return r && typeof r === 'object' ? r : {};
}

/** Run `encodeDownlink(data)` and return its raw result. */
function runEncodeDownlink(source, data) {
  return runFunction(source, 'encodeDownlink', data);
}

/** Run `decodeDownlink(input)` and return its raw result. */
function runDecodeDownlink(source, input) {
  return runFunction(source, 'decodeDownlink', input);
}

module.exports = {
  definesFunction,
  runDecodeUplink,
  runEncodeDownlink,
  runDecodeDownlink,
};
