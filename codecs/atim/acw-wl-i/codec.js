// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for ATIM ACW-WL-I (Indoor Liquid / Water-Leak
// Monitoring).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format (ATIM "ACW" frame protocol: a header nibble selecting frame type +
// timestamp/history flags, followed by typed sensor blocks) understood with
// reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/atim/decodeur.js, attributed in
// NOTICE). The upstream decoder is a generic multi-product interpreter that
// builds a schema string, reflects it into a verbose array-valued object, and
// then post-processes it; we re-derive only the WL-I-relevant frames
// (measurement + life + error) directly and emit normalized vocabulary keys.
// We do NOT copy upstream normalizeUplink/postProcess.
//
// The WL-I wires its liquid probe to digital input 0. The measurement frame
// carries a digital-input block (type 0x01) whose low nibble holds the four
// input states (bit 0 = input 0); input 0 high means liquid/water detected.
//
// Mappings:
//   digital input 0 state (block type 0x01)        -> water.leak (boolean)
//   temperature (block type 0x08, signed/100 °C)   -> water.temperature.current
//   life-frame node voltage (tensionv, mV/1000)    -> battery (V)
//   frame type                                     -> frameType (camelCase extra)
// Upstream's temperature read-error sentinel (-327.68 °C) is dropped and
// surfaced as a warning rather than polluting water.temperature.current.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function u16be(hi, lo) {
  return ((hi << 8) | lo) & 0xffff;
}

function s16be(hi, lo) {
  var v = u16be(hi, lo);
  return v > 0x7fff ? v - 0x10000 : v;
}

// Classify the frame from byte 0, mirroring upstream getFrameType's bit tests
// on the high nibble plus the low nibble (oct2):
//   high-nibble bit3 (0x80) clear        -> "old product" (legacy, unsupported)
//   high-nibble bit1 (0x20) set          -> measurement frame
//   else low nibble selects the subtype: 0x1 life, 0xe error
// High-nibble bit2 (0x40) flags an embedded 4-byte UNIX timestamp ("horo").
function classifyFrame(bytes) {
  if (bytes.length < 1) {
    return { kind: 'empty' };
  }
  var hi = (bytes[0] >> 4) & 0x0f;
  var lo = bytes[0] & 0x0f;
  var timestamped = (hi & 0x04) !== 0;
  if ((hi & 0x08) === 0) {
    return { kind: 'old-product' };
  }
  if ((hi & 0x02) !== 0) {
    return { kind: 'measurement', timestamped: timestamped };
  }
  if (lo === 0x01) {
    return { kind: 'life', timestamped: timestamped };
  }
  if (lo === 0x0e) {
    return { kind: 'error', timestamped: timestamped };
  }
  return { kind: 'unsupported', subtype: lo };
}

function decodeMeasurement(bytes, frame) {
  var data = {};
  var water = {};
  var warnings = [];

  var i = 1;
  // Skip the 4-byte UNIX timestamp ("horo") if present.
  if (frame.timestamped) {
    i += 4;
  }
  // The WL-I emits a single current reading (no history/sampling), so there is
  // no period header to skip and each block carries exactly one sample.

  var recognized = false;
  while (i < bytes.length) {
    // The high nibble of a block's type byte encodes the sensor channel
    // ("voie"); the WL-I uses channel 0 only, so mask to the low nibble.
    var type = bytes[i] & 0x0f;

    if (type === 0x01) {
      // Digital input: one byte of input states; bit 0 = input 0 (liquid probe).
      if (i + 1 >= bytes.length) {
        return { errors: ['truncated digital-input block'] };
      }
      water.leak = (bytes[i + 1] & 0x01) !== 0;
      i += 2;
      recognized = true;
    } else if (type === 0x08) {
      // Temperature: signed 16-bit, hundredths of a degree. Sentinel -327.68.
      if (i + 2 >= bytes.length) {
        return { errors: ['truncated temperature block'] };
      }
      var traw = s16be(bytes[i + 1], bytes[i + 2]);
      if (traw === -32768) {
        warnings.push('temperature sensor read error');
      } else {
        if (water.temperature === undefined) {
          water.temperature = {};
        }
        water.temperature.current = round(traw / 100, 2);
      }
      i += 3;
      recognized = true;
    } else {
      return {
        errors: ['unsupported sensor type 0x' + bytes[i].toString(16)]
      };
    }
  }

  if (!recognized) {
    return { errors: ['no sensor blocks in measurement frame'] };
  }
  if (water.leak === undefined && water.temperature === undefined) {
    return { errors: warnings.length ? warnings : ['no usable measurements'] };
  }

  data.water = water;
  data.frameType = 'measurement';
  var result = { data: data };
  if (warnings.length) {
    result.warnings = warnings;
  }
  return result;
}

function decodeLife(bytes, frame) {
  // Life (keep-alive) frame: optional 4-byte timestamp, then two 16-bit
  // millivolt readings: node voltage (tensionv) then capacitor voltage
  // (tensionc). The node voltage is the device battery.
  var i = 1;
  if (frame.timestamped) {
    i += 4;
  }
  if (i + 1 >= bytes.length) {
    return { errors: ['truncated life frame'] };
  }
  var battery = round(u16be(bytes[i], bytes[i + 1]) / 1000, 3);
  return { data: { battery: battery, frameType: 'life' } };
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;
  if (!bytes || bytes.length === 0) {
    return { errors: ['empty payload'] };
  }

  var frame = classifyFrame(bytes);
  if (frame.kind === 'measurement') {
    return decodeMeasurement(bytes, frame);
  }
  if (frame.kind === 'life') {
    return decodeLife(bytes, frame);
  }
  if (frame.kind === 'error') {
    return { errors: ['device error frame (no measurement)'] };
  }
  if (frame.kind === 'old-product') {
    return { errors: ['unsupported legacy ATIM frame'] };
  }
  return { errors: ['unsupported ATIM frame type'] };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "atim";
    result.data.model = "acw-wl-i";
  }
  return result;
}
