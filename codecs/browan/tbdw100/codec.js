// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Browan TBDW100 (Tabs Door & Window Sensor),
// data uplink on fPort 100.
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format (fixed little-endian Browan/Tabs layout) ported/normalized from the
// upstream Apache-2.0 decoder (TheThingsNetwork/lorawan-devices
// vendor/browan/tbdw100.js, attributed in NOTICE). The decodeUplink wire parse
// below is ported faithfully from that reference; the normalization to
// vocabulary keys is authored here and is NOT copied from upstream
// normalizeUplink.
//
// Wire layout (fPort 100):
//   byte 0 bit0 : reed/hall contact state (1 = door open / magnet separated,
//                 0 = door closed / magnet present)
//   byte 1 low nibble : battery level, (25 + level) / 10 volts (2.5 V .. 4.0 V)
//   byte 2 low 7 bits : board temperature, -32 C offset
//   bytes 3-4 LE      : elapsed open-time counter (seconds)
//   bytes 5-7 LE      : cumulative open count
//
// Mapping decisions:
//   - Contact state -> action.contactState ('open' | 'closed'). This is a door
//     sensor, so the state is emitted as action.contactState and NOT as
//     action.motion (upstream normalizeUplink maps it to action.motion — a known
//     copy-paste bug from the tbms100 motion sensor).
//   - Board temperature -> air.temperature (C).
//   - Battery (4-bit level mapped onto volts) -> battery (volts), matching the
//     vocabulary unit directly.
//   - Cumulative open count -> openCount extra (no vocabulary key).
//   - Elapsed open-time counter -> openTimeSeconds extra (no vocabulary key).
//
// Upstream returns a bare {} for an empty/all-zero payload; that violates this
// module's output contract (never return bare {}), so an empty payload is
// reported as an error instead.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;

  var allZero = true;
  var i;
  for (i = 0; i < bytes.length; i++) {
    if (bytes[i] !== 0) {
      allZero = false;
      break;
    }
  }
  if (bytes.length === 0 || allZero) {
    return { errors: ['empty payload'] };
  }

  if (input.fPort !== 100) {
    return { errors: ['unknown FPort'] };
  }

  if (bytes.length < 8) {
    return { errors: ['payload too short'] };
  }

  var open = (bytes[0] & 0x01) > 0;
  var battery = round((25 + (bytes[1] & 0x0f)) / 10, 1);
  var temperature = (bytes[2] & 0x7f) - 32;
  var openTimeSeconds = ((bytes[4] << 8) | bytes[3]) & 0xffff;
  var openCount = (((bytes[7] << 16) | (bytes[6] << 8)) | bytes[5]) >>> 0;

  return {
    data: {
      battery: battery,
      air: {
        temperature: round(temperature, 1)
      },
      action: {
        contactState: open ? 'open' : 'closed'
      },
      openCount: openCount,
      openTimeSeconds: openTimeSeconds
    }
  };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "browan";
    result.data.model = "tbdw100";
  }
  return result;
}
