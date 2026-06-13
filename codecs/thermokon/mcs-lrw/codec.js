// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Thermokon MCS LRW (Multi Compact Sensor —
// indoor room sensor: temperature, humidity, CO2, VOC, light, occupancy).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format (Thermokon identifier/value LPP-style stream) understood with
// reference to the upstream Apache-2.0 decoder (TheThingsNetwork/lorawan-devices
// vendor/thermokon/thermokon-codec.js, attributed in NOTICE) and the official
// Thermokon "LoRaWAN Schnittstellenbeschreibung" (interface description) data
// point table. Identifiers are decimal-tag big-endian; tags <= 0x7F are one
// byte, tags > 0x7F are two bytes.
//
// Scalings (per the Thermokon interface description data point table):
//   0x10 INT16  temperature 1   /10   (276 = 27.6 degC)
//   0x11 INT8   relative humidity /1  (54 = 54 % rH)
//   0x12 UINT16 CO2 ppm         /1    (1548 = 1548 ppm)
//   0x13 UINT16 VOC %           /1    (10 = 10 %)        -> extra `voc`
//   0x30 UINT16 absolute pressure mBar/hPa /1 -> air.pressure (already hPa)
//   0x31 INT16  differential pressure Pa /1  -> extra `differentialPressure`
//   0x40 UINT16 illuminance lux  /1   (3245 = 3245 lux) -> air.lightIntensity
//   0x41 UINT8  occupancy: bit0 state, bits1-7 motion count since last send
//   0x54 INT8   energy level     x20 = mV (75 = 1500 mV) -> battery (V)
//
// Battery is reported as millivolts; the vocabulary `battery` is volts, so the
// millivolt value is divided by 1000.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function u16be(hi, lo) {
  return ((hi << 8) | lo) & 0xffff;
}

function s16be(hi, lo) {
  var v = u16be(hi, lo);
  return v > 0x7fff ? v - 0x10000 : v;
}

function s8(v) {
  v = v & 0xff;
  return v > 0x7f ? v - 0x100 : v;
}

function decodeUplink(input) {
  var bytes = input.bytes;
  if (!bytes || bytes.length === 0) {
    return { errors: ['empty payload'] };
  }

  var data = {};
  var air = {};
  var motion = {};
  var haveAir = false;
  var haveMotion = false;
  var recognized = false;

  var i = 0;
  while (i < bytes.length) {
    var tag;
    if (bytes[i] <= 0x7f) {
      tag = bytes[i];
      i += 1;
    } else {
      if (i + 1 >= bytes.length) {
        return { errors: ['truncated identifier at offset ' + i] };
      }
      tag = ((bytes[i] << 8) | bytes[i + 1]) & 0xffff;
      i += 2;
    }

    if (tag === 0x10) {
      if (i + 1 >= bytes.length) {
        return { errors: ['truncated temperature value at offset ' + i] };
      }
      air.temperature = round(s16be(bytes[i], bytes[i + 1]) / 10, 1);
      haveAir = true;
      recognized = true;
      i += 2;
    } else if (tag === 0x11) {
      if (i >= bytes.length) {
        return { errors: ['truncated humidity value at offset ' + i] };
      }
      air.relativeHumidity = s8(bytes[i]);
      haveAir = true;
      recognized = true;
      i += 1;
    } else if (tag === 0x12) {
      if (i + 1 >= bytes.length) {
        return { errors: ['truncated CO2 value at offset ' + i] };
      }
      air.co2 = u16be(bytes[i], bytes[i + 1]);
      haveAir = true;
      recognized = true;
      i += 2;
    } else if (tag === 0x13) {
      if (i + 1 >= bytes.length) {
        return { errors: ['truncated VOC value at offset ' + i] };
      }
      data.voc = u16be(bytes[i], bytes[i + 1]);
      recognized = true;
      i += 2;
    } else if (tag === 0x30) {
      if (i + 1 >= bytes.length) {
        return { errors: ['truncated pressure value at offset ' + i] };
      }
      air.pressure = u16be(bytes[i], bytes[i + 1]);
      haveAir = true;
      recognized = true;
      i += 2;
    } else if (tag === 0x31) {
      if (i + 1 >= bytes.length) {
        return { errors: ['truncated differential pressure value at offset ' + i] };
      }
      data.differentialPressure = s16be(bytes[i], bytes[i + 1]);
      recognized = true;
      i += 2;
    } else if (tag === 0x40) {
      if (i + 1 >= bytes.length) {
        return { errors: ['truncated illuminance value at offset ' + i] };
      }
      air.lightIntensity = u16be(bytes[i], bytes[i + 1]);
      haveAir = true;
      recognized = true;
      i += 2;
    } else if (tag === 0x41) {
      if (i >= bytes.length) {
        return { errors: ['truncated occupancy value at offset ' + i] };
      }
      motion.detected = (bytes[i] & 0x01) === 1;
      motion.count = bytes[i] >> 1;
      haveMotion = true;
      recognized = true;
      i += 1;
    } else if (tag === 0x54) {
      if (i >= bytes.length) {
        return { errors: ['truncated battery value at offset ' + i] };
      }
      data.battery = round((s8(bytes[i]) * 20) / 1000, 3);
      recognized = true;
      i += 1;
    } else {
      return { errors: ['unrecognized Thermokon identifier 0x' + tag.toString(16)] };
    }
  }

  if (!recognized) {
    return { errors: ['no recognized Thermokon data points'] };
  }

  if (haveAir) {
    data.air = air;
  }
  if (haveMotion) {
    data.action = { motion: motion };
  }
  return { data: data };
}
