// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Milesight VS133 (AI ToF people-counting sensor:
// bidirectional line-crossing counts across up to 4 counting lines, plus
// per-period in/out counts).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format (Milesight channel/type TLV) understood with reference to the upstream
// Apache-2.0 decoder (TheThingsNetwork/lorawan-devices
// vendor/milesight-iot/vs133.js, attributed in NOTICE). Ported faithfully from
// that decoder's channel walk (the milesight() function); we author the
// normalization here — we do NOT copy upstream's per-line output object.
//
// Wire format (each line N = 1..4 occupies a fixed channel triple):
//   line 1: 0x03 total_in, 0x04 total_out, 0x05 period   (type 0xD2 / 0xCC)
//   line 2: 0x06 total_in, 0x07 total_out, 0x08 period
//   line 3: 0x09 total_in, 0x0A total_out, 0x0B period
//   line 4: 0x0C total_in, 0x0D total_out, 0x0E period
//   total_in / total_out : channel_type 0xD2, uint32 LE
//   period               : channel_type 0xCC, period_in uint16 LE + period_out uint16 LE
//
// Mapping decisions:
//   total_in / total_out (per line)   uint32 LE -> lineNTotalIn / lineNTotalOut extras
//   period_in / period_out (per line) uint16 LE -> lineNPeriodIn / lineNPeriodOut extras
//
// The VS133 is a counting device: the primary normalized measurement is
// action.motion.count, taken as the sum of every line's total_in and total_out
// passages, with action.motion.detected = (count > 0). The raw directional and
// period counters are preserved per-line as camelCase extras. The VS133 counting
// uplink frame carries no battery channel, so no batteryPercent extra is emitted.
// Downlink command responses are not part of the uplink measurement path and are
// not decoded here.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function u16le(lo, hi) {
  return ((hi << 8) | lo) & 0xffff;
}

function u32le(b0, b1, b2, b3) {
  return ((b3 << 24) | (b2 << 16) | (b1 << 8) | b0) >>> 0;
}

function isTotalIn(channel) {
  return channel === 0x03 || channel === 0x06 || channel === 0x09 || channel === 0x0c;
}

function isTotalOut(channel) {
  return channel === 0x04 || channel === 0x07 || channel === 0x0a || channel === 0x0d;
}

function isPeriod(channel) {
  return channel === 0x05 || channel === 0x08 || channel === 0x0b || channel === 0x0e;
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;
  if (!bytes || bytes.length === 0) {
    return { errors: ['empty payload'] };
  }

  var data = {};
  var motion = {};
  var hasMotion = false;
  var totalCount = 0;
  var recognized = false;

  var i = 0;
  while (i + 1 < bytes.length) {
    var channel = bytes[i];
    var type = bytes[i + 1];

    if (isTotalIn(channel) && type === 0xd2) {
      // LINE TOTAL IN: uint32 LE
      var lineIn = (channel - 0x03) / 3 + 1;
      var tin = u32le(bytes[i + 2], bytes[i + 3], bytes[i + 4], bytes[i + 5]);
      data['line' + lineIn + 'TotalIn'] = tin;
      totalCount += tin;
      hasMotion = true;
      i += 6;
      recognized = true;
    } else if (isTotalOut(channel) && type === 0xd2) {
      // LINE TOTAL OUT: uint32 LE
      var lineOut = (channel - 0x04) / 3 + 1;
      var tout = u32le(bytes[i + 2], bytes[i + 3], bytes[i + 4], bytes[i + 5]);
      data['line' + lineOut + 'TotalOut'] = tout;
      totalCount += tout;
      hasMotion = true;
      i += 6;
      recognized = true;
    } else if (isPeriod(channel) && type === 0xcc) {
      // LINE PERIOD: period_in uint16 LE + period_out uint16 LE
      var lineP = (channel - 0x05) / 3 + 1;
      data['line' + lineP + 'PeriodIn'] = u16le(bytes[i + 2], bytes[i + 3]);
      data['line' + lineP + 'PeriodOut'] = u16le(bytes[i + 4], bytes[i + 5]);
      i += 6;
      recognized = true;
    } else {
      break;
    }
  }

  if (!recognized) {
    return { errors: ['no recognized Milesight channels'] };
  }

  if (hasMotion) {
    motion.count = round(totalCount, 0);
    motion.detected = totalCount > 0;
    data.action = { motion: motion };
  }

  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "milesight-iot";
    result.data.model = "vs133";
  }
  return result;
}
