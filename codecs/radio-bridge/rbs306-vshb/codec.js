// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for radio-bridge/rbs306-vshb (MultiTech / Radio
// Bridge RBS306-VSHB high-bandwidth vibration / condition-monitoring sensor).
//
// This sensor is NOT handled by the shared radio_bridge_packet_decoder.js used
// by the other RadioBridge devices. Wire format from the official MIT-licensed
// @radiobridge/packet-decoder (HBVibrationSensor; attributed in NOTICE). Frame:
// b0 protocol (high nibble) + packet counter; b1 type/axis (0x1C-0x1F = channel
// 1-4); b2 event (low nibble); b3 low-frequency peak velocity (/100 inches/s);
// b4 high-frequency peak g-force (/4 g); b5 accelerometer temperature (signed,
// C); b6 bias voltage (/100 V).
//
// Mapping: high-frequency peak g-force -> vibration.accelerationPeak (g);
// accelerometer temperature -> air.temperature (C). The low-frequency PEAK
// velocity has no exact vocabulary key (vibration.velocityRms is an RMS
// statistic, not a peak), so it is surfaced in SI units as the peakVelocity
// extra (mm/s); channel, event, protocol/counter and bias voltage are extras.
function round(value, decimals) { var f = Math.pow(10, decimals); return Math.round(value * f) / f; }
function s8(b) { return (b & 0x80) ? b - 0x100 : b; }

var EVENTS = {
  0: 'Periodic Report',
  1: 'High-frequency vibration above upper threshold',
  2: 'High-frequency vibration below lower threshold',
  3: 'Low-frequency velocity above upper threshold',
  4: 'Low-frequency velocity below lower threshold',
  5: 'Accelerometer exceeded g-force range'
};

function decodeUplinkCore(input) {
  var b = input.bytes;
  if (!b || b.length < 7) { return { errors: ['payload too short (need >= 7 bytes)'] }; }
  if (b[1] < 0x1c || b[1] > 0x1f) {
    return { errors: ['not a high-bandwidth vibration frame (type byte 0x' + (b[1] & 0xff).toString(16) + ', expected 0x1C-0x1F)'] };
  }
  var data = {};
  data.vibration = { accelerationPeak: round(b[4] / 4, 2) };
  data.air = { temperature: s8(b[5]) };
  data.peakVelocity = round((b[3] > 0 ? b[3] / 100 : 0) * 25.4, 3);
  data.channel = (b[1] - 0x1b);
  data.event = EVENTS[b[2] & 0x0f] || ('event ' + (b[2] & 0x0f));
  data.biasVoltage = round(b[6] / 100, 2);
  data.protocolVersion = (b[0] >> 4) & 0x0f;
  data.packetCounter = b[0] & 0xff;
  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) { result.data.make = "radio-bridge"; result.data.model = "rbs306-vshb"; }
  return result;
}
