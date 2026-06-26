// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for ellenex/pdt2-l-v6 (PDT2-L - Differential Pressure Transmitter (ultra-low)).
//
// Ellenex "Version 6" firmware emits a CBOR-encoded map (fPort 15) keyed by
// short sensor codes carrying calibrated SI values. Original work; the CBOR key
// set and units are from Ellenex's published V6 decoder
// (github.com/ellenex/lorawan-payload-decoders), reproduced as facts — no
// upstream decoder copied. The CBOR reader is shared with ellenex/pls2-l-v6
// (authored from the Apache-2.0 TTN reference).
//
// Keys: v -> battery (mV); DP -> pressure.differential (Pa); T -> air.temperature (C)
function decodeUplinkCore(input) {
  var bytes = input.bytes;
  if (!bytes || bytes.length < 1) { return { errors: ['empty payload'] }; }
  var parsed;
  try { parsed = decodeCbor(bytes); } catch (e) { return { errors: ['CBOR decode failed: ' + e.message] }; }
  if (parsed === null || typeof parsed !== 'object' || isArray(parsed)) { return { errors: ['payload is not a CBOR map'] }; }
  var data = {};
  var produced = false;
  var k;
  for (k in parsed) {
    if (!hasOwn(parsed, k)) { continue; }
    var value = parsed[k];
    if (k === 'v') { if (typeof value === 'number' && isFinite(value)) { data.battery = round(value / 1000, 3); produced = true; } }
    else if (k === 'DP') { if (typeof value === 'number') { data.pressure = { differential: round(value, 3) }; produced = true; } }
    else if (k === 'T') { if (typeof value === 'number') { data.air = data.air || {}; data.air.temperature = round(value, 2); } }
    else { data[camel(k)] = value; }
  }
  if (!produced) { return { errors: ['no recognized sensor fields in payload'] }; }
  return { data: data };
}

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function isArray(v) {
  return Object.prototype.toString.call(v) === '[object Array]';
}

// --- CBOR decode (subset; faithful port of upstream, BigInt/Buffer-free) ---
function decodeCbor(buf) {
  var i = 0;

  function readByte() {
    if (i >= buf.length) {
      throw new Error('unexpected end of input');
    }
    return buf[i++];
  }

  function readN(n) {
    if (i + n > buf.length) {
      throw new Error('unexpected end of input');
    }
    var s = buf.slice(i, i + n);
    i += n;
    return s;
  }

  function readLength(ai) {
    if (ai < 24) {
      return ai;
    }
    if (ai === 24) {
      return readByte();
    }
    if (ai === 25) {
      var b2 = readN(2);
      return (b2[0] << 8) | b2[1];
    }
    if (ai === 26) {
      var b4 = readN(4);
      return ((b4[0] << 24) | (b4[1] << 16) | (b4[2] << 8) | b4[3]) >>> 0;
    }
    if (ai === 27) {
      // 64-bit length without BigInt: fold via multiplication.
      var b8 = readN(8);
      var hi = ((b8[0] << 24) | (b8[1] << 16) | (b8[2] << 8) | b8[3]) >>> 0;
      var lo = ((b8[4] << 24) | (b8[5] << 16) | (b8[6] << 8) | b8[7]) >>> 0;
      return hi * 4294967296 + lo;
    }
    if (ai === 31) {
      return -1; // indefinite
    }
    throw new Error('unsupported length encoding');
  }

  function parseItem() {
    var initial = readByte();
    var major = initial >> 5;
    var ai = initial & 0x1f;

    if (major === 0) {
      return readLength(ai);
    }
    if (major === 1) {
      var n = readLength(ai);
      return -1 - n;
    }
    if (major === 2) {
      var blen = readLength(ai);
      return readN(blen);
    }
    if (major === 3) {
      var tlen = readLength(ai);
      return decodeUtf8(readN(tlen));
    }
    if (major === 4) {
      var alen = readLength(ai);
      var arr = [];
      if (alen === -1) {
        while (buf[i] !== 0xff) {
          arr.push(parseItem());
        }
        i++;
      } else {
        for (var a = 0; a < alen; a++) {
          arr.push(parseItem());
        }
      }
      return arr;
    }
    if (major === 5) {
      var mlen = readLength(ai);
      var obj = {};
      if (mlen === -1) {
        while (buf[i] !== 0xff) {
          var ik = parseItem();
          obj[ik] = parseItem();
        }
        i++;
      } else {
        for (var m = 0; m < mlen; m++) {
          var dk = parseItem();
          obj[dk] = parseItem();
        }
      }
      return obj;
    }
    if (major === 7) {
      if (ai === 20) {
        return false;
      }
      if (ai === 21) {
        return true;
      }
      if (ai === 22) {
        return null;
      }
      if (ai === 25) {
        return bytesToFloat16(readN(2));
      }
      if (ai === 26) {
        var f4 = readN(4);
        return bytesToFloat32(f4[0], f4[1], f4[2], f4[3]);
      }
      if (ai === 27) {
        return bytesToFloat64(readN(8));
      }
      if (ai === 31) {
        return null;
      }
      return ai;
    }
    throw new Error('unsupported major type ' + major);
  }

  return parseItem();
}

function decodeUtf8(bytes) {
  var s = '';
  for (var j = 0; j < bytes.length; j++) {
    s += String.fromCharCode(bytes[j]);
  }
  return s;
}

// IEEE-754 half-precision (2 bytes, big-endian).
function bytesToFloat16(bytes) {
  var half = (bytes[0] << 8) | bytes[1];
  var exp = (half & 0x7c00) >> 10;
  var frac = half & 0x03ff;
  var val;
  if (exp === 0) {
    val = (frac / 1024) * Math.pow(2, -14);
  } else if (exp === 31) {
    val = frac ? NaN : Infinity;
  } else {
    val = (1 + frac / 1024) * Math.pow(2, exp - 15);
  }
  return (half & 0x8000) ? -val : val;
}

// IEEE-754 single-precision (4 bytes, big-endian).
function bytesToFloat32(b0, b1, b2, b3) {
  var bits = ((b0 << 24) | (b1 << 16) | (b2 << 8) | b3) >>> 0;
  var sign = (bits >>> 31 === 0) ? 1.0 : -1.0;
  var e = (bits >>> 23) & 0xff;
  var frac = bits & 0x7fffff;
  if (e === 0xff) {
    return frac ? NaN : sign * Infinity;
  }
  var m = (e === 0) ? frac * 2 : frac | 0x800000;
  return sign * m * Math.pow(2, e - 150);
}

// IEEE-754 double-precision (8 bytes, big-endian).
function bytesToFloat64(bytes) {
  var hi = ((bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]) >>> 0;
  var lo = ((bytes[4] << 24) | (bytes[5] << 16) | (bytes[6] << 8) | bytes[7]) >>> 0;
  var sign = (hi & 0x80000000) ? -1.0 : 1.0;
  var e = (hi >> 20) & 0x7ff;
  var mantHi = hi & 0xfffff;
  var mantissa = mantHi * 4294967296 + lo;
  if (e === 0x7ff) {
    return mantissa ? NaN : sign * Infinity;
  }
  if (e === 0) {
    return sign * mantissa * Math.pow(2, -1074);
  }
  return sign * (mantissa + 4503599627370496) * Math.pow(2, e - 1075);
}

function camel(name) {
  var cleaned = String(name).replace(/[^A-Za-z0-9]+/g, ' ').trim();
  var parts = cleaned.split(' ');
  var out = '';
  for (var p = 0; p < parts.length; p++) {
    var part = parts[p];
    if (!part) {
      continue;
    }
    if (out === '') {
      out = part.charAt(0).toLowerCase() + part.slice(1);
    } else {
      out = out + part.charAt(0).toUpperCase() + part.slice(1);
    }
  }
  return out || 'field';
}

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) { result.data.make = "ellenex"; result.data.model = "pdt2-l-v6"; }
  return result;
}
