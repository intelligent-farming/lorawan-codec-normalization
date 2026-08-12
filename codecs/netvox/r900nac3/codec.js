// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Netvox R900NAC3 (Shock / ShockTamper sensor with
// current monitoring), data report on fPort 22.
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format understood with reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/netvox/payload/r900nac3.js, attributed
// in NOTICE). Author the normalization here; do NOT copy upstream
// normalizeUplink.
//
// fPort 22 carries device reports: bytes[0] is the frame version, bytes[1..2]
// the 16-bit big-endian device type (0x0101 == 257 == R900NAC3) and bytes[3] the
// report-type discriminator. reportType 0x00 is a device-info/startup frame
// (software / hardware version + datecode) and carries no measurement -> error.
// For a status frame: bytes[4] is battery voltage in 0.1 V (high bit flags low
// battery, surfaced as the camelCase extra `lowBattery`) -> battery (V);
// bytes[5..7], bytes[8..10], bytes[11..13] are three 24-bit big-endian current
// readings in mA, one per current-transformer input; bytes[14] is a bitmap of
// per-input low/high current threshold-alarm flags; bytes[15] is the
// shock/tamper alarm state (0x00 == NoAlarm, non-zero == Alarm). This is a
// shock/movement sensor, so the alarm maps to action.motion.detected, and the
// same flag is also surfaced as the camelCase extra `tamperAlarm`. Config
// responses (fPort 23) carry no measurement.
//
// Multi-CT shape: the three current inputs are three sub-sensor positions
// measuring the same quantity, so their readings ride in the reserved
// `channels` array (see AUTHORING.md "Multi-channel devices") instead of the
// suffixed extras this codec used to emit (`current1`/`current2`/`current3`,
// `lowCurrent1Alarm`/`highCurrent1Alarm`/...). Entries are labelled
// `ct1`/`ct2`/`ct3`: "CT" is the vendor's own term for the clamp inputs on this
// current-sensing family (compare the sibling R718N3, "3 x 50A Solid Core CT"),
// and the 1-based index is kept from the vendor's own field numbering so `ct2`
// is exactly upstream's Current2 / LowCurrent2Alarm / HighCurrent2Alarm. The
// same scheme is used by netvox/r900ndc (two inputs, `ct1`/`ct2`). Per entry:
//   current           <- that input's 24-bit big-endian mA reading
//   lowCurrentAlarm   <- that input's low-threshold alarm bit
//   highCurrentAlarm  <- that input's high-threshold alarm bit
// The current reading stays a camelCase extra (in mA) rather than becoming the
// vocabulary key power.current: this device is categorised `motion`, not
// `power-meter`, and promoting the reading to a vocabulary key would change the
// category surface (and units) the device advertises — out of scope for this
// pass. Dropping the numeric suffix inside the entry is what retires
// current1/current2/current3: the position now lives in the entry label.
//
// Whole-device state stays top-level and is never repeated inside an entry:
// battery (V) with its `lowBattery` flag, and the shock/tamper event as
// action.motion.detected plus the `tamperAlarm` extra.
//
// Sentinel policy: the wire format carries no disconnected-CT encoding — each
// input is three unsigned mA bytes with no reserved value, and 0 mA is a
// legitimate reading (open or unloaded circuit), not a sentinel. No entry is
// therefore ever skipped: a status frame always emits all three.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;

  if (input.fPort !== 22) {
    return { errors: ['unsupported fPort ' + input.fPort + ' (expected 22, data report)'] };
  }
  if (bytes.length < 16) {
    return { errors: ['expected at least 16 bytes, got ' + bytes.length] };
  }

  var reportType = bytes[3];

  if (reportType === 0x00) {
    return { errors: ['device info frame (no measurement)'] };
  }

  var data = {};

  // Byte 4: battery voltage in 0.1 V; high bit flags low battery.
  if (bytes[4] & 0x80) {
    data.lowBattery = true;
  }
  data.battery = round((bytes[4] & 0x7f) / 10, 1);

  // Bytes 5..7 / 8..10 / 11..13: three 24-bit big-endian currents in mA, one per
  // CT input. Byte 14 packs each input's low/high threshold-alarm bits in
  // ascending pairs (ct1 -> bits 0/1, ct2 -> 2/3, ct3 -> 4/5). One channels entry
  // per input; the format has no sentinel, so none is ever skipped.
  var flags = bytes[14];
  var channels = [];
  var i;
  for (i = 0; i < 3; i++) {
    var b = 5 + i * 3;
    channels.push({
      channel: 'ct' + (i + 1),
      current: (bytes[b] << 16) | (bytes[b + 1] << 8) | bytes[b + 2],
      lowCurrentAlarm: flags >> (i * 2) & 0x01 ? true : false,
      highCurrentAlarm: flags >> (i * 2 + 1) & 0x01 ? true : false
    });
  }
  data.channels = channels;

  // Byte 15: shock/tamper alarm state. Shock/movement -> action.motion.detected;
  // the tamper flag is also surfaced as the camelCase extra `tamperAlarm`.
  var alarm = bytes[15] !== 0x00;
  data.action = {
    motion: {
      detected: alarm
    }
  };
  data.tamperAlarm = alarm;

  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "netvox";
    result.data.model = "r900nac3";
  }
  return result;
}
