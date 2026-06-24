// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for ATIM ACW-THAQ (CO2/VOC/Temperature/Humidity
// Sensor).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format (ATIM "ACW" frame protocol: a header nibble selecting frame type +
// timestamp/history flags, followed by sensor type/value blocks) understood
// with reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/atim/decodeur.js, attributed in
// NOTICE). The upstream decoder is a generic multi-product interpreter that
// builds a schema string and reflects it into a verbose, array-valued object;
// we re-derive only the THAQ-relevant frames (measurement + life) directly and
// emit normalized vocabulary keys. We do NOT copy upstream normalizeUplink.
//
// Mappings:
//   temperature (type 0x08, signed/100 °C) -> air.temperature
//   humidity    (type 0x09, /100 %)        -> air.relativeHumidity
//   CO2         (type 0x0d, ppm)           -> air.co2
//   VOC index   (type 0x0c, dimensionless) -> tvoc (camelCase extra)
//   life-frame node voltage (mV/1000)      -> battery (V)
// Upstream sentinels for a failed read (temperature -327.68, humidity 327.68,
// CO2 256, VOC 512) are dropped and surfaced as warnings, matching upstream's
// "erreur" placeholder without polluting numeric vocabulary fields.

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

// Classify the frame from the high hex digit of byte 0, mirroring upstream
// getFrameType's bit tests on that nibble:
//   bit3 (0x8) clear            -> "old product" (unsupported legacy frames)
//   bit3 set + bit1 (0x2) set   -> ACW measurement frame
//   bit3 set + bit1 clear       -> other ACW frame; the low nibble of byte 0
//                                  selects the subtype (0x1 life, 0xe error)
// bit2 (0x4) of the high nibble flags an embedded 4-byte UNIX timestamp.
function classifyFrame(bytes) {
  if (bytes.length < 2) {
    return { kind: 'empty' };
  }
  var n = (bytes[0] >> 4) & 0x0f;
  var oldProduct = (n & 0x08) === 0;
  var measurement = (n & 0x02) !== 0;
  var timestamped = (n & 0x04) !== 0;
  if (oldProduct) {
    return { kind: 'old-product' };
  }
  if (measurement) {
    return { kind: 'measurement', timestamped: timestamped };
  }
  var sub = bytes[0] & 0x0f;
  if (sub === 0x01) {
    return { kind: 'life', timestamped: timestamped };
  }
  if (sub === 0x0e) {
    return { kind: 'error', timestamped: timestamped };
  }
  return { kind: 'unsupported', subtype: sub };
}

function decodeMeasurement(bytes, frame) {
  var air = {};
  var data = {};
  var warnings = [];

  var i = 1;
  // Skip the 4-byte UNIX timestamp if present (upstream "horo").
  if (frame.timestamped) {
    i += 4;
  }
  // The THAQ measurement frame carries no history/sampling header (a single
  // current reading), so there is no period field to skip.

  var recognized = false;
  while (i < bytes.length) {
    // The high bits of the type byte encode the sensor channel ("voie"); the
    // THAQ has a single temperature/humidity channel (voie 0), so mask them.
    var type = bytes[i] & 0x0f;

    if (type === 0x08) {
      // Temperature: signed 16-bit, hundredths of a degree. Sentinel -327.68.
      if (i + 2 >= bytes.length) {
        return { errors: ['truncated temperature block'] };
      }
      var traw = s16be(bytes[i + 1], bytes[i + 2]);
      if (traw === -32768) {
        warnings.push('temperature sensor read error');
      } else {
        air.temperature = round(traw / 100, 2);
      }
      i += 3;
      recognized = true;
    } else if (type === 0x09) {
      // Humidity: unsigned 16-bit, hundredths of a percent. Sentinel 327.68.
      if (i + 2 >= bytes.length) {
        return { errors: ['truncated humidity block'] };
      }
      var hraw = u16be(bytes[i + 1], bytes[i + 2]);
      if (hraw === 32768) {
        warnings.push('humidity sensor read error');
      } else {
        air.relativeHumidity = round(hraw / 100, 2);
      }
      i += 3;
      recognized = true;
    } else if (type === 0x0d) {
      // CO2: unsigned 16-bit, ppm. Sentinel 256.
      if (i + 2 >= bytes.length) {
        return { errors: ['truncated CO2 block'] };
      }
      var craw = u16be(bytes[i + 1], bytes[i + 2]);
      if (craw === 256) {
        warnings.push('CO2 sensor read error');
      } else {
        air.co2 = craw;
      }
      i += 3;
      recognized = true;
    } else if (type === 0x0c) {
      // VOC index: unsigned 16-bit, dimensionless. Sentinel 512. The vocabulary
      // has no VOC key, so emit the camelCase extra `tvoc`.
      if (i + 2 >= bytes.length) {
        return { errors: ['truncated VOC block'] };
      }
      var vraw = u16be(bytes[i + 1], bytes[i + 2]);
      if (vraw === 512) {
        warnings.push('VOC sensor read error');
      } else {
        data.tvoc = vraw;
      }
      i += 3;
      recognized = true;
    } else {
      return { errors: ['unsupported sensor type 0x' + bytes[i].toString(16)] };
    }
  }

  if (!recognized) {
    return { errors: ['no sensor blocks in measurement frame'] };
  }

  var hasAir =
    air.temperature !== undefined ||
    air.relativeHumidity !== undefined ||
    air.co2 !== undefined;
  if (hasAir) {
    data.air = air;
  }
  if (data.air === undefined && data.tvoc === undefined) {
    // Every reading was a sensor-error sentinel.
    return { errors: warnings.length ? warnings : ['no usable measurements'] };
  }

  var result = { data: data };
  if (warnings.length) {
    result.warnings = warnings;
  }
  return result;
}

function decodeLife(bytes, frame) {
  // Life (keep-alive) frame: optional 4-byte timestamp, then two 16-bit
  // millivolt readings: node voltage (tensionv) and capacitor voltage
  // (tensionc). The node voltage is the device's battery.
  var i = 1;
  if (frame.timestamped) {
    i += 4;
  }
  if (i + 1 >= bytes.length) {
    return { errors: ['truncated life frame'] };
  }
  var battery = round(u16be(bytes[i], bytes[i + 1]) / 1000, 3);
  return { data: { battery: battery } };
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
    result.data.model = "acw-thaq";
  }
  return result;
}
