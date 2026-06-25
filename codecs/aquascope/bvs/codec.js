// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Aquascope BVS (Ball Valve Servo BVSLWE01).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format understood with reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/aquascope/bvs.js, attributed in
// NOTICE). Author the normalization here; do NOT copy upstream normalizeUplink.
//
// Upstream decodes two frames, both 4 bytes:
//   fPort 10 (status):    byte0 bit0 = leak, byte0 bit5 (0x20) = valve on/off,
//                         bytes2..3 = temperature.
//   fPort 16 (heartbeat): byte0 bit5 (0x20) = valve on/off, bytes2..3 = temperature.
// The leak bit is a calibrated boolean leak-state and is the value that places
// this device in the water-leak category; it is coerced from upstream's "Y"/"N"
// to a real boolean (true = leak detected).
//
// The valve open/closed flag is actuator control state with no vocabulary key,
// kept as the camelCase extra `valveState` ("On"/"Off", as upstream reports it).
//
// Temperature is reconstructed with upstream's exact (bytes[2]*0xff + bytes[3])
// expression — preserved verbatim so decoded values match the source of truth.
// Note this multiplier is 0xff (255), not 0x100, so the value is NOT a correctly
// scaled engineering temperature; it is the sensor's own probe temperature as the
// device reports it, mapped to water.temperature.current. There is NO ambient/air
// channel and NO humidity in this payload, so this device is NOT a climate sensor.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;

  if (input.fPort !== 10 && input.fPort !== 16) {
    return { errors: ['unknown FPort ' + input.fPort] };
  }
  if (bytes.length < 4) {
    return { errors: ['expected at least 4 bytes, got ' + bytes.length] };
  }

  // Verbatim from upstream: temperature = bytes[2]*0xff + bytes[3].
  var temperature = bytes[2] * 0xff + bytes[3];

  var data = {
    water: { temperature: { current: round(temperature, 1) } },
    valveState: (bytes[0] & 0x20) ? "On" : "Off"
  };

  if (input.fPort === 10) {
    data.water.leak = (bytes[0] & 0x01) === 0x01;
  }

  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "aquascope";
    result.data.model = "bvs";
  }
  return result;
}
