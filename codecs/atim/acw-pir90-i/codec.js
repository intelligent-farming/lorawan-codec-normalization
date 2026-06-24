// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for ATIM ACW-PIR90-I (90° Indoor Wall PIR Motion
// Sensor). Category: motion.
//
// Ported from the upstream Apache-2.0 ATIM generic decoder
// (TheThingsNetwork/lorawan-devices vendor/atim/decodeur.js, attributed in
// NOTICE). The upstream module is a single generic interpreter shared across
// the whole ATIM ACW range: it builds a schema string, reflects it into a
// verbose array-valued object, then post-processes it. This codec ports only
// the frame types the PIR90-I emits and normalizes them to the shared
// vocabulary. We author the normalization here; we do NOT reuse upstream
// normalizeUplink / postProcess output.
//
// Wire format (per upstream):
//   byte0 high-nibble bit3 (0x80) set  => "new product" (PIR90-I); bit3 clear
//     is a legacy product, not supported here.
//   byte0 high-nibble bit2 (0x40) set  => an embedded 4-byte UNIX timestamp
//     ("horo") follows byte0.
//   byte0 high-nibble bit1 (0x20) set  => "Trame de mesure" (measurement): a
//     stream of type-tagged channels. Each channel = 1 marker byte (low nibble
//     = type, high nibble = channel index) followed by its data. The PIR90-I
//     emits:
//       0x01 digital input -> 1 byte of input states (PIR detection line)
//       0x04 counter       -> 4 bytes, big-endian (motion event count)
//   non-measurement new-product frames are typed by byte1's low nibble:
//       0x1 "Trame de vie" (life/keep-alive): two 16-bit mV readings
//           (node voltage then capacitor voltage); node voltage = battery.
//       0xe "Trame d'erreur" (error): byte2 = error code.
//   empty payload => error.
//
// Motion mapping (the PIR90-I supports both an alarm/detection mode and a
// counting mode, per the datasheet):
//   digital input (0x01): upstream postProcessEntree decodes this two ways.
//     When the input byte is > 15 it carries per-channel motion state: for
//     channel 0, mask 0x10 = "movement present" and mask 0x01 = "state high".
//     When the byte is <= 15 the low nibble is four raw input bits (bit0 =
//     input 0). For the single-PIR PIR90-I we map input 0 to
//     action.motion.detected.
//   counter (0x04): the 32-bit value is the motion-event count ->
//     action.motion.count.
//   life-frame node voltage (mV/1000) -> battery (V).

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

// ERR_* codes (0x81..0x9F) mapped to English text (ported from upstream
// decode_trame_erreur). 0x8A / 0x95 append a battery voltage.
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
  // --- Frame-type detection (ported from upstream getFrameType) ---
  // byte0 high nibble: bit3 (0x80) distinguishes new vs legacy product;
  // bit2 (0x40) flags an embedded 4-byte timestamp; bit1 (0x20) marks a
  // measurement frame.
  var newProduct = (b0 & 0x80) !== 0;
  if (!newProduct) {
    return { errors: ['legacy ATIM product frame not supported by this codec'] };
  }

  var timestamped = (b0 & 0x40) !== 0;
  var isMeasurement = (b0 & 0x20) !== 0;
  if (isMeasurement) {
    return decodeMeasurement(bytes, timestamped);
  }

  var b1 = bytes.length > 1 ? bytes[1] : -1;
  if (b1 === 0x01) {
    return decodeLife(bytes, timestamped);
  }
  if ((b1 & 0x0f) === 0x0e) {
    return decodeError(bytes);
  }
  return { errors: ['unsupported frame type (byte1=0x' + b1.toString(16) + ')'] };
}

function decodeMeasurement(bytes, timestamped) {
  var data = {};
  var motion = {};
  var warnings = [];

  var i = 1; // skip byte0 (frame header)
  if (timestamped) {
    i += 4; // skip the 4-byte UNIX timestamp ("horo")
  }
  // The PIR90-I emits a single current reading (no history/sampling depth), so
  // there is no period header to skip and each channel carries one sample.

  var recognized = false;
  while (i < bytes.length) {
    var marker = bytes[i];
    var type = marker & 0x0f;

    if (type === 0x01) {
      // Digital input: one byte of input states (PIR detection line on input 0).
      if (i + 1 >= bytes.length) {
        return { errors: ['truncated digital-input channel'] };
      }
      var v = bytes[i + 1];
      var detected;
      if (v > 15) {
        // Per-channel motion state: for channel 0, mask 0x10 = "movement
        // present", mask 0x01 = "state high".
        detected = (v & 0x10) !== 0 && (v & 0x01) !== 0;
      } else {
        // Raw input bits: bit0 = input 0 (PIR detection line).
        detected = (v & 0x01) !== 0;
      }
      motion.detected = detected;
      i += 2;
      recognized = true;
    } else if (type === 0x04) {
      // Counter: 4 bytes, big-endian, motion-event count.
      if (i + 4 >= bytes.length) {
        return { errors: ['truncated counter channel'] };
      }
      var count = (bytes[i + 1] << 24) | (bytes[i + 2] << 16) |
        (bytes[i + 3] << 8) | bytes[i + 4];
      // Coerce to unsigned (the count is never negative).
      if (count < 0) {
        count += 4294967296;
      }
      motion.count = count;
      i += 5;
      recognized = true;
    } else {
      return {
        errors: ['unsupported measurement channel type 0x' + type.toString(16)]
      };
    }
  }

  if (!recognized) {
    return { errors: ['measurement frame contained no recognized channels'] };
  }
  if (motion.detected === undefined && motion.count === undefined) {
    return { errors: ['no usable motion data in measurement frame'] };
  }

  data.action = { motion: motion };
  var out = { data: data };
  if (warnings.length) {
    out.warnings = warnings;
  }
  return out;
}

function decodeLife(bytes, timestamped) {
  // Life (keep-alive) frame: byte0 byte1, optional 4-byte timestamp, then two
  // 16-bit millivolt readings: node voltage (battery) then capacitor voltage.
  var i = 2;
  if (timestamped) {
    i += 4;
  }
  if (i + 3 >= bytes.length) {
    return { errors: ['truncated life frame'] };
  }
  var v = (bytes[i] << 8) | bytes[i + 1]; // node/battery voltage, mV
  var c = (bytes[i + 2] << 8) | bytes[i + 3]; // capacitor voltage, mV
  return {
    data: {
      battery: round(v / 1000, 3),
      capacitorVoltage: round(c / 1000, 3)
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
    result.data.model = "acw-pir90-i";
  }
  return result;
}
