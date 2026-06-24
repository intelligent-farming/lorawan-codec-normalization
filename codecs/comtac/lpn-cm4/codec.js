// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for comtac LPN CM-4 (Temperature & Humidity Sensor).
//
// Ported/normalized from the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/comtac/lpn-cm4.js, attributed in
// NOTICE). We author the normalization here; the upstream tempNOW/humNOW array
// shape and its `batLevel` field are not reused as output.
//
// Wire format (uplinks dispatch on fPort):
//   fPort 3   DATA   : version(0x01) reserved reserved battery
//                      then a type marker:
//                        0x03 EVENT   -> temp(2 BE, signed, /100) hum(1)
//                        0x04 HISTORY -> 8 x [temp(2 BE, signed, /100) hum(1)]
//   fPort 100 CONFIG : device configuration / thresholds (vendor extras)
//   fPort 101 INFO   : firmware version (vendor extras)
// Any other fPort, or a payload whose first byte is not version 0x01, is an
// error.
//
// Battery (`data[3] / 2`) is a PERCENTAGE, not a voltage; the vocabulary
// `battery` is volts, so it is emitted as the camelCase extra `batteryPercent`.
//
// The HISTORY frame carries 8 temp/hum samples but NO per-sample timestamps and
// no base time, so a vocabulary `history` array (whose entries must each carry
// an RFC3339 `time`) cannot be produced. The newest sample (index 0, matching
// the EVENT frame's "NOW" reading) is emitted at the top level as air.*, and the
// remaining samples are preserved as the camelCase extra `additionalSamples`
// (vendor diagnostic data the vocabulary does not model).
//
// A reading equal to the sentinel 250 (INVALID_TEMP / INVALID_HUM) is treated as
// "no reading" and that air.* key is omitted rather than emitted as a sentinel.

var PAYLOAD_VERSION = 0x01;

var DATA_PORT = 3;
var CONFIG_PORT = 100;
var INFO_PORT = 101;

var TYPE_TEMP_HUM_EVENT = 0x03;
var TYPE_TEMP_HUM_HISTORY = 0x04;

var INVALID_HUM = 250;
var INVALID_TEMP = 250;

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function s16be(hi, lo) {
  var v = ((hi << 8) | lo) & 0xffff;
  return v > 0x7fff ? v - 0x10000 : v;
}

function s8(b) {
  var v = b & 0xff;
  return v > 0x7f ? v - 0x100 : v;
}

// Parse one temp/hum sample. Returns an object with a key omitted when its
// reading is the INVALID sentinel.
function readSample(bytes, o) {
  var sample = {};
  var temp = round(s16be(bytes[o], bytes[o + 1]) / 100, 2);
  var hum = bytes[o + 2];
  if (temp !== INVALID_TEMP) {
    sample.temperature = temp;
  }
  if (hum !== INVALID_HUM) {
    sample.relativeHumidity = hum;
  }
  return sample;
}

function decodeData(bytes) {
  if (bytes[0] !== PAYLOAD_VERSION) {
    return { errors: ['invalid payload version ' + bytes[0]] };
  }

  var data = {};
  data.batteryPercent = bytes[3] / 2;

  var marker = bytes[4];

  if (marker === TYPE_TEMP_HUM_EVENT) {
    data.air = readSample(bytes, 5);
    return { data: data };
  }

  if (marker === TYPE_TEMP_HUM_HISTORY) {
    var samples = [];
    var i;
    for (i = 0; i < 8; i++) {
      samples.push(readSample(bytes, 5 + i * 3));
    }
    data.air = samples[0];
    var extra = [];
    for (i = 1; i < samples.length; i++) {
      extra.push(samples[i]);
    }
    data.additionalSamples = extra;
    return { data: data };
  }

  return { errors: ['unknown data type marker 0x' + marker.toString(16)] };
}

function decodeConfig(bytes) {
  if (bytes[0] !== PAYLOAD_VERSION) {
    return { errors: ['invalid payload version ' + bytes[0]] };
  }
  var data = {};
  data.batteryPercent = bytes[3] / 2;
  data.measRate = (bytes[4] << 8) | bytes[5];
  data.historyTrigger = bytes[6];
  data.tempOffset = round(s16be(bytes[7], bytes[8]) / 100, 2);
  data.tempMax = s8(bytes[9]);
  data.tempMin = s8(bytes[10]);
  data.humOffset = s8(bytes[11]);
  data.humMax = bytes[12];
  data.humMin = bytes[13];
  return { data: data };
}

function decodeInfo(bytes) {
  if (bytes[0] !== PAYLOAD_VERSION) {
    return { errors: ['invalid payload version ' + bytes[0]] };
  }
  var data = {};
  data.batteryPercent = bytes[3] / 2;
  data.appMainVersion = bytes[4];
  data.appMinorVersion = bytes[5];
  return { data: data };
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;
  if (!bytes || bytes.length < 1) {
    return { errors: ['empty payload'] };
  }

  if (input.fPort === DATA_PORT) {
    return decodeData(bytes);
  }
  if (input.fPort === CONFIG_PORT) {
    return decodeConfig(bytes);
  }
  if (input.fPort === INFO_PORT) {
    return decodeInfo(bytes);
  }
  return { errors: ['invalid fPort ' + input.fPort] };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "comtac";
    result.data.model = "lpn-cm4";
  }
  return result;
}
