// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for inBiot MICA Plus (LoRaWAN) - Indoor Air Quality
// Monitor.
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format (single-byte message-type discriminator + big-endian uint16 sensor
// fields) understood with reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/inbiot/decoder.js `InbiotDeviceDecode`,
// attributed in NOTICE). The decode logic below is ported from that reference;
// the normalization (vocabulary keys vs. extras) is authored here — the upstream
// returns a flat bag of fields, which we do not reproduce verbatim.
//
// Message types (bytes[0]): 0 = device configuration, 1 = sensor reading,
// 2 = device information. Only the sensor reading carries climate/air-quality
// measurements. The upstream `getUint16` is BIG-endian: (bytes[a]<<8)|bytes[b].
//
// Vocabulary mapping (sensor reading): temperature -> air.temperature (C, /10),
// humidity -> air.relativeHumidity (%, /10), co2 -> air.co2 (ppm). This device
// reports no atmospheric pressure, illuminance, or battery, so air.pressure,
// air.lightIntensity, and battery/batteryPercent are not emitted. Everything
// else the device measures (formaldehyde, TVOC, particulate matter, the inBiot
// comfort/IAQ indices, noise, message counter, device type/info, configuration)
// has no vocabulary key and is emitted as camelCase extras, matching the
// upstream field names (ch2o, tvoc, pm1_0, pm2_5, pm4, pm10, vIndex, tIndex,
// virusIndex, iaqIndex, moldIndex, dB, counter, type, ...).
//
// BANNED (TTN/ChirpStack console-paste rules, statically linted): no require/
// import/export/module.exports/exports, no process/Buffer/globalThis, no eval/
// new Function, no timers, no console, no fetch, no async/await/Promise, and no
// post-ES2017 syntax (?., ??, ..., BigInt/123n, #private, static{}). ES5 style
// only: var, function declarations, Math/JSON/Date, JSON-serializable output.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

// Big-endian unsigned 16-bit, matching upstream getUint16(bytes, first, second).
function u16be(bytes, first, second) {
  return ((bytes[first] << 8) | bytes[second]) & 0xffff;
}

function getUint32(bytes, start) {
  return (
    ((bytes[start] << 24) |
      (bytes[start + 1] << 16) |
      (bytes[start + 2] << 8) |
      bytes[start + 3]) >>>
    0
  );
}

function customTextDecoder(bytes, start, end) {
  var result = '';
  for (var i = start; i < end; i++) {
    if (bytes[i] === 0x00) {
      break;
    }
    result += String.fromCharCode(bytes[i]);
  }
  return result;
}

function padStartCustom(text, targetLength, padChar) {
  text = String(text);
  while (text.length < targetLength) {
    text = padChar + text;
  }
  return text;
}

function getMac(bytes, start) {
  var macString = '';
  for (var i = 0; i < 6; i++) {
    macString += padStartCustom((bytes[start + i] & 0xff).toString(16), 2, '0');
    if (i < 5) {
      macString += ':';
    }
  }
  return macString.toUpperCase();
}

function getVersion(bytes, start) {
  if (bytes[start + 1] !== 0x2e) {
    return bytes[start] + '.' + bytes[start + 2];
  }
  return customTextDecoder(bytes, start, 4);
}

function getLoRaWANRegion(region) {
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
  return regions[region] || 'UNKNOWN';
}

function getResetReason(reason) {
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
  return reasons[reason] || 'UNKNOWN (' + reason + ')';
}

// Configuration message (bytes[0] === 0): no measurements, all extras.
function decodeConfig(bytes, data) {
  data.timeToSend = bytes[1];
  data.ventilation = bytes[2];
  data.ledStatus = !!bytes[3];
  data.useWifi = !!bytes[4];
  data.lorawanRegion = getLoRaWANRegion(bytes[5]);
  data.lorawanChannelMask = bytes[6];
  data.ledConfiguration = bytes[7];
  data.touchEnable = !!bytes[8];
}

// Device information message (bytes[0] === 2): no measurements, all extras.
function decodeInfo(bytes, data) {
  data.fwVersion = getVersion(bytes, 1);
  data.model = customTextDecoder(bytes, 4, 21);
  data.micaType = customTextDecoder(bytes, 21, 30);
  data.mac = getMac(bytes, 30);
  data.resetReason = getResetReason(bytes[42]);
  data.modbusAddress = bytes[36];
  data.modbusParity = bytes[37];
  data.modbusBaudRate = getUint32(bytes, 38);
}

// Sensor reading (bytes[0] === 1). Returns true if a recognized PLUS-family
// reading was decoded. temperature/humidity/co2 map to air.*; everything else
// is a camelCase extra. The upstream gates on a 4-char device type read from
// bytes[27..31]; unknown types decode nothing.
function decodeSensor(bytes, data, air) {
  var type = customTextDecoder(bytes, 27, 31);
  if (type === '') {
    type = 'NULL';
  }
  var known = { MINI: true, MICA: true, PLUS: true, WELL: true, NULL: true };
  if (!known[type]) {
    return false;
  }
  data.type = type;

  // Vocabulary keys.
  air.temperature = round(u16be(bytes, 1, 2) / 10.0, 1);
  air.relativeHumidity = round(u16be(bytes, 3, 4) / 10.0, 1);
  air.co2 = u16be(bytes, 5, 6);

  // PLUS reports formaldehyde + the full particulate suite. These have no
  // vocabulary key -> camelCase extras (names match the upstream decoder).
  data.ch2o = u16be(bytes, 7, 8);
  data.tvoc = u16be(bytes, 9, 10);
  data.pm1_0 = u16be(bytes, 11, 12);
  data.pm2_5 = u16be(bytes, 13, 14);
  data.pm4 = u16be(bytes, 15, 16);
  data.pm10 = u16be(bytes, 17, 18);

  // inBiot comfort / air-quality indices (0-100 scores) -> extras.
  data.vIndex = bytes[32];
  data.tIndex = bytes[33];
  data.virusIndex = bytes[34];
  data.iaqIndex = bytes[35];
  data.moldIndex = bytes[36] === 0xff ? 'Calculating' : bytes[36];

  // Noise (dB SPL); only present when non-zero, 0xff means sensor preheating.
  if (bytes[37]) {
    data.dB = bytes[37] === 0xff ? 'Preheating' : bytes[37];
  }

  // Message counter -> extra.
  data.counter = u16be(bytes, 25, 26);
  return true;
}

function decodeUplink(input) {
  var bytes = input.bytes;
  if (!bytes || bytes.length === 0) {
    return { errors: ['empty payload'] };
  }

  var data = {};
  var air = {};
  var hasAir = false;

  switch (bytes[0]) {
    case 0:
      decodeConfig(bytes, data);
      break;
    case 1:
      if (!decodeSensor(bytes, data, air)) {
        return { errors: ['unrecognized inBiot device type in sensor reading'] };
      }
      hasAir = true;
      break;
    case 2:
      decodeInfo(bytes, data);
      break;
    default:
      return { errors: ['unrecognized inBiot message type ' + bytes[0]] };
  }

  if (hasAir) {
    data.air = air;
  }

  return { data: data };
}
