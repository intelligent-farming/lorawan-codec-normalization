// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Radionode RN320-PMT (multi-probe air-quality
// node: temperature, humidity, illuminance, CO2, plus PM2.5/PM10/HCHO/CO).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format (Radionode RN320 head/model framed payload) understood with reference
// to the upstream Apache-2.0 decoder (TheThingsNetwork/lorawan-devices
// vendor/radionode/rn320pmt.js, attributed in NOTICE).
//
// Upstream notes / corrections:
//   * Upstream HARD-CODES `co2 = 265` ("Fixed value to match validation") and
//     `volt = 3592` instead of reading the wire. We read the real CO2 value
//     from bytes[16..17] (little-endian uint16, ppm); for the datain example
//     that is 400 ppm, not 265.
//   * Upstream returns raw integer counts. The RN320 reports temperature and
//     humidity in centi-units, so we scale by 1/100 to °C and %RH.
//   * The vocabulary models only air.co2; PM2.5/PM10/HCHO(TVOC)/CO have no
//     vocabulary key, so they are emitted as camelCase extras (pm25, pm10,
//     hcho, co).
//   * The checkin/config frame (head 11) carries device configuration, not a
//     normalized measurement, so it is reported as an error rather than forced
//     into a measurement object.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function u16le(lo, hi) {
  return ((hi << 8) | lo) & 0xffff;
}

function s16le(lo, hi) {
  var v = u16le(lo, hi);
  return v > 0x7fff ? v - 0x10000 : v;
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;

  if (!bytes || bytes.length < 2) {
    return { errors: ['payload too short'] };
  }

  var head = bytes[0] & 0xff;

  // head 12 = datain (live), head 13 = holdin (held/buffered) sensor frame.
  if (head !== 12 && head !== 13) {
    if (head === 11) {
      return { errors: ['checkin/config frame carries no normalized measurement'] };
    }
    return { errors: ['unsupported head type: ' + head] };
  }

  // Sensor data frame layout (little-endian):
  //   [0] head, [1] model, [2] tsmode, [3..6] timestamp(u32),
  //   [7] splfmt, [8..9] pm25, [10..11] pm10, [12..13] lux,
  //   [14..15] hcho, [16..17] co2, [18..19] co,
  //   [20..21] temperature(s16, centi-°C), [22..23] humidity(centi-%RH)
  if (bytes.length < 24) {
    return { errors: ['sensor frame truncated'] };
  }

  var data = {};
  var air = {};

  var pm25 = u16le(bytes[8], bytes[9]);
  var pm10 = u16le(bytes[10], bytes[11]);
  var lux = u16le(bytes[12], bytes[13]);
  var hcho = u16le(bytes[14], bytes[15]);
  var co2 = u16le(bytes[16], bytes[17]);
  var co = u16le(bytes[18], bytes[19]);
  var temperature = s16le(bytes[20], bytes[21]);
  var humidity = u16le(bytes[22], bytes[23]);

  air.temperature = round(temperature / 100, 2);
  air.relativeHumidity = round(humidity / 100, 2);
  air.co2 = co2;
  air.lightIntensity = lux;

  data.air = air;

  // Non-vocabulary device channels as camelCase extras.
  data.pm25 = pm25;
  data.pm10 = pm10;
  data.hcho = hcho;
  data.co = co;

  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "radionode";
    result.data.model = "rn320pmt";
  }
  return result;
}
