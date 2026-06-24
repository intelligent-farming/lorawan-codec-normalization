// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for ATIM ACW-PIR180-O (180° Outdoor Wall PIR Motion
// Sensor). Category: motion.
//
// Ported from the upstream Apache-2.0 ATIM generic decoder
// (TheThingsNetwork/lorawan-devices vendor/atim/decodeur.js, attributed in
// NOTICE). The upstream module is a single generic decoder shared across the
// whole ATIM ACW range; this codec ports only the frame types the PIR180-O
// emits and normalizes them to the shared vocabulary. We author the
// normalization here; we do NOT reuse upstream normalizeUplink/postProcess.
//
// Wire format (per upstream):
//   byte0 high-nibble bit1 set (e.g. 0xA0) => "Trame de mesure" (measurement):
//     a stream of type-tagged channels. Each channel = 1 marker byte
//     (low nibble = type, high nibble = channel index) followed by its data:
//       0x01 digital input  -> 1 byte, low nibble = 4 input bits (bit0..bit3)
//       0x04 counter        -> 4 bytes, big-endian unsigned event counter
//   byte0 high bit set with byte1 == 0x01 => "Trame de vie" (life/keep-alive):
//     [v_hi v_lo c_hi c_lo], battery voltage = (v<<8|v)/1000 V.
//   byte0 high bit set with low nibble 0x0E => "Trame d'erreur" (error).
//   byte0 high-nibble bit3 (0x80) clear => legacy "Ancien produit" (unsupported).
//   empty payload => error.
//
// Motion mapping: the PIR180-O reports its passive-infrared detector through
// digital input channel 0. Input bit0 high (1) = motion detected
// => action.motion.detected. When the device is configured for event counting
// it adds a counter channel (type 0x04, channel 0) holding the cumulative
// motion-event count => action.motion.count.
//
// byte0 high-nibble bit2 (0x40) flags an embedded 4-byte UNIX timestamp
// ("horo"); we skip it. History/sampling headers are not used by the PIR180-O.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function u16be(hi, lo) {
  return ((hi << 8) | lo) & 0xffff;
}

function u32be(b0, b1, b2, b3) {
  return ((b0 << 24) | (b1 << 16) | (b2 << 8) | b3) >>> 0;
}

// Classify the frame from byte 0, mirroring upstream getFrameType's bit tests
// on the high nibble plus the low nibble (oct2):
//   high-nibble bit3 (0x08 of the nibble) clear -> "old product" (legacy)
//   high-nibble bit1 (0x02 of the nibble) set   -> measurement frame
//   else low nibble selects the subtype: 0x1 life, 0xe error
// High-nibble bit2 (0x04 of the nibble) flags an embedded 4-byte timestamp.
function classifyFrame(bytes) {
  if (bytes.length < 1) {
    return { kind: 'empty' };
  }
  var hi = (bytes[0] >> 4) & 0x0f;
  var lo = bytes[0] & 0x0f;
  var timestamped = (hi & 0x04) !== 0;
  if ((hi & 0x08) === 0) {
    return { kind: 'old-product' };
  }
  if ((hi & 0x02) !== 0) {
    return { kind: 'measurement', timestamped: timestamped };
  }
  if (lo === 0x01) {
    return { kind: 'life', timestamped: timestamped };
  }
  if (lo === 0x0e) {
    return { kind: 'error', timestamped: timestamped };
  }
  return { kind: 'unsupported', subtype: lo };
}

function decodeMeasurement(bytes, frame) {
  var motion = {};

  var i = 1;
  // Skip the 4-byte UNIX timestamp ("horo") if present.
  if (frame.timestamped) {
    i += 4;
  }
  // The PIR180-O emits a single current reading (no history/sampling), so
  // there is no period header to skip and each block carries one sample.

  var recognized = false;
  while (i < bytes.length) {
    // The high nibble of a block's type byte encodes the sensor channel
    // ("voie"); the PIR180-O uses channel 0 only, so mask to the low nibble.
    var type = bytes[i] & 0x0f;

    if (type === 0x01) {
      // Digital input: one byte of input states; bit0 = input0 (PIR detector).
      if (i + 1 >= bytes.length) {
        return { errors: ['truncated digital-input block'] };
      }
      motion.detected = (bytes[i + 1] & 0x01) !== 0;
      i += 2;
      recognized = true;
    } else if (type === 0x04) {
      // Counter: big-endian unsigned 32-bit cumulative motion-event count.
      if (i + 4 >= bytes.length) {
        return { errors: ['truncated counter block'] };
      }
      motion.count = u32be(bytes[i + 1], bytes[i + 2], bytes[i + 3], bytes[i + 4]);
      i += 5;
      recognized = true;
    } else {
      return {
        errors: ['unsupported sensor type 0x' + bytes[i].toString(16)]
      };
    }
  }

  if (!recognized) {
    return { errors: ['no sensor blocks in measurement frame'] };
  }
  if (motion.detected === undefined && motion.count === undefined) {
    return { errors: ['no usable measurements'] };
  }

  return { data: { action: { motion: motion }, frameType: 'measurement' } };
}

function decodeLife(bytes, frame) {
  // Life (keep-alive) frame: optional 4-byte timestamp, then two 16-bit
  // millivolt readings: node voltage (tensionv) then capacitor voltage
  // (tensionc). The node voltage is the device battery.
  var i = 1;
  if (frame.timestamped) {
    i += 4;
  }
  if (i + 1 >= bytes.length) {
    return { errors: ['truncated life frame'] };
  }
  var battery = round(u16be(bytes[i], bytes[i + 1]) / 1000, 3);
  return { data: { battery: battery, frameType: 'life' } };
}

function decodeUplink(input) {
  var bytes = input.bytes;
  if (!bytes || bytes.length === 0) {
    return { errors: ['empty payload'] };
  }

  var frame = classifyFrame(bytes);
  if (frame.kind === 'measurement') {
    return decodeMeasurement(bytes, frame);
  }
  if (frame.kind === 'life') {
    return decodeLife(bytes, frame);
  }
  if (frame.kind === 'error') {
    return { errors: ['device error frame (no measurement)'] };
  }
  if (frame.kind === 'old-product') {
    return { errors: ['unsupported legacy ATIM frame'] };
  }
  return { errors: ['unsupported ATIM frame type'] };
}
