// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Volley Boast VoBo-TC (Thermocouple Endpoint).
//
// Ported/normalized from the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/volley-boast/vobo-decoder.js,
// attributed in NOTICE). Upstream dispatches on fPort into many payload shapes;
// the source of truth for this codec is its FPort-1 standard measurement path
// (`parseStandardPayload`), the only shape that yields a fully unit-defined
// temperature (degrees C) and battery (mV). The 12 thermocouple probe channels
// travel as raw 16-bit Modbus registers (`parseModbusStandardPayload`) with no
// scaling or engineering unit fixed by the upstream decoder, so they are not
// normalized here.
//
// FPort-1 standard payload byte mapping (ported faithfully from upstream):
//   Temperature (bytes[6] hi nibble + bytes[7], 12-bit, 0.125 C/LSB, sign in
//     bytes[7] bit 7) -> temperature   (degrees C, top level)
//   Battery ((bytes[6]&0x0f)<<8 | bytes[5]) * 4 mV -> battery (V; mV / 1000)
//   DIN1/DIN2/DIN3 (bytes[0] bits 0..2) -> din1/din2/din3 (boolean extras;
//     the discrete "button"/digital inputs, housekeeping)
//   WKUP (bytes[0] bit 3)               -> wakeup (boolean extra)
//   Modbus0 (bytes[9]<<8 | bytes[8])    -> modbus0 (raw 16-bit register extra)
//
// Only fPort 1 is normalized; the heartbeat, analog-sensor, config, digital and
// event-log payloads carry no unit-defined temperature and yield errors.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;
  if (!bytes) {
    return { errors: ['missing payload bytes'] };
  }
  if (input.fPort !== 1) {
    return {
      errors: [
        'unsupported fPort ' + input.fPort +
          ' (only the fPort 1 standard measurement payload is normalized)'
      ]
    };
  }
  if (bytes.length < 10) {
    return { errors: ['standard payload too short (expected 10 bytes)'] };
  }

  var data = {};

  // ADC temperature: 12-bit, 0.125 C/LSB; bytes[7] bit 7 selects sign.
  var tRaw = (((bytes[6] & 0xf0) >> 4) | (bytes[7] << 4)) & 0xfff;
  if ((bytes[7] >> 7 & 0x01) === 0) {
    data.temperature = round(tRaw * 0.125, 3);
  } else {
    data.temperature = round((4096 - tRaw) * 0.125 * -1, 3);
  }

  // Battery: 12-bit ADC, 4 mV/LSB -> volts.
  var battMv = ((bytes[6] & 0x0f) << 8 | bytes[5]) * 4;
  data.battery = round(battMv / 1000, 3);

  // Discrete digital inputs / wakeup (housekeeping extras).
  data.din1 = Boolean(bytes[0] & 0x01);
  data.din2 = Boolean((bytes[0] >> 1) & 0x01);
  data.din3 = Boolean((bytes[0] >> 2) & 0x01);
  data.wakeup = Boolean((bytes[0] >> 3) & 0x01);

  // Raw Modbus register (device diagnostic extra; no fixed engineering unit).
  data.modbus0 = (bytes[9] << 8) | bytes[8];

  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "volley-boast";
    result.data.model = "vobo-tc";
  }
  return result;
}
