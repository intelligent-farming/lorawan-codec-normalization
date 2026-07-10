// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for lansitec/precision-platinum-sensor (Precision
// Platinum Sensor): a standalone LoRaWAN PT100 platinum-RTD temperature sensor
// with one or more probe channels. Temperature is the primary (and only)
// measurement; the register/heartbeat/ack framing is housekeeping.
//
// Derivation: wire format understood from the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/lansitec/precision-platinum-sensor.js,
// referenced via precision-platinum-sensor-codec.yaml, attributed in NOTICE).
// Normalization authored here; upstream stringly-typed output (e.g. "3.6℃",
// "-52dBm", "97%") is NOT copied.
//
// Message type is the high nibble of bytes[0]:
//   0x1  Register  (device config / provisioning) -> not telemetry
//   0x3  Heartbeat (PRIMARY telemetry)
//   0xF  Acknowledge (downlink ack) -> not telemetry
//
// Heartbeat layout:
//   bytes[0] low nibble = tnum: number of temperature channels minus one
//   bytes[1]            = battery level (%)  [percentage, NOT voltage]
//   bytes[2]            = RSSI magnitude; reported dBm = -bytes[2]
//   bytes[3 + 2*i ..]   = channel i big-endian signed-16, hundredths of a degree
//                         (signed16 / 100 -> °C)  for i in 0..tnum
//   trailing 2 bytes    = CRC
//
// Upstream extracts each temperature with a plain (hi<<8)|lo and no sign
// extension, then multiplies by 0.01 — which mis-reports every sub-zero reading
// as a large positive value. The datasheet operating range is -40..85 °C, so we
// apply the correct two's-complement signed-16 conversion.
//
// Normalization: standalone temperature probe -> channel 1 is the top-level
// `temperature` (°C). Battery is a percentage, so it is emitted as the extra
// `batteryPercent` (the vocabulary `battery` is volts). RSSI (housekeeping) and
// any additional channels are camelCase extras.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function signed16(hi, lo) {
  var v = ((hi & 0xff) << 8) | (lo & 0xff);
  if (v & 0x8000) {
    v -= 0x10000;
  }
  return v;
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;
  if (!bytes || bytes.length < 1) {
    return { errors: ['missing payload bytes'] };
  }
  var messageType = (bytes[0] >> 4) & 0x0f;

  if (messageType !== 0x03) {
    return { errors: ['message type 0x' + messageType.toString(16) + ' is not heartbeat temperature telemetry'] };
  }

  var tnum = bytes[0] & 0x0f;
  var channelCount = tnum + 1;
  // Need: header(3) + channels(2*channelCount) + CRC(2).
  if (bytes.length < 3 + 2 * channelCount + 2) {
    return { errors: ['heartbeat too short for ' + channelCount + ' channel(s)'] };
  }

  var temps = [];
  for (var i = 0; i < channelCount; i++) {
    temps.push(round(signed16(bytes[3 + 2 * i], bytes[4 + 2 * i]) / 100, 2));
  }

  var data = {};
  data.temperature = temps[0];
  if (channelCount > 1) {
    data.temperatures = temps;
  }
  data.batteryPercent = bytes[1];
  data.rssi = -bytes[2];
  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "lansitec";
    result.data.model = "precision-platinum-sensor";
  }
  return result;
}
