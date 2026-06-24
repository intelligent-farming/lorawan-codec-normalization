// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for inBiot MICA WELL (well-lora) — a LoRaWAN indoor
// air-quality monitor (temperature, humidity, CO2, formaldehyde, TVOC,
// particulate matter, ozone, NO2, CO, comfort indices and noise).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format understood with reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/inbiot/decoder.js, attributed in
// NOTICE). Authored normalization — upstream normalizeUplink is NOT copied.
//
// The first byte selects the message kind: 0 = device configuration, 1 = sensor
// reading, 2 = device information. Only the sensor message carries vocabulary
// measurements: temperature -> air.temperature, humidity ->
// air.relativeHumidity, CO2 -> air.co2. Every other field the device reports
// (TVOC, formaldehyde, PM, gases, comfort indices, noise, counters, identity)
// has no vocabulary key, so it is emitted as a camelCase extra under the
// upstream field name. Gas sensors that are still warming up report 0xffff and
// surface as the string "Preheating"; the mould index reports 0xff as
// "Calculating" — these strings are preserved as-is.
//
// Divergence from upstream: an unrecognized leading byte returns
// { errors: [...] } instead of upstream's bare { data: {} } (the output
// contract forbids empty objects).

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function u16be(bytes, hi, lo) {
  return ((bytes[hi] << 8) | bytes[lo]) & 0xffff;
}

function u32be(bytes, start) {
  return (
    ((bytes[start] << 24) |
      (bytes[start + 1] << 16) |
      (bytes[start + 2] << 8) |
      bytes[start + 3]) >>> 0
  );
}

function textSlice(bytes, start, end) {
  var result = '';
  for (var i = start; i < end && i < bytes.length; i++) {
    if (bytes[i] === 0x00) {
      break;
    }
    result += String.fromCharCode(bytes[i]);
  }
  return result;
}

function pad2(text) {
  text = String(text);
  while (text.length < 2) {
    text = '0' + text;
  }
  return text;
}

function macString(bytes, start) {
  var parts = [];
  for (var i = 0; i < 6; i++) {
    parts.push(pad2((bytes[start + i] || 0).toString(16)));
  }
  return parts.join(':').toUpperCase();
}

function firmwareVersion(bytes, start) {
  if (bytes[start + 1] !== 0x2e) {
    return bytes[start] + '.' + bytes[start + 2];
  }
  return textSlice(bytes, start, 4);
}

function lorawanRegion(code) {
  var regions = {
    0: 'AS923',
    10: 'AS923-JP',
    1: 'AU915',
    2: 'CN470',
    3: 'CN779',
    4: 'EU433',
    5: 'EU868',
    6: 'KR920',
    7: 'IN865',
    8: 'US915',
    9: 'RU864'
  };
  return regions[code] || 'UNKNOWN';
}

function resetReason(code) {
  var reasons = {
    0: '0 Reset reason cannot be determined',
    1: '1 Reset due to power-on event',
    2: '2 Reset by external pin',
    3: '3 Software reset via esp_restart',
    4: '4 Software reset due to exception/panic',
    5: '5 Reset due to interrupt watchdog',
    6: '6 Reset due to task watchdog',
    7: '7 Reset due to other watchdogs',
    8: '8 Reset after exiting deep sleep mode',
    9: '9 Brownout reset',
    10: '10 Reset over SDIO'
  };
  return reasons[code] || 'UNKNOWN (' + code + ')';
}

// 0xffff means a gas sensor is still warming up.
function gas(bytes, hi, lo) {
  var v = u16be(bytes, hi, lo);
  return v === 0xffff ? 'Preheating' : v;
}

function decodeSensor(bytes) {
  var type = textSlice(bytes, 27, 31);
  if (type === '') {
    type = 'NULL';
  }
  var known = {
    MINI: true,
    MICA: true,
    PLUS: true,
    WELL: true,
    NULL: true
  };
  if (!known[type]) {
    return { errors: ['unknown inBiot device type "' + type + '"'] };
  }

  var data = {};
  var air = {};

  data.type = type;

  air.temperature = round(u16be(bytes, 1, 2) / 10, 1);
  air.relativeHumidity = round(u16be(bytes, 3, 4) / 10, 1);
  air.co2 = u16be(bytes, 5, 6);

  if (type !== 'MINI') {
    data.tvoc = u16be(bytes, 9, 10);
    data.pm2_5 = u16be(bytes, 13, 14);
    data.pm10 = u16be(bytes, 17, 18);
  }
  if (type === 'PLUS' || type === 'WELL' || type === 'NULL') {
    data.ch2o = u16be(bytes, 7, 8);
    data.pm1_0 = u16be(bytes, 11, 12);
    data.pm4 = u16be(bytes, 15, 16);
  }
  if (type === 'WELL' || type === 'NULL') {
    data.o3 = gas(bytes, 19, 20);
    data.no2 = gas(bytes, 21, 22);
    var co = u16be(bytes, 23, 24);
    data.co = co === 0xffff ? 'Preheating' : round(co / 10, 1);
  }

  data.vIndex = bytes[32];
  data.tIndex = bytes[33];
  data.virusIndex = bytes[34];
  data.iaqIndex = bytes[35];
  data.moldIndex = bytes[36] === 0xff ? 'Calculating' : bytes[36];
  if (bytes[37]) {
    data.noise = bytes[37] === 0xff ? 'Preheating' : bytes[37];
  }
  data.counter = u16be(bytes, 25, 26);

  data.air = air;
  return { data: data };
}

function decodeConfig(bytes) {
  return {
    data: {
      timeToSend: bytes[1],
      ventilation: bytes[2],
      ledStatus: !!bytes[3],
      useWifi: !!bytes[4],
      lorawanRegion: lorawanRegion(bytes[5]),
      lorawanChannelMask: bytes[6],
      ledConfiguration: bytes[7],
      touchEnable: !!bytes[8]
    }
  };
}

function decodeInfo(bytes) {
  return {
    data: {
      fwVersion: firmwareVersion(bytes, 1),
      deviceModel: textSlice(bytes, 4, 21),
      micaType: textSlice(bytes, 21, 30),
      mac: macString(bytes, 30),
      resetReason: resetReason(bytes[42]),
      modbusAddress: bytes[36],
      modbusParity: bytes[37],
      modbusBaudRate: u32be(bytes, 38)
    }
  };
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;
  if (!bytes || bytes.length === 0) {
    return { errors: ['empty payload'] };
  }
  switch (bytes[0]) {
    case 0:
      return decodeConfig(bytes);
    case 1:
      return decodeSensor(bytes);
    case 2:
      return decodeInfo(bytes);
    default:
      return { errors: ['unrecognized message type ' + bytes[0]] };
  }
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "inbiot";
    result.data.model = "well-lora";
  }
  return result;
}
