// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for ATIM ACW-PIR90-O (90 degree Outdoor Wall PIR
// Motion Sensor). Category: motion.
//
// Ported from the upstream Apache-2.0 ATIM generic decoder
// (TheThingsNetwork/lorawan-devices vendor/atim/decodeur.js, attributed in
// NOTICE). The upstream module is a single generic decoder shared across the
// whole ATIM ACW range; this codec ports only the frame types the PIR sensor
// emits and normalizes them to the shared vocabulary. We author the
// normalization here; we do NOT reuse upstream normalizeUplink output.
//
// Wire format (per upstream getFrameType / frame_type_ancien /
// decode_trame_ancien / postProcessAncienPir):
//   The PIR is a "legacy product" (byte0 high-nibble bit3 / 0x80 clear). Its
//   frame type is keyed off byte0 directly.
//
//   byte0 == 0x32  => "Produit PIR" (the PIR data frame), layout:
//     [type_trame(1) ouverture_boitier(1) capteur_dq(2) compteur_pir(2)
//      temperature_pir(2)] -> 9 bytes total including byte0.
//       type_trame:        0x01 enclosure-open event, 0x08 motion alarm,
//                          0x10 periodic count frame.
//       ouverture_boitier: 0x00 enclosure open, otherwise enclosure closed.
//       capteur_dq[1]:     0x00 active, 0x01 disabled, else unused.
//       compteur_pir:      uint16 BE, cumulative motion-detection count.
//       temperature_pir:   uint16 BE, PIR analog supply reading in mV.
//   byte0 == 0x01  => legacy "Trame de vie" (keep-alive): [tensionc(2)] in mV.
//   New-product error frame (byte0 high bit 0x80 set, byte1 low nibble 0x0E)
//     => surfaced as a decode error (carries no measurement).
//   empty payload => error.
//
// Motion mapping: a motion alarm frame (type_trame 0x08) sets
// action.motion.detected = true; any other PIR frame reports detected = false.
// compteur_pir maps to action.motion.count.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

// ERR_* codes (0x81..0x9F) mapped to English text (from upstream
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

  // New-product frames have byte0 high bit (0x80) set; the only new-product
  // frame this PIR codec recognizes is the error frame (byte1 low nibble 0xE).
  var newProduct = (b0 & 0x80) !== 0;
  if (newProduct) {
    var b1 = bytes.length > 1 ? bytes[1] : -1;
    if ((b1 & 0x0f) === 0x0e) {
      return decodeError(bytes);
    }
    return { errors: ['unsupported new-product frame (byte0=0x' + b0.toString(16) + ')'] };
  }

  // Legacy-product frames are keyed off byte0 directly.
  if (b0 === 0x32) {
    return decodePir(bytes);
  }
  if (b0 === 0x01) {
    return decodeLife(bytes);
  }
  return { errors: ['unsupported legacy frame type (byte0=0x' + b0.toString(16) + ')'] };
}

function decodePir(bytes) {
  // [0x32 type_trame ouverture_boitier dq_hi dq_lo cnt_hi cnt_lo mv_hi mv_lo]
  if (bytes.length < 9) {
    return { errors: ['truncated PIR frame'] };
  }
  var typeTrame = bytes[1];
  var ouverture = bytes[2];
  var dqState = bytes[4]; // capteur_dq[1]
  var count = (bytes[5] << 8) | bytes[6];
  var mv = (bytes[7] << 8) | bytes[8];

  var frameType;
  if (typeTrame === 0x01) {
    frameType = 'enclosureOpen';
  } else if (typeTrame === 0x08) {
    frameType = 'motionAlarm';
  } else if (typeTrame === 0x10) {
    frameType = 'count';
  } else {
    frameType = 'unknown';
  }

  var sensorState;
  if (dqState === 0x00) {
    sensorState = 'active';
  } else if (dqState === 0x01) {
    sensorState = 'disabled';
  } else {
    sensorState = 'unused';
  }

  var data = {
    action: {
      motion: {
        detected: typeTrame === 0x08,
        count: count
      }
    },
    frameType: frameType,
    enclosureOpen: ouverture === 0x00,
    sensorState: sensorState,
    pirSensorVoltage: round(mv / 1000, 3)
  };
  return { data: data };
}

function decodeLife(bytes) {
  // legacy keep-alive: [0x01 tensionc_hi tensionc_lo]
  if (bytes.length < 3) {
    return { errors: ['truncated life frame'] };
  }
  var mv = (bytes[1] << 8) | bytes[2];
  return {
    data: {
      battery: round(mv / 1000, 3)
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
  return { errors: ['device error frame: ' + text] };
}
