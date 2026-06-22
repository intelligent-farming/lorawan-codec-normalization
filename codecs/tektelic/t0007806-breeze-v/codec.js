// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for the Tektelic BREEZE-V Indoor Ambient
// Environment Monitor (T0007806). Reports CO2 (pressure-compensated),
// ambient temperature, relative humidity, and barometric pressure; the same
// platform also exposes battery (voltage + remaining capacity), a PIR
// occupancy channel (motion state + event count), a raw CO2 reading, and a
// secondary display-battery capacity, surfaced as vocabulary keys or
// camelCase extras as appropriate.
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format (Tektelic two-byte header [channel, type] TLV on fPort 10,
// big-endian fields) understood with reference to the upstream Apache-2.0
// decoder (TheThingsNetwork/lorawan-devices vendor/tektelic
// decoder_breeze-v.js, attributed in NOTICE). Author the normalization here;
// upstream decode/normalizeUplink output is NOT copied.
//
// Mapping notes (port-10 channel/type headers, source of truth = upstream
// decoder object's "10" port map):
//   - battery_voltage (0x00 0xBA): uint16 BE * 0.001 V -> the vocabulary
//     `battery` field (volts), NOT batteryPercent.
//   - rem_batt_capacity_sensor (0x00 0xD3): uint8 percentage -> the extra
//     `batteryPercent` (battery is volts; a percent must not go into battery).
//   - rem_batt_capacity_display (0x11 0xD3): uint8 percentage of the optional
//     BLE display module's battery -> extra `displayBatteryPercent` (distinct
//     from the sensor's own batteryPercent).
//   - co2_pressure_compensated (0x0B 0xE4): uint16 BE ppm -> air.co2 (the
//     device's reported, pressure-corrected CO2 concentration).
//   - co2_raw (0x0E 0xE4): uint16 BE ppm, uncompensated -> extra `co2Raw`.
//   - barometric_pressure (0x0C 0x73): uint16 BE * 0.1 hPa -> air.pressure.
//   - temperature (0x03 0x67): signed16 BE * 0.1 C -> air.temperature.
//   - relative_humidity (0x04 0x68): uint8 * 0.5 % -> air.relativeHumidity.
//   - motion_event_state (0x0A 0x00): uint8 -> action.motion.detected
//     (boolean); the PIR occupancy state.
//   - motion_event_count (0x0D 0x04): uint16 BE -> action.motion.count.
//   - This device exposes no calibrated lux/illuminance channel, so no
//     air.lightIntensity (and no `light` category) is produced.

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
  var motion = {};
  var extras = {};
  var i = 0;

  while (i < bytes.length) {
    if (i + 1 >= bytes.length) {
      return { errors: ['truncated header at byte ' + i] };
    }
    var channel = bytes[i];
    var type = bytes[i + 1];

    if (channel === 0x00 && type === 0xba) {
      // Battery voltage: uint16 BE * 0.001 V -> battery (volts).
      data.battery = round(uintBE(bytes, i + 2, 2) * 0.001, 3);
      i += 4;
    } else if (channel === 0x00 && type === 0xd3) {
      // Remaining sensor battery capacity: uint8 % -> batteryPercent.
      extras.batteryPercent = uintBE(bytes, i + 2, 1);
      i += 3;
    } else if (channel === 0x11 && type === 0xd3) {
      // Remaining display-module battery capacity: uint8 % -> extra.
      extras.displayBatteryPercent = uintBE(bytes, i + 2, 1);
      i += 3;
    } else if (channel === 0x03 && type === 0x67) {
      // Ambient temperature: signed16 BE * 0.1 C -> air.temperature.
      air.temperature = round(intBE(bytes, i + 2, 2) * 0.1, 1);
      i += 4;
    } else if (channel === 0x04 && type === 0x68) {
      // Relative humidity: uint8 * 0.5 % -> air.relativeHumidity.
      air.relativeHumidity = round(uintBE(bytes, i + 2, 1) * 0.5, 1);
      i += 3;
    } else if (channel === 0x0b && type === 0xe4) {
      // CO2 (pressure-compensated): uint16 BE ppm -> air.co2.
      air.co2 = uintBE(bytes, i + 2, 2);
      i += 4;
    } else if (channel === 0x0e && type === 0xe4) {
      // CO2 (raw, uncompensated): uint16 BE ppm -> extra.
      extras.co2Raw = uintBE(bytes, i + 2, 2);
      i += 4;
    } else if (channel === 0x0c && type === 0x73) {
      // Barometric pressure: uint16 BE * 0.1 hPa -> air.pressure.
      air.pressure = round(uintBE(bytes, i + 2, 2) * 0.1, 1);
      i += 4;
    } else if (channel === 0x0a && type === 0x00) {
      // PIR motion/occupancy state: uint8 -> action.motion.detected (boolean).
      motion.detected = uintBE(bytes, i + 2, 1) > 0;
      i += 3;
    } else if (channel === 0x0d && type === 0x04) {
      // PIR motion event count: uint16 BE -> action.motion.count.
      motion.count = uintBE(bytes, i + 2, 2);
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
      air.co2 !== undefined ||
      air.pressure !== undefined) {
    data.air = air;
  }
  if (motion.detected !== undefined || motion.count !== undefined) {
    data.action = { motion: motion };
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
