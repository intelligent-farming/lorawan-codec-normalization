// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for the Tektelic T00056xx Industrial Transceiver
// (LoRaWAN battery-powered radio transmitter). The device is primarily an
// analog/digital industrial I/O transceiver, but it carries an ONBOARD
// temperature + relative-humidity sensor whose readings satisfy the `climate`
// category (air.temperature + air.relativeHumidity).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format (Tektelic channel/type TLV on the data fPort 10, big-endian fields)
// understood with reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/tektelic
// decoder_industrial_transceiver.js, attributed in NOTICE). Author the
// normalization here; the upstream normalizeUplink/normalizedOutput is NOT
// copied.
//
// Mapping notes (channel 0xCC type 0xTT on fPort 10):
//   0x00 0xFF  battery_voltage    signed16 * 0.01 V  -> `battery` (volts, not %).
//   0x03 0x67  temperature        signed16 * 0.1 C   -> air.temperature
//                                  (onboard ambient air sensor).
//   0x04 0x68  relative_humidity  uint8 * 0.5 %      -> air.relativeHumidity.
//   0x01 0x01  output1 state      uint8              -> extra outputState1.
//   0x02 0x01  output2 state      uint8              -> extra outputState2.
//   0x05 0x00  input_1 digital    uint8              -> extra digitalInput1.
//   0x06 0x02  input_2 current    uint16 * 1e-6 A    -> extra analogInput2Current
//                                  (4-20 mA current-loop input, amps).
//   0x07 0x02  input_3 voltage    uint16 * 0.001 V   -> extra analogInput3Voltage.
//   0x08 0x04  input_1 count      uint16             -> extra digitalInput1Count
//                                  (pulse counter).
//   0x09 0x67  mcu_temperature    signed16 * 0.1 C   -> extra mcuTemperature
//                                  (internal MCU die temp, NOT ambient air temp).
//
// Only fPort 10 carries measurement data. Configuration/diagnostic ports
// (20 serial, 100 register read-back) are not measurement uplinks and are
// rejected rather than surfaced as telemetry.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

// Big-endian unsigned integer from a byte slice (MSB first).
function uintBE(bytes, offset, length) {
  var out = 0;
  for (var i = 0; i < length; i++) {
    out = out * 256 + (bytes[offset + i] & 0xff);
  }
  return out;
}

// Big-endian signed (two's complement) integer from a byte slice.
function intBE(bytes, offset, length) {
  var out = uintBE(bytes, offset, length);
  var max = Math.pow(2, 8 * length);
  if (out >= max / 2) {
    out -= max;
  }
  return out;
}

function hex2(n) {
  return ('0' + (n & 0xff).toString(16)).slice(-2);
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;

  if (input.fPort !== 10) {
    return {
      errors: [
        'unsupported fPort ' + input.fPort + ' (expected data uplink on fPort 10)',
      ],
    };
  }
  if (!bytes || bytes.length === 0) {
    return { errors: ['empty payload'] };
  }

  var data = {};
  var air = {};
  var extras = {};
  var i = 0;

  while (i < bytes.length) {
    var channel = bytes[i];
    var type = bytes[i + 1];

    if (channel === 0x00 && type === 0xff) {
      // Battery voltage: signed16 BE * 0.01 V.
      data.battery = round(intBE(bytes, i + 2, 2) * 0.01, 2);
      i += 4;
    } else if (channel === 0x01 && type === 0x01) {
      // Relay/output 1 commanded state: uint8 (0/1) -> extra.
      extras.outputState1 = uintBE(bytes, i + 2, 1);
      i += 3;
    } else if (channel === 0x02 && type === 0x01) {
      // Relay/output 2 commanded state: uint8 (0/1) -> extra.
      extras.outputState2 = uintBE(bytes, i + 2, 1);
      i += 3;
    } else if (channel === 0x03 && type === 0x67) {
      // Onboard ambient temperature: signed16 BE * 0.1 C.
      air.temperature = round(intBE(bytes, i + 2, 2) * 0.1, 1);
      i += 4;
    } else if (channel === 0x04 && type === 0x68) {
      // Onboard relative humidity: uint8 * 0.5 %.
      air.relativeHumidity = round(uintBE(bytes, i + 2, 1) * 0.5, 1);
      i += 3;
    } else if (channel === 0x05 && type === 0x00) {
      // Digital input 1 state: uint8 -> extra.
      extras.digitalInput1 = uintBE(bytes, i + 2, 1);
      i += 3;
    } else if (channel === 0x06 && type === 0x02) {
      // Analog input 2: 4-20 mA current loop, uint16 BE * 1e-6 A (amps).
      extras.analogInput2Current = round(uintBE(bytes, i + 2, 2) * 0.000001, 6);
      i += 4;
    } else if (channel === 0x07 && type === 0x02) {
      // Analog input 3: voltage, uint16 BE * 0.001 V.
      extras.analogInput3Voltage = round(uintBE(bytes, i + 2, 2) * 0.001, 3);
      i += 4;
    } else if (channel === 0x08 && type === 0x04) {
      // Digital input 1 pulse count: uint16 BE -> extra.
      extras.digitalInput1Count = uintBE(bytes, i + 2, 2);
      i += 4;
    } else if (channel === 0x09 && type === 0x67) {
      // MCU die temperature: signed16 BE * 0.1 C -> extra (not ambient air).
      extras.mcuTemperature = round(intBE(bytes, i + 2, 2) * 0.1, 1);
      i += 4;
    } else {
      return {
        errors: [
          'unrecognized channel/type 0x' +
            hex2(channel) +
            ' 0x' +
            hex2(type === undefined ? 0 : type) +
            ' at byte ' +
            i,
        ],
      };
    }
  }

  if (air.temperature !== undefined || air.relativeHumidity !== undefined) {
    data.air = air;
  }

  var extraKeys = [];
  var k;
  for (k in extras) {
    if (Object.prototype.hasOwnProperty.call(extras, k)) {
      extraKeys.push(k);
    }
  }
  for (var j = 0; j < extraKeys.length; j++) {
    data[extraKeys[j]] = extras[extraKeys[j]];
  }

  var hasData = false;
  for (k in data) {
    if (Object.prototype.hasOwnProperty.call(data, k)) {
      hasData = true;
      break;
    }
  }
  if (!hasData) {
    return { errors: ['no decodable measurements in payload'] };
  }

  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "tektelic";
    result.data.model = "t00056xx-industrial-transceiver";
  }
  return result;
}
