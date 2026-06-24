// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for tektelic/t00055xx-industrial-transceiver
// (TEKTELIC Industrial Transceiver — analog/digital I/O with onboard
// temperature + humidity).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format (TEKTELIC TLV: 1- or 2-byte header + fixed-size value) understood with
// reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/tektelic/decoder_industrial_transceiver.js,
// attributed in NOTICE).
//
// Ported from upstream port-"10" data uplink only: the generic upstream engine
// also handles config/diagnostic ports (20/32/100), which carry no measurement
// data and are out of scope for a normalized climate codec. The field semantics
// (header -> data_size / signed|unsigned / coefficient / round) are reproduced
// faithfully from the upstream `sensor["10"]` table, including upstream's
// `Number(value.toFixed(round))` rounding.
//
// Onboard sensors map to the vocabulary: temperature (0x03 0x67) ->
// air.temperature; relative humidity (0x04 0x68) -> air.relativeHumidity;
// battery voltage (0x00 0xFF, already volts) -> battery. The MCU's internal
// temperature (0x09 0x67) is a diagnostic, NOT the onboard air sensor, so it is
// emitted as the camelCase extra `mcuTemperature`. Digital outputs, digital/
// analog inputs and the pulse counter are emitted as camelCase extras.

function round(value, decimals) {
  // Mirror upstream Number(value.toFixed(round)): fixed-decimal then numeric.
  return Number(value.toFixed(decimals));
}

// Read `size` bytes big-endian starting at offset; returns an unsigned integer.
function readUintBE(bytes, offset, size) {
  var v = 0;
  for (var i = 0; i < size; i++) {
    v = v * 256 + (bytes[offset + i] & 0xff);
  }
  return v;
}

// Big-endian two's-complement signed integer over `size` bytes.
function readIntBE(bytes, offset, size) {
  var v = readUintBE(bytes, offset, size);
  var limit = Math.pow(2, 8 * size - 1);
  if (v >= limit) {
    v -= Math.pow(2, 8 * size);
  }
  return v;
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;
  var port = input.fPort;

  // Only port 10 carries measurement data. Other ports (config/diagnostics)
  // are out of scope for this normalized codec.
  if (port !== 10) {
    return { errors: ['unsupported fPort ' + port + '; expected data uplink on fPort 10'] };
  }
  if (!bytes || bytes.length === 0) {
    return { errors: ['empty payload'] };
  }

  var data = {};
  var air = {};
  var changeOutputStates = {};
  var hasOutput = false;

  var i = 0;
  while (i < bytes.length) {
    var h0 = bytes[i] & 0xff;
    var h1 = (i + 1 < bytes.length) ? (bytes[i + 1] & 0xff) : -1;

    if (h0 === 0x00 && h1 === 0xff) {
      // battery_voltage: signed 2 bytes, coefficient 0.01, round 2 -> volts.
      if (i + 4 > bytes.length) { return { errors: ['truncated battery_voltage field'] }; }
      data.battery = round(readIntBE(bytes, i + 2, 2) * 0.01, 2);
      i += 4;
    } else if (h0 === 0x01 && h1 === 0x01) {
      // output1: unsigned 1 byte.
      if (i + 3 > bytes.length) { return { errors: ['truncated output1 field'] }; }
      changeOutputStates.output1 = readUintBE(bytes, i + 2, 1);
      hasOutput = true;
      i += 3;
    } else if (h0 === 0x02 && h1 === 0x01) {
      // output2: unsigned 1 byte.
      if (i + 3 > bytes.length) { return { errors: ['truncated output2 field'] }; }
      changeOutputStates.output2 = readUintBE(bytes, i + 2, 1);
      hasOutput = true;
      i += 3;
    } else if (h0 === 0x03 && h1 === 0x67) {
      // temperature: signed 2 bytes, coefficient 0.1, round 1 -> degC.
      if (i + 4 > bytes.length) { return { errors: ['truncated temperature field'] }; }
      air.temperature = round(readIntBE(bytes, i + 2, 2) * 0.1, 1);
      i += 4;
    } else if (h0 === 0x04 && h1 === 0x68) {
      // relative_humidity: unsigned 1 byte, coefficient 0.5, round 1 -> %.
      if (i + 3 > bytes.length) { return { errors: ['truncated relative_humidity field'] }; }
      air.relativeHumidity = round(readUintBE(bytes, i + 2, 1) * 0.5, 1);
      i += 3;
    } else if (h0 === 0x05 && h1 === 0x00) {
      // input_1: unsigned 1 byte (digital input).
      if (i + 3 > bytes.length) { return { errors: ['truncated input_1 field'] }; }
      data.input1 = readUintBE(bytes, i + 2, 1);
      i += 3;
    } else if (h0 === 0x06 && h1 === 0x02) {
      // input_2: unsigned 2 bytes, coefficient 0.000001, round 6 (analog).
      if (i + 4 > bytes.length) { return { errors: ['truncated input_2 field'] }; }
      data.input2 = round(readUintBE(bytes, i + 2, 2) * 0.000001, 6);
      i += 4;
    } else if (h0 === 0x07 && h1 === 0x02) {
      // input_3: unsigned 2 bytes, coefficient 0.001, round 3 (analog).
      if (i + 4 > bytes.length) { return { errors: ['truncated input_3 field'] }; }
      data.input3 = round(readUintBE(bytes, i + 2, 2) * 0.001, 3);
      i += 4;
    } else if (h0 === 0x08 && h1 === 0x04) {
      // input_1_count: unsigned 2 bytes (pulse counter).
      if (i + 4 > bytes.length) { return { errors: ['truncated input_1_count field'] }; }
      data.input1Count = readUintBE(bytes, i + 2, 2);
      i += 4;
    } else if (h0 === 0x09 && h1 === 0x67) {
      // mcu_temperature: signed 2 bytes, coefficient 0.1, round 1 (diagnostic).
      if (i + 4 > bytes.length) { return { errors: ['truncated mcu_temperature field'] }; }
      data.mcuTemperature = round(readIntBE(bytes, i + 2, 2) * 0.1, 1);
      i += 4;
    } else {
      return {
        errors: ['unrecognized TLV header at byte ' + i +
          ' (0x' + ('0' + h0.toString(16)).slice(-2) +
          (h1 >= 0 ? ' 0x' + ('0' + h1.toString(16)).slice(-2) : '') + ')']
      };
    }
  }

  if (air.temperature !== undefined || air.relativeHumidity !== undefined) {
    data.air = air;
  }
  if (hasOutput) {
    data.changeOutputStates = changeOutputStates;
  }

  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "tektelic";
    result.data.model = "t00055xx-industrial-transceiver";
  }
  return result;
}
