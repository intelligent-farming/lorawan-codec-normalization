// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Dragino WSC1-L (Weather Station Process Unit, the
// LoRaWAN hub of the Dragino agriculture weather-station solution).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire format
// understood with reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/dragino/wsc1-l.js, attributed in
// NOTICE). The fPort 2 payload is a sequence of TLV records: [sensorType, len,
// value...]. A per-type "algorithm" byte selects the scaling: op 0 = value/(count
// *10), op 1 = value*(count*10), op 2 = raw integer. Records advance by 2+len.
//
// We map the calibrated meteorological channels to the shared vocabulary:
//   TEM -> air.temperature (degC, /10), HUM -> air.relativeHumidity (%, /10),
//   pressure -> air.pressure (hPa, /10 already in hPa), illumination ->
//   air.lightIntensity (lux, *10), CO2 -> air.co2 (ppm), PM2_5 -> air.pm2_5
//   (ug/m3), PM10 -> air.pm10 (ug/m3), PAR -> air.par (umol/m2/s), TSR ->
//   air.solarIrradiance (W/m2, /10), wind_speed -> wind.speed (m/s, /10),
//   wind_direction_angle -> wind.direction (deg, /10), rain_gauge ->
//   rain.cumulative (mm, /10).
// Device-state / diagnostic channels with no vocabulary home become camelCase
// extras: rainSnow (rain/snow flag byte), windSpeedLevel (Beaufort-style level
// byte), windDirectionCardinal (compass string), batteryRaw (the upstream `bat`
// field, scaled value/30 - not a calibrated volt reading, so it is NOT mapped to
// the volts-only `battery` key).
//
// Negative temperature: upstream uses (value - 0xffff), which is off by one count
// (the documented dragino two's-complement bug, see AUTHORING.md). This codec uses
// the correct (value - 0x10000) two's-complement.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function u16(hi, lo) {
  return ((hi << 8) | lo) & 0xffff;
}

// 16-bit two's-complement from two bytes (hi, lo).
function s16(hi, lo) {
  var v = u16(hi, lo);
  return v & 0x8000 ? v - 0x10000 : v;
}

function decodeFPort5(bytes) {
  if (bytes.length < 10) {
    return { errors: ['fPort 5 device-info frame expects >= 10 bytes, got ' + bytes.length] };
  }
  var frequency = {
    1: 'EU868', 2: 'US915', 3: 'IN865', 4: 'AU915', 5: 'KZ865',
    6: 'RU864', 7: 'AS923', 8: 'AS923-1', 9: 'AS923-2', 10: 'AS923-3'
  };
  function hx(n) {
    var s = (n & 0xff).toString(16);
    return s.length < 2 ? '0' + s : s;
  }
  var data = {};
  data.deviceNode = 'WSC1-L';
  data.firmwareVersion = 'V.' + bytes[1] + '.' + (bytes[2] >> 4) + '.' + (bytes[2] & 0x0f);
  var fb = frequency[bytes[3]];
  if (fb) {
    data.frequencyBand = fb;
  }
  data.subBand = bytes[4];
  data.batteryVoltage = round(u16(bytes[5], bytes[6]) / 1000, 3);
  data.weatherSensorTypes = bytes[7].toString(16) + hx(bytes[8]) + bytes[9].toString(16);
  return { data: data };
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;
  var port = input.fPort;

  if (port === 5) {
    return decodeFPort5(bytes);
  }
  if (port !== 2) {
    return { errors: ['unknown FPort ' + port + ' (expected 2 or 5)'] };
  }
  if (bytes.length < 1) {
    return { errors: ['empty payload'] };
  }
  if (bytes[0] >= 0xe0) {
    return { errors: ['unsupported fPort 2 frame header 0x' + bytes[0].toString(16)] };
  }

  // sensorType -> scaling. algorithm hi nibble = operation, lo nibble = count.
  var algorithm = [0x03, 0x01, 0x01, 0x11, 0x20, 0x20, 0x01, 0x01, 0x01, 0x01, 0x20, 0x20, 0x20, 0x01];
  var directions = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];

  var data = {};
  var air = { location: 'outdoor' };
  var wind = {};
  var rain = {};
  var hasAir = false;
  var hasWind = false;
  var hasRain = false;
  var warnings = [];

  var i = 0;
  while (i < bytes.length) {
    var type = bytes[i];
    var len = bytes[i + 1];
    if (len === undefined) {
      warnings.push('truncated record at offset ' + i);
      break;
    }

    if (type < 0xa1 && type < algorithm.length) {
      var op = algorithm[type] >> 4;
      var count = algorithm[type] & 0x0f;
      var raw;
      if (type === 0x04) {
        // rain_snow: single byte
        raw = bytes[i + 2];
      } else if (type === 0x06) {
        // TEM: signed, two's-complement
        raw = s16(bytes[i + 2], bytes[i + 3]) / (count * 10.0);
      } else if (op === 0) {
        raw = u16(bytes[i + 2], bytes[i + 3]) / (count * 10.0);
      } else if (op === 1) {
        raw = u16(bytes[i + 2], bytes[i + 3]) * (count * 10);
      } else {
        raw = u16(bytes[i + 2], bytes[i + 3]);
      }

      if (type === 0x00) {
        // bat: upstream value/30, not a calibrated volt reading -> extra
        data.batteryRaw = round(raw, 2);
      } else if (type === 0x01) {
        wind.speed = round(raw, 2);
        hasWind = true;
        data.windSpeedLevel = bytes[i + 4];
      } else if (type === 0x02) {
        wind.direction = round(raw, 1);
        hasWind = true;
        var dirIdx = bytes[i + 4];
        if (directions[dirIdx] !== undefined) {
          data.windDirectionCardinal = directions[dirIdx];
        }
      } else if (type === 0x03) {
        air.lightIntensity = round(raw, 0);
        hasAir = true;
      } else if (type === 0x04) {
        data.rainSnow = raw;
      } else if (type === 0x05) {
        air.co2 = round(raw, 0);
        hasAir = true;
      } else if (type === 0x06) {
        air.temperature = round(raw, 1);
        hasAir = true;
      } else if (type === 0x07) {
        air.relativeHumidity = round(raw, 1);
        hasAir = true;
      } else if (type === 0x08) {
        air.pressure = round(raw, 1);
        hasAir = true;
      } else if (type === 0x09) {
        rain.cumulative = round(raw, 1);
        hasRain = true;
      } else if (type === 0x0a) {
        air.pm2_5 = round(raw, 0);
        hasAir = true;
      } else if (type === 0x0b) {
        air.pm10 = round(raw, 0);
        hasAir = true;
      } else if (type === 0x0c) {
        air.par = round(raw, 0);
        hasAir = true;
      } else if (type === 0x0d) {
        air.solarIrradiance = round(raw, 1);
        hasAir = true;
      }
    } else if (type >= 0xa1 && type <= 0xa4) {
      // DIY analog channels A1..A4 (raw counts) -> extras
      data['analog' + (type - 0xa1 + 1)] = u16(bytes[i + 2], bytes[i + 3]);
    } else {
      warnings.push('unknown sensor type 0x' + type.toString(16) + ' at offset ' + i);
    }

    i = i + 2 + len;
  }

  if (hasAir) {
    data.air = air;
  }
  if (hasWind) {
    data.wind = wind;
  }
  if (hasRain) {
    data.rain = rain;
  }

  if (!hasAir && !hasWind && !hasRain) {
    var keyCount = 0;
    for (var k in data) {
      if (data.hasOwnProperty(k)) {
        keyCount++;
      }
    }
    if (keyCount === 0) {
      return { errors: ['no decodable sensor records in fPort 2 payload'] };
    }
  }

  var result = { data: data };
  if (warnings.length) {
    result.warnings = warnings;
  }
  return result;
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "dragino";
    result.data.model = "wsc1-l";
  }
  return result;
}
