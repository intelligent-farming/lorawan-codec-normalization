// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for MCCI Model 4822 Indoor Environmental Sensor
// (Catena-class node with an SHT31 temperature/humidity sensor and an ambient
// light channel).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format (port 1, MCCI Catena sensor report format 0x14: a discriminator byte
// followed by a flag bitmap that gates each field) understood with reference to
// the upstream Apache-2.0 decoder (TheThingsNetwork/lorawan-devices
// vendor/mcci/codec-catena-generic.js, attributed in NOTICE). The upstream
// normalizeUplink is NOT copied; the normalization below is authored here.
//
// Mapping notes:
//   tempC -> air.temperature (degC), rh -> air.relativeHumidity (%),
//   p (Pa*4 LSB) -> air.pressure (hPa), lux -> air.lightIntensity (lux),
//   vBat -> battery (the MCCI int16/4096 field is already VOLTS, so it maps to
//     the volts vocabulary key directly with no percent issue).
// Derived upstream values (dew point tDewC) are NOT measurements and are
// dropped. Genuine device data with no vocabulary home is emitted as camelCase
// extras: vBus (bus voltage, V), boot (reset counter), and the optional power /
// pulse counters (powerUsedCount, powerSourcedCount, powerUsedPerHour,
// powerSourcedPerHour). Format 0x14 carries no soil/water hardware on this SKU.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function u16(bytes, i) {
  return ((bytes[i] << 8) + bytes[i + 1]) & 0xffff;
}

function i16(bytes, i) {
  var v = u16(bytes, i);
  return v > 0x7fff ? v - 0x10000 : v;
}

function uflt16(raw) {
  var exp = raw >> 12;
  var mant = (raw & 0xfff) / 4096.0;
  return mant * Math.pow(2, exp - 15);
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;
  var port = input.fPort;

  if (port !== 1) {
    return { errors: ['unsupported fPort ' + port] };
  }
  if (!bytes || bytes.length < 1) {
    return { errors: ['empty payload'] };
  }

  var format = bytes[0];
  if (format !== 0x14) {
    return { errors: ['unsupported sensor report format 0x' + format.toString(16)] };
  }
  if (bytes.length < 2) {
    return { errors: ['payload too short for flag bitmap'] };
  }

  var data = {};
  var air = {};
  var i = 1;
  var flags = bytes[i];
  i += 1;

  if (flags & 0x01) {
    // Battery: signed 16-bit, LSB = 1/4096 V. Already volts -> `battery`.
    data.battery = round(i16(bytes, i) / 4096.0, 3);
    i += 2;
  }

  if (flags & 0x02) {
    // Bus voltage: signed 16-bit, LSB = 1/4096 V. Vendor diagnostic extra.
    data.vBus = round(i16(bytes, i) / 4096.0, 3);
    i += 2;
  }

  if (flags & 0x04) {
    // Boot/reset counter: vendor diagnostic extra.
    data.boot = bytes[i];
    i += 1;
  }

  if (flags & 0x08) {
    // Temperature (int16, LSB = 1/256 degC), barometric pressure (u16, LSB =
    // 4 Pa -> hPa), relative humidity (u8, full scale 256 = 100%).
    air.temperature = round(i16(bytes, i) / 256, 4);
    i += 2;
    air.pressure = round(u16(bytes, i) * 4 / 100.0, 2);
    i += 2;
    air.relativeHumidity = round(bytes[i] / 256 * 100, 5);
    i += 1;
  }

  if (flags & 0x10) {
    // Ambient light (u16 lux).
    air.lightIntensity = u16(bytes, i);
    i += 2;
  }

  if (flags & 0x20) {
    // Watt-hour counters (u16 each). Raw device counters -> extras.
    data.powerUsedCount = u16(bytes, i);
    i += 2;
    data.powerSourcedCount = u16(bytes, i);
    i += 2;
  }

  if (flags & 0x40) {
    // Floating pulses per hour (UFLT16 each), scaled to power/hour. Extras.
    data.powerUsedPerHour = round(uflt16(u16(bytes, i)) * 60 * 60 * 4, 4);
    i += 2;
    data.powerSourcedPerHour = round(uflt16(u16(bytes, i)) * 60 * 60 * 4, 4);
    i += 2;
  }

  if (flags === 0) {
    return { errors: ['no sensor fields present in payload'] };
  }

  var hasAir = false;
  var k;
  for (k in air) {
    if (air.hasOwnProperty(k)) {
      hasAir = true;
    }
  }
  if (hasAir) {
    data.air = air;
  }

  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "mcci";
    result.data.model = "model4822";
  }
  return result;
}
