// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Nexelec Guard+ (LoRa indoor smoke + climate
// safety monitor: temperature and relative humidity, plus smoke-detector and
// product/battery diagnostics). Product byte 0xB3 ("Guard+ LoRa") of the shared
// Nexelec Origin/Guard frame family.
//
// Original work for @intelligent-farming/lorawan-codec-normalization. The wire
// format (Nexelec bit-packed frame: product byte, message-type byte, then
// MSB-first hex-substring bit fields) was ported from and normalized against the
// upstream Apache-2.0 decoder (TheThingsNetwork/lorawan-devices
// vendor/nexelec/origin-plus-codec.js, attributed in NOTICE). The upstream
// bit-slicing (hex-string substring extraction with shifts/masks) is reproduced
// exactly. The Guard+ has NO CO2 / VOC / luminosity sensors, so only the
// temperature + humidity bearing message types are decoded here:
//
//   0x00 Product Status   -> battery (battery voltage code -> V)
//   0x02 Smoke Alarm      -> air.temperature
//   0x03 Air Quality      -> air.temperature/relativeHumidity (avg) + extras for
//                            the min/max aggregates
//   0x04 Real Time        -> air.temperature + air.relativeHumidity
//
// Field extraction (hex-char offsets into the full payload string, matching the
// upstream substring/shift/mask extraction):
//   Product Status: battery code  hex[12:14]               value = code*5 + 2000 mV -> battery (V)
//   Smoke Alarm:    temp code     (hex[9:13]  >>3) &0x3FF  value = code*0.1 - 30 °C -> air.temperature
//   Air Quality:    tempMin       (hex[4:7]   >>2) &0x3FF  value = code*0.1 - 30 °C
//                   tempMax       (hex[6:9]       ) &0x3FF
//                   tempAvg       (hex[9:12]  >>2) &0x3FF  -> air.temperature
//                   humMin        (hex[11:14] >>2) &0xFF   value = code*0.5 %RH
//                   humMax        (hex[13:16] >>2) &0xFF
//                   humAvg        (hex[15:18] >>2) &0xFF   -> air.relativeHumidity
//   Real Time:      temp code     (hex[4:7]   >>2) &0x3FF  value = code*0.1 - 30 °C -> air.temperature
//                   hum code      (hex[6:9]   >>2) &0xFF   value = code*0.5 %RH     -> air.relativeHumidity
//
// Sentinels are honored. Temperature code 1023 = "Error", 1022 = "Disconnected
// sensor"; humidity code 255 = "Error". At any sentinel the field is suppressed
// rather than emitted. (Upstream mislabels the humidity unit as "°C" — a
// copy-paste bug; the value math code*0.5 yields a percentage, normalized here
// to air.relativeHumidity.)

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

// Temperature code 1022 (disconnected) and 1023 (error) are sensor-absent.
function presentTemp(code) {
  return code < 1022;
}
// Humidity code 255 is the error sentinel.
function presentHum(code) {
  return code !== 255;
}

function tempC(code) {
  return round(code * 0.1 - 30, 1);
}
function humPct(code) {
  return round(code * 0.5, 1);
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;
  if (!bytes || bytes.length < 4) {
    return { errors: ['payload too short for a Nexelec Guard+ frame'] };
  }

  var hex = bytesToHex(bytes);
  var product = parseInt(hex.substring(0, 2), 16);
  var messageType = parseInt(hex.substring(2, 4), 16);

  if (product !== 0xb3) {
    return { errors: ['unexpected product byte (expected 0xB3 for Nexelec Guard+)'] };
  }

  var data = {};
  var air = {};

  if (messageType === 0x00) {
    // Product Status: battery voltage.
    var battCode = parseInt(hex.substring(12, 14), 16) & 0xff;
    data.battery = round((battCode * 5 + 2000) / 1000, 3);
    return { data: data };
  }

  if (messageType === 0x02) {
    // Smoke Alarm: carries the ambient temperature.
    var saTempCode = (parseInt(hex.substring(9, 13), 16) >> 3) & 0x3ff;
    if (presentTemp(saTempCode)) {
      air.temperature = tempC(saTempCode);
      data.air = air;
    }
    return { data: data };
  }

  if (messageType === 0x03) {
    // Air Quality (daily): min/max/avg temperature and humidity. The averages
    // map to the normalized vocabulary; the min/max aggregates are extras.
    var tMin = (parseInt(hex.substring(4, 7), 16) >> 2) & 0x3ff;
    var tMax = parseInt(hex.substring(6, 9), 16) & 0x3ff;
    var tAvg = (parseInt(hex.substring(9, 12), 16) >> 2) & 0x3ff;
    var hMin = (parseInt(hex.substring(11, 14), 16) >> 2) & 0xff;
    var hMax = (parseInt(hex.substring(13, 16), 16) >> 2) & 0xff;
    var hAvg = (parseInt(hex.substring(15, 18), 16) >> 2) & 0xff;

    if (presentTemp(tAvg)) {
      air.temperature = tempC(tAvg);
    }
    if (presentHum(hAvg)) {
      air.relativeHumidity = humPct(hAvg);
    }
    if (air.temperature !== undefined || air.relativeHumidity !== undefined) {
      data.air = air;
    }
    if (presentTemp(tMin)) {
      data.temperatureMinC = tempC(tMin);
    }
    if (presentTemp(tMax)) {
      data.temperatureMaxC = tempC(tMax);
    }
    if (presentHum(hMin)) {
      data.relativeHumidityMinPercent = humPct(hMin);
    }
    if (presentHum(hMax)) {
      data.relativeHumidityMaxPercent = humPct(hMax);
    }
    return { data: data };
  }

  if (messageType === 0x04) {
    // Real Time: instantaneous temperature + humidity (the core climate frame).
    var rtTempCode = (parseInt(hex.substring(4, 7), 16) >> 2) & 0x3ff;
    var rtHumCode = (parseInt(hex.substring(6, 9), 16) >> 2) & 0xff;
    if (presentTemp(rtTempCode)) {
      air.temperature = tempC(rtTempCode);
    }
    if (presentHum(rtHumCode)) {
      air.relativeHumidity = humPct(rtHumCode);
    }
    if (air.temperature !== undefined || air.relativeHumidity !== undefined) {
      data.air = air;
    }
    return { data: data };
  }

  return { errors: ['unsupported message type (Guard+ climate frames are 0x00, 0x02, 0x03, 0x04)'] };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "nexelec";
    result.data.model = "guard-plus";
  }
  return result;
}
