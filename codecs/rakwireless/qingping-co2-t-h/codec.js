// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for the RAKwireless / Qingping CO2, Temperature &
// Humidity Monitor for LoRaWAN (Qingping LoRaWAN CO2 Monitoring Sensor).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire format
// (the Qingping real-time-data frame) ported/normalized from the upstream
// Apache-2.0 decoder (TheThingsNetwork/lorawan-devices
// vendor/rakwireless/decoder-qingping.js, the shared Qingping decoder; attributed
// in NOTICE). We faithfully decode the same frame layout and field math as
// upstream, then NORMALIZE into the shared vocabulary instead of emitting
// upstream's flat keys.
//
// Ported from upstream Decoder(). The frame is:
//   [device_address, function_code, data_length, data_type, ...payload]
// Only real-time data is parsed: function_code == 0x41 AND data_type == 0x01.
// After the 4-byte header the payload is:
//   timestamp   : 4 bytes, big-endian (Unix seconds)
//   temp/humid  : 3 packed bytes
//       temperature = (b0 * 16 + (b1 >> 4) - 500) / 10   (degC)
//       humidity    = (256 * (b1 & 0x0F) + b2) / 10      (%RH)
//   co2         : 2 bytes, big-endian (ppm); this variant carries a real NDIR
//                 CO2 sensor, so the field is a genuine measurement
//   battery     : 1 byte
//
// Upstream notes / fixes applied while porting:
//   * Upstream's Decoder(bytes, port) body references an undefined `data`
//     identifier (a `bytes` -> `data` transcription bug); run as-is it throws
//     ReferenceError. We port the obviously-intended behaviour, reading from the
//     `bytes` argument.
//   * Upstream returns a bare {} for any non-realtime frame (wrong function/data
//     type). Per our output contract a bare {} is illegal, so we return
//     { errors: [...] } instead.
//
// Normalization mapping:
//   temperature    -> air.temperature (degC)
//   humidity       -> air.relativeHumidity (%)
//   co2            -> air.co2 (ppm)
//   battery        -> batteryPercent (extra; the byte is a 0-100 percentage, and
//                     the vocabulary's `battery` is VOLTS, so it must not go there)
//   device_address -> deviceAddress (extra)
//   timestamp      -> timestamp (extra; device Unix seconds)

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function decodeUplink(input) {
  var bytes = input.bytes;
  if (!bytes || bytes.length < 4) {
    return { errors: ['truncated payload: frame header needs 4 bytes'] };
  }

  var deviceAddress = bytes[0];
  var functionCode = bytes[1];
  // bytes[2] is data_length (unused by upstream).
  var dataType = bytes[3];

  // Upstream parses only real-time data frames; anything else yields no data.
  if (functionCode !== 0x41 || dataType !== 0x01) {
    return {
      errors: [
        'unsupported frame: function_code 0x' + functionCode.toString(16) +
          ', data_type 0x' + dataType.toString(16) +
          ' (expected real-time data 0x41/0x01)'
      ]
    };
  }

  // Real-time frame needs 4 header + 4 timestamp + 3 T/H + 2 co2 + 1 battery.
  if (bytes.length < 14) {
    return { errors: ['truncated real-time frame: needs 14 bytes'] };
  }

  var i = 4;

  var timestamp =
    (bytes[i] << 24) +
    (bytes[i + 1] << 16) +
    (bytes[i + 2] << 8) +
    bytes[i + 3];
  // Keep timestamp unsigned (32-bit big-endian Unix seconds).
  if (timestamp < 0) {
    timestamp = timestamp + 4294967296;
  }
  i += 4;

  var temperature = (bytes[i] * 16 + (bytes[i + 1] >> 4) - 500) / 10.0;
  var humidity = (256 * (bytes[i + 1] & 0x0f) + bytes[i + 2]) / 10.0;
  var co2 = (bytes[i + 3] << 8) + bytes[i + 4];
  i += 5;

  var battery = bytes[i];

  var data = {
    deviceAddress: deviceAddress,
    timestamp: timestamp,
    batteryPercent: battery,
    air: {
      temperature: round(temperature, 1),
      relativeHumidity: round(humidity, 1),
      co2: co2
    }
  };

  return { data: data };
}
