// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for MOKO LW003-B (indoor Bluetooth-to-LoRaWAN probe:
// BLE beacon scanning, SHT30 temperature/humidity, accelerometer, battery).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format (MOKO message-type-keyed-by-fPort frames) understood with reference to
// the upstream Apache-2.0 decoder (TheThingsNetwork/lorawan-devices
// vendor/moko/lw003-b.js, attributed in NOTICE). The upstream normalizeUplink
// is NOT copied.
//
// Mapping notes (per MOKO LW003-B User Manual V2.1, section 4):
//   - Port 1 "Device Information Payload": battery level %, battery voltage,
//     firmware version, 3-axis sensitivity, tamper state, SHT30 temperature,
//     SHT30 humidity, LoRaWAN region.
//       * SHT30 temperature -> air.temperature (°C). Byte 6-7 big-endian, /100;
//         values > 0x8000 are negative two's-complement (per vendor decoder).
//       * SHT30 humidity -> air.relativeHumidity (%). Byte 8-9 big-endian, /100.
//       * battery VOLTAGE (bytes 1-2, mV, big-endian) -> `battery` (V), /1000.
//       * battery LEVEL (byte 0, already a percentage) -> camelCase extra
//         `batteryPercent`, never forced into the volts field.
//       * firmware / sensitivity / tamper / region -> camelCase extras.
//   - Port 2 "Beacon Payload": BLE scan lists (MAC / RSSI / raw advert data /
//     timestamps). This is indoor proximity data, NOT a coordinate fix, so it
//     carries no vocabulary-mappable measurement and becomes an errors result.
//   - The device has no light/lux sensor, so air.lightIntensity is never emitted.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function u16be(hi, lo) {
  return ((hi << 8) | lo) & 0xffff;
}

var REGIONS = [
  'AS923',
  'AU915',
  'CN470',
  'CN779',
  'EU433',
  'EU868',
  'KR920',
  'IN865',
  'US915',
  'RU864'
];

function decodeUplink(input) {
  var bytes = input.bytes;
  var fPort = input.fPort;

  if (!bytes || bytes.length === 0) {
    return { errors: ['empty payload'] };
  }

  if (fPort === 1) {
    return decodeDeviceInfo(bytes);
  }

  if (fPort === 2) {
    // Beacon Payload: BLE scan lists (MAC/RSSI/advert data), no coordinates.
    return { errors: ['Port 2 beacon scan carries no vocabulary-mappable measurement'] };
  }

  return { errors: ['unsupported fPort ' + fPort] };
}

// Port 1: Device Information Payload. 11-byte fixed layout.
function decodeDeviceInfo(bytes) {
  if (bytes.length < 11) {
    return { errors: ['device information frame too short'] };
  }

  var batteryPercent = bytes[0];
  var batteryV = u16be(bytes[1], bytes[2]) / 1000;

  var firmware =
    'V' +
    ((bytes[3] >> 6) & 0x03) +
    '.' +
    ((bytes[3] >> 4) & 0x03) +
    '.' +
    (bytes[3] & 0x0f);

  var sensitivity = bytes[4];
  var tamper = bytes[5] === 1;

  var rawTemp = u16be(bytes[6], bytes[7]);
  var temperature;
  if (rawTemp > 0x8000) {
    temperature = -((0x10000 - rawTemp) / 100);
  } else {
    temperature = rawTemp / 100;
  }

  var humidity = u16be(bytes[8], bytes[9]) / 100;
  var region = REGIONS[bytes[10]];

  if (humidity < 0 || humidity > 100) {
    return { errors: ['humidity out of range'] };
  }

  var data = {
    air: {
      location: 'indoor',
      temperature: round(temperature, 2),
      relativeHumidity: round(humidity, 2)
    },
    battery: round(batteryV, 3),
    batteryPercent: batteryPercent,
    firmwareVersion: firmware,
    accelerometerSensitivity: sensitivity,
    tamperAlarm: tamper
  };
  if (region !== undefined) {
    data.region = region;
  }
  return { data: data };
}
