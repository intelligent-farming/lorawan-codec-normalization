// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for adeunis/temp-4 (Temp 4 / Temp 2S 4 IP68
// temperature probe): a standalone LoRaWAN temperature sensor with one or two
// probe channels (PT100/thermocouple), reporting periodic historized samples.
//
// Derivation: wire format understood from the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/adeunis/temp_lib.js, referenced via
// temp-codec.yaml, attributed in NOTICE). Adeunis devices share this
// `temp_lib.js`; the temp-4 profile uses the `temp4` parser set. Normalization
// authored here; upstream output shape (nested `bytes`/`temperatures[]`
// name/unit objects) is NOT copied.
//
// Frame layout (dispatched by frame code = bytes[0]):
//   0x57  periodic data (PRIMARY telemetry). bytes[1] = status byte:
//           bit4 (0x10) -> 2 channels active, else 1 channel
//           bit2 (0x04) -> a 4-byte epoch timestamp trails the samples
//           bit1 (0x02) -> low-battery flag
//         Samples are big-endian signed-16, tenths of a degree (/10 -> °C),
//         interleaved per channel, ordered [t=0, t-1, t-2, ...] (t=0 = current).
//   0x30  keep-alive: a single current sample per channel (same scaling).
//   0x10/0x20/0x2f/0x33/0x36/0x37/0x58  configuration / ack / alarm / version
//         frames -> not periodic telemetry -> reported as an error.
//
// Normalization: this is a standalone temperature probe, so channel 1's current
// reading (t=0) is the top-level `temperature` (°C). Channel 2 (when present),
// the full per-channel sample arrays, the frame counter and the low-battery flag
// are exposed as camelCase extras. The device has no battery-voltage telemetry
// (only a low-battery status bit), so `battery` (volts) is not emitted.

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
  if (!bytes || bytes.length < 2) {
    return { errors: ['missing or too-short payload'] };
  }
  var frameCode = bytes[0];

  if (frameCode === 0x57 || frameCode === 0x30) {
    var status = bytes[1];
    var nbSensors = (status & 0x10) ? 2 : 1;
    var hasTimestamp = Boolean(status & 0x04);
    var lowBattery = Boolean(status & 0x02);

    // Sample region excludes the trailing 4-byte timestamp when present.
    var sampleEnd = hasTimestamp ? bytes.length - 4 : bytes.length;
    if (sampleEnd < 2 + 2 * nbSensors) {
      return { errors: ['0x' + frameCode.toString(16) + ' frame too short for ' + nbSensors + ' channel(s)'] };
    }

    var ch1 = [];
    var ch2 = [];
    for (var offset = 2; offset + 2 * nbSensors <= sampleEnd; offset += 2 * nbSensors) {
      ch1.push(round(signed16(bytes[offset], bytes[offset + 1]) / 10, 1));
      if (nbSensors === 2) {
        ch2.push(round(signed16(bytes[offset + 2], bytes[offset + 3]) / 10, 1));
      }
    }

    var data = {};
    data.temperature = ch1[0];
    data.temperatures1 = ch1;
    if (nbSensors === 2) {
      data.temperature2 = ch2[0];
      data.temperatures2 = ch2;
    }
    data.frameCounter = (status & 0xe0) >> 5;
    data.lowBattery = lowBattery;
    return { data: data };
  }

  return { errors: ['frame 0x' + frameCode.toString(16) + ' is not periodic temperature telemetry'] };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "adeunis";
    result.data.model = "temp-4";
  }
  return result;
}
