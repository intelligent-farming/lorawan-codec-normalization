// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Mutelcor MTC-AQ01 (LoRa Air Quality Sensor) —
// ambient temperature + relative humidity with an optional CO2 / TVOC / PM /
// light / pressure measurement set, all carried in the shared Mutelcor
// "LoRaButton" measurements frame.
//
// Original work for @intelligent-farming/lorawan-codec-normalization. The wire
// format (Mutelcor shared payload: version, battery voltage, opcode, then an
// opcode-3 "Measurements" bitmask-gated field stream) was ported from and
// normalized against the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/mutelcor/mutelcor.js, attributed in
// NOTICE). Only the Measurements opcode (3) is decoded for this air-quality
// sensor; the upstream shared decoder also handles button / vote / location /
// config / switch opcodes for other Mutelcor products, which this device does
// not emit. We author the normalization here; the upstream
// `normalizeUplink`/`Descriptions` relabelling is NOT copied.
//
// Frame layout (ported from upstream MutelcorLoRaButtonDecode):
//   byte 0      version        (uint8)
//   bytes 1..2  voltage        (uint16 BE) / 100 -> volts        -> battery
//   byte 3      opcode         (uint8); 3 = Measurements
//   byte 4      meas bitmask   (uint8); each set bit consumes a field, in order:
//     bit 0x01  temperature  int16 BE / 10  (deg C)             -> air.temperature
//     bit 0x02  humidity     uint8  (%RH)                       -> air.relativeHumidity
//     bit 0x04  pressure     uint16 BE / 10  (hPa)              -> air.pressure
//     bit 0x08  light        uint16 BE  (lux)                   -> air.lightIntensity
//     bit 0x10  co2          uint16 BE  (ppm)                   -> air.co2
//     bit 0x20  tvoc         uint16 BE  (ppb)                   -> tvoc (extra)
//     bit 0x40  distance     uint16 BE  (mm)                    -> distance (extra)
//     bit 0x80  extension    uint8 secondary bitmask:
//       bit 0x01  digital inputs  uint8                         -> digitalInputs (extra)
//       bit 0x02  PM           3x uint16 BE (PM1.0/PM2.5/PM10)   -> pm1_0 / pm2_5 / pm10 (extras)
//   (a trailing switch/state byte, if present, is read by upstream but is not a
//    measurement and is not emitted here.)
//
// Battery: the leading voltage field is a genuine volts reading (uint16 / 100),
// so it maps to the vocabulary `battery` (V) directly — no percentage forcing.
// TVOC (ppb), distance (mm), digital inputs and the PM size bins have no
// vocabulary key, so they are emitted as camelCase extras.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function u16be(hi, lo) {
  return ((hi & 0xff) << 8) | (lo & 0xff);
}

function s16be(hi, lo) {
  var v = u16be(hi, lo);
  return v > 0x7fff ? v - 0x10000 : v;
}

function decodeUplink(input) {
  var bytes = input.bytes;
  if (!bytes || bytes.length === 0) {
    return { errors: ['empty payload'] };
  }
  if (bytes.length < 4) {
    return { errors: ['payload too short for a Mutelcor frame (need version, voltage, opcode)'] };
  }

  var pos = 0;
  pos++; // version (byte 0) — not surfaced as a measurement
  var voltage = round(u16be(bytes[pos], bytes[pos + 1]) / 100, 2);
  pos += 2;
  var opcode = bytes[pos++];

  if (opcode !== 3) {
    return { errors: ['unsupported opcode ' + opcode + ' (only Measurements opcode 3 is decoded)'] };
  }

  if (pos + 1 > bytes.length) {
    return { errors: ['Measurements frame missing measurement bitmask'] };
  }
  var meas = bytes[pos++];

  var data = {};
  var air = {};

  if (meas & 0x01) {
    if (pos + 2 > bytes.length) {
      return { errors: ['truncated temperature field'] };
    }
    air.temperature = round(s16be(bytes[pos], bytes[pos + 1]) / 10, 1);
    pos += 2;
  }
  if (meas & 0x02) {
    if (pos + 1 > bytes.length) {
      return { errors: ['truncated humidity field'] };
    }
    air.relativeHumidity = bytes[pos];
    pos += 1;
  }
  if (meas & 0x04) {
    if (pos + 2 > bytes.length) {
      return { errors: ['truncated pressure field'] };
    }
    air.pressure = round(u16be(bytes[pos], bytes[pos + 1]) / 10, 1);
    pos += 2;
  }
  if (meas & 0x08) {
    if (pos + 2 > bytes.length) {
      return { errors: ['truncated light field'] };
    }
    air.lightIntensity = u16be(bytes[pos], bytes[pos + 1]);
    pos += 2;
  }
  if (meas & 0x10) {
    if (pos + 2 > bytes.length) {
      return { errors: ['truncated CO2 field'] };
    }
    air.co2 = u16be(bytes[pos], bytes[pos + 1]);
    pos += 2;
  }
  if (meas & 0x20) {
    if (pos + 2 > bytes.length) {
      return { errors: ['truncated TVOC field'] };
    }
    data.tvoc = u16be(bytes[pos], bytes[pos + 1]);
    pos += 2;
  }
  if (meas & 0x40) {
    if (pos + 2 > bytes.length) {
      return { errors: ['truncated distance field'] };
    }
    data.distance = u16be(bytes[pos], bytes[pos + 1]);
    pos += 2;
  }
  if (meas & 0x80) {
    if (pos + 1 > bytes.length) {
      return { errors: ['truncated measurement extension bitmask'] };
    }
    var ext = bytes[pos++];
    if (ext & 0x01) {
      if (pos + 1 > bytes.length) {
        return { errors: ['truncated digital inputs field'] };
      }
      var di = bytes[pos++];
      var inputs = {};
      var d;
      for (d = 0; d < 4; d++) {
        if (di & (1 << d)) {
          inputs[d + 1] = (di & (1 << (d + 4))) !== 0;
        }
      }
      data.digitalInputs = inputs;
    }
    if (ext & 0x02) {
      if (pos + 6 > bytes.length) {
        return { errors: ['truncated particulate matter field'] };
      }
      data.pm1_0 = u16be(bytes[pos], bytes[pos + 1]);
      data.pm2_5 = u16be(bytes[pos + 2], bytes[pos + 3]);
      data.pm10 = u16be(bytes[pos + 4], bytes[pos + 5]);
      pos += 6;
    }
  }

  if (air.temperature !== undefined || air.relativeHumidity !== undefined ||
      air.pressure !== undefined || air.lightIntensity !== undefined ||
      air.co2 !== undefined) {
    data.air = air;
  }

  data.battery = voltage;

  return { data: data };
}
