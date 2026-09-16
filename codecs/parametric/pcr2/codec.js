// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for the Parametric PCR2 Radar People Counter: a
// camera-less radar counter that registers people passing from left-to-right
// (LTR) and right-to-left (RTL), reporting both the per-interval directional
// counts and running cumulative sums, plus CPU temperature and (when fitted with
// an SBX solar charger) battery voltage and solar power.
//
// Original work for @intelligent-farming/lorawan-codec-normalization. The wire
// format was understood with reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/parametric/pcr2-decoder.js, attributed
// in NOTICE). This module re-authors the JSON to the normalized vocabulary and
// never copies the upstream output.
//
// Application payloads arrive on FPort 14. Two extended application layouts carry
// counts and are decoded here (both begin with the magic bytes be 01 <ver>):
//   be 01 03  extended V3 (16 bytes): SBX_BATT is a 1-byte gauge/percent
//   be 01 04  extended V4 (17 bytes): SBX_BATT is a 2-byte voltage (mV)
// Configuration payloads (FPort 190) and all other frames are not measurements
// and are reported as errors.
//
// Field mapping (extended V3/V4):
//   LTR      (bytes[3..4])   -> people.in  (left-to-right entries this interval)
//   RTL      (bytes[5..6])   -> people.out (right-to-left exits this interval)
//   LTR_SUM  (bytes[7..8])   -> totalIn  (cumulative extra)
//   RTL_SUM  (bytes[9..10])  -> totalOut (cumulative extra)
//   people.total = LTR_SUM - RTL_SUM       -> people.total (cumulative net)
//   TEMP     (last 2 bytes, signed, deci-degC) -> air.temperature (floor to degC,
//            matching the device's integer-degC report)
//   V3: SBX_BATT (bytes[11])            -> solarBatteryGauge (extra, device units)
//       SBX_PV   (bytes[12..13])        -> solarPowerMw (extra, mW)
//   V4: SBX_BATT (bytes[11..12], mV)    -> battery (mV -> V)
//       SBX_PV   (bytes[13..14])        -> solarPowerMw (extra, mW)
//
// Battery note: `battery` is populated only from the V4 layout, where SBX_BATT is
// a millivolt reading from the optional SBX solar charger. The V3 SBX_BATT byte
// is a gauge/percentage, so it is kept as the extra `solarBatteryGauge` (never
// pushed into `battery`, which is volts).

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function u16(bytes, index) {
  return (bytes[index] << 8) | bytes[index + 1];
}

function s16(value) {
  var num = value & 0xffff;
  if (num & 0x8000) num = num - 0x10000;
  return num;
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;

  if (input.fPort === 190) {
    return { errors: ['configuration payload carries no normalized measurement'] };
  }
  if (input.fPort !== 14) {
    return { errors: ['unsupported fPort ' + input.fPort + ' (expected 14 application payload)'] };
  }
  if (!bytes || bytes.length < 3) {
    return { errors: ['payload too short'] };
  }
  if (!(bytes[0] === 0xbe && bytes[1] === 0x01)) {
    return { errors: ['unsupported application payload (expected extended payload be 01 03/04)'] };
  }

  var version = bytes[2];
  if (version !== 0x03 && version !== 0x04) {
    return { errors: ['unsupported extended payload version ' + version + ' (expected 3 or 4)'] };
  }

  var expectedLen = version === 0x03 ? 16 : 17;
  if (bytes.length !== expectedLen) {
    return { errors: ['wrong length for extended V' + version + ' payload (expected ' + expectedLen + ')'] };
  }

  var ltr = u16(bytes, 3);
  var rtl = u16(bytes, 5);
  var ltrSum = u16(bytes, 7);
  var rtlSum = u16(bytes, 9);

  var data = {};
  data.people = { in: ltr, out: rtl, total: ltrSum - rtlSum };
  data.totalIn = ltrSum;
  data.totalOut = rtlSum;

  if (version === 0x03) {
    data.solarBatteryGauge = bytes[11];
    data.solarPowerMw = u16(bytes, 12);
    data.air = { temperature: Math.floor(s16(u16(bytes, 14)) / 10) };
  } else {
    data.battery = round(u16(bytes, 11) / 1000, 3);
    data.solarPowerMw = u16(bytes, 13);
    data.air = { temperature: Math.floor(s16(u16(bytes, 15)) / 10) };
  }

  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  // fPort 0 carries MAC commands only (LoRaWAN spec): there is no application
  // payload to decode, so this is not a decode failure. See AUTHORING.md.
  if (input && input.fPort === 0) {
    return { data: { make: "parametric", model: "pcr2" } };
  }
  if (!input || !input.bytes || input.bytes.length === 0) {
    return { errors: ['empty payload: no application bytes to decode'] };
  }

  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "parametric";
    result.data.model = "pcr2";
  }
  return result;
}
