// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Volley Boast VoBo-GP-1 (general-purpose input
// endpoint / LoRaWAN bridge).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format understood with reference to the upstream (vendor-maintained) decoder
// (TheThingsNetwork/lorawan-devices vendor/volley-boast/vobo-decoder.js,
// attributed in NOTICE). Upstream emits raw ADC counts plus metadata; this
// module normalizes the fPort-1 Standard payload's defined fields to the shared
// vocabulary and does NOT copy upstream.
//
// Only the fPort-1 "Standard" payload is decoded here -- it is the one payload
// with a fixed, unit-defined layout (10 bytes). The Modbus / analog-sensor /
// heartbeat / config payloads on other fPorts carry either opaque raw Modbus
// registers (no scale) or non-measurement data and are reported as errors.
//
// Standard payload (fPort 1) bit layout:
//   byte0 bit0..2   = DIN1..DIN3 (digital inputs)
//   byte0 bit3      = WKUP (wakeup digital input)
//   ADC1 (12-bit)   = (byte0>>4) | (byte1<<4)
//   ADC2 (12-bit)   = (byte3&0x0f)<<8 | byte2
//   ADC3 (12-bit)   = (byte3>>4) | (byte4<<4)
//   Battery (12-bit)= ((byte6&0x0f)<<8 | byte5) * 4  [millivolts]
//   Temperature     = 12-bit signed ADC, 0.125 degC/count
//   Modbus0 (16-bit)= byte9<<8 | byte8
//
// Normalization:
//   ADC1 raw count      -> analog.raw
//   Battery mV          -> battery (V, mV/1000)
//   Temperature         -> air.temperature (degC)
//   DIN1                -> action.contactState (1 -> "closed", 0 -> "open")
// ADC2/ADC3/DIN2/DIN3/WKUP/Modbus0 are exposed as camelCase extras.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function decodeVoboStandard(bytes, make, model) {
  if (!bytes || bytes.length < 10) {
    return { errors: ['Standard payload too short (' + (bytes ? bytes.length : 0) + '), expected 10 bytes'] };
  }

  var adc1 = ((bytes[0] & 0xf0) >> 4) | (bytes[1] << 4);
  var adc2 = ((bytes[3] & 0x0f) << 8) | bytes[2];
  var adc3 = ((bytes[3] & 0xf0) >> 4) | (bytes[4] << 4);
  var batteryMv = (((bytes[6] & 0x0f) << 8) | bytes[5]) * 4;

  var tempRaw = ((bytes[6] & 0xf0) >> 4) | (bytes[7] << 4);
  var temperature;
  if ((bytes[7] >> 7 & 0x01) === 0) {
    temperature = tempRaw * 0.125;
  } else {
    temperature = (4096 - tempRaw) * 0.125 * -1;
  }

  var data = {};
  data.analog = { raw: adc1 };
  data.battery = round(batteryMv / 1000, 3);
  data.air = { temperature: round(temperature, 3) };
  data.action = { contactState: (bytes[0] & 0x01) ? 'closed' : 'open' };

  data.adc2Raw = adc2;
  data.adc3Raw = adc3;
  data.digitalInput2 = (bytes[0] >> 1) & 0x01;
  data.digitalInput3 = (bytes[0] >> 2) & 0x01;
  data.wakeup = (bytes[0] >> 3) & 0x01;
  data.modbus0 = (bytes[9] << 8) | bytes[8];

  return { data: data };
}

function decodeUplinkCore(input) {
  if (input.fPort !== 1) {
    return { errors: ['unsupported fPort ' + input.fPort + ' (only the Standard payload on fPort 1 is normalized)'] };
  }
  return decodeVoboStandard(input.bytes);
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "volley-boast";
    result.data.model = "vobo-gp-1";
  }
  return result;
}
