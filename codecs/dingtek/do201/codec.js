// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Dingtek DO201 (parking occupancy / fill-level
// sensor with magnetometer and onboard temperature + humidity).
//
// Decode logic ported/normalized from the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/dingtek/do201.js, attributed in
// NOTICE). The upstream wire format is preserved faithfully: telemetry uplinks
// arrive on FPort 3 as a 23-byte frame, parameter/config packets as a 16-byte
// frame whose 4th byte (index 3) is 0x03.
//
// Vocabulary mapping: the onboard `temperature` (signed °C byte) -> air.temperature,
// `humidity` (% byte) -> air.relativeHumidity, and `volt` (battery voltage in V)
// -> battery. Everything else the DO201 reports — fill level, the three
// magnetometer axes, alarm flags, the frame counter, and all config-packet
// fields — has no vocabulary key and is emitted as camelCase extras.
//
// Faithful quirk preserved from upstream: a 16-byte frame whose data_type byte
// is not 0x03 falls through to the length default and reports 'wrong length'
// (upstream has no break after the data_type === 0x03 branch).

function s16(hi, lo) {
  var v = ((hi << 8) + lo) & 0xffff;
  return v > 32767 ? v - 65536 : v;
}

function s8(b) {
  return b > 127 ? b - 256 : b;
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;

  if (input.fPort != 3) {
    return { errors: ['unknown FPort'] };
  }

  if (bytes.length === 23) {
    var data = {};

    data.fillLevel = (bytes[5] << 8) + bytes[6];
    data.alarmPark = Boolean(bytes[7] >> 4);
    data.alarmLevel = Boolean(bytes[7] & 0x0f);
    data.alarmMagnet = Boolean(bytes[8] >> 4);
    data.alarmBattery = Boolean(bytes[8] & 0x0f);
    data.xMagnet = s16(bytes[11], bytes[12]);
    data.yMagnet = s16(bytes[13], bytes[14]);
    data.zMagnet = s16(bytes[15], bytes[16]);
    data.frameCounter = (bytes[19] << 8) + bytes[20];

    data.battery = ((bytes[9] << 8) + bytes[10]) / 100;

    data.air = {
      temperature: s8(bytes[17]),
      relativeHumidity: bytes[18]
    };

    return { data: data };
  }

  if (bytes.length === 16 && bytes[3] === 0x03) {
    return {
      data: {
        firmware: bytes[5] + '.' + bytes[6],
        uploadInterval: bytes[7],
        detectInterval: bytes[8],
        levelThreshold: bytes[9],
        magnetThreshold: (bytes[10] << 8) + bytes[11],
        batteryThreshold: bytes[12]
      }
    };
  }

  return { errors: ['wrong length'] };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "dingtek";
    result.data.model = "do201";
  }
  return result;
}
