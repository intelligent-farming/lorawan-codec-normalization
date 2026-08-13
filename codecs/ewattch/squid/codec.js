// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for the Ewattch Squid — a LoRaWAN current-clamp
// energy sub-meter that measures single- or three-phase installations with up
// to 12 current clamps and reports calibrated per-clamp current, voltage,
// active/apparent/reactive power, line frequency and energy indexes.
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format understood with reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/ewattch/ewattchlorawandecoder.js,
// attributed in NOTICE). That decoder emits an array of vendor-typed objects
// (type:"voltage"/"current"/"power"/... with uuid/socket/channel and a raw
// `value`/`unit`); the normalization below is authored here and is NOT a copy
// of that decoder's output shape (ChirpStack rejects top-level arrays).
//
// Frame layout (clamp/metering uplink, header s=0 object stream):
//   byte0  = node/header byte (bit0=1 selects nodeInfo stream; metering uses 0)
//   byte1  = declared payload length (= total length - 2)
//   then a sequence of objects, each:
//     b0 = object byte: bit0 = hasSocketChannel, bit7 = error flag,
//          (b0 & 0x7E) = object type code (clamp metering is 0x40)
//     if hasSocketChannel: 1 byte = (socket<<5) | channel
//     for the clamp object (0x40): 1 header byte = (count<<4) | measureCode,
//       then `count` little-endian samples (2 or 3 bytes each) of measureCode.
//
// Every clamp is a sub-sensor position, so each one becomes an entry in the
// reserved `channels` array (see AUTHORING.md "Multi-channel devices"). The
// entry label mirrors the vendor's own clamp identifier — upstream names each
// clamp `clamp_s<socket>_c<channel>` — as `s<socket>c<channel>`, e.g. `s1c0`.
// Calibrated fields mapped to the vocabulary, per channels entry:
//   power.current (A)        <- measure 1  "current"      (mA / 1000)
//   power.voltage (V)        <- measure 10 "voltage"      (raw * 0.1)
//   power.active (W)         <- measure 4  "power"        (W, signed)
//   power.apparent (VA)      <- measure 11 "apparentPower"(VA)
//   power.frequency (Hz)     <- measure 12 "frequency"    (raw * 0.01)
//   metering.energy.total Wh <- measure 3  "consumedActiveEnergyIndex" (raw*10)
// Other genuine device data the flat vocabulary cannot model travels as
// camelCase extras inside the same entry: currentIndexMah,
// producedActiveEnergyWh, reactivePowerVar, positiveReactiveEnergyVarh,
// negativeReactiveEnergyVarh, apparentEnergyVah.
//
// Nothing metered is repeated at the top level: a clamp reading emitted in an
// entry must not also appear top-level or downstream stores double-count it,
// and this meter has no whole-device aggregate to report — clamps may sit on
// independent (or nested) circuits, so summing them would invent a site total
// the device never claimed. The top level therefore carries identity only.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function signedPower(raw, isPowerSign) {
  // 3-byte two's complement for power/reactivePower (measures 4 and 8).
  if (isPowerSign && (raw & 0x800000)) {
    raw = raw - 0x1000000;
  }
  return raw;
}

// Measure-code table: code -> { name, bytes, sign }.
function measureInfo(code) {
  switch (code) {
    case 0: return { name: 'currentIndex', bytes: 3 };
    case 1: return { name: 'current', bytes: 3 };
    case 3: return { name: 'consumedActiveEnergyIndex', bytes: 3 };
    case 4: return { name: 'power', bytes: 3, sign: true };
    case 5: return { name: 'producedActiveEnergyIndex', bytes: 3 };
    case 6: return { name: 'positiveReactiveEnergyIndex', bytes: 3 };
    case 7: return { name: 'negativeReactiveEnergyIndex', bytes: 3 };
    case 8: return { name: 'reactivePower', bytes: 3, sign: true };
    case 9: return { name: 'apparentEnergyIndex', bytes: 3 };
    case 10: return { name: 'voltage', bytes: 2 };
    case 11: return { name: 'apparentPower', bytes: 3 };
    case 12: return { name: 'frequency', bytes: 2 };
    default: return null;
  }
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;
  if (!bytes || bytes.length < 2) {
    return {
      errors: [
        'Squid frame too short (need at least 2 header bytes, got ' +
          (bytes ? bytes.length : 0) + ')'
      ]
    };
  }

  var header = bytes[0] & 0xff;
  // bit0 of the header selects the nodeInfo object stream (version/battery
  // level/periodicity), not metering. This codec normalizes metering uplinks.
  if (header & 0x01) {
    return { errors: ['Squid node-info uplink is not a metering frame'] };
  }

  var declared = bytes[1] & 0xff;
  if (declared !== bytes.length - 2) {
    return {
      errors: [
        'Payload size indicated (' + declared + ') does not match payload ' +
          'size given (' + (bytes.length - 2) + ')'
      ]
    };
  }

  var i = 2;
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

  while (i < bytes.length) {
    var objByte = bytes[i] & 0xff;
    i = i + 1;
    var hasSc = objByte & 0x01;
    var isError = (objByte & 0x80) === 0x80;
    var typeCode = objByte & 0x7e;

    var socket = 0;
    var channel = 0;
    if (hasSc) {
      if (i >= bytes.length) {
        return { errors: ['Truncated object: missing socket/channel byte'] };
      }
      var sc = bytes[i] & 0xff;
      socket = (sc & 0xe0) >> 5;
      channel = sc & 0x1f;
      i = i + 1;
    }

    if (isError) {
      // Sensor self-reported error object: one trailing byte, no value.
      warnings.push('clamp s' + socket + ' c' + channel + ' reported a sensor error');
      i = i + 1;
      continue;
    }

    if (typeCode !== 0x40) {
      return { errors: ['Unsupported Squid object type 0x' + typeCode.toString(16)] };
    }

    if (i >= bytes.length) {
      return { errors: ['Truncated clamp object: missing measure header'] };
    }
    var mh = bytes[i] & 0xff;
    i = i + 1;
    var count = (mh & 0xf0) >> 4;
    var code = mh & 0x0f;

    // measure code 2 is the paired index/current framing this metering
    // normalizer does not emit.
    if (code === 2) {
      return { errors: ['Squid paired index/current frame (measure 2) is unsupported'] };
    }

    var info = measureInfo(code);
    if (info === null) {
      return { errors: ['No such Squid measure code ' + code] };
    }

    var c;
    for (c = 0; c < count; c = c + 1) {
      var need = info.bytes;
      if (i + need > bytes.length) {
        return { errors: ['Truncated clamp samples for measure ' + code] };
      }
      var raw;
      if (need === 2) {
        raw = (bytes[i] & 0xff) | ((bytes[i + 1] & 0xff) << 8);
      } else {
        raw = (bytes[i] & 0xff) | ((bytes[i + 1] & 0xff) << 8) | ((bytes[i + 2] & 0xff) << 16);
      }
      i = i + need;
      raw = signedPower(raw, info.sign === true);

      var clamp = clampFor(socket, channel + c);

      if (code === 1) {
        powerOf(clamp).current = round(raw / 1000, 3);
      } else if (code === 10) {
        powerOf(clamp).voltage = round(raw * 0.1, 1);
      } else if (code === 4) {
        powerOf(clamp).active = raw;
      } else if (code === 11) {
        powerOf(clamp).apparent = raw;
      } else if (code === 12) {
        powerOf(clamp).frequency = round(raw * 0.01, 2);
      } else if (code === 3) {
        clamp.metering = { energy: { total: raw * 10 } };
      } else if (code === 0) {
        clamp.currentIndexMah = raw * 10;
      } else if (code === 5) {
        clamp.producedActiveEnergyWh = raw * 10;
      } else if (code === 6) {
        clamp.positiveReactiveEnergyVarh = raw * 10;
      } else if (code === 7) {
        clamp.negativeReactiveEnergyVarh = raw * 10;
      } else if (code === 8) {
        clamp.reactivePowerVar = raw;
      } else if (code === 9) {
        clamp.apparentEnergyVah = raw * 10;
      }
    }
  }

  if (channels.length === 0) {
    return { errors: ['Squid frame contained no clamp measurements'] };
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
    result.data.model = "squid";
  }
  return result;
}
