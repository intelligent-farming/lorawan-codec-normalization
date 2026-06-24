// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Dingtek DT311 (Temperature & Humidity Sensor).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format (Dingtek BCD-encoded telemetry / parameter frame on FPort 3)
// understood with reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/dingtek/dt311.js, attributed in
// NOTICE). Ported from upstream decodeUplink; the normalization here is
// authored, not copied from any upstream normalizeUplink.
//
// Notes on the faithful port:
//   - Temperature and humidity are BCD-encoded across two bytes each, with a
//     dedicated temperature sign byte. Upstream emits them as `.toFixed(2)`
//     STRINGS; the vocabulary requires numbers, so we emit numeric values
//     rounded to 2 decimals (the sensor's BCD resolution).
//   - Voltage is reported in volts (raw / 100), so it maps to the vocabulary
//     `battery` (V) field directly — it is NOT a percentage.
//   - The parameter packet (frame type 3) carries only configuration
//     thresholds and no environmental readings; all of its fields are emitted
//     as camelCase extras.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function bcd2(hi, lo) {
  // Two BCD bytes -> XX.XX where hi encodes the tens/ones and lo the
  // tenths/hundredths digits.
  return (
    (hi >> 4) * 10 +
    (hi & 0x0f) +
    (lo >> 4) / 10 +
    (lo & 0x0f) / 100
  );
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;

  if (input.fPort !== 3) {
    return { errors: ['unknown FPort'] };
  }

  var frameType = bytes[3];

  if (frameType === 1 || frameType === 2) {
    // Telemetry / heartbeat frame.
    var tempSign = bytes[8];
    var tempAbs = bcd2(bytes[9], bytes[10]);
    var humidity = bcd2(bytes[11], bytes[12]);
    var temperature = tempSign === 0 ? tempAbs : -tempAbs;

    var data = {
      air: {
        temperature: round(temperature, 2),
        relativeHumidity: round(humidity, 2)
      },
      battery: round(((bytes[5] << 8) + bytes[6]) / 100, 2),
      alarmHighTemperature: (bytes[13] & 0x10) ? true : false,
      alarmLowTemperature: (bytes[13] & 0x01) ? true : false,
      alarmHighHumidity: (bytes[14] & 0x10) ? true : false,
      alarmLowHumidity: (bytes[14] & 0x01) ? true : false,
      alarmBattery: (bytes[7] & 0x01) ? true : false,
      frameCounter: (bytes[15] << 8) + bytes[16]
    };
    return { data: data };
  }

  if (frameType === 3) {
    // Parameter / configuration frame — no environmental readings.
    var highTempAbs = bytes[10];
    var lowTempAbs = bytes[12];
    return {
      data: {
        firmware: bytes[5] + '.' + bytes[6],
        uploadInterval: bytes[7],
        detectInterval: bytes[8],
        highTemperatureThreshold: bytes[9] ? 256 - highTempAbs : highTempAbs,
        lowTemperatureThreshold: bytes[11] ? -lowTempAbs : lowTempAbs,
        highHumidityThreshold: bytes[13],
        lowHumidityThreshold: bytes[14],
        batteryThreshold: bytes[16],
        workMode: bytes[15]
      }
    };
  }

  return { errors: ['wrong length'] };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "dingtek";
    result.data.model = "dt311";
  }
  return result;
}
