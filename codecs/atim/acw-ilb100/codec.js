// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for ATIM ACW-ILB100 (Infrared Light Barrier:
// 4-beam outdoor presence detection / people counting, range ~100 m).
// Category: motion.
//
// Ported from the upstream Apache-2.0 ATIM generic decoder
// (TheThingsNetwork/lorawan-devices vendor/atim/decodeur.js, codec id
// "codecpir", attributed in NOTICE). The upstream module is a single generic
// interpreter shared across the whole ATIM ACW range: it derives a schema
// string, reflects it into a verbose object, then post-processes it. This codec
// ports only the "Produit PIR" legacy frame that the ILB100 emits and
// normalizes it to the shared vocabulary. We author the normalization here; we
// do NOT reuse upstream normalizeUplink/postProcess output.
//
// Wire format (per upstream frame_type_ancien + postProcessAncienPir):
//   byte0 == 0x32                              => "Produit PIR" frame.
//   Layout: [0x32, type_trame, ouverture_boitier, dq_hi, dq_lo,
//            cpt_hi, cpt_lo, temp_hi, temp_lo]  (9 bytes)
//     type_trame        0x01 box-opening, 0x08 alarm/detection, 0x10 counting
//     ouverture_boitier 0x00 enclosure open, else closed
//     capteur_dq[1]     0x00 sensor active, 0x01 disabled, else not used
//     compteur_pir      u16be = cumulative PIR detection count
//     temperature_pir   u16be = PIR sensor voltage in mV
//
// Mappings:
//   compteur_pir                       -> action.motion.count (number)
//   type_trame 0x08 (alarm/detection)  -> action.motion.detected = true
//     (0x10 counting / 0x01 box-opening are not themselves detection events)
//   type_trame                         -> frameType (camelCase extra)
//   ouverture_boitier                  -> enclosureOpen (boolean extra)
//   capteur_dq state                   -> sensorState (string extra)
//   temperature_pir (mV)               -> sensorVoltage V (number extra)
// The PIR frame carries no battery measurement, so `battery` is not emitted.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function u16be(hi, lo) {
  return ((hi << 8) | lo) & 0xffff;
}

function decodeUplink(input) {
  var bytes = input.bytes;
  if (!bytes || bytes.length === 0) {
    return { errors: ['empty payload'] };
  }
  if (bytes[0] !== 0x32) {
    return {
      errors: ['unsupported ATIM frame type 0x' + bytes[0].toString(16) +
        ' (this codec decodes only the ILB100 PIR frame 0x32)']
    };
  }
  if (bytes.length < 9) {
    return { errors: ['truncated PIR frame'] };
  }

  var typeTrame = bytes[1];
  var ouverture = bytes[2];
  var dqState = bytes[4];
  var count = u16be(bytes[5], bytes[6]);
  var sensorMillivolts = u16be(bytes[7], bytes[8]);

  var frameType;
  if (typeTrame === 0x01) {
    frameType = 'boxOpening';
  } else if (typeTrame === 0x08) {
    frameType = 'alarm';
  } else if (typeTrame === 0x10) {
    frameType = 'counting';
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

  var motion = { count: count };
  // The alarm frame is the genuine detection event; counting/box-opening
  // frames report the running count without asserting a fresh detection.
  if (typeTrame === 0x08) {
    motion.detected = true;
  }

  var data = {
    action: { motion: motion },
    frameType: frameType,
    enclosureOpen: ouverture === 0x00,
    sensorState: sensorState,
    sensorVoltage: round(sensorMillivolts / 1000, 3)
  };

  return { data: data };
}
