// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for ATIM ACW-PIR360 (360° Indoor Ceiling PIR Motion
// Sensor). Category: motion.
//
// Ported from the upstream Apache-2.0 ATIM generic decoder
// (TheThingsNetwork/lorawan-devices vendor/atim/decodeur.js, codec id
// "codecpir", attributed in NOTICE). The upstream module is a single generic
// interpreter shared across the whole ATIM ACW range that builds a schema
// string, reflects it into a verbose array-valued object, then post-processes
// it. We re-derive only the PIR360-relevant frames directly and emit normalized
// vocabulary keys. We do NOT reuse upstream normalizeUplink / postProcess.
//
// Wire format (per upstream getFrameType / decodeFrame / postProcessEntree /
// postProcessCompteur):
//   byte0 high nibble: bit3 (0x80) set => "new product"; cleared => legacy
//     (unsupported). bit1 (0x20) set => "Trame de mesure" (measurement). bit2
//     (0x40) set => an embedded 4-byte UNIX timestamp ("horo") follows byte0.
//   Non-measurement new-product frames are typed by byte0's LOW nibble (the
//     whole frame type lives in byte0; upstream getFrameType reads its two hex
//     nibbles): 0x1 => "Trame de vie" (life/keep-alive), 0xe => "Trame d'erreur".
//
//   A measurement frame is a stream of type-tagged channels. Each channel is a
//   marker byte (low nibble = type, high nibble = channel index "voie")
//   followed by its data bytes. The PIR360 uses:
//     0x01 digital input (alarm mode) -> 1 byte; low nibble = 4 input states
//          (bit0 = input 0 = the PIR line). When the byte is > 0x0f the upstream
//          treats it as a "state change" frame where a high-nibble bit marks
//          which input changed and the matching low-nibble bit gives the new
//          level (1 = etat haut). Either way, the PIR (input 0) being
//          active/high => motion detected.
//     0x04 counter (counting mode)    -> 4 bytes, big-endian unsigned: the PIR
//          event counter.
//   Life frames carry [v_hi v_lo c_hi c_lo]: node voltage then capacitor
//   voltage, in mV (after the optional timestamp).
//
// Mappings:
//   digital input 0 active/high (block 0x01) -> action.motion.detected (boolean)
//   PIR counter (block 0x04)                 -> action.motion.count (number)
//   life-frame node voltage (mV/1000)        -> battery (V)
//   life-frame capacitor voltage (mV/1000)   -> chargeVoltage (camelCase extra)
//   frame type                               -> frameType (camelCase extra)
// Error frames carry no measurement and are surfaced as errors.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

// ERR_* codes (0x81..0x9F) mapped to English text (ported from
// decode_trame_erreur).
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

function decodeUplink(input) {
  var bytes = input.bytes;
  if (!bytes || bytes.length === 0) {
    return { errors: ['empty payload'] };
  }

  var b0 = bytes[0];

  // --- Frame-type detection (ported from upstream getFrameType) ---
  // byte0 high nibble: bit3 (0x80) distinguishes new vs legacy product;
  // bit1 (0x20) marks a measurement frame; bit2 (0x40) flags a timestamp.
  var newProduct = (b0 & 0x80) !== 0;
  if (!newProduct) {
    return { errors: ['legacy ATIM product frame not supported by this codec'] };
  }

  var timestamped = (b0 & 0x40) !== 0;
  var isMeasurement = (b0 & 0x20) !== 0;
  if (isMeasurement) {
    return decodeMeasurement(bytes, timestamped);
  }

  // Non-measurement frames are discriminated by byte0's low nibble.
  var sub = b0 & 0x0f;
  if (sub === 0x01) {
    return decodeLife(bytes, timestamped);
  }
  if (sub === 0x0e) {
    return decodeError(bytes, timestamped);
  }
  return { errors: ['unsupported frame type (byte0=0x' + b0.toString(16) + ')'] };
}

function decodeMeasurement(bytes, timestamped) {
  var data = {};
  var motion = {};

  var i = 1; // skip byte0 (frame header)
  // Skip the 4-byte UNIX timestamp ("horo") if present.
  if (timestamped) {
    i += 4;
  }
  // The PIR360 reports a single current reading per frame (no history/sampling
  // header), so each channel carries exactly one sample.

  var recognized = false;
  while (i < bytes.length) {
    var marker = bytes[i];
    var type = marker & 0x0f;

    if (type === 0x01) {
      // Digital input (alarm mode): one data byte.
      var v = bytes[i + 1];
      if (v === undefined) {
        return { errors: ['truncated digital-input channel'] };
      }
      // The PIR is wired to input 0. When v <= 0x0f the low nibble directly
      // holds the four input levels (bit0 = input 0). When v > 0x0f the frame
      // is a "state change": high-nibble bit0 (0x10) flags that input 0 changed
      // and low-nibble bit0 (0x01) gives the new level (1 = high). In both
      // encodings, input 0 being high means the PIR line is active => motion.
      if (v > 0x0f) {
        motion.detected = (v & 0x10) !== 0 && (v & 0x01) !== 0;
      } else {
        motion.detected = (v & 0x01) !== 0;
      }
      i += 2;
      recognized = true;
    } else if (type === 0x04) {
      // Counter (counting mode): 4-byte big-endian unsigned event count.
      var c0 = bytes[i + 1];
      var c1 = bytes[i + 2];
      var c2 = bytes[i + 3];
      var c3 = bytes[i + 4];
      if (c3 === undefined) {
        return { errors: ['truncated counter channel'] };
      }
      // Use unsigned arithmetic; a 32-bit shift would go negative in JS.
      motion.count = c0 * 16777216 + c1 * 65536 + c2 * 256 + c3;
      i += 5;
      recognized = true;
    } else {
      return { errors: ['unsupported measurement channel type 0x' + type.toString(16)] };
    }
  }

  if (!recognized) {
    return { errors: ['no sensor channels in measurement frame'] };
  }

  data.action = { motion: motion };
  data.frameType = 'measurement';
  return { data: data };
}

function decodeLife(bytes, timestamped) {
  // Optional 4-byte timestamp, then [v_hi v_lo c_hi c_lo]: node voltage then
  // capacitor voltage, in mV.
  var i = 1;
  if (timestamped) {
    i += 4;
  }
  if (bytes[i + 3] === undefined) {
    return { errors: ['truncated life frame'] };
  }
  var v = (bytes[i] << 8) | bytes[i + 1]; // node / battery voltage, mV
  var c = (bytes[i + 2] << 8) | bytes[i + 3]; // capacitor voltage, mV
  return {
    data: {
      battery: round(v / 1000, 3),
      chargeVoltage: round(c / 1000, 3),
      frameType: 'life'
    }
  };
}

function decodeError(bytes, timestamped) {
  // byte0 byte1 then optional 4-byte timestamp, then error code byte.
  var i = 2;
  if (timestamped) {
    i += 4;
  }
  var code = bytes[i];
  if (code === undefined) {
    return { errors: ['truncated error frame'] };
  }
  var text = ERR_TEXT[code];
  if (text === undefined) {
    text = 'unknown error (0x' + code.toString(16) + ')';
  }
  // ERR_BATTERY_LEVEL_DEAD (0x8A) / ERR_BATTERY_LEVEL_LOW (0x95) append a
  // battery voltage in the following two bytes.
  if ((code === 0x8a || code === 0x95) && bytes[i + 2] !== undefined) {
    var mv = (bytes[i + 1] << 8) | bytes[i + 2];
    return { errors: ['device error: ' + text + ' (battery ' + round(mv / 1000, 3) + ' V)'] };
  }
  return { errors: ['device error: ' + text] };
}
