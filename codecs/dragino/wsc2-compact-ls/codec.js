// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for the Dragino WSC2-Compact-LS weather-station
// transmitter, the LoRaWAN node that the DR-RG-6P tipping-bucket rain-gauge
// probe (0.2 mm per tip) plugs into via the pulse-count input. The DR-RG-6P
// itself is a passive probe; its rainfall is carried in this transmitter's
// uplink.
//
// This device is not in TheThingsNetwork/lorawan-devices. The wire format is
// authored here from Dragino's published decoder and manual
// (WSC2-Compact-LS-V1.0.6_TTN_decoder, dragino-end-node-decoder; product wiki),
// reproduced as original work — no upstream decoder is copied.
//
// Periodic uplink on fPort 2 (bytes[2] = payload version):
//   bytes[0..1]  battery: ((hi<<8|lo) & 0x3FFF) / 1000          -> battery (V)
//   bytes[3..6]  cumulative rain pulse count (tips, big-endian)
//                DR-RG-6P resolution 0.2 mm/tip -> rain.cumulative (mm)
//   bytes[7..8]  external DS18B20 probe temp (signed /10)        -> probeTemperature (extra)
//   bytes[9..10] ambient temperature (signed /10)                -> air.temperature (C)
//   bytes[11..12] humidity /10                                   -> air.relativeHumidity (%)
//   bytes[13..14] barometric pressure: device reports kPa (raw/100);
//                converted x10 to hPa                            -> air.pressure (hPa)
//   bytes[15..16] illuminance (lux)                              -> air.lightIntensity
//   bytes[17]    sensor-present flags for optional appended soil/wind/solar
//                blocks (not used by the rain-gauge configuration; surfaced as
//                the sensorFlags extra).
// fPort 5 is a device-information frame (no measurement) and is reported as an
// error so a provisioner falls back appropriately.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function signed16(hi, lo) {
  var v = ((hi & 0xff) << 8) | (lo & 0xff);
  return (v & 0x8000) ? v - 0x10000 : v;
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;
  var port = input.fPort;

  if (port === 5) {
    return { errors: ['device information frame (fPort 5), not a measurement'] };
  }
  if (port !== 2) {
    return { errors: ['unsupported fPort ' + port + ' (expected 2)'] };
  }
  if (!bytes || bytes.length < 18) {
    return { errors: ['payload too short (need >= 18 bytes, got ' + (bytes ? bytes.length : 0) + ')'] };
  }

  var data = {};

  // Battery (V).
  data.battery = round((((bytes[0] << 8) | bytes[1]) & 0x3fff) / 1000, 3);

  // Cumulative rain: big-endian 32-bit tip count; DR-RG-6P is 0.2 mm per tip.
  var tips = (bytes[3] * 16777216) + ((bytes[4] & 0xff) << 16) + ((bytes[5] & 0xff) << 8) + (bytes[6] & 0xff);
  data.rain = { cumulative: round(tips * 0.2, 1) };
  data.rainTipCount = tips;

  // Ambient temperature + humidity (the 3-in-1 sensor).
  data.air = {};
  data.air.temperature = round(signed16(bytes[9], bytes[10]) / 10, 1);
  data.air.relativeHumidity = round((((bytes[11] & 0xff) << 8) | bytes[12]) / 10, 1);

  // Barometric pressure: device value is kPa (raw / 100); convert to hPa.
  data.air.pressure = round((((bytes[13] & 0xff) << 8) | bytes[14]) / 100 * 10, 1);

  // Illuminance (lux).
  data.air.lightIntensity = (((bytes[15] & 0xff) << 8) | bytes[16]);

  // External DS18B20 probe temperature (extra; not the ambient air reading).
  data.probeTemperature = round(signed16(bytes[7], bytes[8]) / 10, 2);

  data.payloadVersion = bytes[2];
  data.sensorFlags = bytes[17];

  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "dragino";
    result.data.model = "wsc2-compact-ls";
  }
  return result;
}
