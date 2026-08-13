// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for dragino/se02-lb (Dragino SE02-LB/LS 2-channel soil moisture/EC/temperature sensor).
//
// Wire format authored from the upstream Apache-2.0 Dragino decoder
// (TheThingsNetwork/lorawan-devices vendor/dragino/se02-lb.js, attributed in
// NOTICE; upstream stores the JS with escaped newlines). Original normalization.
//
// fPort 2: battery (bytes[0..1] & 0x3FFF, mV -> V); DS18B20 probe temp
// (bytes[2..3] signed/10). Then two identical 6-byte soil blocks — the vendor's
// "channel 1" (bytes[4..9], upstream *_soil) and "channel 2" (bytes[10..15],
// upstream *_soil2) — each carrying moisture (hi<<8|lo)/100 %, temperature
// signed/100 (C), EC (hi<<8|lo) in uS/cm. Frames are read as the calibrated
// MOD 0 layout; the raw/uncalibrated MOD 1 layout (mod bit in the trailing
// status byte) is not normalized.
//
// Both blocks are the same three quantities at two physical positions, so each
// becomes an entry in the reserved `channels` array (see AUTHORING.md
// "Multi-channel devices") instead of a suffixed extra. Labels are the vendor's
// term plus a 0-based index: `probe0` = vendor channel 1, `probe1` = vendor
// channel 2. Each entry carries soil.moisture (%), soil.temperature (C) and
// soil.ec (dS/m, uS/cm / 1000) with identical scaling/rounding for both probes;
// the old moistureSoil2 / tempSoil2 / ecSoil2 extras are retired (ecSoil2 used to
// leak raw uS/cm — probe1's EC is now normalized to dS/m like probe0's).
//
// Whole-device readings stay top-level and are never duplicated in an entry:
// `battery`, and `probeTemperature` — the on-board DS18B20, a separate single
// probe on its own bus (upstream `temperature_pro`), not one of the two soil
// positions, so it remains a top-level extra rather than a third channels entry.
//
// Sentinel / disconnected-position policy: the frame carries NO per-probe
// presence, fault or sentinel indicator. The trailing mod/status byte
// (bytes[16], not decoded here) holds a single device-level sensor flag plus the
// MOD bit — device-wide, not per position — and upstream emits the channel-2
// block unconditionally. An unconnected probe reads as zeros (or a stale count),
// which is indistinguishable from a genuine 0.00 % / 0.00 C / 0 uS/cm reading, so
// no position can be skipped: both entries are always emitted and no sentinel is
// invented here.
function round(value, decimals) { var f = Math.pow(10, decimals); return Math.round(value * f) / f; }
function s16(hi, lo) { var v = ((hi & 0xff) << 8) | (lo & 0xff); return (v & 0x8000) ? v - 0x10000 : v; }
function u16(hi, lo) { return ((hi & 0xff) << 8) | (lo & 0xff); }

// One soil position: 6 bytes at offset o (moisture, temperature, EC).
function soilProbe(b, o, label) {
  return {
    channel: label,
    soil: {
      moisture: round(u16(b[o], b[o + 1]) / 100, 2),
      temperature: round(s16(b[o + 2], b[o + 3]) / 100, 2),
      ec: round(u16(b[o + 4], b[o + 5]) / 1000, 4)
    }
  };
}

function decodeUplinkCore(input) {
  var b = input.bytes;
  if (input.fPort === 5) { return { errors: ['device information frame (fPort 5), not a measurement'] }; }
  if (input.fPort !== 2) { return { errors: ['unsupported fPort ' + input.fPort + ' (expected 2)'] }; }
  if (!b || b.length < 16) { return { errors: ['payload too short (need >= 16 bytes)'] }; }
  var data = {};
  data.battery = round((((b[0] << 8) | b[1]) & 0x3fff) / 1000, 3);
  data.probeTemperature = round(s16(b[2], b[3]) / 10, 2);
  data.channels = [soilProbe(b, 4, 'probe0'), soilProbe(b, 10, 'probe1')];
  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) { result.data.make = "dragino"; result.data.model = "se02-lb"; }
  return result;
}
