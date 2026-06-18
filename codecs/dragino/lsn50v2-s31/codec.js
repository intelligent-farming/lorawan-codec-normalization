// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Dragino LSN50v2-S31 (Temperature & Humidity
// Sensor Node, SHT31 probe).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format ported from the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/dragino/lsn50v2-s31-codec.yaml,
// attributed in NOTICE). The LSN50v2 is a multi-mode node; the work-mode
// nibble in byte 6 selects the payload layout. The S31 ships the SHT31
// temperature/humidity probe, reported in the IIC work mode (mode 0). This
// module ports the upstream decodeUplink faithfully across all work modes,
// then normalizes: SHT31 temperature/humidity -> air; battery volts ->
// battery; the contact/door input -> action.contactState. The remaining
// Dragino diagnostic fields (analog channels, digital input, trigger flag,
// per-mode probes) are preserved as camelCase extras.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

// Sign-extend a 16-bit two's-complement value built from a high and low byte.
// Upstream uses ((hi << 24) >> 16) | lo, which sign-extends the high byte then
// merges the low byte; mirror that exactly so ported values match bit-for-bit.
function s16(hi, lo) {
  return ((hi << 24) >> 16) | lo;
}

// Sign-extend a single byte as 8-bit two's complement.
function s8(b) {
  return (b << 24) >> 24;
}

function decodeUplink(input) {
  var bytes = input.bytes;

  if (input.fPort !== 2) {
    return { errors: ['unknown FPort ' + input.fPort + ' (expected 2)'] };
  }
  if (bytes.length !== 11 && bytes.length !== 12) {
    return { errors: ['expected 11 or 12 bytes, got ' + bytes.length] };
  }

  var mode = (bytes[6] & 0x7c) >> 2;

  var data = {};
  var air = {};
  var action = {};

  // Common header (present for every mode except 3ADC and ALARM, which carry
  // their own battery/temperature in different byte positions).
  if (mode !== 2 && mode !== 31) {
    data.battery = round(((bytes[0] << 8) | bytes[1]) / 1000, 3);
    data.temperatureC1 = round(s16(bytes[2], bytes[3]) / 10, 2);
    data.adcCh0V = round(((bytes[4] << 8) | bytes[5]) / 1000, 3);
    data.digitalInputStatus = bytes[6] & 0x02 ? 'H' : 'L';
    if (mode !== 6) {
      data.extiTrigger = bytes[6] & 0x01 ? 'TRUE' : 'FALSE';
      action.contactState = bytes[6] & 0x80 ? 'closed' : 'open';
    }
  }

  if (mode === 0) {
    // IIC: SHT31 temperature/humidity, or illuminance when both H/L bytes are 0.
    data.workMode = 'IIC';
    if (((bytes[9] << 8) | bytes[10]) === 0) {
      air.lightIntensity = s16(bytes[7], bytes[8]);
    } else {
      air.temperature = round(s16(bytes[7], bytes[8]) / 10, 2);
      air.relativeHumidity = round(((bytes[9] << 8) | bytes[10]) / 10, 1);
    }
  } else if (mode === 1) {
    data.workMode = 'Distance';
    data.distanceCm = round(((bytes[7] << 8) | bytes[8]) / 10, 1);
    if (((bytes[9] << 8) | bytes[10]) !== 65535) {
      data.distanceSignalStrength = (bytes[9] << 8) | bytes[10];
    }
  } else if (mode === 2) {
    data.workMode = '3ADC';
    data.battery = round(bytes[11] / 10, 2);
    data.adcCh0V = round(((bytes[0] << 8) | bytes[1]) / 1000, 3);
    data.adcCh1V = round(((bytes[2] << 8) | bytes[3]) / 1000, 3);
    data.adcCh4V = round(((bytes[4] << 8) | bytes[5]) / 1000, 3);
    data.digitalInputStatus = bytes[6] & 0x02 ? 'H' : 'L';
    data.extiTrigger = bytes[6] & 0x01 ? 'TRUE' : 'FALSE';
    action.contactState = bytes[6] & 0x80 ? 'closed' : 'open';
    if (((bytes[9] << 8) | bytes[10]) === 0) {
      air.lightIntensity = s16(bytes[7], bytes[8]);
    } else {
      air.temperature = round(s16(bytes[7], bytes[8]) / 10, 2);
      air.relativeHumidity = round(((bytes[9] << 8) | bytes[10]) / 10, 2);
    }
  } else if (mode === 3) {
    data.workMode = '3DS18B20';
    data.temperatureC2 = round(s16(bytes[7], bytes[8]) / 10, 2);
    data.temperatureC3 = round(s16(bytes[9], bytes[10]) / 10, 2);
  } else if (mode === 4) {
    data.workMode = 'Weight';
    data.weight = s16(bytes[7], bytes[8]);
  } else if (mode === 5) {
    data.workMode = 'Count';
    data.count = (bytes[7] << 24) | (bytes[8] << 16) | (bytes[9] << 8) | bytes[10];
  } else if (mode === 31) {
    data.workMode = 'ALARM';
    data.battery = round(((bytes[0] << 8) | bytes[1]) / 1000, 3);
    data.temperatureC1 = round(s16(bytes[2], bytes[3]) / 10, 2);
    data.temperatureC1Min = s8(bytes[4]);
    data.temperatureC1Max = s8(bytes[5]);
    data.shtTempMin = s8(bytes[7]);
    data.shtTempMax = s8(bytes[8]);
    data.shtHumMin = bytes[9];
    data.shtHumMax = bytes[10];
  }

  if (air.temperature !== undefined || air.relativeHumidity !== undefined ||
      air.lightIntensity !== undefined) {
    data.air = air;
  }
  if (action.contactState !== undefined) {
    data.action = action;
  }

  return { data: data };
}
