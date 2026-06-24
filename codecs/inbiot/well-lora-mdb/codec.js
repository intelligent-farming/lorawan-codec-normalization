// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for inBiot MICA WELL (Modbus-payload variant) —
// indoor air-quality sensor reporting temperature, humidity, CO2, TVOC, HCHO,
// particulate matter (PM1/PM2.5/PM4/PM10), gases (O3, NO2, CO), comfort indices
// and noise.
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format understood with reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/inbiot/inbiot-lora-codec, file
// decoder.js, attributed in NOTICE). Ported from that reference's
// InbiotDeviceDecode for the WELL sensor message; author the normalization
// here — do NOT copy upstream normalizeUplink.
//
// The shared inBiot payload multiplexes several message types on bytes[0]:
//   0 = device configuration, 1 = sensor reading, 2 = device information.
// Only the sensor reading (bytes[0] === 1) carries measurement data, so this
// codec recognizes that frame and reports everything else as an error rather
// than returning a bare/empty object (the output contract forbids `{}`).
//
// Wire layout for a WELL sensor frame (uint16 fields are BIG-endian:
// (bytes[hi] << 8) | bytes[lo], matching upstream getUint16):
//   bytes[1..2]   temperature  uint16 /10 °C    -> air.temperature
//   bytes[3..4]   humidity     uint16 /10 %      -> air.relativeHumidity
//   bytes[5..6]   CO2          uint16 ppm        -> air.co2
//   bytes[7..8]   CH2O (HCHO)  uint16 µg/m³      -> air.ch2o   (extra)
//   bytes[9..10]  TVOC         uint16            -> air.tvoc   (extra)
//   bytes[11..12] PM1.0        uint16 µg/m³      -> air.pm1    (extra)
//   bytes[13..14] PM2.5        uint16 µg/m³      -> air.pm25   (extra)
//   bytes[15..16] PM4          uint16 µg/m³      -> air.pm4    (extra)
//   bytes[17..18] PM10         uint16 µg/m³      -> air.pm10   (extra)
//   bytes[19..20] O3           uint16; 0xffff=Preheating -> air.o3  (extra)
//   bytes[21..22] NO2          uint16; 0xffff=Preheating -> air.no2 (extra)
//   bytes[23..24] CO           uint16 /10; 0xffff=Preheating -> air.co (extra)
//   bytes[25..26] message counter  uint16        -> counter        (extra)
//   bytes[27..30] device type ("WELL")           -> type           (extra)
//   bytes[32]     ventilation index              -> vIndex         (extra)
//   bytes[33]     thermal index                  -> tIndex         (extra)
//   bytes[34]     virus index                    -> virusIndex     (extra)
//   bytes[35]     IAQ index                      -> iaqIndex       (extra)
//   bytes[36]     mold persistence; 0xff=Calculating -> moldIndex  (extra)
//   bytes[37]     noise dB; 0=absent, 0xff=Preheating -> noiseDb   (extra)
//
// Mapping notes:
//   - temperature/humidity/co2 are the only WELL fields modeled by the
//     vocabulary (air.temperature, air.relativeHumidity, air.co2). TVOC, HCHO,
//     PM*, gases (O3/NO2/CO), indices, counter, type and noise have no
//     vocabulary key and are emitted as camelCase extras.
//   - This device reports neither battery nor barometric pressure nor an
//     illuminance (lux) channel, so `battery`/`batteryPercent`, `air.pressure`
//     and `air.lightIntensity` are not emitted.
//   - Preheating sensors report 0xffff; we preserve the upstream "Preheating"
//     marker string rather than emitting a bogus numeric reading.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function u16be(bytes, hi, lo) {
  return ((bytes[hi] << 8) | bytes[lo]) & 0xffff;
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;
  if (!bytes || bytes.length === 0) {
    return { errors: ['empty payload'] };
  }

  // Only the sensor reading frame (bytes[0] === 1) carries measurements.
  if (bytes[0] !== 1) {
    return { errors: ['unsupported inBiot message type ' + bytes[0] + ' (expected sensor reading 1)'] };
  }
  if (bytes.length < 38) {
    return { errors: ['truncated WELL sensor frame: expected >= 38 bytes, got ' + bytes.length] };
  }

  var data = {};
  var air = {};

  air.temperature = round(u16be(bytes, 1, 2) / 10, 1);
  air.relativeHumidity = round(u16be(bytes, 3, 4) / 10, 1);
  air.co2 = u16be(bytes, 5, 6);

  // Air-quality extras (no vocabulary key): HCHO, TVOC, particulate matter.
  air.ch2o = u16be(bytes, 7, 8);
  air.tvoc = u16be(bytes, 9, 10);
  air.pm1 = u16be(bytes, 11, 12);
  air.pm25 = u16be(bytes, 13, 14);
  air.pm4 = u16be(bytes, 15, 16);
  air.pm10 = u16be(bytes, 17, 18);

  // Gases: 0xffff signals the sensor is still preheating.
  var o3 = u16be(bytes, 19, 20);
  air.o3 = o3 === 0xffff ? 'Preheating' : o3;
  var no2 = u16be(bytes, 21, 22);
  air.no2 = no2 === 0xffff ? 'Preheating' : no2;
  var co = u16be(bytes, 23, 24);
  air.co = co === 0xffff ? 'Preheating' : round(co / 10, 1);

  data.air = air;

  // Device-reported indices and metadata (camelCase extras).
  var type = '';
  for (var t = 27; t < 31; t++) {
    if (bytes[t] === 0x00) {
      break;
    }
    type += String.fromCharCode(bytes[t]);
  }
  if (type === '') {
    type = 'NULL';
  }
  data.type = type;

  data.vIndex = bytes[32];
  data.tIndex = bytes[33];
  data.virusIndex = bytes[34];
  data.iaqIndex = bytes[35];
  data.moldIndex = bytes[36] === 0xff ? 'Calculating' : bytes[36];

  // Noise: 0 means the channel is absent on this frame; 0xff means preheating.
  if (bytes[37]) {
    data.noiseDb = bytes[37] === 0xff ? 'Preheating' : bytes[37];
  }

  data.counter = u16be(bytes, 25, 26);

  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "inbiot";
    result.data.model = "well-lora-mdb";
  }
  return result;
}
