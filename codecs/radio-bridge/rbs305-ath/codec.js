// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for RadioBridge RBS305-ATH (Indoor Air Temperature
// & Humidity Sensor).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format (RadioBridge protocol-version + event/message-type frame) understood
// with reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/radio-bridge/
// radio_bridge_packet_decoder.js, "RADIO BRIDGE PACKET DECODER v1.4",
// attributed in NOTICE).
//
// Frame: byte[0] high nibble = protocol version, low nibble = packet counter;
// byte[1] = event / message type; remaining bytes are event-specific.
//
// The upstream Supervisory message reports battery as an "X.YV" string built
// from the two nibbles of byte[4]. The vocabulary `battery` is volts, so it is
// parsed back to a number (matching the upstream parseFloat semantics where the
// low nibble is a tenths digit, e.g. 0x36 -> 3.6 V). The ATH temperature uses
// the upstream sign convention: the combined integer.fraction value is negated
// as -(value - 128) when it exceeds 127.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

// Upstream Convert(number, 1): integer+fraction temperature with a >127 sign flip.
function athTemperature(intByte, fracByte) {
  var number = intByte + ((fracByte >> 4) / 10);
  if (number > 127) {
    return round(-(number - 128), 1);
  }
  return round(number, 1);
}

// Upstream battery: parseFloat(major + "." + minor) where major/minor are the
// nibbles of byte[4]; the low nibble is a tenths digit (0x36 -> "3.6" -> 3.6).
function batteryVolts(b) {
  var major = (b >> 4) & 0x0f;
  var minor = b & 0x0f;
  return parseFloat(major + '.' + minor);
}

var ATH_EVENTS = [
  'Periodic Report',
  'Temperature has Risen Above Upper Threshold',
  'Temperature has Fallen Below Lower Threshold',
  'Temperature Report-on-Change Increase',
  'Temperature Report-on-Change Decrease',
  'Humidity has Risen Above Upper Threshold',
  'Humidity has Fallen Below Lower Threshold',
  'Humidity Report-on-Change Increase',
  'Humidity Report-on-Change Decrease'
];

function decodeUplinkCore(input) {
  var bytes = input.bytes;
  if (!bytes || bytes.length < 2) {
    return { errors: ['payload too short'] };
  }

  var protocol = (bytes[0] >> 4) & 0x0f;
  var counter = bytes[0] & 0x0f;
  var type = bytes[1];

  var data = { protocol: protocol, counter: counter };

  // ===== Air Temperature & Humidity (ATH, 0x0D) — the primary climate event =====
  if (type === 0x0d) {
    var eventType = bytes[2];
    var temperature = athTemperature(bytes[3], bytes[4]);
    var humidity = round(bytes[5] + ((bytes[6] >> 4) / 10), 1);

    data.messageType = 'ath';
    data.event = ATH_EVENTS[eventType] !== undefined ? ATH_EVENTS[eventType] : 'Undefined';
    data.air = { temperature: temperature, relativeHumidity: humidity };
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
    data.event = bytes[2] === 0 ? 'Open' : 'Closed';
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
    data.deviceType = bytes[2];
    return { data: data };
  }

  // ===== Downlink ACK (0xFF) =====
  if (type === 0xff) {
    data.messageType = 'downlinkAck';
    data.event = bytes[2] === 1 ? 'Message Invalid' : 'Message Valid';
    return { data: data };
  }

  return { errors: ['unsupported message type 0x' + type.toString(16)] };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "radio-bridge";
    result.data.model = "rbs305-ath";
  }
  return result;
}
