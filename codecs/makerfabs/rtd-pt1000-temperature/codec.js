// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for makerfabs/rtd-pt1000-temperature (AgroSense
// Industrial RTD PT1000 Temperature Sensor, -60..200 °C): a standalone
// single-channel industrial temperature probe reporting battery and temperature.
//
// Derivation: wire format understood from the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/makerfabs/rtd-pt1000.js, referenced
// via rtd-pt1000-codec.yaml, attributed in NOTICE). Normalization authored here;
// upstream `field1`/`field2` output shape is NOT copied.
//
// Wire format:
//   bytes[0..1]  frame/sequence number (unused by upstream) -> ignored
//   bytes[2]     battery: bytes[2] / 10  -> volts (already V, tenths)
//   bytes[3..4]  temperature: big-endian signed-16, hundredths of a degree
//                (signed16 / 100 -> °C)
//
// Normalization: standalone temperature probe -> the reading is the top-level
// `temperature` (°C); battery is already volts (tenths).

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
  if (!bytes || bytes.length < 5) {
    return { errors: ['payload too short (expected at least 5 bytes)'] };
  }

  var data = {};
  data.battery = round(bytes[2] / 10, 1);
  data.temperature = round(signed16(bytes[3], bytes[4]) / 100, 2);
  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  // fPort 0 carries MAC commands only (LoRaWAN spec): there is no application
  // payload to decode, so this is not a decode failure. See AUTHORING.md.
  if (input && input.fPort === 0) {
    return { data: { make: "makerfabs", model: "rtd-pt1000-temperature" } };
  }
  if (!input || !input.bytes || input.bytes.length === 0) {
    return { errors: ['empty payload: no application bytes to decode'] };
  }

  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "makerfabs";
    result.data.model = "rtd-pt1000-temperature";
  }
  return result;
}
