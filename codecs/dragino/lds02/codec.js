// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Dragino LDS02 (LoRaWAN Door Sensor, with a
// water-leak / 2nd-input variant selected by the on-wire MOD byte).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format understood with reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/dragino/lds02.js, attributed in
// NOTICE). Author the normalization here; do NOT copy upstream normalizeUplink.
//
// Wire layout (fPort 10):
//   bytes[0..1]  battery: low 14 bits, mV -> V; byte[0] bit 0x80 = door open,
//                byte[0] bit 0x40 = water leak
//   bytes[2]     MOD (1 = door, 2 = water leak, 3 = door + water leak)
//   MOD 1: bytes[3..5] door-open count, bytes[6..8] last-open duration (min),
//          bytes[9] bit 0x01 alarm
//   MOD 2: bytes[3..5] water-leak count, bytes[6..8] last-leak duration (min)
//   MOD 3: door + water-leak status + alarm only
//
// Mapping decisions:
//   door open/close status  -> action.contactState ('open' | 'closed')
//   water leak (bool)       -> water.leak
//   battery (mV)            -> battery (V), per the volts vocabulary
//   MOD                     -> mode extra (raw mode selector)
//   door-open count         -> doorOpenTimes extra
//   last-open duration      -> lastDoorOpenDuration extra (minutes)
//   water-leak count        -> waterLeakTimes extra
//   last-leak duration      -> lastWaterLeakDuration extra (minutes)
//   alarm flag (bool)       -> alarm extra
//
// The reed/hall-effect contact reports door state. The vocabulary's
// `action.contactState` enum is 'closed'/'open', so the open bit maps to
// 'open' and a clear bit maps to 'closed'. This is a contact sensor, so the
// state is emitted as `action.contactState` and NOT as `action.motion`.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function u24(hi, mid, lo) {
  return ((hi << 16) | (mid << 8) | lo) >>> 0;
}

function decodeUplink(input) {
  var bytes = input.bytes;

  if (input.fPort !== 10) {
    return { errors: ['unsupported fPort ' + input.fPort + ' (expected 10)'] };
  }
  if (!bytes || bytes.length < 3) {
    return { errors: ['expected at least 3 bytes, got ' + (bytes ? bytes.length : 0)] };
  }

  var battRaw = ((bytes[0] << 8) | bytes[1]) & 0x3fff;
  var doorOpen = (bytes[0] & 0x80) !== 0;
  var waterLeak = (bytes[0] & 0x40) !== 0;
  var mod = bytes[2];

  var data = {};
  data.battery = round(battRaw / 1000, 3);
  data.mode = mod;

  if (mod === 1) {
    if (bytes.length < 10) {
      return { errors: ['MOD 1 expected at least 10 bytes, got ' + bytes.length] };
    }
    data.action = { contactState: doorOpen ? 'open' : 'closed' };
    data.doorOpenTimes = u24(bytes[3], bytes[4], bytes[5]);
    data.lastDoorOpenDuration = u24(bytes[6], bytes[7], bytes[8]);
    data.alarm = (bytes[9] & 0x01) !== 0;
  } else if (mod === 2) {
    if (bytes.length < 9) {
      return { errors: ['MOD 2 expected at least 9 bytes, got ' + bytes.length] };
    }
    data.water = { leak: waterLeak };
    data.waterLeakTimes = u24(bytes[3], bytes[4], bytes[5]);
    data.lastWaterLeakDuration = u24(bytes[6], bytes[7], bytes[8]);
  } else if (mod === 3) {
    if (bytes.length < 10) {
      return { errors: ['MOD 3 expected at least 10 bytes, got ' + bytes.length] };
    }
    data.action = { contactState: doorOpen ? 'open' : 'closed' };
    data.water = { leak: waterLeak };
    data.alarm = (bytes[9] & 0x01) !== 0;
  } else {
    return { errors: ['unsupported MOD ' + mod] };
  }

  return { data: data };
}
