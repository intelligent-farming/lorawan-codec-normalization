// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Dragino SW3L (LoRaWAN Outdoor Water Flow Sensor).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. The wire
// format was understood with reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/dragino/sw3l.js, attributed in
// NOTICE); the normalization below is authored for this module, not copied.
//
// The SW3L counts turbine pulses and reports a cumulative pulse total plus a
// cumulative water volume. The pulses-per-litre constant is selected on-device
// by Calculate_flag (carried in the payload) per the bundled flow-meter model:
//   flag 2 -> 60 pulses/L, flag 1 -> 360 pulses/L, flag 0 -> 450 pulses/L.
// Cumulative volume (L) = totalPulse / (pulses-per-litre). This maps to
// metering.water.total. The raw pulse count is preserved as flowPulseTotal.
//
// Note: the upstream codec renders the payload timestamp with local-timezone
// Date methods (getHours/getMonth/...), which is non-deterministic. This codec
// emits the timestamp as a UTC RFC3339 string derived directly from the epoch.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function pad2(n) {
  return n < 10 ? '0' + n : '' + n;
}

// Epoch seconds -> RFC3339 UTC string (deterministic; no local-TZ Date methods).
function rfc3339(epochSeconds) {
  var d = new Date(epochSeconds * 1000);
  return (
    d.getUTCFullYear() +
    '-' +
    pad2(d.getUTCMonth() + 1) +
    '-' +
    pad2(d.getUTCDate()) +
    'T' +
    pad2(d.getUTCHours()) +
    ':' +
    pad2(d.getUTCMinutes()) +
    ':' +
    pad2(d.getUTCSeconds()) +
    'Z'
  );
}

function u32(bytes, i) {
  return ((bytes[i] << 24) | (bytes[i + 1] << 16) | (bytes[i + 2] << 8) | bytes[i + 3]) >>> 0;
}

// Pulses per litre, keyed by the on-device Calculate_flag.
function pulsesPerLitre(flag) {
  if (flag === 2) {
    return 60;
  }
  if (flag === 1) {
    return 360;
  }
  return 450;
}

function decodeUplink(input) {
  var bytes = input.bytes;
  var port = input.fPort;

  // fPort 2: periodic water-flow uplink.
  if (port === 2) {
    if (bytes.length < 11) {
      return { errors: ['expected at least 11 bytes on fPort 2, got ' + bytes.length] };
    }

    var data = {};
    var metering = { water: {} };

    var flag = (bytes[0] & 0xfc) >> 2;
    var alarm = (bytes[0] & 0x02) !== 0;
    var mod = bytes[5];
    var totalPulse = u32(bytes, 1);

    // Cumulative water volume (litres) from the cumulative pulse count.
    metering.water.total = round(totalPulse / pulsesPerLitre(flag), 1);
    data.metering = metering;

    // Extras: device-specific data the vocabulary does not model.
    data.flowPulseTotal = totalPulse;
    data.calculateFlag = flag;
    data.mod = mod;
    data.alarm = alarm;
    if (mod === 0x01) {
      data.lastPulse = totalPulse;
    } else {
      data.totalPulse = totalPulse;
    }
    data.time = rfc3339(u32(bytes, 7));

    return { data: data };
  }

  // fPort 5: device-status uplink (model, firmware, band, battery).
  if (port === 5) {
    if (bytes.length < 7) {
      return { errors: ['expected at least 7 bytes on fPort 5, got ' + bytes.length] };
    }

    var status = {};

    // Bytes 5-6: battery voltage, millivolts -> volts.
    status.battery = round(((bytes[5] << 8) | bytes[6]) / 1000, 3);

    if (bytes[0] === 0x11) {
      status.sensorModel = 'SW3L';
    }
    status.firmwareVersion = (bytes[1] & 0x0f) + '.' + ((bytes[2] >> 4) & 0x0f) + '.' + (bytes[2] & 0x0f);

    var bands = {
      1: 'EU868',
      2: 'US915',
      3: 'IN865',
      4: 'AU915',
      5: 'KZ865',
      6: 'RU864',
      7: 'AS923',
      8: 'AS923_1',
      9: 'AS923_2',
      10: 'AS923_3',
      11: 'CN470',
      12: 'EU433',
      13: 'KR920',
      14: 'MA869'
    };
    if (bands[bytes[3]]) {
      status.frequencyBand = bands[bytes[3]];
    }
    status.subBand = bytes[4] === 0xff ? 'NULL' : bytes[4];

    return { data: status };
  }

  return { errors: ['unsupported fPort ' + port + ' (expected 2 or 5)'] };
}
