// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for SenseCAP S2101 (LoRaWAN Air Temperature &
// Humidity Sensor).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format (SenseCAP S210x "TTN v3" frame format) understood with reference to the
// upstream Apache-2.0 decoder (TheThingsNetwork/lorawan-devices
// vendor/sensecap/sensecap210x-common-decoder.js, attributed in NOTICE).
//
// Frame layout: a packet is a sequence of 7-byte frames followed by a 2-byte
// CRC16 trailer. Each frame is [channel:1][dataID:2 LE][value:4 LE]. Telemetry
// frames carry dataID > 4096; the 4-byte value is a signed little-endian
// fixed-point integer scaled by 1000 (value = rawSigned / 1000). Measurement IDs
// are shared across the SenseCAP S21xx family: 4097 = Air Temperature (degC),
// 4098 = Air Humidity (%RH) — confirmed against the upstream telemetry example
// (payload 01011098530000010210A87A...: id 4097 -> 21.4, id 4098 -> 31.4) and the
// sibling SenseCAP S2102 codec. dataID 7 carries battery percentage + reporting
// interval; the battery percentage is the low 16 bits of the value field. The
// vocabulary `battery` is volts, so the percentage is emitted as the camelCase
// extra `batteryPercent` rather than being forced into a volts field. Any other
// telemetry measurement ID this variant does not model is emitted as a camelCase
// extra `measurement<ID>`.
//
// CRC16: the upstream snapshot stubs its crc16Check to `return true`, so the
// exact vendor polynomial/table is not recoverable from the reference. We do not
// fabricate a check; instead we enforce the structural invariant that the packet
// is a whole number of 7-byte frames plus the 2-byte CRC trailer (the upstream
// length check). A malformed length or a packet carrying no decodable telemetry
// yields an errors array.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

// Build a hex string (uppercase, zero-padded) from a byte array.
function bytesToHex(arr) {
  var s = '';
  for (var i = 0; i < arr.length; i++) {
    var n = arr[i];
    if (n < 0) {
      n = 256 + n;
    }
    var t = (n & 0xff).toString(16);
    if (t.length === 1) {
      t = '0' + t;
    }
    s += t;
  }
  return s.toUpperCase();
}

// Reverse a hex substring byte-by-byte (little-endian -> big-endian ordering).
function leReverseHex(hex) {
  var out = '';
  for (var i = hex.length - 2; i >= 0; i -= 2) {
    out += hex.substring(i, i + 2);
  }
  return out;
}

// Interpret a little-endian hex string as an unsigned integer.
function leToUnsigned(hex) {
  return parseInt(leReverseHex(hex), 16);
}

// Decode a 4-byte little-endian signed fixed-point telemetry value, scaled /1000,
// matching the upstream ttnDataFormat two's-complement handling.
function decodeTelemetryValue(hex8) {
  var be = leReverseHex(hex8);
  var raw = parseInt(be, 16);
  // 32-bit two's complement: high bit set -> negative.
  if (raw >= 0x80000000) {
    raw = raw - 0x100000000;
  }
  return raw / 1000;
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;

  if (!bytes || bytes.length < 9) {
    return { errors: ['payload too short for a SenseCAP S210x frame'] };
  }

  var hex = bytesToHex(bytes);

  // Length check: total bytes minus the 2-byte CRC trailer must be a whole
  // number of 7-byte frames.
  if ((bytes.length - 2) % 7 !== 0) {
    return { errors: ['length check failed: not a whole number of 7-byte frames'] };
  }

  var data = {};
  var air = {};
  var hasAir = false;
  var hasTelemetry = false;

  // Iterate frames; the last 2 bytes are the CRC trailer (4 hex chars).
  var frameHexLen = 14;
  for (var i = 0; i + 4 <= hex.length - 4; i += frameHexLen) {
    var frame = hex.substring(i, i + frameHexLen);
    if (frame.length < frameHexLen) {
      break;
    }
    var dataID = leToUnsigned(frame.substring(2, 6));
    var valueHex = frame.substring(6, 14);

    if (dataID > 4096) {
      // Telemetry frame.
      var value = decodeTelemetryValue(valueHex);
      if (dataID === 4097) {
        air.temperature = round(value, 1);
        hasAir = true;
        hasTelemetry = true;
      } else if (dataID === 4098) {
        air.relativeHumidity = round(value, 1);
        hasAir = true;
        hasTelemetry = true;
      } else {
        // Telemetry the S2101 vocabulary mapping does not model -> camelCase extra.
        data['measurement' + dataID] = round(value, 3);
        hasTelemetry = true;
      }
    } else if (dataID === 7) {
      // Battery percentage + reporting interval. Battery lives in the low 16
      // bits, interval in the high 16 bits of the value field.
      var u = leToUnsigned(valueHex);
      data.batteryPercent = u & 0xffff;
      hasTelemetry = true;
    }
    // dataIDs 0-6 / 0x120 are version / sensor-id / interval / remove-sensor
    // control frames carrying no measurement; intentionally skipped.
  }

  if (hasAir) {
    data.air = air;
  }

  if (!hasTelemetry) {
    return { errors: ['no telemetry in payload'] };
  }

  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "sensecap";
    result.data.model = "sensecaps2101-temp-humid";
  }
  return result;
}
