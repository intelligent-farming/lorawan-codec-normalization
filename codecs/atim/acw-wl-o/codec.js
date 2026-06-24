// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for ATIM ACW-WL-O (Outdoor Liquid / Water-Leak
// Monitoring). Category: water-leak.
//
// Ported from the upstream Apache-2.0 ATIM generic decoder
// (TheThingsNetwork/lorawan-devices vendor/atim/decodeur.js, attributed in
// NOTICE). The upstream module is a single generic decoder shared across the
// whole ATIM ACW range; this codec ports only the frame types the WL-O emits
// and normalizes them to the shared vocabulary. We author the normalization
// here; we do NOT reuse upstream normalizeUplink output.
//
// Wire format (per upstream):
//   byte0 high-nibble bit2 set (e.g. 0xA0) => "Trame de mesure" (measurement):
//     a stream of type-tagged channels. Each channel = 1 marker byte
//     (low nibble = type, high nibble = channel index) followed by its data:
//       0x01 digital input  -> 1 byte, low nibble = 4 input bits (bit0..bit3)
//       0x08 temperature    -> 2 bytes, signed, /100 = degC
//   byte0 high bit set with byte1 == 0x01 => "Trame de vie" (life/keep-alive):
//     [v_hi v_lo c_hi c_lo], battery voltage = (v<<8|v)/1000 V.
//   byte1 low nibble == 0x0E => "Trame d'erreur" (error): byte2 = error code.
//   empty payload => error.
//
// Leak mapping: the WL-O is a single-probe liquid detector wired to digital
// input channel 0. Input bit0 high (1) = liquid/leak detected => water.leak.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

// ERR_* codes (0x81..0x9F) mapped to English text.
var ERR_TEXT = {
  129: 'Sensor returned no data',
  130: 'Data buffer full',
  131: 'History depth out of range',
  132: 'Sample count out of range',
  133: 'Channel count out of range',
  134: 'Measurement type out of range',
  135: 'Bad sampling-period structure',
  136: 'Subtask ended unexpectedly',
  137: 'Null pointer',
  138: 'Battery level critical',
  139: 'EEPROM corrupted',
  140: 'ROM corrupted',
  141: 'RAM corrupted',
  142: 'Radio module init failed',
  143: 'Radio module busy',
  144: 'Radio module in bridge mode',
  145: 'Radio queue full',
  146: 'Black-box init failed',
  147: 'Bad keep-alive-period structure',
  148: 'Entered deep sleep',
  149: 'Battery level low',
  150: 'Radio transmission error',
  151: 'Payload too large for network',
  152: 'Network pairing timeout',
  153: 'Sensor timeout',
  154: 'Sensor returned no value',
  155: 'Sensor not detected at startup',
  156: 'Enclosure opened',
  157: 'Enclosure closed',
  158: 'Movement/theft detected',
  159: 'Sensor data corrupted'
};

function decodeUplinkCore(input) {
  var bytes = input.bytes;
  if (!bytes || bytes.length === 0) {
    return { errors: ['empty payload'] };
  }

  var b0 = bytes[0];
  var b1 = bytes.length > 1 ? bytes[1] : -1;

  // --- Frame-type detection (ported from upstream getFrameType) ---
  // byte0 high nibble: bit0 (0x80) distinguishes new vs legacy product;
  // bit2 (0x20) marks a measurement frame.
  var newProduct = (b0 & 0x80) !== 0;
  if (!newProduct) {
    return { errors: ['legacy ATIM product frame not supported by this codec'] };
  }

  var isMeasurement = (b0 & 0x20) !== 0;
  if (isMeasurement) {
    return decodeMeasurement(bytes);
  }
  // Non-measurement new-product frames are typed by byte1.
  if (b1 === 0x01) {
    return decodeLife(bytes);
  }
  if ((b1 & 0x0f) === 0x0e) {
    return decodeError(bytes);
  }
  return { errors: ['unsupported frame type (byte1=0x' + b1.toString(16) + ')'] };
}

function decodeMeasurement(bytes) {
  var data = {};
  var warnings = [];
  var i = 1; // skip byte0 (frame header); WL-O measurement frames are not timestamped
  while (i < bytes.length) {
    var marker = bytes[i];
    var type = marker & 0x0f;
    var channel = (marker & 0xf0) >> 4; // high nibble = channel index (0..3)

    if (type === 0x01) {
      // digital input: 1 data byte, low nibble holds 4 input bits
      var v = bytes[i + 1];
      if (v === undefined) {
        return { errors: ['truncated digital-input channel'] };
      }
      // bit0 = probe / liquid-detect line for the WL-O
      if (data.water === undefined) {
        data.water = {};
      }
      data.water.leak = (v & 0x01) !== 0;
      // expose all four raw input lines as an extra (bit0..bit3)
      data.digitalInputs = [
        (v & 0x01) !== 0 ? 1 : 0,
        (v & 0x02) !== 0 ? 1 : 0,
        (v & 0x04) !== 0 ? 1 : 0,
        (v & 0x08) !== 0 ? 1 : 0
      ];
      i += 2;
    } else if (type === 0x08) {
      // temperature: 2 bytes, signed, /100 degC
      var hi = bytes[i + 1];
      var lo = bytes[i + 2];
      if (hi === undefined || lo === undefined) {
        return { errors: ['truncated temperature channel'] };
      }
      var raw = ((hi << 8) | lo) << 16 >> 16; // sign-extend 16-bit
      if (raw === -32768) {
        warnings.push('temperature sensor error on channel ' + channel);
      } else {
        if (data.water === undefined) {
          data.water = {};
        }
        if (data.water.temperature === undefined) {
          data.water.temperature = {};
        }
        data.water.temperature.current = round(raw / 100, 2);
      }
      i += 3;
    } else {
      return { errors: ['unsupported measurement channel type 0x' + type.toString(16)] };
    }
  }

  if (data.water === undefined) {
    return { errors: ['measurement frame contained no recognized channels'] };
  }
  var out = { data: data };
  if (warnings.length) {
    out.warnings = warnings;
  }
  return out;
}

function decodeLife(bytes) {
  // byte0 byte1 then [v_hi v_lo c_hi c_lo]
  if (bytes.length < 6) {
    return { errors: ['truncated life frame'] };
  }
  var v = (bytes[2] << 8) | bytes[3]; // battery voltage, mV
  var c = (bytes[4] << 8) | bytes[5]; // supply / charge voltage, mV
  return {
    data: {
      battery: round(v / 1000, 3),
      chargeVoltage: round(c / 1000, 3)
    }
  };
}

function decodeError(bytes) {
  if (bytes.length < 3) {
    return { errors: ['truncated error frame'] };
  }
  var code = bytes[2];
  var text = ERR_TEXT[code];
  if (text === undefined) {
    text = 'unknown error (0x' + code.toString(16) + ')';
  }
  // ERR_BATTERY_LEVEL_DEAD (0x8A) / ERR_BATTERY_LEVEL_LOW (0x95) append a
  // battery voltage in the following two bytes.
  if ((code === 0x8a || code === 0x95) && bytes.length >= 5) {
    var mv = (bytes[3] << 8) | bytes[4];
    return { errors: ['device error: ' + text + ' (battery ' + round(mv / 1000, 3) + ' V)'] };
  }
  return { errors: ['device error: ' + text] };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "atim";
    result.data.model = "acw-wl-o";
  }
  return result;
}
