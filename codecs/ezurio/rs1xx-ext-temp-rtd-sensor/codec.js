// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for ezurio/rs1xx-ext-temp-rtd-sensor (Sentrius RS1xx
// Ext Temp RTD Sensor): a LoRaWAN temperature probe with an external RTD element,
// reporting temperature in degrees Celsius.
//
// Derivation: wire format understood from the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/ezurio/rs1xx-ext-temp-rtd-sensor.js,
// attributed in NOTICE). Normalization authored here; the upstream decodeUplink
// output is NOT copied.
//
// All frames arrive on fPort 1; bytes[0] is the message type. The primary
// telemetry is the single-reading RTD frame (0x0B, 11 bytes):
//   bytes[0]      message type (0x0B)
//   bytes[1]      uplink options bitfield (status/request flags)
//   bytes[2..5]   temperature, upstream "fourBytesToFloat":
//                   int16BE(bytes[2],bytes[3]) / 100   (fractional part)
//                 + int16BE(bytes[4],bytes[5])         (whole degrees)
//                 -> degrees Celsius
//   bytes[6]      battery capacity bucket enum (a percent RANGE string, not a
//                 numeric percentage or a voltage)
//   bytes[7..8]   alarm message count (uint16 BE)
//   bytes[9..10]  backlog message count (uint16 BE)
//
// Battery: the RTD frame carries only a coarse capacity bucket (e.g. "80-100%"),
// not a voltage and not a single numeric percentage. Actual battery voltage is
// reported in a separate 0x0A frame. We therefore do not emit the vocabulary
// `battery` (volts) key here; the bucket is surfaced as the string extra
// `batteryCapacityRange`.
//
// Other message types (0x02 aggregate datalog, 0x03/0x04 backlog, 0x05/0x0C
// config, 0x07 firmware, 0x0A battery voltage) are not temperature telemetry and
// are reported as errors.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function s16(hi, lo) {
  var v = ((hi & 0xff) << 8) | (lo & 0xff);
  return v & 0x8000 ? v - 0x10000 : v;
}

function u16(hi, lo) {
  return ((hi & 0xff) << 8) | (lo & 0xff);
}

// Battery capacity bucket enum (upstream batteryCapacityEnum).
function batteryCapacityRange(v) {
  if (v === 0) { return '0-5%'; }
  if (v === 1) { return '5-20%'; }
  if (v === 2) { return '20-40%'; }
  if (v === 3) { return '40-60%'; }
  if (v === 4) { return '60-80%'; }
  if (v === 5) { return '80-100%'; }
  return 'unknown';
}

// Uplink options bitfield (upstream uplinkOptionsBitfield).
function decodeOptions(b) {
  var out = [];
  if (b & 0x01) { out.push('Sensor request for server time'); }
  if (b & 0x02) { out.push('Sensor configuration error'); }
  if (b & 0x04) { out.push('Sensor alarm flag'); }
  if (b & 0x08) { out.push('Sensor reset flag'); }
  if (b & 0x10) { out.push('Sensor fault flag'); }
  return out;
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;

  if (input.fPort !== 1) {
    return { errors: ['unsupported fPort ' + input.fPort + ' (expected 1)'] };
  }
  if (!bytes || bytes.length === 0) {
    return { errors: ['missing payload bytes'] };
  }

  var msgType = bytes[0];

  // Primary telemetry: single-reading RTD frame (0x0B, 11 bytes).
  if (msgType === 0x0b) {
    if (bytes.length !== 11) {
      return { errors: ['invalid RTD frame length ' + bytes.length + ' (expected 11)'] };
    }
    var frac = s16(bytes[2], bytes[3]);
    var whole = s16(bytes[4], bytes[5]);
    var temperature = round(whole + frac / 100, 2);

    var data = {};
    data.temperature = temperature;
    data.batteryCapacityRange = batteryCapacityRange(bytes[6]);
    data.uplinkOptions = decodeOptions(bytes[1]);
    data.alarmMessageCount = u16(bytes[7], bytes[8]);
    data.backlogMessageCount = u16(bytes[9], bytes[10]);
    return { data: data };
  }

  if (msgType === 0x02) {
    return { errors: ['aggregate datalog frame (0x02) is not single-reading telemetry'] };
  }
  if (msgType === 0x03 || msgType === 0x04) {
    return { errors: ['backlog frame (0x' + msgType.toString(16) + ') is historical, not current telemetry'] };
  }
  if (msgType === 0x05 || msgType === 0x0c) {
    return { errors: ['configuration frame (0x' + msgType.toString(16) + ') carries no temperature measurement'] };
  }
  if (msgType === 0x07) {
    return { errors: ['firmware-version frame (0x07) carries no measurement'] };
  }
  if (msgType === 0x0a) {
    return { errors: ['battery-voltage frame (0x0a) is not temperature telemetry'] };
  }
  return { errors: ['unknown message type 0x' + msgType.toString(16)] };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "ezurio";
    result.data.model = "rs1xx-ext-temp-rtd-sensor";
  }
  return result;
}
