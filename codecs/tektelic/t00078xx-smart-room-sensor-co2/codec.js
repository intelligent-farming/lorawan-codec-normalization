// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Tektelic BREEZE CO2 Smart Room Sensor
// (T00078xx). Reports ambient temperature, relative humidity, CO2,
// barometric pressure, PIR motion, and battery state.
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format (Tektelic channel/type TLV on fPort 10, each field prefixed by a
// 2-byte header) understood with reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices
// vendor/tektelic/decoder_smart_room_sensor_co2.js, attributed in NOTICE).
// Author the normalization here; do NOT copy upstream's decode/flatten output.
//
// Mapping notes:
//   * Battery is reported two ways. battery_voltage (0x00 0xBA, mV) maps to
//     the vocabulary `battery` (volts). The remaining-capacity gauges are
//     percentages, so they go to the camelCase extras `batteryPercent` and
//     `displayBatteryPercent` rather than into the volts field.
//   * The sensor exposes a filtered and a raw CO2 channel. The filtered value
//     is the canonical reading -> air.co2; the raw value is kept as the
//     non-vocabulary extra `co2Raw`.
//   * The TTN product page lists a light sensor, but the device's uplink
//     decoder defines no illuminance channel, so no air.lightIntensity is
//     produced and the `light` category is not claimed.

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

function decodeUplinkCore(input) {
  var bytes = input.bytes;
  var fPort = input.fPort;

  if (fPort !== 10) {
    return { errors: ['unsupported fPort ' + fPort + '; expected data port 10'] };
  }
  if (!bytes || bytes.length === 0) {
    return { errors: ['empty payload'] };
  }

  var data = {};
  var air = {};
  var motion = {};
  var hasAir = false;
  var hasMotion = false;

  var i = 0;
  while (i + 1 < bytes.length) {
    var ch = bytes[i];
    var ty = bytes[i + 1];

    if (ch === 0x00 && ty === 0xba) {
      // battery voltage, 2 bytes, mV -> V
      data.battery = round(u16be(bytes[i + 2], bytes[i + 3]) * 0.001, 3);
      i += 4;
    } else if (ch === 0x00 && ty === 0xd3) {
      // remaining battery capacity, 1 byte, percent
      data.batteryPercent = bytes[i + 2];
      i += 3;
    } else if (ch === 0x11 && ty === 0xd3) {
      // remaining display battery capacity, 1 byte, percent
      data.displayBatteryPercent = bytes[i + 2];
      i += 3;
    } else if (ch === 0x03 && ty === 0x67) {
      // ambient temperature, 2 bytes signed, 0.1 degC
      air.temperature = round(s16be(bytes[i + 2], bytes[i + 3]) * 0.1, 1);
      hasAir = true;
      i += 4;
    } else if (ch === 0x04 && ty === 0x68) {
      // relative humidity, 1 byte, 0.5 %
      air.relativeHumidity = round(bytes[i + 2] * 0.5, 1);
      hasAir = true;
      i += 3;
    } else if (ch === 0x0c && ty === 0x73) {
      // atmospheric pressure, 2 bytes, 0.1 hPa
      air.pressure = round(u16be(bytes[i + 2], bytes[i + 3]) * 0.1, 1);
      hasAir = true;
      i += 4;
    } else if (ch === 0x0b && ty === 0xe4) {
      // CO2 concentration (filtered), 2 bytes, ppm
      air.co2 = u16be(bytes[i + 2], bytes[i + 3]);
      hasAir = true;
      i += 4;
    } else if (ch === 0x0e && ty === 0xe4) {
      // CO2 concentration (raw), 2 bytes, ppm -> non-vocab extra
      air.co2Raw = u16be(bytes[i + 2], bytes[i + 3]);
      hasAir = true;
      i += 4;
    } else if (ch === 0x0a && ty === 0x00) {
      // motion event state, 1 byte (0 = no motion, 1 = motion)
      motion.detected = bytes[i + 2] !== 0;
      hasMotion = true;
      i += 3;
    } else if (ch === 0x0d && ty === 0x04) {
      // motion event count, 2 bytes
      motion.count = u16be(bytes[i + 2], bytes[i + 3]);
      hasMotion = true;
      i += 4;
    } else {
      return {
        errors: [
          'unrecognized channel/type 0x' + ch.toString(16) + ' 0x' +
            ty.toString(16) + ' at byte ' + i,
        ],
      };
    }
  }

  if (i !== bytes.length) {
    return { errors: ['truncated field at byte ' + i] };
  }
  if (!hasAir && !hasMotion && data.battery === undefined &&
      data.batteryPercent === undefined && data.displayBatteryPercent === undefined) {
    return { errors: ['no recognized Tektelic channels'] };
  }

  if (hasAir) {
    data.air = air;
  }
  if (hasMotion) {
    data.action = { motion: motion };
  }
  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "tektelic";
    result.data.model = "t00078xx-smart-room-sensor-co2";
  }
  return result;
}
