// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Nexelec Origin+ (indoor smoke detector with an
// onboard temperature + humidity sensor; "Origin+ LoRa", product byte 0xB1).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. The wire
// format (Nexelec bit-packed frame: product byte, message-type byte, then
// MSB-first bit fields extracted from the hex string) was ported from and
// normalized against the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/nexelec/origin-plus-codec.js,
// attributed in NOTICE). The upstream hex-substring/shift bit-slicing is
// reproduced exactly. The Origin+ is primarily a smoke detector; the only
// messages carrying climate telemetry are decoded here:
//
//   Real Time   (message type 0x04) — instantaneous temperature + humidity
//   Air Quality (message type 0x03) — daily min/max/avg temperature + humidity
//
// Status, configuration, smoke-alarm, and temperature-datalog messages are not
// climate telemetry and are reported as an unsupported-message error.
//
// Field mapping (hex-char offsets into the full payload, matching the upstream
// substring/shift extraction; the 2-byte header occupies chars 0..3):
//
//   Real Time (0x04):
//     temperature  hex[4:7]  >>2 &0x3FF (10b) value = code/10 - 30 °C -> air.temperature
//     humidity     hex[6:9]  >>2 &0xFF  ( 8b) value = code*0.5 %RH    -> air.relativeHumidity
//
//   Air Quality (0x03):
//     tempMin      hex[4:7]   >>2 &0x3FF (10b) code/10 - 30 °C -> temperatureMinC (extra)
//     tempMax      hex[6:9]       &0x3FF (10b) code/10 - 30 °C -> temperatureMaxC (extra)
//     tempAvg      hex[9:12]  >>2 &0x3FF (10b) code/10 - 30 °C -> air.temperature
//     humMin       hex[11:14] >>2 &0xFF  ( 8b) code*0.5 %RH    -> humidityMinPercent (extra)
//     humMax       hex[13:16] >>2 &0xFF  ( 8b) code*0.5 %RH    -> humidityMaxPercent (extra)
//     humAvg       hex[15:18] >>2 &0xFF  ( 8b) code*0.5 %RH    -> air.relativeHumidity
//
// Sensor-absent / fault sentinels are honored per the upstream temperature() and
// humidity() helpers: a 10-bit temperature code of 1022 (sensor disconnected) or
// 1023 (error) suppresses that temperature; an 8-bit humidity code of 255
// (error) suppresses that humidity. The temperature value is rounded to the
// sensor's 0.1 °C resolution (the upstream `code*0.1` arithmetic emits binary
// floating-point drift such as -21.799999999999997; we round it away).

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function bytesToHex(bytes) {
  var s = '';
  for (var i = 0; i < bytes.length; i++) {
    s += (bytes[i] & 0xff).toString(16).padStart(2, '0');
  }
  return s;
}

// A 10-bit temperature code is "absent" at 1022 (disconnected) or 1023 (error).
function tempPresent(code) {
  return code !== 1022 && code !== 1023;
}
// An 8-bit humidity code is "absent" at 255 (error).
function humPresent(code) {
  return code !== 255;
}

function tempValue(code) {
  return round(code / 10 - 30, 1);
}
function humValue(code) {
  return round(code * 0.5, 1);
}

function decodeRealTime(hex) {
  var tempCode = (parseInt(hex.substring(4, 7), 16) >> 2) & 0x3ff;
  var humCode = (parseInt(hex.substring(6, 9), 16) >> 2) & 0xff;

  var air = {};
  if (tempPresent(tempCode)) {
    air.temperature = tempValue(tempCode);
  }
  if (humPresent(humCode)) {
    air.relativeHumidity = humValue(humCode);
  }

  var data = {};
  if (air.temperature !== undefined || air.relativeHumidity !== undefined) {
    data.air = air;
  }
  return data;
}

function decodeAirQuality(hex) {
  var tminCode = (parseInt(hex.substring(4, 7), 16) >> 2) & 0x3ff;
  var tmaxCode = parseInt(hex.substring(6, 9), 16) & 0x3ff;
  var tavgCode = (parseInt(hex.substring(9, 12), 16) >> 2) & 0x3ff;
  var hminCode = (parseInt(hex.substring(11, 14), 16) >> 2) & 0xff;
  var hmaxCode = (parseInt(hex.substring(13, 16), 16) >> 2) & 0xff;
  var havgCode = (parseInt(hex.substring(15, 18), 16) >> 2) & 0xff;

  var air = {};
  if (tempPresent(tavgCode)) {
    air.temperature = tempValue(tavgCode);
  }
  if (humPresent(havgCode)) {
    air.relativeHumidity = humValue(havgCode);
  }

  var data = {};
  if (air.temperature !== undefined || air.relativeHumidity !== undefined) {
    data.air = air;
  }

  // Daily min/max have no vocabulary key — emit as camelCase extras.
  if (tempPresent(tminCode)) {
    data.temperatureMinC = tempValue(tminCode);
  }
  if (tempPresent(tmaxCode)) {
    data.temperatureMaxC = tempValue(tmaxCode);
  }
  if (humPresent(hminCode)) {
    data.humidityMinPercent = humValue(hminCode);
  }
  if (humPresent(hmaxCode)) {
    data.humidityMaxPercent = humValue(hmaxCode);
  }
  return data;
}

function decodeUplink(input) {
  var bytes = input.bytes;
  if (!bytes || bytes.length < 5) {
    return { errors: ['payload too short for a Nexelec Origin+ frame'] };
  }

  var hex = bytesToHex(bytes);
  var product = parseInt(hex.substring(0, 2), 16);
  var messageType = parseInt(hex.substring(2, 4), 16);

  if (product !== 0xb1) {
    return { errors: ['unexpected product byte (expected 0xB1 for Nexelec Origin+)'] };
  }

  var data;
  if (messageType === 0x04) {
    data = decodeRealTime(hex);
  } else if (messageType === 0x03) {
    if (bytes.length < 9) {
      return { errors: ['payload too short for a Nexelec Origin+ Air Quality frame'] };
    }
    data = decodeAirQuality(hex);
  } else {
    return {
      errors: ['unsupported message type (only Real Time 0x04 and Air Quality 0x03 carry climate data)'],
    };
  }

  return { data: data };
}
