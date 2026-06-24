// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for RadioBridge RBS306-ATH-EXT (External-Probe Air
// Temperature & Humidity Sensor).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format (RadioBridge generic packet protocol: byte0 = protocol/counter nibbles,
// byte1 = event/payload type, remainder event-specific) understood with
// reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/radio-bridge/
// radio_bridge_packet_decoder.js, attributed in NOTICE).
//
// The temperature/humidity decode math is ported faithfully from the upstream
// ATH event (the "Convert" mode-1 sign-magnitude scheme and the upper-nibble
// fractional tenths), but the OUTPUT is authored to the shared vocabulary:
//   ATH event (0x0D): temperature -> air.temperature, humidity ->
//     air.relativeHumidity. This device's whole AHT element sits on the external
//     sintered-filter probe and measures AIR, so it maps to air.* (not water.*).
//   Supervisory event (0x01): battery volts -> `battery` (vocabulary battery is
//     VOLTS, which this device already reports).
// Event/message-type and diagnostic flags are emitted as camelCase extras.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

// Ported from upstream Convert(number, 1): sign-magnitude where the integer
// byte's bit7 acts as a sign flag (number > 127 => negative magnitude of
// (number - 128)). Fractional tenths come from the high nibble of fracByte.
function athTemperature(intByte, fracByte) {
  var number = intByte + ((fracByte >> 4) / 10);
  if (number > 127) {
    return round(-(number - 128), 1);
  }
  return round(number, 1);
}

function athEventLabel(eventType) {
  switch (eventType) {
    case 0: return 'Periodic Report';
    case 1: return 'Temperature has Risen Above Upper Threshold';
    case 2: return 'Temperature has Fallen Below Lower Threshold';
    case 3: return 'Temperature Report-on-Change Increase';
    case 4: return 'Temperature Report-on-Change Decrease';
    case 5: return 'Humidity has Risen Above Upper Threshold';
    case 6: return 'Humidity has Fallen Below Lower Threshold';
    case 7: return 'Humidity Report-on-Change Increase';
    case 8: return 'Humidity Report-on-Change Decrease';
    default: return 'Undefined';
  }
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;
  if (!bytes || bytes.length < 2) {
    return { errors: ['payload too short'] };
  }

  var counter = bytes[0] & 0x0f;
  var payloadType = bytes[1];

  // ATH event (0x0D): air temperature + relative humidity.
  if (payloadType === 0x0d) {
    if (bytes.length < 7) {
      return { errors: ['ATH event payload too short'] };
    }
    var eventType = bytes[2];
    var temperature = athTemperature(bytes[3], bytes[4]);
    var humidity = round(bytes[5] + ((bytes[6] >> 4) / 10), 1);

    return {
      data: {
        air: {
          temperature: temperature,
          relativeHumidity: humidity
        },
        messageType: 'ath',
        event: athEventLabel(eventType),
        counter: counter
      }
    };
  }

  // Supervisory event (0x01): periodic health report carrying battery voltage.
  if (payloadType === 0x01) {
    if (bytes.length < 11) {
      return { errors: ['supervisory event payload too short'] };
    }
    // Battery volts: high nibble = whole volts, low nibble = tenths.
    var battery = round(((bytes[4] >> 4) & 0x0f) + (bytes[4] & 0x0f) / 10, 1);

    return {
      data: {
        battery: battery,
        messageType: 'supervisory',
        batteryLow: ((bytes[2] >> 1) & 0x01) === 1,
        tamperSinceLastReset: ((bytes[2] >> 4) & 0x01) === 1,
        tamperState: ((bytes[2] >> 3) & 0x01) === 1,
        errorWithLastDownlink: ((bytes[2] >> 2) & 0x01) === 1,
        radioCommError: (bytes[2] & 0x01) === 1,
        accumulationCount: (bytes[9] * 256) + bytes[10],
        counter: counter
      }
    };
  }

  return { errors: ['unsupported RadioBridge event type 0x' + payloadType.toString(16)] };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "radio-bridge";
    result.data.model = "rbs306-ath-ext";
  }
  return result;
}
