// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Milesight VS121 (AI Workplace Sensor:
// people-counting / workplace occupancy with per-region occupancy breakdown).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format (Milesight channel/type TLV) was ported from the upstream Apache-2.0
// decoder (TheThingsNetwork/lorawan-devices vendor/milesight-iot/vs121.js, in
// turn Milesight-IoT/SensorDecoders, attributed in NOTICE). The channel-walk
// and field extraction are reproduced faithfully; only the JSON shape is
// re-authored to the normalized vocabulary (never the upstream output).
//
// Mapping decisions:
//   0x04/0xc9 people counter   byte people_counter_all -> action.motion.count
//                              byte region_count       -> regionCount extra
//                              uint16 BE region bitmap  -> regions[] extra
//
// The VS121 is a counting/occupancy device: the primary normalized measurement
// is action.motion.count (total people detected in the field of view), with
// action.motion.detected = (count > 0). The per-region occupancy breakdown is
// preserved as the camelCase extra `regions` (each entry { index, count }) and
// the region tally as `regionCount`. The per-region occupancy bit is extracted
// exactly as the upstream decoder does so the breakdown stays faithful to the
// device (the TTN codec is the source of truth). This channel reports no
// battery, so no batteryPercent extra is emitted.

function u16be(hi, lo) {
  return ((hi << 8) | lo) & 0xffff;
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;
  if (!bytes || bytes.length === 0) {
    return { errors: ['empty payload'] };
  }

  var data = {};
  var motion = {};
  var hasMotion = false;
  var recognized = false;

  var i = 0;
  while (i + 1 < bytes.length) {
    var channel = bytes[i];
    var type = bytes[i + 1];

    if (channel === 0x04 && type === 0xc9) {
      // PEOPLE COUNTER: people_counter_all byte, region_count byte,
      // uint16 BE region occupancy bitmap.
      var peopleAll = bytes[i + 2] & 0xff;
      var regionCount = bytes[i + 3] & 0xff;
      var region = u16be(bytes[i + 4], bytes[i + 5]);

      var regions = [];
      for (var idx = 0; idx < regionCount; idx++) {
        regions.push({
          index: idx,
          count: (region > idx) & 1
        });
      }

      data.regionCount = regionCount;
      data.regions = regions;
      motion.count = peopleAll;
      motion.detected = peopleAll > 0;
      hasMotion = true;

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
    data.action = { motion: motion };
  }

  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "milesight-iot";
    result.data.model = "vs121";
  }
  return result;
}
