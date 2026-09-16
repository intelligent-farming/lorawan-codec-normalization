// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for dragino/se0x-lb (Dragino SE0X-LB/LS
// multi-channel soil moisture / temperature / EC sensor, up to 4 probes).
// Authored from the upstream Apache-2.0 Dragino SE0X-LB decoder (attributed in
// NOTICE). Original normalization.
//
// fPort 2: battery ((b0<<8|b1)&0x3FFF)/1000; DS18B20 probe temperature
// b2..3 signed/10 (extra); b4 holds the mode bit (bit7: 0=calibrated MOD 0,
// 1=raw/uncalibrated MOD 1) and a 4-bit channel-present mask in the low nibble,
// bit-reversed: bit3=ch1, bit2=ch2, bit1=ch3, bit0=ch4. Each present channel n
// (0-based) occupies a 6-byte block at j=6*n, fields b[5+j]..b[10+j]:
// calibrated moisture (b[5+j]<<8|b[6+j])/100 %, temperature
// signed(b[7+j],b[8+j])/100 C, EC (b[9+j]<<8|b[10+j]) in uS/cm; raw mode reads
// the same three slots as dielectric constant /10, raw water count and raw
// conductivity count.
//
// Up to four probes report the same three quantities at four physical
// positions, so each present channel becomes an entry in the reserved
// `channels` array (see AUTHORING.md "Multi-channel devices") instead of a
// suffixed extra. Labels are the vendor's term plus a 0-based index: `probe0` =
// vendor channel 1, `probe1` = vendor channel 2, `probe2` = channel 3,
// `probe3` = channel 4 — the same scheme as the sibling dragino/se02-lb.
//
// The label is indexed by the PHYSICAL channel, not by presence order: a frame
// whose mask carries only channels 2 and 4 emits `probe1` and `probe3`, never a
// renumbered `probe0`/`probe1`. A given probe therefore keeps its label across
// frames even when another channel drops out, which is the whole point of a
// stable positional label.
//
// Calibrated (MOD 0) entries carry soil.moisture (%), soil.temperature (C) and
// soil.ec (dS/m, uS/cm / 1000), with identical scaling/rounding for every
// position; the old soil.* (channel 1) plus moistureSoil2/3/4,
// temperatureSoil2/3/4 and ecSoil2/3/4 extras are retired. Raw (MOD 1) entries
// carry the `dielectric`, `rawWater` and `rawConduct` extras — unsuffixed now
// that the entry label carries the position — and, as before, no soil.* keys,
// because uncalibrated counts are not the normalized quantities; the old
// dielectricChannel1..4 / rawWaterChannel1..4 / rawConductChannel1..4 extras
// are retired with them.
//
// Whole-device readings stay top-level and are never duplicated in an entry:
// `battery`; `probeTemperature` — the on-board DS18B20, a separate single probe
// on its own bus (upstream `temp_DS18B20`), not one of the four soil positions,
// so it stays a top-level extra rather than a fifth channels entry; and
// `channelMask`, the raw low nibble of b4. The mask is kept for continuity and
// is harmless, but the entry labels are now the authoritative positional record
// — a consumer should read `channels[].channel`, not re-derive positions from
// the bitmask.
//
// Sentinel / disconnected-position policy: unlike se02-lb, this frame DOES
// carry per-position presence — the 4-bit mask — and it is the only presence
// indicator (there is no per-probe fault flag or out-of-range sentinel value).
// A channel whose mask bit is clear simply gets no entry, so `channels` holds
// only the connected positions and is omitted entirely when the mask is 0. A
// present channel's values are emitted as read, including zeros: an in-band
// 0.00 % / 0.00 C / 0 uS/cm reading is indistinguishable from a fault, so no
// sentinel is invented here. The frame is also truncation-guarded: a mask
// claiming more channels than the payload carries stops the scan at the last
// complete 6-byte block rather than reading past the end.
function round(value, decimals) { var f = Math.pow(10, decimals); return Math.round(value * f) / f; }
function s16(hi, lo) { var v = ((hi & 0xff) << 8) | (lo & 0xff); return (v & 0x8000) ? v - 0x10000 : v; }
function u16(hi, lo) { return ((hi & 0xff) << 8) | (lo & 0xff); }

// One soil position: 6 bytes at offset o. Calibrated frames yield soil.*;
// raw/uncalibrated frames yield the dielectric/raw-count extras instead.
function soilProbe(b, o, label, calibrated) {
  var entry = { channel: label };
  if (calibrated) {
    entry.soil = {
      moisture: round(u16(b[o], b[o + 1]) / 100, 2),
      temperature: round(s16(b[o + 2], b[o + 3]) / 100, 2),
      ec: round(u16(b[o + 4], b[o + 5]) / 1000, 3)
    };
  } else {
    entry.dielectric = round(u16(b[o], b[o + 1]) / 10, 1);
    entry.rawWater = u16(b[o + 2], b[o + 3]);
    entry.rawConduct = u16(b[o + 4], b[o + 5]);
  }
  return entry;
}

function decodeUplinkCore(input) {
  var b = input.bytes;
  if (input.fPort === 5) { return { errors: ['device information frame (fPort 5), not a measurement'] }; }
  if (input.fPort !== 2) { return { errors: ['unsupported fPort ' + input.fPort + ' (expected 2)'] }; }
  if (!b || b.length < 11) { return { errors: ['payload too short (need >= 11 bytes for one channel)'] }; }
  var calibrated = ((b[4] >> 7) & 0x01) === 0;
  var mask = b[4] & 0x0f;
  var data = {};
  data.battery = round((((b[0] << 8) | b[1]) & 0x3fff) / 1000, 3);
  data.probeTemperature = round(s16(b[2], b[3]) / 10, 2);
  data.channelMask = mask;
  var channels = [];
  var n, j;
  for (n = 0; n < 4; n++) {
    // Mask bit order is reversed: bit3 is channel 1, bit0 is channel 4.
    if (!((mask >> (3 - n)) & 0x01)) { continue; }
    j = 6 * n;
    if (b.length < 11 + j) { break; }
    // Labelled by physical channel n, never by presence order.
    channels.push(soilProbe(b, 5 + j, 'probe' + n, calibrated));
  }
  if (channels.length > 0) { data.channels = channels; }
  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  // fPort 0 carries MAC commands only (LoRaWAN spec): there is no application
  // payload to decode, so this is not a decode failure. See AUTHORING.md.
  if (input && input.fPort === 0) {
    return { data: { make: "dragino", model: "se0x-lb" } };
  }
  if (!input || !input.bytes || input.bytes.length === 0) {
    return { errors: ['empty payload: no application bytes to decode'] };
  }

  var result = decodeUplinkCore(input);
  if (result && result.data) { result.data.make = "dragino"; result.data.model = "se0x-lb"; }
  return result;
}
