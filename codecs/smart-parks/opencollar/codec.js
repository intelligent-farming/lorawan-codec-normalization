// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Smart Parks OpenCollar (Wildlife Protection
// animal-tracking collar: GNSS position + accelerometer + onboard temperature).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format (per-fPort frame layout) understood with reference to the upstream
// Apache-2.0 decoder (TheThingsNetwork/lorawan-devices
// vendor/smart-parks/opencollar-v26.js, attributed in NOTICE). The upstream
// decodeUplink is NOT copied as our output; normalization is authored here.
//
// fPorts that carry normalized measurement data:
//   - port 1  : periodic GPS fix frame  -> position + action.motion + extras
//   - port 12 : status frame            -> position + air.temperature + battery
//   - port 11 : GPS location-history frame -> history[] of positions
// fPorts that carry no normalized vocabulary data are reported as errors:
//   - port 3  : device settings/configuration readback
//   - port 30 : VSWR antenna diagnostic
//
// Mapping notes:
//   - GPS lat/lon (24-bit packed, scaled 0..0xffffff over the WGS84 range)
//                              -> position.latitude / position.longitude
//   - onboard temperature      -> air.temperature (get_num companding, -20..80 C)
//   - port-1 `motion` flag      -> action.motion.detected (genuine activity flag)
//   - battery (mV)             -> battery (volts, /1000)
//   - accelerometer axes, altitude, satellites, hdop, light, GPS quality,
//     diagnostics, pulse/fence telemetry, reset cause -> camelCase extras
//
// The device's TTN sensor list claims humidity, but the decoder emits NO
// humidity on any fPort, so `climate` (which requires air.relativeHumidity) is
// NOT a satisfied category and is not claimed.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

// Inverse of the device's linear companding: an integer sample `x` quantised to
// `precision` bits maps back onto the range [min, max]. Mirrors the upstream
// get_num() so decoded values match the device exactly.
function getNum(x, min, max, precision, decimals) {
  var range = max - min;
  var newRange = (Math.pow(2, precision) - 1) / range;
  var backX = x / newRange;
  if (backX === 0) {
    backX = min;
  } else if (backX === max - min) {
    backX = max;
  } else {
    backX += min;
  }
  return round(backX, decimals);
}

// 24-bit big-endian packed GPS coordinate -> decimal degrees, or null when the
// raw value is zero (device convention for "no fix on this axis").
function gpsLat(b0, b1, b2) {
  var raw = ((b0 << 16) >>> 0) + ((b1 << 8) >>> 0) + b2;
  if (raw === 0) {
    return null;
  }
  return round((raw / 16777215.0) * 180 - 90, 5);
}

function gpsLon(b0, b1, b2) {
  var raw = ((b0 << 16) >>> 0) + ((b1 << 8) >>> 0) + b2;
  if (raw === 0) {
    return null;
  }
  return round((raw / 16777215.0) * 360 - 180, 5);
}

function rfc3339(epochSeconds) {
  return new Date(epochSeconds * 1000).toISOString();
}

var RESET_CAUSE = {
  0: 'POWERON',
  1: 'EXTERNAL',
  2: 'SOFTWARE',
  3: 'WATCHDOG',
  4: 'FIREWALL',
  5: 'OTHER',
  6: 'STANDBY'
};

function decodeUplink(input) {
  var bytes = input.bytes;
  var port = input.fPort;

  if (!bytes) {
    return { errors: ['missing payload bytes'] };
  }

  if (port === 1) {
    return decodePort1(bytes);
  }
  if (port === 11) {
    return decodePort11(bytes);
  }
  if (port === 12) {
    return decodePort12(bytes);
  }
  if (port === 3) {
    return { errors: ['fPort 3 is a settings/configuration frame with no normalized measurement data'] };
  }
  if (port === 30) {
    return { errors: ['fPort 30 is a VSWR diagnostic frame with no normalized measurement data'] };
  }
  return { errors: ['unsupported fPort ' + port] };
}

// Periodic GPS fix frame.
function decodePort1(bytes) {
  if (bytes.length < 18) {
    return { errors: ['fPort 1 frame too short: expected 18 bytes, got ' + bytes.length] };
  }

  var data = {};

  var lat = gpsLat(bytes[0], bytes[1], bytes[2]);
  var lon = gpsLon(bytes[3], bytes[4], bytes[5]);
  if (lat !== null && lon !== null) {
    data.position = { latitude: lat, longitude: lon };
  }

  data.gpsAltitude = bytes[6] | (bytes[7] << 8);
  data.gpsSatellites = bytes[8] >> 4;
  data.gpsHdop = bytes[8] & 0x0f;
  data.gpsTimeToFix = bytes[9];
  data.gpsEpe = bytes[10];
  data.gpsSnr = bytes[11];
  data.light = bytes[12];

  // Genuine motion/activity flag on the GPS frame.
  data.action = { motion: { detected: bytes[13] !== 0 } };

  var gpsTime = bytes[14] | (bytes[15] << 8) | (bytes[16] << 16) | (bytes[17] << 24);
  data.gpsTimeEpoch = gpsTime;

  return { data: data };
}

// Status frame: battery, onboard temperature, current GPS fix, accelerometer,
// pulse/fence telemetry and reset diagnostics.
function decodePort12(bytes) {
  if (bytes.length < 28) {
    return { errors: ['fPort 12 frame too short: expected 28 bytes, got ' + bytes.length] };
  }

  var data = {};

  data.resetCause = RESET_CAUSE[bytes[0] & 0x07];
  data.systemStateTimeout = bytes[0] >> 3;

  // Battery reported in mV -> normalized volts.
  data.battery = round((bytes[1] * 10 + 2500) / 1000, 3);

  var air = {};
  air.temperature = getNum(bytes[2], -20, 80, 8, 1);
  data.air = air;

  data.systemFunctionsErrors = {
    gpsPeriodicError: (bytes[3] >> 0) & 0x01 ? 1 : 0,
    gpsTriggeredError: (bytes[3] >> 1) & 0x01 ? 1 : 0,
    gpsFixError: (bytes[3] >> 2) & 0x01 ? 1 : 0,
    accelerometerError: (bytes[3] >> 3) & 0x01 ? 1 : 0,
    lightError: (bytes[3] >> 4) & 0x01 ? 1 : 0,
    chargingStatus: (bytes[3] >> 5) & 0x07
  };

  var lat = gpsLat(bytes[4], bytes[5], bytes[6]);
  var lon = gpsLon(bytes[7], bytes[8], bytes[9]);
  if (lat !== null && lon !== null) {
    data.position = { latitude: lat, longitude: lon };
  }

  data.gpsResend = bytes[10];
  data.accelX = getNum(bytes[11], -2000, 2000, 8, 1);
  data.accelY = getNum(bytes[12], -2000, 2000, 8, 1);
  data.accelZ = getNum(bytes[13], -2000, 2000, 8, 1);
  data.batteryLowMv = (bytes[15] << 8) | bytes[14];
  data.gpsOnTimeTotal = (bytes[17] << 8) | bytes[16];
  data.gpsTimeEpoch = bytes[18] | (bytes[19] << 8) | (bytes[20] << 16) | (bytes[21] << 24);
  data.pulseCounter = bytes[22];
  data.pulseVoltage = (bytes[24] | (bytes[25] << 8)) & 0x0fff;
  data.voltageFenceV = data.pulseVoltage * 8;
  data.downlinkCounter = bytes[26] | (bytes[27] << 8);

  return { data: data };
}

// GPS location-history frame: up to 20 fixes; only entries with a non-zero
// coordinate are real. The current (first) fix sits at the top level; the
// remainder go in a `history` array, each carrying an RFC3339 `time`.
function decodePort11(bytes) {
  if (bytes.length < 200) {
    return { errors: ['fPort 11 frame too short: expected 200 bytes, got ' + bytes.length] };
  }

  var entries = [];
  var cnt = 0;
  var slot = 0;
  while (slot < 20) {
    var latRaw = ((bytes[cnt] << 16) >>> 0) + ((bytes[cnt + 1] << 8) >>> 0) + bytes[cnt + 2];
    var lonRaw = ((bytes[cnt + 3] << 16) >>> 0) + ((bytes[cnt + 4] << 8) >>> 0) + bytes[cnt + 5];
    var timeRaw = ((bytes[cnt + 6] << 16) >>> 0) + ((bytes[cnt + 7] << 8) >>> 0) + bytes[cnt + 8];
    var fixStats = bytes[cnt + 9];
    cnt += 10;
    slot++;

    if (latRaw !== 0 && lonRaw !== 0) {
      entries.push({
        time: rfc3339(timeRaw * 60 + 1600000000),
        position: {
          latitude: round((latRaw / 16777215.0) * 180 - 90, 5),
          longitude: round((lonRaw / 16777215.0) * 360 - 180, 5)
        },
        action: { motion: { detected: (fixStats >> 7) !== 0 } },
        gpsEpe: ((fixStats >> 4) & 0x07) * 12,
        gpsTimeToFix: (fixStats & 0x0f) * 5
      });
    }
  }

  if (entries.length === 0) {
    return { errors: ['fPort 11 frame contained no valid GPS fixes'] };
  }

  var data = {};
  var current = entries[0];
  data.time = current.time;
  data.position = current.position;
  data.action = current.action;
  data.gpsEpe = current.gpsEpe;
  data.gpsTimeToFix = current.gpsTimeToFix;
  if (entries.length > 1) {
    data.history = entries.slice(1);
  }

  return { data: data };
}
