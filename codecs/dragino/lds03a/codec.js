// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Dragino LDS03A (Outdoor Open/Close Door Sensor).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. The wire
// format was understood with reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/dragino/lds03a.js, attributed in
// NOTICE); the normalization below is authored for this module, not copied.
//
// Wire format:
//   fPort 2 (door status uplink):
//     bytes[0]      bit 0x01 = door open status (1 = open, 0 = closed)
//                   bit 0x02 = alarm flag
//     bytes[1..3]   door open event count (uint24)
//     bytes[4..6]   last door-open duration, minutes (uint24)
//     bytes[7..10]  unix time (uint32 seconds)
//   fPort 3 (datalog history): N x 11-byte records, same layout as fPort 2.
//   fPort 4 (config report): TDC (uint24), DISALARM, KEEP_STATUS, KEEP_TIME.
//   fPort 5 (device status): sensor model, firmware, frequency/sub band,
//                            battery (mV -> V).
//
// Mapping decisions:
//   DOOR_OPEN_STATUS (1=open,0=closed) -> action.contactState ('open'|'closed').
//     This is a reed contact sensor, so the state is emitted as
//     action.contactState and NOT as action.motion (a known upstream
//     copy-paste bug for door sensors).
//   unix time                          -> time (RFC3339, UTC)
//   battery millivolts (fPort 5)       -> battery (volts)
//   alarm flag                         -> alarm extra (boolean)
//   door open event count              -> doorOpenTimes extra (count)
//   last door-open duration (minutes)  -> lastDoorOpenDurationMinutes extra
//   datalog prior records              -> history array (each carries time)
//   device model / firmware / bands    -> deviceModel / firmwareVersion /
//                                         frequencyBand / subBand extras
//   config fields                      -> transmitIntervalSeconds / disalarm /
//                                         keepStatus / keepTimeSeconds extras
//
// Upstream returns vendor-named keys (DOOR_OPEN_STATUS, BAT, etc.) directly and
// formats TIME in the runtime's local timezone; this module normalizes to the
// shared vocabulary plus camelCase extras and emits time as UTC RFC3339.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function u24(hi, mid, lo) {
  return ((hi << 16) | (mid << 8) | lo) >>> 0;
}

function u32(b3, b2, b1, b0) {
  return ((b3 << 24) | (b2 << 16) | (b1 << 8) | b0) >>> 0;
}

// Unix seconds -> UTC RFC3339 (deterministic, timezone-independent).
function rfc3339(epochSeconds) {
  return new Date(epochSeconds * 1000).toISOString();
}

var FREQUENCY_BANDS = {
  1: 'EU868',
  2: 'US915',
  3: 'IN865',
  4: 'AU915',
  5: 'KZ865',
  6: 'RU864',
  7: 'AS923',
  8: 'AS923_1',
  9: 'AS923_2',
  10: 'AS923_3',
  11: 'CN470',
  12: 'EU433',
  13: 'KR920',
  14: 'MA869'
};

// Decode one 11-byte door record (used by fPort 2 and each fPort 3 entry).
function decodeRecord(bytes, i) {
  return {
    contactState: (bytes[i] & 0x01) ? 'open' : 'closed',
    alarm: (bytes[i] & 0x02) !== 0,
    doorOpenTimes: u24(bytes[i + 1], bytes[i + 2], bytes[i + 3]),
    lastDoorOpenDurationMinutes: u24(bytes[i + 4], bytes[i + 5], bytes[i + 6]),
    time: rfc3339(u32(bytes[i + 7], bytes[i + 8], bytes[i + 9], bytes[i + 10]))
  };
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;
  var data;
  var rec;
  var i;
  var entries;
  var history;

  if (!bytes) {
    return { errors: ['no bytes'] };
  }

  if (input.fPort === 2) {
    if (bytes.length < 11) {
      return { errors: ['fPort 2 expected at least 11 bytes, got ' + bytes.length] };
    }
    rec = decodeRecord(bytes, 0);
    data = {};
    data.action = { contactState: rec.contactState };
    data.time = rec.time;
    data.alarm = rec.alarm;
    data.doorOpenTimes = rec.doorOpenTimes;
    data.lastDoorOpenDurationMinutes = rec.lastDoorOpenDurationMinutes;
    return { data: data };
  }

  if (input.fPort === 3) {
    if (bytes.length < 11 || (bytes.length % 11) !== 0) {
      return { errors: ['fPort 3 expected a positive multiple of 11 bytes, got ' + bytes.length] };
    }
    entries = [];
    for (i = 0; i < bytes.length; i = i + 11) {
      entries.push(decodeRecord(bytes, i));
    }
    rec = entries[0];
    data = {};
    data.action = { contactState: rec.contactState };
    data.time = rec.time;
    data.alarm = rec.alarm;
    data.doorOpenTimes = rec.doorOpenTimes;
    data.lastDoorOpenDurationMinutes = rec.lastDoorOpenDurationMinutes;
    if (entries.length > 1) {
      history = [];
      for (i = 1; i < entries.length; i = i + 1) {
        history.push({
          action: { contactState: entries[i].contactState },
          time: entries[i].time,
          alarm: entries[i].alarm,
          doorOpenTimes: entries[i].doorOpenTimes,
          lastDoorOpenDurationMinutes: entries[i].lastDoorOpenDurationMinutes
        });
      }
      data.history = history;
    }
    return { data: data };
  }

  if (input.fPort === 4) {
    if (bytes.length < 7) {
      return { errors: ['fPort 4 expected at least 7 bytes, got ' + bytes.length] };
    }
    data = {};
    data.transmitIntervalSeconds = u24(bytes[0], bytes[1], bytes[2]);
    data.disalarm = (bytes[3] & 0x01) !== 0;
    data.keepStatus = (bytes[4] & 0x01) !== 0;
    data.keepTimeSeconds = (bytes[5] << 8) | bytes[6];
    return { data: data };
  }

  if (input.fPort === 5) {
    if (bytes.length < 7) {
      return { errors: ['fPort 5 expected at least 7 bytes, got ' + bytes.length] };
    }
    data = {};
    data.battery = round(((bytes[5] << 8) | bytes[6]) / 1000, 3);
    if (bytes[0] === 0x0a) {
      data.deviceModel = 'LDS03A';
    }
    data.firmwareVersion = (bytes[1] & 0x0f) + '.' + ((bytes[2] >> 4) & 0x0f) + '.' + (bytes[2] & 0x0f);
    if (FREQUENCY_BANDS[bytes[3]]) {
      data.frequencyBand = FREQUENCY_BANDS[bytes[3]];
    }
    data.subBand = (bytes[4] === 0xff) ? 'NULL' : bytes[4];
    return { data: data };
  }

  return { errors: ['unsupported fPort ' + input.fPort] };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "dragino";
    result.data.model = "lds03a";
  }
  return result;
}
