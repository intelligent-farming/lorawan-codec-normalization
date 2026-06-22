// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Lansitec Temperature & Humidity Sensor.
//
// Original work for @intelligent-farming/lorawan-codec-normalization. The wire
// format was understood with reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/lansitec/temperature-humidity-sensor.js,
// attributed in NOTICE); the normalization below is authored for this module,
// not copied.
//
// Despite the repo tag "soil-monitor", the upstream decoder produces no soil
// channels at all: there is no soil moisture, soil temperature, EC or pH. The
// only environmental uplink (Heartbeat) carries AMBIENT air temperature and
// relative humidity, so this device normalizes to the `air.*` vocabulary and
// belongs to the `climate` category.
//
// Uplink type is selected by the high nibble of bytes[0]:
//   0x1  Register   - device/region/datarate config; no measurement
//   0x2  Heartbeat  - battery %, rssi, snr, air temperature, humidity
//   0xF  Acknowledge- downlink acknowledgement
// Any other high nibble -> upstream returns null (no recognized message).
//
// Heartbeat wire layout (ported faithfully from the upstream decoder):
//   bytes[0]  low nibble = protocol version          -> protocolVersion (extra)
//   bytes[1]  battery level, percent                 -> batteryPercent (extra)
//   bytes[2]  RSSI magnitude; reported as -bytes[2]   -> rssi (dBm, extra)
//   bytes[3..4] SNR, big-endian, x0.01               -> snr (dB, extra)
//   bytes[5]  bit7 = sign, bits[6..0] = integer degC
//   bytes[6]  fractional degrees, x0.01              -> air.temperature (C)
//   bytes[7]  relative humidity, percent             -> air.relativeHumidity (%)
//   bytes[8..9] CRC, big-endian                       -> crc (extra)
//
// Register / Acknowledge messages carry no vocabulary measurement; their fields
// are surfaced as camelCase extras so the uplink is not silently dropped.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

var REGIONS = {
  0x1: 'AU915',
  0x2: 'CLAA',
  0x3: 'CN470',
  0x4: 'AS923',
  0x5: 'EU433',
  0x6: 'EU868',
  0x7: 'US915'
};

var SMODE_REGIONS = {
  0x01: 'AU915',
  0x02: 'CLAA',
  0x04: 'CN470',
  0x08: 'AS923',
  0x10: 'EU433',
  0x20: 'EU868',
  0x40: 'US915'
};

function decodeRegister(bytes, data) {
  data.messageType = 'register';
  data.adrEnabled = ((bytes[0] >> 3) & 0x01) === 1;
  var mode = bytes[0] & 0x07;
  if (REGIONS[mode]) {
    data.region = REGIONS[mode];
  }
  if (SMODE_REGIONS[bytes[1]]) {
    data.supportedRegion = SMODE_REGIONS[bytes[1]];
  }
  data.loraTxPower = (bytes[2] >> 3) & 0x1f;
  data.dataRate = 'DR' + ((bytes[3] >> 4) & 0x0f);
  data.repeating = ((bytes[3] >> 3) & 0x01) === 1;
  // TH (transmit interval) is reported in units of 10 seconds.
  data.transmitInterval = (((bytes[4] << 8) & 0xff00) | (bytes[5] & 0xff)) * 10;
  data.crc = ((bytes[6] << 8) & 0xff00) | (bytes[7] & 0xff);
}

function decodeHeartbeat(bytes, data) {
  data.messageType = 'heartbeat';
  data.protocolVersion = bytes[0] & 0x0f;

  // bytes[1]: battery level, percent. Vocabulary `battery` is volts, so a
  // percentage is emitted as the camelCase extra `batteryPercent`.
  data.batteryPercent = bytes[1];

  // bytes[2]: RSSI magnitude, reported as a negative dBm value upstream.
  data.rssi = -bytes[2];

  // bytes[3..4]: SNR, big-endian, 0.01 dB resolution.
  data.snr = round((((bytes[3] << 8) & 0xff00) | (bytes[4] & 0xff)) * 0.01, 2);

  // bytes[5..6]: ambient air temperature. bytes[5] bit7 is the sign, bits[6..0]
  // are the integer degrees, bytes[6] is hundredths of a degree.
  var magnitude = (bytes[5] & 0x7f) + 0.01 * bytes[6];
  var temperature = ((bytes[5] >> 7) & 0x01) === 1 ? -magnitude : magnitude;

  var air = {};
  air.temperature = round(temperature, 2);
  // bytes[7]: relative humidity, percent.
  air.relativeHumidity = bytes[7];
  data.air = air;

  // bytes[8..9]: CRC, big-endian. Vendor diagnostic; not in the vocabulary.
  data.crc = ((bytes[8] << 8) & 0xff00) | (bytes[9] & 0xff);
}

function decodeAcknowledge(bytes, data) {
  data.messageType = 'acknowledge';
  data.result = bytes[0] & 0x0f;
  data.messageId = bytes[1];
}

function decodeUplink(input) {
  var bytes = input.bytes;

  if (!bytes || bytes.length < 1) {
    return { errors: ['empty payload'] };
  }

  var uplinkType = (bytes[0] >> 4) & 0x0f;
  var data = {};

  if (uplinkType === 0x01) {
    if (bytes.length < 8) {
      return { errors: ['register message expects at least 8 bytes, got ' + bytes.length] };
    }
    decodeRegister(bytes, data);
    return { data: data };
  }

  if (uplinkType === 0x02) {
    if (bytes.length < 10) {
      return { errors: ['heartbeat message expects at least 10 bytes, got ' + bytes.length] };
    }
    decodeHeartbeat(bytes, data);
    return { data: data };
  }

  if (uplinkType === 0x0f) {
    if (bytes.length < 2) {
      return { errors: ['acknowledge message expects at least 2 bytes, got ' + bytes.length] };
    }
    decodeAcknowledge(bytes, data);
    return { data: data };
  }

  return { errors: ['unknown uplink type 0x' + uplinkType.toString(16)] };
}
