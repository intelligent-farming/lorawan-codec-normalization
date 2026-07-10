// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Tehama Single Pulse Sensor (tehama-pulse-mdt).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format understood with reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/tehama/tehama-pulse-mdt.js,
// attributed in NOTICE). Upstream emits `reading`, a wall-clock `rxTimeStamp`
// (non-deterministic new Date()) and a `readTimeStamp`; this module normalizes
// only the cumulative pulse reading and its read time, and does NOT copy
// upstream.
//
// The device reports a single cumulative pulse index from a dry-contact pulse
// input, plus the device's read timestamp:
//   bytes[3..6]  = 32-bit little-endian seconds since 1970-01-01T00:00:00Z
//                  (device read time) -> top-level `time` (RFC3339 UTC)
//   bytes[9..12] = 32-bit little-endian cumulative pulse reading -> pulse.total
// The metered quantity (water/gas/etc.) is defined by the attached meter, so
// the reading maps to the generic pulse vocabulary. A minimum of 13 bytes is
// required to reach the reading field.

function u32le(bytes, off) {
  return (bytes[off]) + (bytes[off + 1] * 256) + (bytes[off + 2] * 65536) + (bytes[off + 3] * 16777216);
}

function pad2(n) {
  return n < 10 ? '0' + n : '' + n;
}

// Format epoch seconds as an RFC3339 UTC timestamp without using Date().
function rfc3339(epochSeconds) {
  var secsOfDay = epochSeconds % 86400;
  var days = (epochSeconds - secsOfDay) / 86400;
  var hh = Math.floor(secsOfDay / 3600);
  var mm = Math.floor((secsOfDay % 3600) / 60);
  var ss = secsOfDay % 60;

  var year = 1970;
  while (true) {
    var leap = (year % 4 === 0 && year % 100 !== 0) || (year % 400 === 0);
    var yearDays = leap ? 366 : 365;
    if (days < yearDays) { break; }
    days -= yearDays;
    year++;
  }
  var isLeap = (year % 4 === 0 && year % 100 !== 0) || (year % 400 === 0);
  var monthLengths = [31, isLeap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  var month = 0;
  while (days >= monthLengths[month]) {
    days -= monthLengths[month];
    month++;
  }
  var day = days + 1;
  return year + '-' + pad2(month + 1) + '-' + pad2(day) + 'T' +
    pad2(hh) + ':' + pad2(mm) + ':' + pad2(ss) + 'Z';
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;
  if (!bytes || bytes.length < 13) {
    return { errors: ['payload too short (' + (bytes ? bytes.length : 0) + '), expected at least 13 bytes'] };
  }

  var reading = u32le(bytes, 9);
  var readSeconds = u32le(bytes, 3);

  var data = {};
  data.pulse = { total: reading };
  data.time = rfc3339(readSeconds);
  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "tehama";
    result.data.model = "tehama-pulse-mdt";
  }
  return result;
}
