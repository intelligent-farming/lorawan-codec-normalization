// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Milesight VS373 (radar fall-detection /
// occupancy sensor: detection target status, region occupancy, in-bed / fall
// / motionless states, breathing, alarms, datalog history).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format (Milesight channel/type TLV) was ported faithfully from the upstream
// Apache-2.0 decoder (TheThingsNetwork/lorawan-devices
// vendor/milesight-iot/vs373.js, in turn Milesight-IoT/SensorDecoders,
// attributed in NOTICE). The channel-walk and field extraction are reproduced
// faithfully; only the JSON shape is re-authored to the normalized vocabulary
// (we do NOT copy upstream normalizeUplink).
//
// Mapping decisions:
//   0x03/0xF8 detection target (v1.0.1)  status + target + use_time u16 x2
//     -> action.motion.detected (presence), detectionStatus / targetStatus /
//        useTimeNow / useTimeToday extras
//   0x07/0xB0 detection target (v1.0.2)  status + target + use_time u24 x2
//     -> same as 0x03/0xF8 (use_time fields are 24-bit)
//   0x04/0xF9 region occupancy (v1.0.1)  4 occupancy bytes (inverted: 1=vacant)
//     -> action.motion.count (occupied regions) + region{N}Occupancy extras
//   0x0A/0xB3 region occupy (v1.0.2)      count byte + u32 bitmask
//     -> action.motion.count (occupied regions) + region{N}Occupancy extras
//   0xFF/0x01 IPSO version                byte                 -> ipsoVersion
//   0xFF/0x09 hardware version            2 bytes              -> hardwareVersion
//   0xFF/0x0A firmware version            2 bytes              -> firmwareVersion
//   0xFF/0x0B device status               byte                 -> deviceStatus
//   0xFF/0x0F LoRaWAN class               byte                 -> lorawanClass
//   0xFF/0x16 serial number               8 bytes              -> sn
//
// The VS373 is a presence/occupancy radar: the category-defining state is
// action.motion.detected, true whenever the detection target status is anything
// other than "vacant" (normal / in_bed / out_of_bed / fall / motionless all
// indicate a target is present). When per-region occupancy is reported,
// action.motion.count carries the number of occupied regions. Rich device
// states (detection / target status strings, region occupancy strings, usage
// timers, version / status info) are preserved as camelCase extras. The VS373
// upstream exposes no battery channel. Downlink command responses (channels
// 0xFE/0xFF config, 0xF8/0xF9 ext) and the breathing / alarm / out-of-bed /
// region-type / history paths beyond the occupancy mapping are not part of the
// core occupancy measurement and are not decoded here; an unrecognized channel
// stops the walk.

function u16le(lo, hi) {
  return ((hi << 8) | lo) & 0xffff;
}

function u24le(b0, b1, b2) {
  return ((b2 << 16) | (b1 << 8) | b0) & 0xffffff;
}

function readDetectionStatus(status) {
  if (status === 0) { return 'normal'; }
  if (status === 1) { return 'vacant'; }
  if (status === 2) { return 'in_bed'; }
  if (status === 3) { return 'out_of_bed'; }
  if (status === 4) { return 'fall'; }
  return 'unknown';
}

function readTargetStatus(status) {
  if (status === 0) { return 'normal'; }
  if (status === 1) { return 'motionless'; }
  if (status === 2) { return 'abnormal'; }
  if (status === 3) { return 'lying_down'; }
  return 'unknown';
}

function readOccupancyStatus(status) {
  if (status === 0) { return 'vacant'; }
  if (status === 1) { return 'occupied'; }
  return 'unknown';
}

function readProtocolVersion(b) {
  return 'v' + ((b & 0xf0) >> 4) + '.' + (b & 0x0f);
}

function readHardwareVersion(b) {
  return 'v' + (b[0] & 0xff).toString(16) + '.' + ((b[1] & 0xff) >> 4);
}

function readFirmwareVersion(b) {
  return 'v' + (b[0] & 0xff).toString(16) + '.' + (b[1] & 0xff).toString(16);
}

function readDeviceStatus(status) {
  return status === 1 ? 'on' : 'off';
}

function readLoRaWANClass(type) {
  if (type === 0) { return 'Class A'; }
  if (type === 1) { return 'Class B'; }
  if (type === 2) { return 'Class C'; }
  if (type === 3) { return 'Class CtoB'; }
  return 'unknown';
}

function readSerialNumber(b) {
  var out = '';
  for (var k = 0; k < b.length; k++) {
    out += ('0' + (b[k] & 0xff).toString(16)).slice(-2);
  }
  return out;
}

function decodeUplink(input) {
  var bytes = input.bytes;
  if (!bytes || bytes.length === 0) {
    return { errors: ['empty payload'] };
  }

  var data = {};
  var motion = {};
  var hasDetected = false;
  var hasCount = false;
  var recognized = false;

  var i = 0;
  while (i + 1 < bytes.length) {
    var channel = bytes[i];
    var type = bytes[i + 1];

    if (channel === 0xff && type === 0x01) {
      // IPSO VERSION
      data.ipsoVersion = readProtocolVersion(bytes[i + 2]);
      i += 3;
      recognized = true;
    } else if (channel === 0xff && type === 0x09) {
      // HARDWARE VERSION
      data.hardwareVersion = readHardwareVersion(bytes.slice(i + 2, i + 4));
      i += 4;
      recognized = true;
    } else if (channel === 0xff && type === 0x0a) {
      // FIRMWARE VERSION
      data.firmwareVersion = readFirmwareVersion(bytes.slice(i + 2, i + 4));
      i += 4;
      recognized = true;
    } else if (channel === 0xff && type === 0x0b) {
      // DEVICE STATUS
      data.deviceStatus = readDeviceStatus(bytes[i + 2]);
      i += 3;
      recognized = true;
    } else if (channel === 0xff && type === 0x0f) {
      // LORAWAN CLASS
      data.lorawanClass = readLoRaWANClass(bytes[i + 2]);
      i += 3;
      recognized = true;
    } else if (channel === 0xff && type === 0x16) {
      // PRODUCT SERIAL NUMBER
      data.sn = readSerialNumber(bytes.slice(i + 2, i + 10));
      i += 10;
      recognized = true;
    } else if (channel === 0x03 && type === 0xf8) {
      // DETECTION TARGET (v1.0.1): status, target, use_time_now u16, use_time_today u16
      var ds1 = readDetectionStatus(bytes[i + 2]);
      data.detectionStatus = ds1;
      data.targetStatus = readTargetStatus(bytes[i + 3]);
      data.useTimeNow = u16le(bytes[i + 4], bytes[i + 5]);
      data.useTimeToday = u16le(bytes[i + 6], bytes[i + 7]);
      motion.detected = ds1 !== 'vacant';
      hasDetected = true;
      i += 8;
      recognized = true;
    } else if (channel === 0x07 && type === 0xb0) {
      // DETECTION TARGET (v1.0.2): status, target, use_time_now u24, use_time_today u24
      var ds2 = readDetectionStatus(bytes[i + 2]);
      data.detectionStatus = ds2;
      data.targetStatus = readTargetStatus(bytes[i + 3]);
      data.useTimeNow = u24le(bytes[i + 4], bytes[i + 5], bytes[i + 6]);
      data.useTimeToday = u24le(bytes[i + 7], bytes[i + 8], bytes[i + 9]);
      motion.detected = ds2 !== 'vacant';
      hasDetected = true;
      i += 10;
      recognized = true;
    } else if (channel === 0x04 && type === 0xf9) {
      // REGION OCCUPANCY (v1.0.1): 4 bytes. Upstream maps 1 -> vacant, else occupied.
      var occ = 0;
      var r;
      for (r = 0; r < 4; r++) {
        var status = bytes[i + 2 + r] === 1 ? 0 : 1;
        data['region' + (r + 1) + 'Occupancy'] = readOccupancyStatus(status);
        if (status === 1) { occ += 1; }
      }
      motion.count = occ;
      hasCount = true;
      i += 6;
      recognized = true;
    } else if (channel === 0x0a && type === 0xb3) {
      // REGION OCCUPY (v1.0.2): count byte + u32 LE bitmask (bit set = occupied)
      var regionCount = bytes[i + 2] & 0xff;
      var mask = ((bytes[i + 6] << 24) | (bytes[i + 5] << 16) | (bytes[i + 4] << 8) | bytes[i + 3]) >>> 0;
      var occ2 = 0;
      var j;
      for (j = 0; j < regionCount; j++) {
        var bit = (mask >>> j) & 0x01;
        data['region' + (j + 1) + 'Occupancy'] = readOccupancyStatus(bit);
        if (bit === 1) { occ2 += 1; }
      }
      motion.count = occ2;
      hasCount = true;
      i += 7;
      recognized = true;
    } else {
      break;
    }
  }

  if (!recognized) {
    return { errors: ['no recognized Milesight channels'] };
  }

  if (hasDetected || hasCount) {
    // Ensure action.motion always carries a detected boolean when a count is
    // present (count > 0 implies presence) so the category-defining key is set.
    if (!hasDetected && hasCount) {
      motion.detected = motion.count > 0;
    }
    data.action = { motion: motion };
  }

  return { data: data };
}
