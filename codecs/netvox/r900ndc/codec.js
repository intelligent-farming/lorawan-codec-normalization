// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Netvox R900NDC (Shock / Shock-Tamper sensor with
// dual current sensing), data report on fPort 22.
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format understood with reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/netvox/payload/r900ndc.js, attributed
// in NOTICE). Author the normalization here; do NOT copy upstream
// normalizeUplink.
//
// Despite the catalog name ("Wireless Water leak Sensor"), the R900NDC is a
// shock / movement sensor: the upstream decoder carries NO leak field. fPort 22
// carries device reports; bytes[1..2] are the 16-bit big-endian device type
// (0x0103 == 259 == R900NDC) and bytes[3] is the report-type discriminator.
// reportType 0x00 is a device-info/startup frame (software / hardware version +
// datecode) with no measurement -> error. For a status frame, bytes[4] is the
// battery voltage in 0.1 V (high bit flags low battery, surfaced as the
// camelCase extra `lowBattery`) -> battery (V); bytes[5..7] and bytes[8..10] are
// two 24-bit big-endian current readings in mA, one per current-transformer
// input; bytes[11] packs those two inputs' low/high current threshold-alarm
// flags; and bytes[12] is the shock/tamper alarm state (0x00 == no alarm,
// non-zero == alarm) -> action.motion.detected (the device's shock/movement
// event). Config responses (fPort 23) carry no measurement.
//
// Multi-CT shape: the two current inputs are two sub-sensor positions measuring
// the same quantity, so their readings ride in the reserved `channels` array
// (see AUTHORING.md "Multi-channel devices") instead of the suffixed extras this
// codec used to emit (`current1`/`current2`, `lowCurrent1Alarm`/
// `highCurrent1Alarm`/...). Entries are labelled `ct1`/`ct2`: "CT" is the
// vendor's own term for the clamp inputs on this current-sensing family (compare
// the sibling R718N3, "3 x 50A Solid Core CT"), and the 1-based index is kept
// from the vendor's own field numbering so `ct2` is exactly upstream's Current2 /
// LowCurrent2Alarm / HighCurrent2Alarm. netvox/r900nac3 uses the same scheme for
// its three inputs (`ct1`/`ct2`/`ct3`). Per entry:
//   current           <- that input's 24-bit big-endian mA reading
//   lowCurrentAlarm   <- that input's low-threshold alarm bit
//   highCurrentAlarm  <- that input's high-threshold alarm bit
// The current reading stays a camelCase extra (in mA) rather than becoming the
// vocabulary key power.current: this device is categorised `motion`, not
// `power-meter`, and promoting the reading to a vocabulary key would change the
// category surface (and units) the device advertises — out of scope for this
// pass. Dropping the numeric suffix inside the entry is what retires
// current1/current2: the position now lives in the entry label.
//
// Whole-device state stays top-level and is never repeated inside an entry:
// battery (V) with its `lowBattery` flag and the shock event as
// action.motion.detected.
//
// Sentinel policy: the wire format carries no disconnected-CT encoding — each
// input is three unsigned mA bytes with no reserved value, and 0 mA is a
// legitimate reading (open or unloaded circuit), not a sentinel. No entry is
// therefore ever skipped: a status frame always emits both.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;

  if (input.fPort !== 22) {
    return { errors: ['unsupported fPort ' + input.fPort + ' (expected 22, data report)'] };
  }
  if (bytes.length < 13) {
    return { errors: ['expected at least 13 bytes, got ' + bytes.length] };
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

  // Bytes 5..7 and 8..10: two 24-bit big-endian current readings (mA), one per CT
  // input. Byte 11 packs each input's low/high threshold-alarm bits in ascending
  // pairs (ct1 -> bits 0/1, ct2 -> bits 2/3). One channels entry per input; the
  // format has no sentinel, so neither is ever skipped.
  var flags = bytes[11];
  var channels = [];
  var i;
  for (i = 0; i < 2; i++) {
    var b = 5 + i * 3;
    channels.push({
      channel: 'ct' + (i + 1),
      current: (bytes[b] << 16) | (bytes[b + 1] << 8) | bytes[b + 2],
      lowCurrentAlarm: flags >> (i * 2) & 0x01 ? true : false,
      highCurrentAlarm: flags >> (i * 2 + 1) & 0x01 ? true : false
    });
  }
  data.channels = channels;

  // Byte 12: shock / shock-tamper alarm state. The device's movement event ->
  // action.motion.detected.
  data.action = {
    motion: {
      detected: bytes[12] !== 0x00
    }
  };

  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  // fPort 0 carries MAC commands only (LoRaWAN spec): there is no application
  // payload to decode, so this is not a decode failure. See AUTHORING.md.
  if (input && input.fPort === 0) {
    return { data: { make: "netvox", model: "r900ndc" } };
  }
  if (!input || !input.bytes || input.bytes.length === 0) {
    return { errors: ['empty payload: no application bytes to decode'] };
  }

  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "netvox";
    result.data.model = "r900ndc";
  }
  return result;
}
