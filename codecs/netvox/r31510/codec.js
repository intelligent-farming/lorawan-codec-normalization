// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Netvox R31510 (R315 multi-sensor: temperature /
// humidity / light, plus binary PIR / water-leak / vibration inputs), data
// report on fPort 6.
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format understood with reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/netvox/payload/r315.js, attributed
// in NOTICE). Author the normalization here; do NOT copy upstream
// normalizeUplink.
//
// fPort 6 is a multiplexed data report whose sub-type is byte 2:
//   0x00  device-info frame (Device/SWver/HWver/Datecode) — no measurement
//   0x01  status report: battery + signed temperature (0.01 °C) + humidity
//         (0.5 %); a per-frame flag (byte 5 bit 0) tells whether the T/H
//         reading is valid (upstream emits sentinel 0xFFFF/0xFF when not)
//   0x02  illuminance report: battery + illuminance (lux, 16-bit BE) + alarms
//   0x11  function/sensor-enable + binary-sensor-state bitmask — status flags
//         only, no analog measurement
//   0x12  combined report: battery + signed temperature + humidity (0.01 %) +
//         illuminance (lux)
// fPort 7 carries configuration command responses — no measurement.
//
// Battery is volts (high bit of the voltage byte is the low-battery flag,
// surfaced as the camelCase extra `lowBattery`). Temperature -> air.temperature
// (°C); humidity -> air.relativeHumidity (%); illuminance -> air.lightIntensity
// (lux). Alarm / sensor-state bits are device status, not normalized
// measurements, and are not emitted.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

// Battery byte: low 7 bits are voltage in 0.1 V, high bit flags low battery.
function readBattery(data, voltByte) {
  if (voltByte & 0x80) {
    data.lowBattery = true;
  }
  data.battery = round((voltByte & 0x7f) / 10, 1);
}

// Signed 16-bit big-endian temperature in 0.01 °C (two's complement).
function readTemp(hi, lo) {
  var raw = (hi << 8) | lo;
  if (hi & 0x80) {
    raw = raw - 0x10000;
  }
  return round(raw / 100, 2);
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;

  if (input.fPort === 7) {
    return { errors: ['fPort 7 carries a configuration response (no measurement)'] };
  }
  if (input.fPort !== 6) {
    return { errors: ['unsupported fPort ' + input.fPort + ' (expected 6, data report)'] };
  }
  if (bytes.length < 6) {
    return { errors: ['expected at least 6 bytes, got ' + bytes.length] };
  }

  var type = bytes[2];

  if (type === 0x00) {
    return { errors: ['device info frame (no measurement)'] };
  }

  if (type === 0x01) {
    if (bytes.length < 11) {
      return { errors: ['type 0x01 status report expects 11 bytes, got ' + bytes.length] };
    }
    // Byte 5 bit 0: temperature/humidity reading valid flag.
    if ((bytes[5] & 0x01) === 0x00) {
      return { errors: ['type 0x01 status report carries no valid temperature/humidity reading'] };
    }
    var d1 = {};
    readBattery(d1, bytes[3]);
    d1.air = {
      temperature: readTemp(bytes[8], bytes[9]),
      relativeHumidity: round(bytes[10] * 0.5, 1)
    };
    return { data: d1 };
  }

  if (type === 0x02) {
    if (bytes.length < 6) {
      return { errors: ['type 0x02 illuminance report expects at least 6 bytes, got ' + bytes.length] };
    }
    var d2 = {};
    readBattery(d2, bytes[3]);
    d2.air = { lightIntensity: (bytes[4] << 8) | bytes[5] };
    return { data: d2 };
  }

  if (type === 0x11) {
    return { errors: ['type 0x11 frame carries sensor-enable / binary-state flags (no measurement)'] };
  }

  if (type === 0x12) {
    if (bytes.length < 10) {
      return { errors: ['type 0x12 combined report expects at least 10 bytes, got ' + bytes.length] };
    }
    var d3 = {};
    readBattery(d3, bytes[3]);
    d3.air = {
      temperature: readTemp(bytes[4], bytes[5]),
      relativeHumidity: round(((bytes[6] << 8) | bytes[7]) * 0.01, 2),
      lightIntensity: (bytes[8] << 8) | bytes[9]
    };
    return { data: d3 };
  }

  return { errors: ['unknown fPort 6 report type 0x' + type.toString(16)] };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "netvox";
    result.data.model = "r31510";
  }
  return result;
}
