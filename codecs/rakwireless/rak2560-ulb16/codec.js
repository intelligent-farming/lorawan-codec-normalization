// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for the RAKwireless RAK2560 Sensor Hub configured
// with the ULB16 submersible water-level probe (the "Water Level Monitoring"
// Sensor Hub solution). Same RAK Standardized Payload (Cayenne-LPP-style TLV)
// as rak2560; this variant knows the attached probe is the ULB16 and so
// interprets the generic analog-input channel as a 4-20 mA loop current and
// converts it to a water level.
//
// Per the RAK Water Level Monitoring datasheet the ULB16 maps 4-20 mA linearly
// to a 0-5 m depth at 3.2 mA per metre (4 mA = 0 m; e.g. 4.8 mA = 0.25 m). The
// loop current arrives on a generic analog-input channel (LPP type 0x02,
// 0.01/bit), so on the plain rak2560 codec it is only an analogIn extra; here it
// becomes water.level = (mA - 4) / 3.2 (clamped to >= 0). Voltage (116) ->
// battery; any other LPP field is preserved as a camelCase extra. Wire format
// understood with reference to the upstream Apache-2.0 RAK Standardized Payload
// decoder (attributed in NOTICE).
function round(value, decimals) { var f = Math.pow(10, decimals); return Math.round(value * f) / f; }

// LPP type sizes (bytes) needed to walk the TLV stream.
function lppSize(type) {
  var t = {
    0: 1, 1: 1, 2: 2, 3: 2, 100: 4, 101: 2, 102: 1, 103: 2, 104: 1, 112: 2,
    113: 6, 115: 2, 116: 2, 117: 2, 118: 4, 120: 1, 121: 2, 125: 2, 128: 2,
    130: 4, 131: 4, 132: 2, 133: 4, 134: 6, 135: 3, 136: 9, 137: 11, 138: 2,
    142: 1, 188: 2, 190: 2, 191: 2, 192: 2, 193: 2, 194: 2, 195: 2, 203: 1
  };
  return t[type];
}
function s16(hi, lo) { var v = ((hi & 0xff) << 8) | (lo & 0xff); return (v & 0x8000) ? v - 0x10000 : v; }

function decodeUplinkCore(input) {
  var b = input.bytes;
  if (!b || b.length < 1) { return { errors: ['empty payload'] }; }
  var data = {};
  var haveLevel = false;
  var i = 0;
  while (i < b.length) {
    var channel = b[i];
    var type = b[i + 1];
    i += 2;
    var size = lppSize(type);
    if (size === undefined) { return { errors: ['unrecognized LPP sensor type: ' + type] }; }
    if (i + size > b.length) { return { errors: ['truncated payload: incomplete value for type ' + type] }; }
    if (type === 0x02) {
      // analog input = ULB16 4-20 mA loop current (0.01/bit)
      var mA = round(s16(b[i], b[i + 1]) / 100, 2);
      var level = (mA - 4.0) / 3.2;
      if (level < 0) { level = 0; }
      data.water = { level: round(level, 3) };
      data.loopCurrent = mA;
      haveLevel = true;
    } else if (type === 116) {
      data.battery = round((((b[i] & 0xff) << 8) | b[i + 1]) / 100, 2);
    } else if (type === 103) {
      data['temperature' + channel] = round(s16(b[i], b[i + 1]) / 10, 1);
    } else {
      data['lpp' + type + '_' + channel] = true;
    }
    i += size;
  }
  if (!haveLevel) { return { errors: ['no analog-input (level) channel in this frame'] }; }
  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) { result.data.make = "rakwireless"; result.data.model = "rak2560-ulb16"; }
  return result;
}
