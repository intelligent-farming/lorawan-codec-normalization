// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for tekzitel/tekzipark (TekziPark parking-occupancy
// sensor: occupied/free via radar + magnetometer, plus board temperature).
//
// Ported from the upstream Apache-2.0 reference decoder
// (TheThingsNetwork/lorawan-devices vendor/tekzitel/tekzipark.js, attributed in
// NOTICE). The upstream normalizeUplink output is NOT reused; the normalization
// to the shared vocabulary is authored here.
//
// Wire format (fPort 1 = status frame, fPort 2 = diagnostic/magnetometer frame):
//   byte[0]  status bitfield:
//            bit7 occupied, bit5 goodBattery, bit4 obstruction, bit3 radar,
//            bit2 noBeacon, bit1 reset, bit0 keepAlive
//   byte[1]  temperature, signed 8-bit two's complement (deg C)
//   byte[2]  parking ID (unsigned)
//   fPort 1 (optional, when length > 3):
//     byte[3]            beacon RSSI, signed 8-bit (dBm)
//     byte[4..]          beacon IDs, big-endian 16-bit pairs
//   fPort 2:
//     byte[3..5]         magnetometer deflection X/Y/Z, signed 8-bit
//     byte[6..8]         magnetometer baseline X/Y/Z, signed 8-bit
//     byte[9]            fault code (unsigned)
//     byte[10]           obstruction level (unsigned)
//     byte[11]           radar reflection (unsigned)
//
// The device reports battery only as a "good battery" health flag, not a
// voltage, so the vocabulary `battery` key (volts) is intentionally NOT emitted;
// the flag is surfaced as the extra `goodBattery`.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function signed8(b) {
  return b > 0x7f ? b - 0x100 : b;
}

function decodeUplink(input) {
  var bytes = input.bytes;
  var fPort = input.fPort;

  if (fPort !== 1 && fPort !== 2) {
    return { errors: ['unknown FPort'] };
  }
  if (!bytes || bytes.length < 3) {
    return { errors: ['payload too short: expected at least 3 bytes'] };
  }

  var status = bytes[0];
  var occupied = (status & 0x80) !== 0;

  var data = {
    action: {
      occupancy: {
        occupied: occupied
      }
    },
    air: {
      temperature: round(signed8(bytes[1]), 1)
    },
    parkingId: bytes[2],
    goodBattery: (status & 0x20) !== 0,
    obstruction: (status & 0x10) !== 0,
    radar: (status & 0x08) !== 0,
    noBeacon: (status & 0x04) !== 0,
    reset: (status & 0x02) !== 0,
    keepAlive: (status & 0x01) !== 0,
    messageType: fPort === 1 ? 'status' : 'diagnostic'
  };

  if (fPort === 1) {
    if (bytes.length > 3) {
      data.beaconRssi = signed8(bytes[3]);
      var beacons = [];
      var i = 4;
      while (i + 1 < bytes.length) {
        beacons.push((bytes[i] << 8) | bytes[i + 1]);
        i += 2;
      }
      data.beacons = beacons;
    }
  } else {
    if (bytes.length < 12) {
      return { errors: ['diagnostic frame too short: expected 12 bytes'] };
    }
    data.deflectionX = signed8(bytes[3]);
    data.deflectionY = signed8(bytes[4]);
    data.deflectionZ = signed8(bytes[5]);
    data.baselineX = signed8(bytes[6]);
    data.baselineY = signed8(bytes[7]);
    data.baselineZ = signed8(bytes[8]);
    data.faultCode = bytes[9];
    data.obstructionLevel = bytes[10];
    data.reflection = bytes[11];
  }

  return { data: data };
}
