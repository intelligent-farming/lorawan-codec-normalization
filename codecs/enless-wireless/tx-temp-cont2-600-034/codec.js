// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Enless Wireless TX T&H 600-034 (EN311) — the
// "T&H with External Probe" transmitter. Despite the catalog slug
// "tx-temp-cont2-600-034", the upstream TTN decoder routes the 600-034 payload
// through device type 0x0E (EN311), which reports a single ambient
// temperature plus relative humidity from an external T&H probe — NOT two
// contact-temperature probes. This codec follows the wire format exactly as
// the upstream decoder reads it.
//
// Ported from the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/enless-wireless/enlessdecoder.js,
// EN311 / type 0x0E branch; attributed in NOTICE). Wire format is big-endian:
//   bytes 0-2   uint24  device id
//   byte  3     uint8   device type (0x0E for this device)
//   byte  4     uint8   sequence counter
//   byte  5     uint8   firmware version (low 6 bits)
//   bytes 6-7   int16   temperature x10 (degC)
//   bytes 8-9   uint16  humidity x10 (%)
//   bytes 10-11 uint16  alarm status flags
//   bytes 12-13 uint16  device state (battery class + msg type)
//
// The device reports battery as a coarse PERCENTAGE class (100/75/50/25), not
// volts, so it is emitted as the camelCase extra `batteryPercent` rather than
// forced into the vocabulary's volts-based `battery` key.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function u8(bytes, i) {
  return bytes[i] & 0xff;
}

function u16be(bytes, i) {
  return ((bytes[i] & 0xff) << 8) | (bytes[i + 1] & 0xff);
}

function s16be(bytes, i) {
  var v = u16be(bytes, i);
  return v > 0x7fff ? v - 0x10000 : v;
}

var EN311 = 0x0e; /* TX T&H 600-034 */

function decodeUplinkCore(input) {
  var bytes = input.bytes;
  if (!bytes || bytes.length < 14) {
    return { errors: ['payload too short: expected at least 14 bytes'] };
  }

  var type = u8(bytes, 3);
  if (type !== EN311) {
    return {
      errors: ['unsupported device type 0x' + type.toString(16) + ' (expected 0x0e EN311 TX T&H 600-034)']
    };
  }

  var temperature = round(s16be(bytes, 6) / 10, 1);
  var humidity = round(u16be(bytes, 8) / 10, 1);

  var alarm = u16be(bytes, 10);
  var state = u16be(bytes, 12);

  // Battery class: bits 2-3 of the state word. 00=100% 01=75% 10=50% 11=25%.
  var batteryByCode = [100, 75, 50, 25];
  var batteryCode = (state >> 2) & 0x03;

  // Message type: bit 0 of the state word. 1 => alarm.
  var msgType = (state & 0x01) ? 'alarm' : 'normal';

  // Device id: big-endian uint24 over bytes 0-2.
  var deviceId = ((bytes[0] & 0xff) << 16) | u16be(bytes, 1);

  // Alarm flags (EN311 / upstream defs302): bit 0 temp high, bit 1 temp low,
  // bit 2 humidity high, bit 3 humidity low.
  var data = {
    air: {
      temperature: temperature,
      relativeHumidity: humidity
    },
    batteryPercent: batteryByCode[batteryCode],
    deviceId: deviceId,
    sequenceCounter: u8(bytes, 4),
    firmwareVersion: u8(bytes, 5) & 0x3f,
    messageType: msgType,
    alarmStatus: {
      temperature: {
        high: !!(alarm & 0x01),
        low: !!(alarm & 0x02)
      },
      relativeHumidity: {
        high: !!(alarm & 0x04),
        low: !!(alarm & 0x08)
      }
    }
  };

  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "enless-wireless";
    result.data.model = "tx-temp-cont2-600-034";
  }
  return result;
}
