// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for SEZO EL (sezo/sezoel) — air/ambient quality
// sensor (temperature, humidity, barometric pressure, illuminance, IAQ index,
// loudness, PIR presence, 3-axis accelerometer, 3-axis magnetometer).
//
// Ported and normalized from the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/sezo/sezo.js, attributed in NOTICE).
// The wire format is Cayenne-LPP-style: a stream of TLV records, each
//   [channel_no, sensor_type, ...big-endian data bytes]
// with per-type size/sign/divisor. The decode below faithfully reproduces the
// upstream `arrayToDecimal` (MSB-first, two's-complement for signed types,
// integer divisor; 6-byte vector types decode to x/y/z), then a normalization
// layer maps the decoded device fields onto the shared vocabulary. We author the
// normalization ourselves; the upstream `data` shape is NOT used as our output.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

// Per-sensor-type wire description, transcribed from the upstream sensor_types
// table. divisor is a single number for scalar types, or a 3-element array for
// the 6-byte vector types (accelerometer / magnetometer, per-axis).
function sensorType(t) {
  switch (t) {
    case 101: return { size: 2, name: 'luminosity', signed: false, divisor: 1 };
    case 102: return { size: 1, name: 'presence', signed: false, divisor: 1 };
    case 103: return { size: 2, name: 'temperature', signed: true, divisor: 10 };
    case 104: return { size: 1, name: 'humidity', signed: false, divisor: 2 };
    case 113: return { size: 6, name: 'accelerometer', signed: true, divisor: [1000, 1000, 1000] };
    case 114: return { size: 6, name: 'magnetometer', signed: true, divisor: [1000, 1000, 1000] };
    case 115: return { size: 2, name: 'barometer', signed: false, divisor: 10 };
    case 200: return { size: 2, name: 'battery', signed: false, divisor: 100 };
    case 201: return { size: 2, name: 'loudness', signed: true, divisor: 100 };
    case 206: return { size: 2, name: 'IAQ', signed: false, divisor: 1 };
    default: return null;
  }
}

// Big-endian (MSB-first) integer decode with optional two's-complement sign and
// integer divisor — a faithful port of the upstream arrayToDecimal. Uses
// multiply-by-256 (not the upstream bitwise `<<`) so the 6-byte vector slices
// stay exact instead of overflowing 32-bit signed ints.
function arrayToDecimal(stream, isSigned, divisor) {
  var value = 0;
  var i;
  for (i = 0; i < stream.length; i++) {
    value = (value * 256) + (stream[i] & 0xff);
  }
  if (isSigned) {
    var edge = Math.pow(2, stream.length * 8);
    var max = (edge - 1) / 2;
    if (value > max) {
      value = value - edge;
    }
  }
  return value / divisor;
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;
  if (!bytes || bytes.length === 0) {
    return { errors: ['empty payload'] };
  }

  var dev = {};
  var i = 0;
  while (i < bytes.length) {
    if (i + 1 >= bytes.length) {
      return { errors: ['truncated record at byte ' + i] };
    }
    // s_no (channel) is read but, like upstream, keys are by sensor name.
    i++; // skip channel number
    var sType = bytes[i++];
    var def = sensorType(sType);
    if (def === null) {
      return { errors: ['Sensor type error!: ' + sType] };
    }
    if (i + def.size > bytes.length) {
      return { errors: ['truncated record at byte ' + i] };
    }
    var value;
    if (def.size === 6) {
      // 6-byte vector type: three MSB-first signed axes, each its own divisor.
      value = {
        x: arrayToDecimal(bytes.slice(i + 0, i + 2), def.signed, def.divisor[0]),
        y: arrayToDecimal(bytes.slice(i + 2, i + 4), def.signed, def.divisor[1]),
        z: arrayToDecimal(bytes.slice(i + 4, i + 6), def.signed, def.divisor[2])
      };
    } else {
      value = arrayToDecimal(bytes.slice(i, i + def.size), def.signed, def.divisor);
    }
    dev[def.name] = value;
    i += def.size;
  }

  // ---- normalization layer: device fields -> vocabulary keys ----
  var data = {};
  var air = {};

  if (dev.temperature !== undefined) {
    air.temperature = round(dev.temperature, 1);
  }
  if (dev.humidity !== undefined) {
    air.relativeHumidity = round(dev.humidity, 1);
  }
  if (dev.barometer !== undefined) {
    air.pressure = round(dev.barometer, 1);
  }
  if (dev.luminosity !== undefined) {
    // luminosity (type 101) is an unsigned MSB lux count (divisor 1).
    air.lightIntensity = round(dev.luminosity, 0);
  }

  if (dev.IAQ !== undefined) {
    // IAQ is an air-quality INDEX, not a CO2 concentration — keep as a
    // camelCase extra, never map to air.co2.
    air.iaq = round(dev.IAQ, 0);
  }
  if (dev.loudness !== undefined) {
    air.loudness = round(dev.loudness, 2);
  }
  if (dev.accelerometer !== undefined) {
    // 3-axis acceleration in g; the vocabulary models no acceleration key, so
    // emit it as a camelCase extra.
    air.accelerometer = {
      x: round(dev.accelerometer.x, 3),
      y: round(dev.accelerometer.y, 3),
      z: round(dev.accelerometer.z, 3)
    };
  }
  if (dev.magnetometer !== undefined) {
    air.magnetometer = {
      x: round(dev.magnetometer.x, 3),
      y: round(dev.magnetometer.y, 3),
      z: round(dev.magnetometer.z, 3)
    };
  }

  if (air.temperature !== undefined || air.relativeHumidity !== undefined ||
      air.pressure !== undefined || air.lightIntensity !== undefined ||
      air.iaq !== undefined || air.loudness !== undefined ||
      air.accelerometer !== undefined || air.magnetometer !== undefined) {
    data.air = air;
  }

  if (dev.presence !== undefined) {
    data.action = { motion: { detected: dev.presence !== 0 } };
  }

  if (dev.battery !== undefined) {
    // battery (type 200) is reported in volts already (divisor 100 -> V).
    data.battery = round(dev.battery, 2);
  }

  var hasAny = false;
  var k;
  for (k in data) {
    if (Object.prototype.hasOwnProperty.call(data, k)) {
      hasAny = true;
      break;
    }
  }
  if (!hasAny) {
    return { errors: ['no recognized SEZO channels'] };
  }

  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "sezo";
    result.data.model = "sezoel";
  }
  return result;
}
