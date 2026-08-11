// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for ewattch/tyness (modular LoRaWAN node; the
// power-metering variant carries one or more current clamps).
//
// Ported/normalized from the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/ewattch/ewattchlorawandecoder.js,
// attributed in NOTICE). The upstream file is Ewattch's generic decoder shared
// across the whole product line (environnement/presence/ambiance/squid/impulse/
// tyness/tynode). The source of truth for the tyness power-meter wire format is
// its data-frame path:
//   header byte0 = 0  -> data frame (object table); byte1 = payload length
//   each object: low bit = has-socket/channel byte; bit7 = error flag;
//                bits1..6 (mask 0x7e) = object type code
//   the "clamp" object (type code 0x40) is the calibrated power-meter source.
//
// Clamp object layout (faithful port of upstream case 0x40):
//   measure header byte: high nibble n = channel count, low nibble u = measure
//   code. Per channel, a little-endian integer of width 2 (u in {10,12}) or 3
//   (otherwise), scaled by the per-code factor below. Power (code 4) and
//   reactivePower (code 8) are sign-extended from 24 bits. The paired branch
//   (u == 2) emits, per channel, a currentIndex block then a current block
//   (both 3-byte LE).
//
// Every clamp is a sub-sensor position, so each one becomes an entry in the
// reserved `channels` array (see AUTHORING.md "Multi-channel devices"),
// labelled `s<socket>c<channel>` after upstream's own
// `clamp_s<socket>_c<channel>` naming — the same convention as the
// ewattch/squid codec. Per entry:
//   voltage              -> power.voltage           (V; x0.1)
//   current  (mA)        -> power.current           (A; mA / 1000)
//   power    (W)         -> power.active            (W)
//   consumedActiveEnergy -> metering.energy.total   (Wh; x10)
//   apparentPower (VA)   -> power.apparent          (VA)
//   frequency (Hz)       -> power.frequency         (Hz; x0.01)
// Additional clamp quantities the vocabulary does not model become camelCase
// extras inside the same entry (Wh/varh/VAh indexes, reactive power, raw
// current index): currentIndexMah, producedActiveEnergyWh,
// positiveReactiveEnergyVarh, negativeReactiveEnergyVarh, reactivePowerVar,
// apparentEnergyVah. The top level carries identity only.
//
// Scope note: non-clamp objects (analog/pulse/digital/temperature) are raw or
// uncalibrated and out of scope for power-meter; without a full length table
// for every object type the stream cannot be skipped safely, so such frames
// abort with an error. A clamp object flagged in error yields a warning for
// that position, not a reading.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function u8(bytes, i) {
  return bytes[i] & 0xff;
}

// Little-endian unsigned, width 2 or 3.
function uleN(bytes, i, width) {
  if (width === 2) {
    return (bytes[i] | (bytes[i + 1] << 8)) >>> 0;
  }
  return (bytes[i] | (bytes[i + 1] << 8) | (bytes[i + 2] << 16)) >>> 0;
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;
  if (!bytes || bytes.length < 2) {
    return { errors: ['payload too short'] };
  }

  // Header. byte0 == 0 selects the data-frame object table; any other value is
  // a config/info frame that carries no power-meter measurement.
  if ((bytes[0] & 0xff) !== 0) {
    return { errors: ['not a data frame (header byte 0x' + (bytes[0] & 0xff).toString(16) + '): no power-meter measurement'] };
  }
  if (bytes[1] !== bytes.length - 2) {
    return { errors: ['Payload size indicated does not match payload size given'] };
  }

  var channels = [];
  var channelIndex = {};
  var warnings = [];

  // One channels entry per (socket, channel) clamp, created on first sight so
  // entry order follows the payload.
  function clampFor(socket, channel) {
    var key = socket + ':' + channel;
    if (channelIndex[key] === undefined) {
      channelIndex[key] = channels.length;
      channels.push({ channel: 's' + socket + 'c' + channel });
    }
    return channels[channelIndex[key]];
  }

  // The `power` group is created lazily: a clamp reporting only an energy index
  // must not carry an empty `power: {}`.
  function powerOf(entry) {
    if (entry.power === undefined) {
      entry.power = {};
    }
    return entry.power;
  }

  var i = 2;
  while (i < bytes.length) {
    var head = u8(bytes, i);
    var hasAddr = (head & 0x01) === 1;
    var isError = (head & 0x80) === 0x80;
    var typeCode = head & 0x7e;
    i += 1;

    if (typeCode !== 0x40) {
      // Non-clamp object types are out of scope for power-meter. Without a
      // full length table for every object we cannot safely skip past them,
      // so abort rather than misalign the stream.
      return { errors: ['unsupported object type 0x' + typeCode.toString(16) + ': no clamp/power-meter data'] };
    }

    var socket = 0;
    var channel = 0;
    if (hasAddr) {
      var addr = u8(bytes, i);
      socket = (addr & 0xe0) >> 5;
      channel = addr & 0x1f;
      i += 1;
    }

    if (isError) {
      // Clamp object flagged in error: 1 status byte, no measurement.
      warnings.push('clamp s' + socket + ' c' + channel + ' reported a sensor error');
      i += 1;
      continue;
    }

    if (i >= bytes.length) {
      return { errors: ['truncated clamp object: missing measure header'] };
    }
    var header = u8(bytes, i);
    var n = (header & 0xf0) >> 4;
    var u = header & 0x0f;
    i += 1;
    var c;

    if (u === 2) {
      // Paired branch: n currentIndex blocks (3-byte LE, x10 mAh) then n
      // current blocks (3-byte LE, x1 mA), channel-aligned.
      if (i + 6 * n > bytes.length) {
        return { errors: ['truncated paired index/current clamp object'] };
      }
      for (c = 0; c < n; c++) {
        clampFor(socket, channel + c).currentIndexMah = 10 * uleN(bytes, i, 3);
        i += 3;
      }
      for (c = 0; c < n; c++) {
        powerOf(clampFor(socket, channel + c)).current = round(uleN(bytes, i, 3) / 1000, 3);
        i += 3;
      }
      continue;
    }

    if (u > 12) {
      // Upstream returns a string and stops on an unknown clamp measure code.
      return { errors: ['unknown clamp measure code ' + u] };
    }

    var width = (u === 10 || u === 12) ? 2 : 3;
    for (c = 0; c < n; c++) {
      if (i + width > bytes.length) {
        return { errors: ['truncated clamp samples for measure ' + u] };
      }
      var raw = uleN(bytes, i, width);
      // Power (4) and reactivePower (8) are signed 24-bit.
      if ((u === 4 || u === 8) && (raw & 0x800000)) {
        raw = raw - 0x1000000;
      }
      i += width;

      var clamp = clampFor(socket, channel + c);
      if (u === 1) {
        powerOf(clamp).current = round(raw / 1000, 3);
      } else if (u === 10) {
        powerOf(clamp).voltage = round(raw * 0.1, 1);
      } else if (u === 4) {
        powerOf(clamp).active = round(raw, 0);
      } else if (u === 11) {
        powerOf(clamp).apparent = round(raw, 0);
      } else if (u === 12) {
        powerOf(clamp).frequency = round(raw * 0.01, 2);
      } else if (u === 3) {
        clamp.metering = { energy: { total: round(raw * 10, 0) } };
      } else if (u === 0) {
        clamp.currentIndexMah = round(raw * 10, 0);
      } else if (u === 5) {
        clamp.producedActiveEnergyWh = round(raw * 10, 0);
      } else if (u === 6) {
        clamp.positiveReactiveEnergyVarh = round(raw * 10, 0);
      } else if (u === 7) {
        clamp.negativeReactiveEnergyVarh = round(raw * 10, 0);
      } else if (u === 8) {
        clamp.reactivePowerVar = round(raw, 0);
      } else if (u === 9) {
        clamp.apparentEnergyVah = round(raw * 10, 0);
      }
    }
  }

  if (channels.length === 0) {
    return { errors: ['no clamp measurement in frame'] };
  }

  var data = { channels: channels };
  if (warnings.length > 0) {
    return { data: data, warnings: warnings };
  }
  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "ewattch";
    result.data.model = "tyness";
  }
  return result;
}
