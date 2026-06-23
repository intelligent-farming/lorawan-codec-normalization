// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for the RestoTracker SCD18 (LoRaWAN multi-mode asset
// tracker: GNSS position fix, Wi-Fi / BLE cloud-solve scans, IC temperature,
// battery voltage and motion / tamper state, plus heartbeat, fix-failure and
// work-time diagnostic frames).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. The wire
// format was ported from and normalized against the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/restotracker/scd18.js, attributed in
// NOTICE). The upstream field extraction (common 3-byte head, big-endian int32
// lat/lon * 1e-7, packed status bits) is reproduced faithfully; only the JSON
// shape is re-authored to the normalized vocabulary (never the upstream Decoder
// object).
//
// The SCD18 multiplexes frame types onto LoRaWAN FPorts. Ports 1-10 share a
// common 3-byte head: byte0 packs work-mode / power / tamper / idle / motion
// status bits; byte1 is a signed IC temperature (deg C); byte2 packs the LoRaWAN
// downlink count (low nibble) and a battery-voltage code (high nibble, volts =
// (22 + code) / 10).
//
//   fPort 1  Heartbeat             — restart reason, firmware version, motion count
//   fPort 2  Fix success          — Wi-Fi / BLE scan OR a live GNSS fix
//   fPort 3  Fix failure          — reason, optional scan / GNSS diagnostics
//   fPort 4  System close info    — shutdown reason
//   fPort 5  Shake info           — shake count
//   fPort 6  Idle info            — idle time
//   fPort 7  Demolish (tamper) alarm — alarm timestamp
//   fPort 8  Event                — motion / moving-fix lifecycle event
//   fPort 9  Battery consume      — per-subsystem work times
//   fPort 12 Limit GPS data       — compact live GNSS fix (distinct 2-byte head)
//
// Position handling:
//   A live on-device GNSS fix is published as position.latitude /
//   position.longitude (signed decimal degrees, WGS84) ONLY on fPort 2 with
//   fix technology = GPS, and on fPort 12. Wi-Fi / BLE frames carry MAC/RSSI
//   scan lists that are solved in the cloud, NOT an on-device coordinate; those
//   are surfaced as a wifiScans / bleScans extra (never as position.*).
//   Out-of-range coordinates (|lat| > 90, |lon| > 180) are suppressed, guarding
//   against a malformed frame over-reading the packed fields.
//
//   motion status bit -> action.motion.detected.
//   IC temperature    -> air.temperature (deg C).
//   battery code      -> battery (volts).
//   pdop / satellites / fix technology / work mode / counters / timestamps and
//   other device diagnostics -> camelCase extras.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

var WORK_MODE = ['standby', 'period', 'timing', 'motion'];
var RESTART_REASON = ['power_restart', 'ble_cmd_restart', 'lorawan_cmd_restart', 'switch_off_mode_restart'];
var FIX_TYPE = ['work_mode_fix', 'down_request_fix'];
var FIX_TECH = ['wifi', 'ble', 'gps'];
var FIX_FALSE_REASON = [
  'wifi_fix_time_timeout', 'wifi_fix_tech_timeout', 'wifi_module_nofind',
  'ble_fix_time_timeout', 'ble_fix_tech_timeout', 'ble_adv',
  'gps_no_budget', 'gps_coarse_acc_timeout', 'gps_fine_acc_timeout',
  'gps_fix_timeout', 'gps_assistnow_timeout', 'gps_cold_start_timeout',
  'down_request_fix_interrupt', 'motion_start_fix_false_by_motion_end',
  'motion_end_fix_false_by_motion_start'
];
var SYS_CLOSE_REASON = ['ble_cmd_close', 'lorawan_cmd_close', 'reed_switch_close'];
var EVENT = ['motion_start', 'moving_fix_start', 'motion_end', 'lorawan_downlink_trigger_uplink'];

function readInt32BE(bytes, start) {
  var v = (bytes[start] * 16777216) + (bytes[start + 1] * 65536) + (bytes[start + 2] * 256) + bytes[start + 3];
  if (v >= 0x80000000) {
    v -= 0x100000000;
  }
  return v;
}

function readUint16BE(bytes, start) {
  return bytes[start] * 256 + bytes[start + 1];
}

// Build an RFC3339 UTC timestamp from the packed date/time components and a
// signed timezone offset (whole hours), normalizing back to UTC.
function rfc3339(year, mon, day, hour, minute, sec, tzHours) {
  var t = Date.UTC(year, mon - 1, day, hour - tzHours, minute, sec);
  return new Date(t).toISOString().replace('.000Z', 'Z');
}

function decodeMacScans(bytes, start, datalen) {
  var scans = [];
  var n = Math.floor(datalen / 7);
  var pos = start;
  for (var i = 0; i < n; i++) {
    var mac = '';
    for (var j = 0; j < 6; j++) {
      var h = (bytes[pos + j] & 0xff).toString(16);
      mac += h.length < 2 ? '0' + h : h;
    }
    pos += 6;
    scans.push({ mac: mac, rssi: bytes[pos] - 256 });
    pos += 1;
  }
  return scans;
}

// Common 3-byte head shared by fPort 1-10.
function decodeHead(bytes, port) {
  var info = {};
  info.workMode = WORK_MODE[bytes[0] & 0x03];
  info.lowPower = ((bytes[0] >> 2) & 0x01) !== 0;
  info.tamper = ((bytes[0] >> 3) & 0x01) !== 0;
  info.idle = ((bytes[0] >> 4) & 0x01) !== 0;
  info.motion = ((bytes[0] >> 5) & 0x01) !== 0;
  if (port === 2 || port === 3) {
    info.fixType = FIX_TYPE[(bytes[0] >> 6) & 0x01];
  }
  var icTemp = bytes[1];
  if (icTemp > 0x80) {
    icTemp -= 0x100;
  }
  info.icTemperature = icTemp;
  info.downlinkCount = bytes[2] & 0x0f;
  info.battery = round((22 + ((bytes[2] >> 4) & 0x0f)) / 10, 1);
  return info;
}

// Attach the shared head fields to a normalized measurement object.
function applyHead(data, head) {
  data.air = { temperature: head.icTemperature };
  data.action = { motion: { detected: head.motion } };
  data.battery = head.battery;
  data.workMode = head.workMode;
  data.lowPower = head.lowPower;
  data.tamper = head.tamper;
  data.idle = head.idle;
  data.downlinkCount = head.downlinkCount;
  if (head.fixType !== undefined) {
    data.fixType = head.fixType;
  }
}

// Place a live fix into position.*, suppressing out-of-range coordinates.
function applyPosition(data, lat, lon) {
  var position = {};
  if (lat >= -90 && lat <= 90) {
    position.latitude = round(lat, 7);
  }
  if (lon >= -180 && lon <= 180) {
    position.longitude = round(lon, 7);
  }
  if (position.latitude !== undefined || position.longitude !== undefined) {
    data.position = position;
  }
}

function decodeHeartbeat(bytes) {
  var head = decodeHead(bytes, 1);
  var data = {};
  applyHead(data, head);
  data.restartReason = RESTART_REASON[bytes[3]];
  var verMajor = (bytes[4] >> 6) & 0x03;
  var verMinor = (bytes[4] >> 4) & 0x03;
  var verPatch = bytes[4] & 0x0f;
  data.firmwareVersion = 'V' + verMajor + '.' + verMinor + '.' + verPatch;
  data.motionCount = readInt32BE(bytes, 5);
  return { data: data };
}

function decodeFixSuccess(bytes) {
  var head = decodeHead(bytes, 2);
  var data = {};
  applyHead(data, head);

  var p = 3;
  var tech = bytes[p];
  p += 1;
  data.fixTech = FIX_TECH[tech];

  var year = readUint16BE(bytes, p);
  p += 2;
  var mon = bytes[p];
  p += 1;
  var day = bytes[p];
  p += 1;
  var hour = bytes[p];
  p += 1;
  var minute = bytes[p];
  p += 1;
  var sec = bytes[p];
  p += 1;
  var tz = bytes[p];
  p += 1;
  if (tz > 0x80) {
    tz -= 0x100;
  }
  data.time = rfc3339(year, mon, day, hour, minute, sec, tz);

  var datalen = bytes[p];
  p += 1;

  if (tech === 0 || tech === 1) {
    // Wi-Fi / BLE scan list — cloud-solved, not an on-device fix.
    var scans = decodeMacScans(bytes, p, datalen);
    if (tech === 0) {
      data.wifiScans = scans;
    } else {
      data.bleScans = scans;
    }
  } else {
    var lat = readInt32BE(bytes, p) / 1e7;
    p += 4;
    var lon = readInt32BE(bytes, p) / 1e7;
    p += 4;
    applyPosition(data, lat, lon);
    data.pdop = round(bytes[p] / 10, 1);
  }

  return { data: data };
}

function decodeFixFalse(bytes) {
  var head = decodeHead(bytes, 3);
  var data = {};
  applyHead(data, head);

  var p = 3;
  var reason = bytes[p];
  p += 1;
  data.fixFailReason = FIX_FALSE_REASON[reason];
  var datalen = bytes[p];
  p += 1;

  if (reason <= 5) {
    if (datalen) {
      data.scans = decodeMacScans(bytes, p, datalen);
    }
  } else if (reason <= 11) {
    var pdop = bytes[p];
    p += 1;
    if (pdop !== 0xff) {
      data.pdop = round(pdop / 10, 1);
    }
    data.satelliteCn = [bytes[p], bytes[p + 1], bytes[p + 2], bytes[p + 3]];
  }

  return { data: data };
}

function decodeSysClose(bytes) {
  var head = decodeHead(bytes, 4);
  var data = {};
  applyHead(data, head);
  data.closeReason = SYS_CLOSE_REASON[bytes[3]];
  return { data: data };
}

function decodeShake(bytes) {
  var head = decodeHead(bytes, 5);
  var data = {};
  applyHead(data, head);
  data.shakeCount = readUint16BE(bytes, 3);
  return { data: data };
}

function decodeIdle(bytes) {
  var head = decodeHead(bytes, 6);
  var data = {};
  applyHead(data, head);
  data.idleTime = readUint16BE(bytes, 3);
  return { data: data };
}

function decodeDemolish(bytes) {
  var head = decodeHead(bytes, 7);
  var data = {};
  applyHead(data, head);
  var year = readUint16BE(bytes, 3);
  var mon = bytes[5];
  var day = bytes[6];
  var hour = bytes[7];
  var minute = bytes[8];
  var sec = bytes[9];
  var tz = bytes[10];
  if (tz > 0x80) {
    tz -= 0x100;
  }
  data.alarmTime = rfc3339(year, mon, day, hour, minute, sec, tz);
  return { data: data };
}

function decodeEvent(bytes) {
  var head = decodeHead(bytes, 8);
  var data = {};
  applyHead(data, head);
  data.event = EVENT[bytes[3]];
  return { data: data };
}

function decodeBatteryConsume(bytes) {
  var head = decodeHead(bytes, 9);
  var data = {};
  applyHead(data, head);
  data.gpsWorkTime = readInt32BE(bytes, 3);
  data.wifiWorkTime = readInt32BE(bytes, 7);
  data.bleScanWorkTime = readInt32BE(bytes, 11);
  data.bleAdvWorkTime = readInt32BE(bytes, 15);
  data.lorawanWorkTime = readInt32BE(bytes, 19);
  return { data: data };
}

// fPort 12 uses a distinct 2-byte head (no IC temperature byte): byte0 status,
// byte1 downlink count, byte2 battery code (high nibble), then int32 lat/lon.
function decodeLimitGps(bytes) {
  var data = {};
  data.workMode = WORK_MODE[bytes[0] & 0x03];
  data.lowPower = (bytes[0] & 0x04) !== 0;
  data.tamper = (bytes[0] & 0x08) !== 0;
  data.idle = (bytes[0] & 0x10) !== 0;
  data.action = { motion: { detected: (bytes[0] & 0x20) !== 0 } };
  data.fixType = FIX_TYPE[(bytes[0] >> 6) & 0x01];
  data.downlinkCount = bytes[1] & 0x0f;
  data.battery = round((22 + ((bytes[2] >> 4) & 0x0f)) / 10, 1);

  var lat = readInt32BE(bytes, 2) / 1e7;
  var lon = readInt32BE(bytes, 6) / 1e7;
  applyPosition(data, lat, lon);
  data.pdop = round(bytes[10] / 10, 1);

  return { data: data };
}

function decodeUplink(input) {
  var port = input.fPort;
  var bytes = input.bytes;

  if (!bytes) {
    return { errors: ['missing payload bytes'] };
  }

  if (port >= 1 && port <= 9 && bytes.length < 3) {
    return { errors: ['payload too short for the common 3-byte head'] };
  }

  if (port === 1) {
    if (bytes.length < 9) {
      return { errors: ['fPort 1 heartbeat requires 9 bytes'] };
    }
    return decodeHeartbeat(bytes);
  }
  if (port === 2) {
    if (bytes.length < 13) {
      return { errors: ['fPort 2 fix-success frame requires at least 13 bytes'] };
    }
    return decodeFixSuccess(bytes);
  }
  if (port === 3) {
    if (bytes.length < 5) {
      return { errors: ['fPort 3 fix-failure frame requires at least 5 bytes'] };
    }
    return decodeFixFalse(bytes);
  }
  if (port === 4) {
    if (bytes.length < 4) {
      return { errors: ['fPort 4 system-close frame requires 4 bytes'] };
    }
    return decodeSysClose(bytes);
  }
  if (port === 5) {
    if (bytes.length < 5) {
      return { errors: ['fPort 5 shake frame requires 5 bytes'] };
    }
    return decodeShake(bytes);
  }
  if (port === 6) {
    if (bytes.length < 5) {
      return { errors: ['fPort 6 idle frame requires 5 bytes'] };
    }
    return decodeIdle(bytes);
  }
  if (port === 7) {
    if (bytes.length < 11) {
      return { errors: ['fPort 7 demolish-alarm frame requires 11 bytes'] };
    }
    return decodeDemolish(bytes);
  }
  if (port === 8) {
    if (bytes.length < 4) {
      return { errors: ['fPort 8 event frame requires 4 bytes'] };
    }
    return decodeEvent(bytes);
  }
  if (port === 9) {
    if (bytes.length < 23) {
      return { errors: ['fPort 9 battery-consume frame requires 23 bytes'] };
    }
    return decodeBatteryConsume(bytes);
  }
  if (port === 12) {
    if (bytes.length < 11) {
      return { errors: ['fPort 12 limit-GPS frame requires 11 bytes'] };
    }
    return decodeLimitGps(bytes);
  }

  return { errors: ['unsupported FPort'] };
}
