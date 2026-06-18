// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for the Tektelic CLOVER Agriculture Sensor
// (T00059xx). Reports ambient temperature, relative humidity, and ambient
// light intensity; the same platform also exposes battery status, six external
// inputs (Watermark soil-moisture frequency inputs + analog voltage inputs),
// an accelerometer, an orientation alarm, a light alarm, and an MCU
// temperature, all surfaced as camelCase extras.
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format (Tektelic two-byte header [channel, type] TLV on fPort 10, big-endian
// fields) understood with reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/tektelic
// decoder_agriculture_sensor.js, attributed in NOTICE). Author the
// normalization here; upstream normalizeUplink/decode output is NOT copied.
//
// Mapping notes:
//   - Battery status (header 0x00 0xBA): the low 7 bits are the cell voltage as
//     level * 0.01 + 2.5 V -> the vocabulary `battery` field (volts), NOT
//     batteryPercent. Bit 7 is an end-of-service flag -> extra
//     `batteryEndOfService` (boolean).
//   - ambient_temperature (header 0x0B 0x67): signed16 BE * 0.1 C ->
//     air.temperature.
//   - relative_humidity (header 0x0B 0x68): uint8 * 0.5 % -> air.relativeHumidity.
//   - light_intensity (header 0x09 0x65): uint16 BE lux -> air.lightIntensity
//     (numeric illuminance, lux).
//   - light_alarm (header 0x09 0x00): uint8 categorical flag -> extra
//     `lightAlarm` (boolean), NOT pushed into air.lightIntensity.
//   - mcu_temperature (header 0x0C 0x67): signed16 BE * 0.1 C -> extra
//     `mcuTemperature` (device-internal, not ambient air temperature).
//   - Accelerometer (header 0x0A 0x71): three signed16 BE * 0.001 g ->
//     extras accelerationX/Y/Z.
//   - orientation_alarm (header 0x0A 0x00): signed8 -> extra `orientationAlarm`.
//   - External inputs 1-6 (headers 0x01..0x06): uint16 BE raw frequency (Hz,
//     Watermark soil-moisture probes) or voltage (mV) readings depending on the
//     channel. These are device-specific raw counts on a per-input scale, so
//     they are emitted as camelCase extras (input1Frequency .. input6Frequency,
//     input2Voltage .. input4Voltage), not coerced into vocabulary soil keys.
//   - This is an agriculture/climate sensor: there is no PIR/motion/occupancy
//     channel in the wire format, so no action.motion is produced.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

// Big-endian unsigned integer from a byte slice (MSB first), matching the
// upstream "unsigned" accumulation.
function uintBE(bytes, offset, length) {
  var out = 0;
  for (var i = 0; i < length; i++) {
    out = out * 256 + (bytes[offset + i] & 0xff);
  }
  return out;
}

// Big-endian signed (two's complement) integer from a byte slice.
function intBE(bytes, offset, length) {
  var out = uintBE(bytes, offset, length);
  var max = Math.pow(2, 8 * length);
  if (out >= max / 2) {
    out -= max;
  }
  return out;
}

function hex2(n) {
  return ('0' + (n === undefined ? 0 : n).toString(16)).slice(-2);
}

function decodeUplink(input) {
  var bytes = input.bytes;

  if (input.fPort !== 10) {
    return { errors: ['unsupported fPort ' + input.fPort + ' (expected data uplink on fPort 10)'] };
  }
  if (!bytes || bytes.length === 0) {
    return { errors: ['empty payload'] };
  }

  var data = {};
  var air = {};
  var extras = {};
  var i = 0;

  while (i < bytes.length) {
    if (i + 1 >= bytes.length) {
      return { errors: ['truncated header at byte ' + i] };
    }
    var channel = bytes[i];
    var type = bytes[i + 1];

    if (channel === 0x00 && type === 0xba) {
      // Battery status: low 7 bits -> level * 0.01 + 2.5 V; bit 7 -> EOS flag.
      var b = bytes[i + 2] & 0xff;
      data.battery = round((b & 0x7f) * 0.01 + 2.5, 2);
      extras.batteryEndOfService = (b & 0x80) !== 0;
      i += 3;
    } else if (channel === 0x01 && type === 0x04) {
      // External input 1 frequency (Hz): uint16 BE -> extra.
      extras.input1Frequency = uintBE(bytes, i + 2, 2);
      i += 4;
    } else if (channel === 0x02 && type === 0x02) {
      // External input 2 voltage (mV): uint16 BE -> extra.
      extras.input2Voltage = uintBE(bytes, i + 2, 2);
      i += 4;
    } else if (channel === 0x03 && type === 0x02) {
      // External input 3 voltage (mV): uint16 BE -> extra.
      extras.input3Voltage = uintBE(bytes, i + 2, 2);
      i += 4;
    } else if (channel === 0x04 && type === 0x02) {
      // External input 4 voltage (mV): uint16 BE -> extra.
      extras.input4Voltage = uintBE(bytes, i + 2, 2);
      i += 4;
    } else if (channel === 0x05 && type === 0x04) {
      // External input 5 frequency (Hz): uint16 BE -> extra.
      extras.input5Frequency = uintBE(bytes, i + 2, 2);
      i += 4;
    } else if (channel === 0x06 && type === 0x04) {
      // External input 6 frequency (Hz): uint16 BE -> extra.
      extras.input6Frequency = uintBE(bytes, i + 2, 2);
      i += 4;
    } else if (channel === 0x09 && type === 0x65) {
      // Light intensity: uint16 BE lux -> air.lightIntensity.
      air.lightIntensity = uintBE(bytes, i + 2, 2);
      i += 4;
    } else if (channel === 0x09 && type === 0x00) {
      // Light alarm: uint8 categorical flag -> extra.
      extras.lightAlarm = uintBE(bytes, i + 2, 1) > 0;
      i += 3;
    } else if (channel === 0x0a && type === 0x71) {
      // Accelerometer x/y/z: three signed16 BE * 0.001 g -> extras.
      extras.accelerationX = round(intBE(bytes, i + 2, 2) * 0.001, 3);
      extras.accelerationY = round(intBE(bytes, i + 4, 2) * 0.001, 3);
      extras.accelerationZ = round(intBE(bytes, i + 6, 2) * 0.001, 3);
      i += 8;
    } else if (channel === 0x0a && type === 0x00) {
      // Orientation alarm: signed8 -> extra.
      extras.orientationAlarm = intBE(bytes, i + 2, 1);
      i += 3;
    } else if (channel === 0x0b && type === 0x67) {
      // Ambient temperature: signed16 BE * 0.1 C -> air.temperature.
      air.temperature = round(intBE(bytes, i + 2, 2) * 0.1, 1);
      i += 4;
    } else if (channel === 0x0b && type === 0x68) {
      // Relative humidity: uint8 * 0.5 % -> air.relativeHumidity.
      air.relativeHumidity = round(uintBE(bytes, i + 2, 1) * 0.5, 1);
      i += 3;
    } else if (channel === 0x0c && type === 0x67) {
      // MCU temperature: signed16 BE * 0.1 C -> extra (not ambient air temp).
      extras.mcuTemperature = round(intBE(bytes, i + 2, 2) * 0.1, 1);
      i += 4;
    } else {
      return {
        errors: [
          'unrecognized channel/type 0x' + hex2(channel) + ' 0x' + hex2(type) + ' at byte ' + i,
        ],
      };
    }
  }

  if (air.temperature !== undefined ||
      air.relativeHumidity !== undefined ||
      air.lightIntensity !== undefined) {
    data.air = air;
  }

  var extraKeys = [];
  var k;
  for (k in extras) {
    if (Object.prototype.hasOwnProperty.call(extras, k)) {
      extraKeys.push(k);
    }
  }
  for (var j = 0; j < extraKeys.length; j++) {
    data[extraKeys[j]] = extras[extraKeys[j]];
  }

  var hasData = false;
  for (k in data) {
    if (Object.prototype.hasOwnProperty.call(data, k)) {
      hasData = true;
      break;
    }
  }
  if (!hasData) {
    return { errors: ['no decodable measurements in payload'] };
  }

  return { data: data };
}
