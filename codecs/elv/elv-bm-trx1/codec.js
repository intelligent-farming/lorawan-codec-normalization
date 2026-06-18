// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for ELV BM-TRX1 (LoRIS modular experimental
// platform for LoRaWAN).
//
// Ported from the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/elv/elv-bm-trx1.js, "ELV modular
// system Payload-Parser" V1.10.1, attributed in NOTICE). The upstream
// Decoder() wire walk (port 10, 5-byte header, then a TLV stream keyed by a
// datatype byte) is reproduced faithfully here; only the OUTPUT is renormalized
// to the shared vocabulary.
//
// Renormalization notes (deliberate divergence from upstream's raw output):
//   * Upstream emits temperature / humidity / brightness / pressure as STRINGS
//     (toFixed/String); the vocabulary requires numbers, so we parse to numbers
//     with the sensor's real resolution.
//   * Header "Supply_Voltage" is the device supply rail in millivolts; the
//     vocabulary `battery` is volts, so it is divided by 1000.
//   * The TLV "Concentration" (0x08) datatype is the ELV CO2 module reading in
//     ppm -> air.co2.
//   * Sensor special values (Unknown / Overflow / Underflow / SensorError /
//     CalibrationError / reserved) are NOT vocabulary numbers; they are dropped
//     from the normalized fields and surfaced as camelCase status extras.
//   * Non-climate datatypes upstream decodes (binary I/O, position, time,
//     distance, V/I/P, angle, wind, rain, 6-axis, window, UV, irradiance) are
//     decoded into camelCase extras so no device data is silently lost.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

var TX_REASON = [
  'Timer_Event', // 0x00
  'User_Button_Event', // 0x01
  'App_Event', // 0x02
  'FUOTA_Event', // 0x03
  'Cyclic_Event', // 0x04
  'Timeout_Event' // 0x05
];

// 16-bit signed temperature (0.1 resolution) with the device's special codes.
// Returns { value: <number> } for a real reading or { status: <string> } for a
// special code.
function decodeTemp16(raw) {
  if (raw === 0x8000) return { status: 'Unknown' };
  if (raw === 0x8001) return { status: 'Overflow' };
  if (raw === 0x8002) return { status: 'Underflow' };
  var v = raw;
  if (v > 0x7fff) v -= 0x10000;
  return { value: round(v * 0.1, 1) };
}

function decodeUplink(input) {
  var bytes = input.bytes;
  var port = input.fPort;

  if (port !== 10) {
    return { errors: ['Wrong Port Number'] };
  }
  if (bytes.length < 5) {
    return { errors: ['Not enough data'] };
  }

  var data = {};
  var air = {};
  var motion = {};
  var warnings = [];

  // The TH module (0x03) and a standalone temperature probe (0x02) can both
  // appear in one payload. Air temperature comes from the TH module when
  // present; a lone 0x02 probe then maps to air.temperature, otherwise it is
  // preserved as the camelCase extra `temperatureSensor` so neither reading is
  // lost to the single-scalar vocabulary key.
  var thTemp; // { value } | { status } from a 0x03 datatype
  var probeTemps = []; // ordered { value } | { status } from each 0x02 datatype

  // Header -------------------------------------------------------------------
  if (bytes[0] === 0xff) {
    data.txReason = 'UNDEFINED_EVENT';
  } else if (bytes[0] >= TX_REASON.length) {
    data.txReason = 'UNKNOWN_EVENT --> Please update your payload parser';
  } else {
    data.txReason = TX_REASON[bytes[0]];
  }

  // Supply rail in millivolts -> battery volts.
  var supplymV = (bytes[3] << 8) | bytes[4];
  data.battery = round(supplymV / 1000, 3);

  // Application TLV stream ---------------------------------------------------
  var parserError = false;
  var index = 5;

  if (bytes.length >= 6) {
    do {
      var type = bytes[index];

      if (type === 0x00) {
        // Binary input bitfield
        index++;
        var bi = bytes[index];
        if (bi & 0x02) data.input1 = bi & 0x01 ? 'Active' : 'Inactive';
        if (bi & 0x08) data.input2 = bi & 0x04 ? 'Active' : 'Inactive';
        if (bi & 0x20) data.input3 = bi & 0x10 ? 'Active' : 'Inactive';
        if (bi & 0x80) data.input4 = bi & 0x40 ? 'Active' : 'Inactive';
      } else if (type === 0x01) {
        // Binary output bitfield
        index++;
        var bo = bytes[index];
        if (bo & 0x02) data.output1 = bo & 0x01 ? 'Active' : 'Inactive';
        if (bo & 0x08) data.output2 = bo & 0x04 ? 'Active' : 'Inactive';
        if (bo & 0x20) data.output3 = bo & 0x10 ? 'Active' : 'Inactive';
        if (bo & 0x80) data.output4 = bo & 0x40 ? 'Active' : 'Inactive';
      } else if (type === 0x02) {
        // Temperature (standalone probe, no humidity). Deferred: resolved
        // after the full stream so the TH module can claim air.temperature.
        index++;
        var traw = bytes[index] * 256;
        index++;
        traw += bytes[index];
        probeTemps.push(decodeTemp16(traw));
      } else if (type === 0x03) {
        // Temperature + relative humidity (the climate TH module)
        index++;
        var thraw = bytes[index] * 256;
        index++;
        thraw += bytes[index];
        thTemp = decodeTemp16(thraw);

        index++;
        var hum = bytes[index];
        if (hum === 0xff) data.humidityStatus = 'Unknown';
        else if (hum === 0xfe) data.humidityStatus = 'Overflow';
        else if (hum === 0xfd) data.humidityStatus = 'Underflow';
        else air.relativeHumidity = hum;
      } else if (type === 0x04) {
        // Positioning data (TTN Mapper conform)
        var lat = bytes[++index] | (bytes[++index] << 8) | (bytes[++index] << 16) | (bytes[++index] << 24);
        data.position = { latitude: round(lat / 1000000, 6) };
        var lon = bytes[++index] | (bytes[++index] << 8) | (bytes[++index] << 16) | (bytes[++index] << 24);
        data.position.longitude = round(lon / 1000000, 6);
        var alt = bytes[++index] | (bytes[++index] << 8) | (bytes[++index] << 16) | (bytes[++index] << 24);
        data.altitude = round(alt / 10000, 2);
        var hd = String(bytes[++index]) + '.' + lpad2(bytes[++index] * 4);
        data.hdop = round(parseFloat(hd), 2);
      } else if (type === 0x05) {
        // Time value (encoded units in top 2 bits)
        index++;
        var tv = bytes[index] * 256;
        index++;
        tv += bytes[index];
        if (tv === 0x3fff) {
          data.timeValueStatus = 'Unknown';
        } else if (tv === 0x3ffe) {
          data.timeValueStatus = 'Overflow';
        } else {
          var unit = tv >> 14;
          var base = tv & 0x3fff;
          if (unit === 0) data.timeValueSeconds = base;
          else if (unit === 1) data.timeValueSeconds = base * 60;
          else if (unit === 2) data.timeValueSeconds = base * 3600;
          else data.timeValueSeconds = base * 86400;
        }
      } else if (type === 0x06) {
        // Distance
        index++;
        var dist = bytes[index] * 256;
        index++;
        dist += bytes[index];
        data.distance = dist;
      } else if (type === 0x07) {
        // Battery indicator (categorical, not a voltage)
        index++;
        var bind = bytes[index];
        if (bind === 0x01) data.batteryIndicator = 'Battery_LOW';
        else if (bind === 0x02) data.batteryIndicator = 'Battery_OKAY';
        else if (bind === 0x03) data.batteryIndicator = 'Battery_HIGH';
        else data.batteryIndicator = 'Invalid_Value!';
      } else if (type === 0x08) {
        // Concentration (ELV CO2 module) -> ppm
        index++;
        var craw = bytes[index] * 256;
        index++;
        craw += bytes[index];
        if (craw === 0x7fff) data.co2Status = 'Unknown';
        else if (craw === 0x7ffe) data.co2Status = 'Overflow';
        else if (craw === 0x7ffd) data.co2Status = 'SensorError';
        else if (craw === 0x7ffc) data.co2Status = 'CalibrationError';
        else if (craw >= 0x7ff0 && craw <= 0x7ffb) data.co2Status = 'reserved';
        else {
          var cval = craw;
          if (cval > 0x7fff) cval -= 0x10000;
          air.co2 = cval;
        }
      } else if (type === 0x0b) {
        // Brightness [lx]
        index++;
        var braw = bytes[index] * 65536;
        index++;
        braw += bytes[index] * 256;
        index++;
        braw += bytes[index];
        if (braw === 0xffffff) data.lightStatus = 'Overflow';
        else air.lightIntensity = round(braw * 0.01, 2);
      } else if (type === 0x0c) {
        // Acceleration / motion
        index++;
        var acc = bytes[index];
        motion.detected = !!(acc & 0x80);
        data.tiltArea2 = !!(acc & 0x08);
        data.tiltArea1 = !!(acc & 0x04);
        data.tiltArea0 = !!(acc & 0x02);
        data.acceleration = !!(acc & 0x01);
        index++;
        data.tiltAngle = bytes[index];
      } else if (type === 0x0d) {
        // Voltage + Current + Power (per-channel, selected by a bitfield)
        index++;
        var bf = bytes[index];
        for (var ch = 0; ch < 4; ch++) {
          if (bf & (1 << ch)) {
            index++;
            var vraw = bytes[index] * 256;
            index++;
            vraw += bytes[index];
            putChannel(data, 'voltage', ch, round(vraw * 0.001, 3));

            index++;
            var iraw = bytes[index] * 256;
            index++;
            iraw += bytes[index];
            if (iraw > 0x7fff) iraw -= 0x10000;
            putChannel(data, 'current', ch, round(iraw * 0.001, 3));

            index++;
            var praw = bytes[index] * 256;
            index++;
            praw += bytes[index];
            var pscale = praw >> 14;
            var pbase = praw & 0x3fff;
            var pval;
            if (pscale === 1) pval = pbase * 0.01;
            else if (pscale === 2) pval = pbase * 0.1;
            else if (pscale === 3) pval = pbase * 1;
            else pval = pbase * 0.001;
            putChannel(data, 'power', ch, round(pval, 3));
          }
        }
      } else if (type === 0x0e) {
        // Pressure (24-bit, 0.1 hPa) -> hPa
        index++;
        var praw2 = bytes[index] * 65536;
        index++;
        praw2 += bytes[index] * 256;
        index++;
        praw2 += bytes[index];
        air.pressure = round(praw2 / 10, 1);
      } else if (type === 0x0f) {
        // Error bitfield
        index++;
        var ebits = bytes[index];
        if (ebits) {
          var es = '';
          for (var eb = 0; eb < 8; eb++) {
            if (ebits & (1 << eb)) es += 'Bit' + eb + ' ';
          }
          data.error = es;
        } else {
          data.error = 'None ';
        }
      } else if (type === 0x10) {
        // Absolute angle (2.5 deg resolution)
        index++;
        if (bytes[index] === 0xff) data.absoluteAngleStatus = 'Unknown';
        else data.absoluteAngle = round(bytes[index] * 2.5, 1);
      } else if (type === 0x11) {
        // Speed
        index++;
        var sraw = bytes[index] * 256;
        index++;
        sraw += bytes[index];
        data.windDetection = sraw & 0x0800 ? 1 : 0;
        var sval = sraw & 0x07ff;
        if (sval === 0x7ff) data.windSpeedStatus = 'Unknown';
        else if (sval === 0x7fe) data.windSpeedStatus = 'Overflow';
        else data.windSpeedKmh = round(sval * 0.1, 1);
      } else if (type === 0x12) {
        // Wind (variation angle + speed + absolute angle)
        index++;
        var wraw = bytes[index] * 256;
        index++;
        wraw += bytes[index];
        var varRange = (wraw & 0xf000) / 4096;
        if (varRange === 0xf) data.variationAngleStatus = 'Unknown';
        else if (varRange === 0xe) data.variationAngleStatus = 'Overflow';
        else data.variationAngle = round(11.25 * varRange, 2);
        data.windDetection = wraw & 0x0800 ? 1 : 0;
        var wval = wraw & 0x07ff;
        if (wval === 0x7ff) data.windSpeedStatus = 'Unknown';
        else if (wval === 0x7fe) data.windSpeedStatus = 'Overflow';
        else data.windSpeedKmh = round(wval * 0.1, 1);
        index++;
        if (bytes[index] === 0xff) data.absoluteAngleStatus = 'Unknown';
        else data.absoluteAngle = round(bytes[index] * 2.5, 1);
      } else if (type === 0x13) {
        // Rainfall
        index++;
        var rraw = bytes[index] * 256;
        index++;
        rraw += bytes[index];
        data.rainDetection = rraw & 0x8000 ? 1 : 0;
        data.rainCounterOverflow = rraw & 0x4000 ? 1 : 0;
        var rval = rraw & 0x3fff;
        if (rval === 0x3fff) data.rainAmountStatus = 'Unknown';
        else data.rainAmount = round(rval * 0.1, 1);
      } else if (type === 0x14) {
        // 6-axis sensor flags
        index++;
        var ax = bytes[index];
        data.accX = !!(ax & 0x01);
        data.accY = !!(ax & 0x02);
        data.accZ = !!(ax & 0x04);
        data.gyrX = !!(ax & 0x08);
        data.gyrY = !!(ax & 0x10);
        data.gyrZ = !!(ax & 0x20);
      } else if (type === 0x15) {
        // Window state
        index++;
        var ws = bytes[index];
        if (ws < 100) data.windowState = ws;
        else if (ws === 255) data.windowState = 'Tilted';
        else data.windowState = 'Undefined';
      } else if (type === 0x16) {
        index++;
        data.situation = bytes[index];
      } else if (type === 0x17) {
        // UV index
        data.uvIndex = bytes[++index];
      } else if (type === 0x18) {
        // UV-A
        data.uvA = round(((bytes[++index] << 24) | (bytes[++index] << 16) | (bytes[++index] << 8) | bytes[++index]) / 1000000, 6);
      } else if (type === 0x19) {
        // UV-B
        data.uvB = round(((bytes[++index] << 24) | (bytes[++index] << 16) | (bytes[++index] << 8) | bytes[++index]) / 1000000, 6);
      } else if (type === 0x1a) {
        // UV-C
        data.uvC = round(((bytes[++index] << 24) | (bytes[++index] << 16) | (bytes[++index] << 8) | bytes[++index]) / 1000000, 6);
      } else if (type === 0x1b) {
        // Irradiance
        var irr = (bytes[++index] << 8) | bytes[++index];
        if (irr === 0xffff) irr = 0;
        data.irradiance = round(irr / 10, 1);
      } else {
        parserError = true;
      }
    } while (++index < bytes.length && !parserError);
  }

  if (parserError) {
    return { errors: ['Data Type Failure --> Please update your payload parser'] };
  }

  // Resolve temperatures. The TH module (0x03) owns air.temperature when
  // present; otherwise the first standalone probe does. Any probes that do not
  // claim air.temperature are preserved as camelCase extras: a lone probe is
  // `temperatureSensor` (upstream's naming), multiples are temperatureT1..Tn.
  if (thTemp !== undefined) {
    if (thTemp.value !== undefined) air.temperature = thTemp.value;
    else data.temperatureStatus = thTemp.status;
  }
  // Index of the probe (if any) that is promoted to air.temperature.
  var promoted = thTemp === undefined && probeTemps.length > 0 ? 0 : -1;
  for (var pi = 0; pi < probeTemps.length; pi++) {
    var pt = probeTemps[pi];
    if (pi === promoted) {
      if (pt.value !== undefined) air.temperature = pt.value;
      else data.temperatureStatus = pt.status;
      continue;
    }
    var extraKey = probeTemps.length === 1 ? 'temperatureSensor' : 'temperatureT' + (pi + 1);
    if (pt.value !== undefined) data[extraKey] = pt.value;
    else data[extraKey + 'Status'] = pt.status;
  }

  if (motion.detected !== undefined) {
    data.action = { motion: motion };
  }
  for (var k in air) {
    if (air.hasOwnProperty(k)) {
      data.air = air;
      break;
    }
  }

  if (warnings.length) return { data: data, warnings: warnings };
  return { data: data };
}

function lpad2(n) {
  var s = String(n);
  return s.length >= 2 ? s : '0' + s;
}

function putChannel(data, base, ch, value) {
  var key = ch === 0 ? base : base + (ch + 1);
  data[key] = value;
}
