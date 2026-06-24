// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for RadioBridge RBS306-ABM (Outdoor
// Acceleration-Based Movement sensor — reports start/stop of movement detected
// by an onboard accelerometer).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format (RadioBridge protocol-version + event/message-type frame) understood
// with reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/radio-bridge/
// radio_bridge_packet_decoder.js, "RADIO BRIDGE PACKET DECODER v1.4",
// attributed in NOTICE). Ported from that decoder's Generic_Decoder; the
// normalization (vocabulary mapping) is authored here, NOT copied from upstream.
//
// The RBS306 series shares the generic RadioBridge event-based decoder; the
// ABM is the outdoor acceleration-based movement variant. Movement is reported
// as an event STATE (Movement Started / Movement Stopped), not a numeric field.
//
// Frame: byte[0] high nibble = protocol version, low nibble = packet counter;
// byte[1] = event / message type; remaining bytes are event-specific.
//
// Mapping decisions:
//   0x0E ABM          byte[2] (0=Movement Started, !=0=Movement Stopped)
//                     -> action.motion.detected (true = moving, false = idle).
//   0x01 SUPERVISORY  battery "X.Y" nibbles of byte[4] -> battery (volts).
//                     byte[9..10] 16-bit accumulation count is the number of
//                     movement detections since reset -> action.motion.count.
//                     byte[2] flags -> camelCase extras.
//   0x02 TAMPER       byte[2] (0=Open,1=Closed)   -> tamperEvent extra
//   0xFB LINK QUALITY subband/rssi/snr             -> camelCase extras
//   0x00 RESET        device type                  -> deviceType extra
//   0xFF DOWNLINK ACK valid/invalid                -> downlinkAck extra
//
// upstream emits ABM.Event "Movement Started" (byte[2]==0) or "Movement
// Stopped" (byte[2]!=0). We map the started state to detected=true (motion in
// progress) and the stopped state to detected=false (idle / motion cleared).
//
// The upstream Supervisory message reports battery as an "X.Y" string built
// from the two nibbles of byte[4] (e.g. 0x36 -> "3.6" -> 3.6 V). The vocabulary
// `battery` is volts, so it is parsed back to a number matching upstream's
// parseFloat semantics. The supervisory accumulation counter is the running
// total of movement detections, mapped to action.motion.count.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

// Upstream battery: parseFloat(major + "." + minor) where major/minor are the
// nibbles of byte[4]; the low nibble is a tenths digit (0x36 -> "3.6" -> 3.6).
function batteryVolts(b) {
  var major = (b >> 4) & 0x0f;
  var minor = b & 0x0f;
  return parseFloat(major + '.' + minor);
}

var RESET_DEVICE_TYPES = {
  1: 'Door/Window Sensor',
  2: 'Door/Window High Security',
  3: 'Contact Sensor',
  4: 'No-Probe Temperature Sensor',
  5: 'External-Probe Temperature Sensor',
  6: 'Single Push Button',
  7: 'Dual Push Button',
  8: 'Acceleration-Based Movement Sensor',
  9: 'Tilt Sensor',
  10: 'Water Sensor',
  11: 'Tank Level Float Sensor',
  12: 'Glass Break Sensor',
  13: 'Ambient Light Sensor',
  14: 'Air Temperature and Humidity Sensor',
  15: 'High-Precision Tilt Sensor',
  16: 'Ultrasonic Level Sensor',
  17: '4-20mA Current Loop Sensor',
  18: 'Ext-Probe Air Temp and Humidity Sensor',
  19: 'Thermocouple Temperature Sensor',
  25: 'Internal-Probe Temperature Sensor',
  26: 'Vibration Sensor - High Frequency'
};

function decodeUplink(input) {
  var bytes = input.bytes;
  if (!bytes || bytes.length < 2) {
    return { errors: ['payload too short'] };
  }

  var protocol = (bytes[0] >> 4) & 0x0f;
  var counter = bytes[0] & 0x0f;
  var type = bytes[1];

  var data = { protocol: protocol, counter: counter };

  // ===== ABM / Acceleration-Based Movement (0x0E) — primary movement event =====
  if (type === 0x0e) {
    if (bytes.length < 3) {
      return { errors: ['movement payload too short'] };
    }
    data.messageType = 'movement';
    // 0 = Movement Started (detected); non-zero = Movement Stopped (idle).
    data.action = { motion: { detected: bytes[2] === 0 } };
    return { data: data };
  }

  // ===== Supervisory (0x01) — battery, movement accumulation, status flags =====
  if (type === 0x01) {
    data.messageType = 'supervisory';
    data.battery = batteryVolts(bytes[4]);
    // 16-bit running total of movement detections since last reset.
    var accumulation = (bytes[9] * 256) + bytes[10];
    data.action = { motion: { count: accumulation } };
    data.accumulation = accumulation;
    data.tamperSinceLastReset = ((bytes[2] >> 4) & 0x01) === 1;
    data.tamperState = ((bytes[2] >> 3) & 0x01) === 1;
    data.errorWithLastDownlink = ((bytes[2] >> 2) & 0x01) === 1;
    data.batteryLow = ((bytes[2] >> 1) & 0x01) === 1;
    data.radioCommError = (bytes[2] & 0x01) === 1;
    return { data: data };
  }

  // ===== Tamper (0x02) =====
  if (type === 0x02) {
    data.messageType = 'tamper';
    data.tamperEvent = bytes[2] === 0 ? 'Open' : 'Closed';
    return { data: data };
  }

  // ===== Link Quality (0xFB) =====
  if (type === 0xfb) {
    data.messageType = 'linkQuality';
    data.subband = bytes[2];
    data.rssi = -256 + bytes[3];
    data.snr = bytes[4];
    return { data: data };
  }

  // ===== Reset (0x00) =====
  if (type === 0x00) {
    data.messageType = 'reset';
    data.deviceType = RESET_DEVICE_TYPES[bytes[2]] !== undefined
      ? RESET_DEVICE_TYPES[bytes[2]]
      : 'Device Undefined';
    return { data: data };
  }

  // ===== Downlink ACK (0xFF) =====
  if (type === 0xff) {
    data.messageType = 'downlinkAck';
    data.downlinkAck = bytes[2] === 1 ? 'Message Invalid' : 'Message Valid';
    return { data: data };
  }

  return { errors: ['unsupported message type 0x' + type.toString(16)] };
}
