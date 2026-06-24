// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for MCCI Model 4931 (Maple Sugarbush Monitor — an
// outdoor environmental / weather node: BME280-class air temperature, relative
// humidity and barometric pressure, plus a number of sugarbush-specific probes
// — one-wire tree temperatures, soil moisture/temperature, tree (xylem)
// pressures, sap-flow and rain pulse counters, an SD-card logger status, and
// battery / bus voltages).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format (MCCI Model 4931 flag-bitmap record: ports 1 and 4, uplink format
// 0x37, with TWO flag bytes) understood with reference to the upstream
// Apache-2.0 decoder (TheThingsNetwork/lorawan-devices
// vendor/mcci/codec-model4931.js, attributed in NOTICE). Author the
// normalization here; do NOT copy upstream normalizeUplink.
//
// Mapping notes:
//   t  -> air.temperature (degC; signed 16-bit count, LSB = 1/256 degC)
//   rh -> air.relativeHumidity (%; unsigned 16-bit, full-scale 65535 = 100%)
//   p  -> air.pressure (hPa). ATMOSPHERIC: the device reports station
//         barometric pressure (unsigned 16-bit, LSB = 4 Pa -> hPa), which lands
//         in the ~900-1100 hPa range, so it maps straight to the vocabulary
//         air.pressure.
//   vBat -> battery (V; signed 16-bit count, LSB = 1/4096 V). The device already
//         reports volts, so it maps straight to the vocabulary battery (no
//         percent issue).
// This device has NO ambient-light / lux channel, so air.lightIntensity is not
// emitted. The secondary bus rail (vBus) and the boot/reset counter are genuine
// device diagnostics with no vocabulary home, emitted as camelCase extras
// (vBus, boot), as are the SD-card logger status (sdCardPresent /
// sdCardWriteOk), one-wire probe temperatures (tProbeOne / tProbeTwo, degC),
// soil channels (soilOne / soilTwo: temperature degC, moisture %, type code),
// xylem/tree pressure sensors (treePressureOne / treePressureTwo, with their
// raw mV), sap-flow and rain pulse counters and per-hour rates, and the network
// timestamp (timeType / time). Derived upstream values that are not direct
// measurements (dew point tDew, heat index tHeatIndexC) are dropped from the
// normalized output. Port 3 carries downlink command responses (not sensor
// telemetry) and is not decoded here.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function u16(bytes, i) {
  return ((bytes[i] << 8) + bytes[i + 1]) & 0xffff;
}

function i16(bytes, i) {
  var v = u16(bytes, i);
  return v > 0x7fff ? v - 0x10000 : v;
}

function u32(bytes, i) {
  return (
    (bytes[i] * 0x1000000) +
    (bytes[i + 1] << 16) +
    (bytes[i + 2] << 8) +
    bytes[i + 3]
  );
}

// UFLT16: 4-bit exponent, 12-bit mantissa (mantissa is a fraction of 4096).
function uflt16(raw) {
  var exp = raw >> 12;
  var mant = (raw & 0xfff) / 4096.0;
  return mant * Math.pow(2, exp - 15);
}

function need(bytes, i, n) {
  return bytes.length - i >= n;
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;
  var port = input.fPort;

  if (!bytes || bytes.length < 1) {
    return { errors: ['empty payload'] };
  }
  // Ports 1 and 4 carry sensor telemetry; port 3 is downlink responses.
  if (port !== 1 && port !== 4) {
    return { errors: ['unsupported fPort ' + port] };
  }

  var format = bytes[0];
  if (format !== 0x37) {
    return { errors: ['unsupported uplink format 0x' + format.toString(16)] };
  }
  if (bytes.length < 3) {
    return { errors: ['payload too short for format + status + flag bytes'] };
  }

  var data = {};
  var air = {};
  var i = 1;
  var hasField = false;

  // SD-card logger status (2-bit code): bit 0 = card present, bit 1 = last
  // write succeeded. Vendor diagnostic extras.
  var sdCardStatus = bytes[i];
  i += 1;
  data.sdCardPresent = (sdCardStatus & 0x1) !== 0;
  data.sdCardWriteOk = (sdCardStatus & 0x2) !== 0;

  // First flag bitmap.
  var flags = bytes[i];
  i += 1;

  // bit 0x01: battery rail (signed 16-bit count, LSB = 1/4096 V). Already volts.
  if (flags & 0x01) {
    if (!need(bytes, i, 2)) {
      return { errors: ['payload truncated reading battery'] };
    }
    data.battery = round(i16(bytes, i) / 4096.0, 4);
    i += 2;
    hasField = true;
  }

  // bit 0x02: bus / secondary rail (vBus). Diagnostic extra.
  if (flags & 0x02) {
    if (!need(bytes, i, 2)) {
      return { errors: ['payload truncated reading vBus'] };
    }
    data.vBus = round(i16(bytes, i) / 4096.0, 4);
    i += 2;
    hasField = true;
  }

  // bit 0x04: boot/reset counter. Diagnostic extra.
  if (flags & 0x04) {
    if (!need(bytes, i, 1)) {
      return { errors: ['payload truncated reading boot'] };
    }
    data.boot = bytes[i];
    i += 1;
    hasField = true;
  }

  // bit 0x08: environment block — air temperature and relative humidity.
  // (Upstream also derives dew point and heat index here; both are dropped.)
  if (flags & 0x08) {
    if (!need(bytes, i, 4)) {
      return { errors: ['payload truncated reading environment block'] };
    }
    air.temperature = round(i16(bytes, i) / 256, 4);
    i += 2;
    air.relativeHumidity = round((u16(bytes, i) * 100) / 65535.0, 4);
    i += 2;
    hasField = true;
  }

  // bit 0x10: barometric (atmospheric) pressure — U16, LSB = 4 Pa -> hPa.
  if (flags & 0x10) {
    if (!need(bytes, i, 2)) {
      return { errors: ['payload truncated reading pressure'] };
    }
    air.pressure = round((u16(bytes, i) * 4) / 100.0, 2);
    i += 2;
    hasField = true;
  }

  // bit 0x20: one-wire probe temperature #1 (signed 16-bit, LSB = 1/256 degC).
  // A secondary probe, not the primary air sensor -> diagnostic extra.
  if (flags & 0x20) {
    if (!need(bytes, i, 2)) {
      return { errors: ['payload truncated reading probe temperature one'] };
    }
    data.tProbeOne = round(i16(bytes, i) / 256, 4);
    i += 2;
    hasField = true;
  }

  // bit 0x40: one-wire probe temperature #2. Diagnostic extra.
  if (flags & 0x40) {
    if (!need(bytes, i, 2)) {
      return { errors: ['payload truncated reading probe temperature two'] };
    }
    data.tProbeTwo = round(i16(bytes, i) / 256, 4);
    i += 2;
    hasField = true;
  }

  // bit 0x80: soil channel #1 (temperature degC LSB 1/100, volumetric moisture
  // % LSB 1/100, sensor type code). Sugarbush soil probe -> extra.
  if (flags & 0x80) {
    if (!need(bytes, i, 6)) {
      return { errors: ['payload truncated reading soil block one'] };
    }
    data.soilOne = {
      temperature: round(i16(bytes, i) / 100.0, 4),
      moisture: round(u16(bytes, i + 2) / 100.0, 4),
      type: u16(bytes, i + 4)
    };
    i += 6;
    hasField = true;
  }

  // Second flag bitmap.
  if (!need(bytes, i, 1)) {
    return { errors: ['payload truncated reading second flag byte'] };
  }
  var flags2 = bytes[i];
  i += 1;

  // bit 0x01: soil channel #2. Extra.
  if (flags2 & 0x01) {
    if (!need(bytes, i, 6)) {
      return { errors: ['payload truncated reading soil block two'] };
    }
    data.soilTwo = {
      temperature: round(i16(bytes, i) / 100.0, 4),
      moisture: round(u16(bytes, i + 2) / 100.0, 4),
      type: u16(bytes, i + 4)
    };
    i += 6;
    hasField = true;
  }

  // bit 0x02: xylem/tree pressure sensor #2 (raw rail volts, then a derived
  // pressure value via the device's linear calibration). Extra.
  if (flags2 & 0x02) {
    if (!need(bytes, i, 2)) {
      return { errors: ['payload truncated reading tree pressure two'] };
    }
    var p2mV = round(i16(bytes, i) / 4096.0, 4);
    i += 2;
    data.treePressureTwo = {
      mV: p2mV,
      value: round(750 * p2mV - 1375, 4)
    };
    hasField = true;
  }

  // bit 0x04: xylem/tree pressure sensor #1. Extra.
  if (flags2 & 0x04) {
    if (!need(bytes, i, 2)) {
      return { errors: ['payload truncated reading tree pressure one'] };
    }
    var p1mV = round(i16(bytes, i) / 4096.0, 4);
    i += 2;
    data.treePressureOne = {
      mV: p1mV,
      value: round(750 * p1mV - 1375, 4)
    };
    hasField = true;
  }

  // bit 0x08: sap-flow counter (cumulative pulses) + UFLT16 flow rate, scaled
  // to gallons-per-tap-per-hour by the device's pulse normalization. Extras.
  if (flags2 & 0x08) {
    if (!need(bytes, i, 4)) {
      return { errors: ['payload truncated reading sap flow block'] };
    }
    data.sapPulseCount = u16(bytes, i);
    i += 2;
    data.sapPerHour = round(uflt16(u16(bytes, i)) * 60 * 60 * 4, 4);
    i += 2;
    hasField = true;
  }

  // bit 0x10: rain pulse counter + UFLT16 rain rate (same pulse normalization).
  // Extras (the vocabulary rain.* keys are mm/mm-per-hour, not raw pulses).
  if (flags2 & 0x10) {
    if (!need(bytes, i, 4)) {
      return { errors: ['payload truncated reading rain block'] };
    }
    data.rainPulseCount = u16(bytes, i);
    i += 2;
    data.rainPerHour = round(uflt16(u16(bytes, i)) * 60 * 60 * 4, 4);
    i += 2;
    hasField = true;
  }

  // bit 0x20: network/boot timestamp (U32, low bit = time source). Extra.
  if (flags2 & 0x20) {
    if (!need(bytes, i, 4)) {
      return { errors: ['payload truncated reading timestamp'] };
    }
    var timestamp = u32(bytes, i);
    i += 4;
    data.timeType = (timestamp & 1) ? 'network' : 'boot';
    timestamp = (Math.floor(timestamp / 2)) * 2;
    // GPS epoch -> POSIX (+315964800), minus 17 leap seconds, to RFC3339.
    var posixSeconds = timestamp + 315964800 - 17;
    data.time = new Date(posixSeconds * 1000).toISOString();
    hasField = true;
  }

  var hasAir = false;
  var ak;
  for (ak in air) {
    if (air.hasOwnProperty(ak)) {
      hasAir = true;
    }
  }
  if (hasAir) {
    data.air = air;
  }

  if (!hasField) {
    return { errors: ['no sensor fields present in payload'] };
  }
  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "mcci";
    result.data.model = "model4931";
  }
  return result;
}
