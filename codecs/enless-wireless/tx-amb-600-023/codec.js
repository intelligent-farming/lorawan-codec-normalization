// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Enless Wireless TX CO2/VOC/T&H AMB 600-023
// (EN304), an ambient CO2 + VOC + temperature + humidity transmitter.
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format (Enless fixed/framed format) understood with reference to the upstream
// Apache-2.0 decoder (TheThingsNetwork/lorawan-devices
// vendor/enless-wireless/enlessdecoder.js, attributed in NOTICE).
// Ported from the upstream EN304 (deviceType 0x06) branch of bin_decode.
//
// Enless reports battery as a coarse PERCENTAGE code (100/75/50/25%); the
// vocabulary's `battery` is volts, so the percentage is emitted as the
// camelCase extra `batteryPercent` rather than being forced into a volts field.
// The vocabulary models air.co2 but not VOC, so VOC (ppb) is emitted as the
// camelCase extra `tvoc`.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function u24be(bytes, offset) {
  return (bytes[offset] * 65536) + (bytes[offset + 1] << 8) + bytes[offset + 2];
}

function u16be(bytes, offset) {
  return ((bytes[offset] << 8) | bytes[offset + 1]) & 0xffff;
}

function s16be(bytes, offset) {
  var v = u16be(bytes, offset);
  return v > 0x7fff ? v - 0x10000 : v;
}

// Upstream renders the 16-bit value as a 16-char binary string and indexes bits
// from the right as `binNum[len - bit]` (1-indexed). bit() mirrors that: bit 1
// is the least-significant bit.
function bit(value, n) {
  return (value >> (n - 1)) & 1;
}

// EN304 device type byte (TX CO2/VOC/T&H AMB 600-023).
var EN304 = 0x06;

function decodeUplinkCore(input) {
  var bytes = input.bytes;

  if (!bytes || bytes.length < 18) {
    return { errors: ['payload too short for Enless EN304 frame (need 18 bytes)'] };
  }

  var type = bytes[3];
  if (type !== EN304) {
    return { errors: ['unsupported Enless device type 0x' + type.toString(16) + ' (expected 0x06 / EN304)'] };
  }

  var deviceId = u24be(bytes, 0);
  var seqCounter = bytes[4];
  // Firmware version is the low 6 bits of byte 5 (upstream hexToFwVerison).
  var fwVersion = bytes[5] & 0x3f;

  // All scaled values divide the raw 16-bit count by 10 (upstream divider 10).
  var temperature = round(s16be(bytes, 6) / 10, 1);
  var humidity = round(u16be(bytes, 8) / 10, 1);
  var voc = round(u16be(bytes, 10) / 10, 1);
  var co2 = round(u16be(bytes, 12) / 10, 1);

  // Alarm field (bytes 14-15). EN304 bit map (1-indexed from LSB):
  //   bit 1 = temperature high, bit 2 = temperature low,
  //   bit 3 = humidity high,    bit 4 = humidity low,
  //   bit 5 = voc high,         bit 6 = voc low,
  //   bit 7 = co2 high,         bit 8 = co2 low.
  var alarmWord = u16be(bytes, 14);
  var alarms = {
    temperatureHigh: bit(alarmWord, 1) === 1,
    temperatureLow: bit(alarmWord, 2) === 1,
    humidityHigh: bit(alarmWord, 3) === 1,
    humidityLow: bit(alarmWord, 4) === 1,
    vocHigh: bit(alarmWord, 5) === 1,
    vocLow: bit(alarmWord, 6) === 1,
    co2High: bit(alarmWord, 7) === 1,
    co2Low: bit(alarmWord, 8) === 1
  };

  // Battery + message-type field (bytes 16-17). Upstream reads a 2-bit battery
  // code at bit positions [len-4, len-2) of the 16-bit binary, i.e. bits 4..3
  // (1-indexed). Code 00->100%, 01->75%, 10->50%, 11->25%. msg_type is bit 1.
  var stateWord = u16be(bytes, 16);
  var batteryCode = (bit(stateWord, 4) << 1) | bit(stateWord, 3);
  var batteryPercent;
  if (batteryCode === 0) {
    batteryPercent = 100;
  } else if (batteryCode === 1) {
    batteryPercent = 75;
  } else if (batteryCode === 2) {
    batteryPercent = 50;
  } else {
    batteryPercent = 25;
  }
  var messageType = bit(stateWord, 1) === 1 ? 'alarm' : 'normal';

  return {
    data: {
      air: {
        temperature: temperature,
        relativeHumidity: humidity,
        co2: co2
      },
      tvoc: voc,
      batteryPercent: batteryPercent,
      deviceId: deviceId,
      sequenceCounter: seqCounter,
      firmwareVersion: fwVersion,
      messageType: messageType,
      alarms: alarms
    }
  };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "enless-wireless";
    result.data.model = "tx-amb-600-023";
  }
  return result;
}
