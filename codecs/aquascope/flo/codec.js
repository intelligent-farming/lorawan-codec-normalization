// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Aquascope Flo (water leak / flood sensor).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format understood with reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/aquascope/wwd.js, attributed in
// NOTICE). Author the normalization here; do NOT copy upstream normalizeUplink.
//
// Upstream decodes the same two frames this codec supports:
//   fPort 10 (status):  byte0 bit0 = leak, byte0 bit1 = remote flag,
//                       byte1 = battery, bytes2..3 = temperature.
//   fPort 16 (heartbeat): byte1 = battery, bytes2..3 = temperature.
// Temperature is reconstructed with upstream's exact (bytes[2]*0xff + bytes[3])
// expression — preserved verbatim so decoded values match the source of truth.
// It is the sensor's own (water/probe) temperature, mapped to
// water.temperature.current; there is NO ambient/air channel and NO humidity in
// this payload, so this device is NOT a climate sensor.
//
// `battery` here is a 0-100 percentage, not volts; the vocabulary `battery` is
// volts, so it is emitted as the camelCase extra `batteryPercent`. The `remote`
// status flag has no vocabulary key and is kept as a camelCase extra (0/1, as
// upstream reports it).

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
    batteryPercent: bytes[1]
  };

  if (input.fPort === 10) {
    data.water.leak = (bytes[0] & 0x01) === 0x01;
    data.remote = (bytes[0] & 0x02) ? 1 : 0;
  }

  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "aquascope";
    result.data.model = "flo";
  }
  return result;
}
