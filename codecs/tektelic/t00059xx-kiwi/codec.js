// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for the Tektelic KIWI Agriculture Sensor
// (T00059xx). Reports battery, ambient temperature, relative humidity and a
// numeric ambient-light reading; the shared agriculture decoder table also
// exposes analog/frequency inputs, an accelerometer, a light alarm and MCU
// temperature, which are surfaced as camelCase extras.
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format (Tektelic header/value TLV on fPort 10, big-endian fields) understood
// with reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/tektelic
// decoder_agriculture_sensor.js, attributed in NOTICE). The normalization is
// authored here; the upstream table-driven decode is NOT copied.
//
// Mapping notes:
//   - Battery Status (header 0x00 0xBA): the low 7 bits are the voltage
//     (value * 0.01 + 2.5 V) -> the vocabulary `battery` field (volts, not
//     batteryPercent); bit 7 is an end-of-shelf-life flag -> extra
//     `batteryEndOfShelfLifeAlert`.
//   - ambient_temperature (header 0x0B 0x67): signed16 BE * 0.1 C ->
//     air.temperature.
//   - relative_humidity (header 0x0B 0x68): uint8 * 0.5 % -> air.relativeHumidity.
//   - light_intensity (header 0x09 0x65): uint16 BE lux -> air.lightIntensity.
//   - light_alarm (header 0x09 0x00): uint8 categorical flag -> extra
//     `lightAlarm` (not pushed into the numeric air.lightIntensity).
//   - mcu_temperature (header 0x0C 0x67): signed16 BE * 0.1 C -> extra
//     `mcuTemperature` (board temperature, not ambient air temperature).
//   - Accelerometer Data (header 0x0A 0x71): x/y/z signed16 BE * 0.001 g ->
//     extras accelerationX/Y/Z.
//   - orientation_alarm (header 0x0A 0x00): signed8 -> extra orientationAlarm.
//   - inputN_frequency/inputN_voltage (headers 0x0n 0x04 / 0x0n 0x02): uint16 BE
//     raw external-connector readings -> extras inputNFrequency / inputNVoltage.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

// Big-endian unsigned integer from a byte slice (MSB first).
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
  return ('0' + (n & 0xff).toString(16)).slice(-2);
}

function decodeUplink(input) {
  var bytes = input.bytes;

  if (input.fPort !== 10) {
    return {
      errors: ['unsupported fPort ' + input.fPort + ' (expected data uplink on fPort 10)'],
    };
  }
  if (!bytes || bytes.length === 0) {
    return { errors: ['empty payload'] };
  }

  var data = {};
  var air = {};
  var extras = {};
  var i = 0;

  while (i < bytes.length) {
    var channel = bytes[i];
    var type = bytes[i + 1];

    if (channel === 0x00 && type === 0xba) {
      // Battery Status: low 7 bits = voltage * 0.01 + 2.5 V; bit 7 = EOS flag.
      var b = uintBE(bytes, i + 2, 1);
      data.battery = round((b & 0x7f) * 0.01 + 2.5, 2);
      extras.batteryEndOfShelfLifeAlert = ((b >> 7) & 0x01) > 0;
      i += 3;
    } else if (channel === 0x01 && type === 0x04) {
      extras.input1Frequency = uintBE(bytes, i + 2, 2);
      i += 4;
    } else if (channel === 0x02 && type === 0x02) {
      extras.input2Voltage = uintBE(bytes, i + 2, 2);
      i += 4;
    } else if (channel === 0x03 && type === 0x02) {
      extras.input3Voltage = uintBE(bytes, i + 2, 2);
      i += 4;
    } else if (channel === 0x04 && type === 0x02) {
      extras.input4Voltage = uintBE(bytes, i + 2, 2);
      i += 4;
    } else if (channel === 0x05 && type === 0x04) {
      extras.input5Frequency = uintBE(bytes, i + 2, 2);
      i += 4;
    } else if (channel === 0x06 && type === 0x04) {
      extras.input6Frequency = uintBE(bytes, i + 2, 2);
      i += 4;
    } else if (channel === 0x09 && type === 0x65) {
      // Ambient light intensity: uint16 BE lux -> air.lightIntensity.
      air.lightIntensity = uintBE(bytes, i + 2, 2);
      i += 4;
    } else if (channel === 0x09 && type === 0x00) {
      // Categorical light alarm flag -> extra (not numeric lux).
      extras.lightAlarm = uintBE(bytes, i + 2, 1) > 0;
      i += 3;
    } else if (channel === 0x0a && type === 0x71) {
      // Acceleration vector x/y/z: signed16 BE * 0.001 g -> extras.
      extras.accelerationX = round(intBE(bytes, i + 2, 2) * 0.001, 3);
      extras.accelerationY = round(intBE(bytes, i + 4, 2) * 0.001, 3);
      extras.accelerationZ = round(intBE(bytes, i + 6, 2) * 0.001, 3);
      i += 8;
    } else if (channel === 0x0a && type === 0x00) {
      // Orientation alarm: signed8 -> extra.
      extras.orientationAlarm = intBE(bytes, i + 2, 1);
      i += 3;
    } else if (channel === 0x0b && type === 0x67) {
      // Ambient temperature: signed16 BE * 0.1 C.
      air.temperature = round(intBE(bytes, i + 2, 2) * 0.1, 1);
      i += 4;
    } else if (channel === 0x0b && type === 0x68) {
      // Relative humidity: uint8 * 0.5 %.
      air.relativeHumidity = round(uintBE(bytes, i + 2, 1) * 0.5, 1);
      i += 3;
    } else if (channel === 0x0c && type === 0x67) {
      // MCU/board temperature: signed16 BE * 0.1 C -> extra (not ambient air temp).
      extras.mcuTemperature = round(intBE(bytes, i + 2, 2) * 0.1, 1);
      i += 4;
    } else {
      return {
        errors: [
          'unrecognized channel/type 0x' +
            hex2(channel) +
            '/0x' +
            hex2(type === undefined ? 0 : type) +
            ' at byte ' +
            i,
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
