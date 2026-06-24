// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for quandify/cubicmeter-1-1-copper (Quandify CubicMeter
// 1.1 Copper — ultrasonic water meter reporting cumulative volume + temperatures).
//
// Ported from the upstream Apache-2.0 reference decoder
// (TheThingsNetwork/lorawan-devices vendor/quandify/cubicmeter-1-1-uplink.js,
// attributed in NOTICE). The wire-format decode below mirrors the upstream
// statusReportDecoder / responseDecoder; the normalization is authored here and
// the upstream normalizeUplink is NOT copied.
//
// fPort 1 = status report (28 bytes): cumulative volume (litres), water
// temperature min/max since last report, current ambient temperature, leak
// state, battery (active/recovered, mV), error code + is-sensing flag.
// fPort 6 = response: a 3-byte header (fPort/status/type) wrapping an inner
// status / hardware / settings report. Only the wrapped status report carries
// metering data; hardware/settings responses are device diagnostics (extras).
//
// Normalization (shared vocabulary):
//   totalVolume (L)        -> metering.water.total  (L; CubicMeter reports litres)
//   waterTemperatureMin/Max (°C) -> water.temperature.min / .max
//                                 + water.temperature.current (midpoint)
//   ambientTemperature (°C) -> air.temperature
//   batteryRecovered (mV)  -> battery (V); batteryActive (mV) -> extra batteryActiveV
//   leakState              -> water.leak (boolean) + extra leakState
//   errorCode / isSensing  -> camelCase extras

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

var UPLINK_TYPES = { 0: 'ping', 1: 'statusReport', 6: 'response' };
var RESPONSE_STATUSES = { 0: 'ok', 1: 'commandError', 2: 'payloadError', 3: 'valueError' };
var RESPONSE_TYPES = { 0: 'none', 1: 'statusReport', 2: 'hardwareReport', 4: 'settingsReport' };
var APP_STATES = { 3: 'ready', 4: 'pipeSelection', 5: 'metering' };
// Cloud-analytics leak levels; leakState in {3,4} means an active leak.
var LEAK_STATES = { 3: 'medium', 4: 'large' };
var PIPE_TYPES = {
  0: 'Custom', 1: 'Copper 15 mm', 2: 'Copper 18 mm', 3: 'Copper 22 mm',
  4: 'Chrome 15 mm', 5: 'Chrome 18 mm', 6: 'Chrome 22 mm', 7: 'Pal 16 mm',
  8: 'Pal 20 mm', 9: 'Pal 25 mm', 14: 'Pex 16 mm', 15: 'Pex 20 mm',
  16: 'Pex 25 mm', 17: 'Distpipe'
};

// Little-endian unsigned readers over a plain byte array, with offset base.
function u8(b, base, o) {
  return b[base + o] & 0xff;
}

function u16le(b, base, o) {
  return (b[base + o] & 0xff) | ((b[base + o + 1] & 0xff) << 8);
}

function u32le(b, base, o) {
  return (
    (b[base + o] & 0xff) +
    ((b[base + o + 1] & 0xff) * 0x100) +
    ((b[base + o + 2] & 0xff) * 0x10000) +
    ((b[base + o + 3] & 0xff) * 0x1000000)
  );
}

function decodeBatteryMv(input) {
  return 1800 + ((input & 0xff) << 3); // raw -> milliVolt
}

function decodeTemperatureC(input) {
  return (input & 0xff) * 0.5 - 20.0; // raw -> °C
}

function intToSemver(version) {
  var major = (version >>> 24) & 0xff;
  var minor = (version >>> 16) & 0xff;
  var patch = version & 0xffff;
  return major + '.' + minor + '.' + patch;
}

// Decode a status report starting at `base` within `bytes`; needs 28 bytes.
function decodeStatusReport(bytes, base) {
  if (bytes.length - base !== 28) {
    return { error: 'Wrong payload length (' + (bytes.length - base) + '), should be 28 bytes' };
  }
  var error = u16le(bytes, base, 4);
  var isSensing = !(error & 0x8000);
  var errorCode = error & 0x7fff;

  return {
    fields: {
      errorCode: errorCode,
      isSensing: isSensing,
      totalVolume: u32le(bytes, base, 6),          // litres, all-time aggregate
      leakState: u8(bytes, base, 22),
      batteryActive: decodeBatteryMv(u8(bytes, base, 23)),     // mV
      batteryRecovered: decodeBatteryMv(u8(bytes, base, 24)),  // mV
      waterTemperatureMin: decodeTemperatureC(u8(bytes, base, 25)), // °C
      waterTemperatureMax: decodeTemperatureC(u8(bytes, base, 26)), // °C
      ambientTemperature: decodeTemperatureC(u8(bytes, base, 27))   // °C
    }
  };
}

function decodeHardwareReport(bytes, base) {
  if (bytes.length - base !== 35) {
    return { error: 'Wrong payload length (' + (bytes.length - base) + '), should be 35 bytes' };
  }
  var appState = APP_STATES[u8(bytes, base, 5)];
  if (appState === undefined) {
    return { error: 'Invalid app state (' + u8(bytes, base, 5) + ')' };
  }
  var pipeId = u8(bytes, base, 28);
  var pipeType = PIPE_TYPES[pipeId];
  if (pipeType === undefined) {
    return { error: 'Invalid pipe index (' + pipeId + ')' };
  }
  return {
    fields: {
      firmwareVersion: intToSemver(u32le(bytes, base, 0)),
      hardwareVersion: u8(bytes, base, 4),
      appState: appState,
      pipeId: pipeId,
      pipeType: pipeType
    }
  };
}

function decodeSettingsReport(bytes, base) {
  if (bytes.length - base !== 38) {
    return { error: 'Wrong payload length (' + (bytes.length - base) + '), should be 38 bytes' };
  }
  return {
    fields: {
      lorawanReportInterval: u32le(bytes, base, 5)
    }
  };
}

// Build the normalized measurement from a decoded status report.
function normalizeStatusReport(f, warnings) {
  var data = {
    metering: { water: { total: round(f.totalVolume, 0) } },
    water: {
      leak: (f.leakState in LEAK_STATES),
      temperature: {
        min: round(f.waterTemperatureMin, 1),
        max: round(f.waterTemperatureMax, 1),
        current: round((f.waterTemperatureMin + f.waterTemperatureMax) / 2, 1)
      }
    },
    air: { temperature: round(f.ambientTemperature, 1) },
    battery: round(f.batteryRecovered / 1000, 3),
    batteryActiveV: round(f.batteryActive / 1000, 3),
    leakState: f.leakState,
    errorCode: f.errorCode,
    isSensing: f.isSensing
  };

  if (f.isSensing === false) {
    warnings.push('Not sensing water');
  }
  if (f.errorCode) {
    warnings.push(f.errorCode === 384 ? 'Reverse flow' : ('Contact support, error ' + f.errorCode));
  }
  if (f.batteryRecovered <= 3100) {
    warnings.push('Low battery');
  }
  return data;
}

function decodeUplinkCore(input) {
  if (!input || !input.bytes) {
    return { errors: ['empty payload'] };
  }
  var bytes = input.bytes;
  var fPort = input.fPort;
  var warnings = [];

  if (fPort === 1) {
    var sr = decodeStatusReport(bytes, 0);
    if (sr.error) {
      return { errors: [sr.error] };
    }
    var srData = normalizeStatusReport(sr.fields, warnings);
    return warnings.length ? { data: srData, warnings: warnings } : { data: srData };
  }

  if (fPort === 6) {
    if (bytes.length < 3) {
      return { errors: ['Response payload too short'] };
    }
    var status = RESPONSE_STATUSES[bytes[1]];
    if (status === undefined) {
      return { errors: ['Invalid response status: ' + bytes[1]] };
    }
    var type = RESPONSE_TYPES[bytes[2]];
    if (type === undefined) {
      return { errors: ['Invalid response type: ' + bytes[2]] };
    }

    // Inner report begins after the 3-byte response header.
    if (type === 'statusReport') {
      var rsr = decodeStatusReport(bytes, 3);
      if (rsr.error) {
        return { errors: [rsr.error] };
      }
      var rsrData = normalizeStatusReport(rsr.fields, warnings);
      rsrData.responseStatus = status;
      rsrData.responseType = type;
      return warnings.length ? { data: rsrData, warnings: warnings } : { data: rsrData };
    }

    if (type === 'hardwareReport') {
      var hr = decodeHardwareReport(bytes, 3);
      if (hr.error) {
        return { errors: [hr.error] };
      }
      var hrData = hr.fields;
      hrData.responseStatus = status;
      hrData.responseType = type;
      return { data: hrData };
    }

    if (type === 'settingsReport') {
      var setr = decodeSettingsReport(bytes, 3);
      if (setr.error) {
        return { errors: [setr.error] };
      }
      var setData = setr.fields;
      setData.responseStatus = status;
      setData.responseType = type;
      return { data: setData };
    }

    // type === 'none': an acknowledgement carrying no report.
    return { data: { responseStatus: status, responseType: type } };
  }

  if (fPort === 0) {
    return { data: { uplinkType: UPLINK_TYPES[0] } };
  }

  return { errors: ['Unsupported fPort ' + fPort] };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "quandify";
    result.data.model = "cubicmeter-1-1-copper";
  }
  return result;
}
