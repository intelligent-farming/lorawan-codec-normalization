// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for RadioBridge RBS306-WR1M (Outdoor Water Detect
// Sensor, rope: water present / not-present detection).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format (RadioBridge protocol-version + event/message-type frame) understood
// with reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/radio-bridge/
// radio_bridge_packet_decoder.js, "RADIO BRIDGE PACKET DECODER v1.4",
// attributed in NOTICE). Ported from that decoder's Generic_Decoder; the
// normalization (vocabulary mapping) is authored here, NOT copied from upstream.
//
// The RBS306 series shares the generic RadioBridge event-based decoder with the
// RBS301 water sensors; the WR1M is the outdoor, rope-style water-detect
// variant. Water detection is reported as an event STATE (Water Present /
// Water Not Present), not a field named "leak".
//
// Frame: byte[0] high nibble = protocol version, low nibble = packet counter;
// byte[1] = event / message type; remaining bytes are event-specific.
//
// Mapping decisions:
//   0x08 WATER        byte[2] (0=Water Present, !=0=Water Not Present)
//                     -> water.leak (true = water present/detected, false =
//                     cleared). byte[3] relative level -> waterRelative extra.
//   0x01 SUPERVISORY  battery "X.Y" nibbles of byte[4] -> battery (volts)
//                     byte[2] flags + byte[9..10] accumulation -> camelCase extras
//   0x02 TAMPER       byte[2] (0=Open,1=Closed)   -> tamperEvent extra
//   0xFB LINK QUALITY subband/rssi/snr             -> camelCase extras
//   0x00 RESET        device type                  -> deviceType extra
//   0xFF DOWNLINK ACK valid/invalid                -> downlinkAck extra
//
// This is a water-leak sensor: the WATER event (0x08) maps to water.leak.
// upstream emits Water.Event "Water Present" (byte[2]==0) or "Water Not
// Present" (byte[2]!=0). We map presence of water to leak=true (a leak/detection
// has occurred) and absence to leak=false (cleared). byte[3] is a relative
// wetness reading kept as the camelCase extra waterRelative.
//
// The upstream Supervisory message reports battery as an "X.Y" string built
// from the two nibbles of byte[4] (e.g. 0x36 -> "3.6" -> 3.6 V). The vocabulary
// `battery` is volts, so it is parsed back to a number matching upstream's
// parseFloat semantics.

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

function decodeUplinkCore(input) {
  var bytes = input.bytes;
  if (!bytes || bytes.length < 2) {
    return { errors: ['payload too short'] };
  }

  var protocol = (bytes[0] >> 4) & 0x0f;
  var counter = bytes[0] & 0x0f;
  var type = bytes[1];

  var data = { protocol: protocol, counter: counter };

  // ===== Water (0x08) — the primary water-detection event =====
  if (type === 0x08) {
    if (bytes.length < 4) {
      return { errors: ['water payload too short'] };
    }
    data.messageType = 'water';
    // 0 = Water Present (leak detected); non-zero = Water Not Present (cleared).
    data.water = { leak: bytes[2] === 0 };
    data.waterRelative = bytes[3];
    return { data: data };
  }

  // ===== Supervisory (0x01) — battery voltage + tamper / error flags =====
  if (type === 0x01) {
    data.messageType = 'supervisory';
    data.battery = batteryVolts(bytes[4]);
    data.accumulation = (bytes[9] * 256) + bytes[10];
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

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "radio-bridge";
    result.data.model = "rbs306-wr1m";
  }
  return result;
}
