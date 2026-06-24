// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for TWTG NEON DS-VB-01-xx (industrial vibration
// sensor: vibration condition events, tri-axis RMS velocity + acceleration,
// temperature, battery).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. The wire
// format was ported from and normalized against the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/twtg/decoder_vb_doc-e_rev-4.js,
// attributed in NOTICE). The little-endian header / cursor scheme and the
// per-field byte offsets are reproduced from that decoder; the normalization to
// the shared vocabulary is authored here (upstream normalizeUplink is NOT
// copied).
//
// The NEON DS-VB-01 emits several message types (header low nibble):
//   3 sensor_event   -> a vibration/movement event. The device fires this when a
//                       configured threshold condition (condition_0..5) trips or
//                       on timer/button. We map the discrete event to
//                       action.motion.detected (true when any condition flag is
//                       set OR a condition trigger fired) and action.motion.count
//                       (number of conditions currently active). Temperature ->
//                       air.temperature. Tri-axis RMS velocity / acceleration are
//                       raw magnitudes and become camelCase extras.
//   4 device_status  -> battery voltage (V) -> battery; temperature -> air.temperature.
// Only protocol versions 1 and 2 are supported (matching upstream). Other
// message types (boot/activated/deactivated/sensor_data spectra) carry no
// normalized measurement and are reported as an unsupported-message error.
//
// Banned in the TTN/ChirpStack console sandbox and therefore avoided here:
//   require, import/export, module.exports, exports., process, Buffer,
//   globalThis, eval, new Function, timers, console, fetch, async/await,
//   Promise, optional chaining (?.), nullish (??), spread/rest (...), BigInt,
//   private (#) fields, static blocks. ES5-style only.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function readUint16LE(bytes, cursor) {
  var v = bytes[cursor.value] + bytes[cursor.value + 1] * 256;
  cursor.value += 2;
  return v;
}

function readInt16LE(bytes, cursor) {
  var v = bytes[cursor.value] + bytes[cursor.value + 1] * 256;
  if (v & 0x8000) {
    v = v - 0x10000;
  }
  cursor.value += 2;
  return v;
}

function readInt8(bytes, cursor) {
  var v = bytes[cursor.value];
  if (v & 0x80) {
    v = v - 0x100;
  }
  cursor.value += 1;
  return v;
}

function triAxis(bytes, cursor, reader, scale) {
  return {
    min: round(reader(bytes, cursor) * scale, 2),
    max: round(reader(bytes, cursor) * scale, 2),
    avg: round(reader(bytes, cursor) * scale, 2)
  };
}

function decodeSensorEvent(bytes) {
  // byte[0] header already consumed by caller; event body starts at byte[1].
  var expectedLength = 45;
  if (bytes.length !== expectedLength) {
    return {
      errors: [
        'Invalid sensor_event message length ' + bytes.length +
          ' instead of ' + expectedLength
      ]
    };
  }

  var cursor = { value: 1 };
  var trigger = bytes[cursor.value];
  cursor.value += 1;

  // byte[2..19]  tri-axis RMS velocity (uint16, /100), raw magnitudes
  var rmsVelocity = {
    x: triAxis(bytes, cursor, readUint16LE, 0.01),
    y: triAxis(bytes, cursor, readUint16LE, 0.01),
    z: triAxis(bytes, cursor, readUint16LE, 0.01)
  };

  // byte[20..37]  tri-axis acceleration (int16, /100), raw magnitudes
  var acceleration = {
    x: triAxis(bytes, cursor, readInt16LE, 0.01),
    y: triAxis(bytes, cursor, readInt16LE, 0.01),
    z: triAxis(bytes, cursor, readInt16LE, 0.01)
  };

  // byte[38..43]  temperature min/max/avg (int16, /100) °C
  var tempMin = round(readInt16LE(bytes, cursor) * 0.01, 2);
  var tempMax = round(readInt16LE(bytes, cursor) * 0.01, 2);
  var tempAvg = round(readInt16LE(bytes, cursor) * 0.01, 2);

  // byte[44]  condition flags (each bit = a threshold condition currently active)
  var conditions = bytes[cursor.value];
  cursor.value += 1;
  var conditionFlags = [
    conditions & 1,
    (conditions >> 1) & 1,
    (conditions >> 2) & 1,
    (conditions >> 3) & 1,
    (conditions >> 4) & 1,
    (conditions >> 5) & 1
  ];

  var activeCount = 0;
  var i;
  for (i = 0; i < conditionFlags.length; i++) {
    activeCount += conditionFlags[i];
  }

  // trigger ids 2..7 are condition_0..condition_5 (a vibration threshold fired);
  // 0 = timer, 1 = button.
  var triggeredByCondition = trigger >= 2 && trigger <= 7;
  var detected = activeCount > 0 || triggeredByCondition;

  var data = {
    action: {
      motion: {
        detected: detected,
        count: activeCount
      }
    },
    air: {
      temperature: tempAvg
    },
    temperatureMin: tempMin,
    temperatureMax: tempMax,
    rmsVelocity: rmsVelocity,
    acceleration: acceleration,
    conditionFlags: conditionFlags
  };

  return { data: data };
}

function decodeDeviceStatus(bytes) {
  var expectedLength = 24;
  if (bytes.length !== expectedLength) {
    return {
      errors: [
        'Invalid device_status message length ' + bytes.length +
          ' instead of ' + expectedLength
      ]
    };
  }

  var cursor = { value: 3 }; // skip header (1) + base config_crc (2)

  // byte[3..8]  battery voltage low/high/settle (uint16 mV -> V)
  var batteryLow = round(readUint16LE(bytes, cursor) / 1000, 3);
  var batteryHigh = round(readUint16LE(bytes, cursor) / 1000, 3);
  var batterySettle = round(readUint16LE(bytes, cursor) / 1000, 3);

  // byte[9..11]  temperature min/max/avg (int8) °C
  var tempMin = readInt8(bytes, cursor);
  var tempMax = readInt8(bytes, cursor);
  var tempAvg = readInt8(bytes, cursor);

  var data = {
    battery: batterySettle,
    air: {
      temperature: tempAvg
    },
    batteryLow: batteryLow,
    batteryHigh: batteryHigh,
    temperatureMin: tempMin,
    temperatureMax: tempMax
  };

  return { data: data };
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;
  if (!bytes || bytes.length < 1) {
    return { errors: ['empty payload'] };
  }

  var protocolVersion = bytes[0] >> 4;
  var messageType = bytes[0] & 0x0f;

  if (protocolVersion !== 1 && protocolVersion !== 2) {
    return { errors: ['Unsupported protocol version!'] };
  }

  var MSGID_SENSOR_EVENT = 3;
  var MSGID_DEVICE_STATUS = 4;

  if (messageType === MSGID_SENSOR_EVENT) {
    return decodeSensorEvent(bytes);
  }
  if (messageType === MSGID_DEVICE_STATUS) {
    return decodeDeviceStatus(bytes);
  }

  return { errors: ['Unsupported message type ' + messageType] };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "twtg";
    result.data.model = "ds-vb-01-xx";
  }
  return result;
}
