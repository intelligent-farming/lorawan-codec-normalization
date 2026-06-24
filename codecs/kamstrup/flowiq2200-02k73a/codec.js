// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for kamstrup/flowiq2200-02k73a (Kamstrup flowIQ 2200
// water meter — OMS / wM-Bus payload over LoRaWAN, EN 13757-3 application layer).
//
// Ported from the upstream Apache-2.0 reference decoder
// (TheThingsNetwork/lorawan-devices vendor/kamstrup/mbusparser.js, attributed in
// NOTICE). The M-Bus TPL header skip, DIF/VIF parsing, Type A/B/C/D/F/G/I data
// conversion, Inverse Compact Profile expansion and `normalize()` scaling below
// mirror the upstream parser faithfully; the normalization to the shared
// vocabulary is authored here and the upstream output shape is NOT copied.
//
// Wire format: M-Bus frame. TPL header (CI 0x78 none / 0x7A short / 0x72 long)
// is skipped; TPL encryption (security mode != 0) is rejected. The APL is a
// sequence of M-Bus data records (DIF [+DIFE] / VIF [+VIFE] / data). Supported
// VIFs: Volume (m^3), Volume flow (m^3/h), Flow temperature (C), External
// temperature (C), Date/time, manufacturer-specific Infocode / ALD / config.
// Inverse Compact Profile records expand to a series of historical volumes.
//
// Normalization (shared vocabulary):
//   Volume record (m^3)            -> metering.water.total (L; m^3 x 1000),
//                                     newest reading at top level, older readings
//                                     in history[] (each with RFC3339 time)
//   Flow temperature, instantaneous (C) -> water.temperature.current
//   Volume flow / flow-temp min-max / external temp / ALD / config / infocodes
//                                  -> camelCase extras
//   Infocode bit "Low Battery"     -> extra infoLowBattery (no battery voltage is
//                                     present in the M-Bus payload, so `battery`
//                                     is not emitted)

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

// Primary VIF table (Table 10, EN 13757-3:2018). resolution is the scale applied
// to the raw integer to obtain the value in `unit`.
var PRI_VIF_TABLE = {
  0x10: { type: 'Volume', unit: 'm3', resolution: 1e-6, conv: 'B' },
  0x11: { type: 'Volume', unit: 'm3', resolution: 1e-5, conv: 'B' },
  0x12: { type: 'Volume', unit: 'm3', resolution: 1e-4, conv: 'B' },
  0x13: { type: 'Volume', unit: 'm3', resolution: 1e-3, conv: 'B' },
  0x14: { type: 'Volume', unit: 'm3', resolution: 1e-2, conv: 'B' },
  0x15: { type: 'Volume', unit: 'm3', resolution: 1e-1, conv: 'B' },
  0x16: { type: 'Volume', unit: 'm3', resolution: 1e-0, conv: 'B' },
  0x17: { type: 'Volume', unit: 'm3', resolution: 1e+1, conv: 'B' },
  0x38: { type: 'Volume flow', unit: 'm3/h', resolution: 1e-6, conv: 'B' },
  0x39: { type: 'Volume flow', unit: 'm3/h', resolution: 1e-5, conv: 'B' },
  0x3a: { type: 'Volume flow', unit: 'm3/h', resolution: 1e-4, conv: 'B' },
  0x3b: { type: 'Volume flow', unit: 'm3/h', resolution: 1e-3, conv: 'B' },
  0x3c: { type: 'Volume flow', unit: 'm3/h', resolution: 1e-2, conv: 'B' },
  0x3d: { type: 'Volume flow', unit: 'm3/h', resolution: 1e-1, conv: 'B' },
  0x3e: { type: 'Volume flow', unit: 'm3/h', resolution: 1e-0, conv: 'B' },
  0x3f: { type: 'Volume flow', unit: 'm3/h', resolution: 1e+1, conv: 'B' },
  0x58: { type: 'Flow temperature', unit: 'C', resolution: 1e-3, conv: 'B' },
  0x59: { type: 'Flow temperature', unit: 'C', resolution: 1e-2, conv: 'B' },
  0x5a: { type: 'Flow temperature', unit: 'C', resolution: 1e-1, conv: 'B' },
  0x5b: { type: 'Flow temperature', unit: 'C', resolution: 1e-0, conv: 'B' },
  0x64: { type: 'External temperature', unit: 'C', resolution: 1e-3, conv: 'B' },
  0x65: { type: 'External temperature', unit: 'C', resolution: 1e-2, conv: 'B' },
  0x66: { type: 'External temperature', unit: 'C', resolution: 1e-1, conv: 'B' },
  0x67: { type: 'External temperature', unit: 'C', resolution: 1e-0, conv: 'B' },
  0x6c: { type: 'Date/time', unit: 'NA', resolution: 1, conv: 'G' },
  0x6d: { type: 'Date/time', unit: 'NA', resolution: 1, conv: 'F/J/I/M' }
};

// Manufacturer-specific VIFE (preceded by 0xFF).
var MANU_VIFE_TABLE = {
  0x25: { type: 'Infocode', unit: 'NA', resolution: 1, conv: 'D' },
  0x1c: { type: 'ALD last day', unit: 'NA', resolution: 1, conv: 'C' },
  0x16: { type: 'Module type/config number', unit: 'NA', resolution: 1, conv: 'C' },
  0x1b: { type: 'ALD', unit: 'NA', resolution: 1, conv: 'C' }
};

// Orthogonal VIFE (Table 15, EN 13757-3:2018).
var ORTHO_VIFE_TABLE = { 0x13: 'Inverse Compact Profile', 0x3c: 'Reverse' };

// Manufacturer infocode bit positions -> camelCase extra key.
var INFOCODE_KEYS = {
  0: 'infoDry',
  1: 'infoReverse',
  2: 'infoLeak',
  3: 'infoBurst',
  4: 'infoTamper',
  5: 'infoLowBattery',
  6: 'infoLowAmbientTemperature',
  7: 'infoHighAmbientTemperature'
};

function readUIntLE(buffer, offset, byteLength) {
  var value = 0;
  for (var i = 0; i < byteLength; i++) {
    value |= buffer[offset + i] << (8 * i);
  }
  return value >>> 0;
}

function readIntLE(buffer, offset, byteLength) {
  var value = readUIntLE(buffer, offset, byteLength);
  var maxVal = 1 << (8 * byteLength - 1);
  return value & maxVal ? value - (1 << (8 * byteLength)) : value;
}

// Type A — packed BCD, little endian.
function typeA(buffer, idx, size) {
  var result = 0;
  var multiplier = 1;
  for (var j = idx; j < idx + size; j++) {
    var lsb = buffer[j] & 0xf;
    var msb = (buffer[j] >> 4) & 0xf;
    if (lsb > 9 || msb > 9) {
      return undefined;
    }
    result += lsb * multiplier;
    result += msb * multiplier * 10;
    multiplier *= 100;
  }
  return result;
}

// Type B — signed binary integer; all-ones-with-sign-bit pattern means invalid.
function typeB(buffer, idx, size) {
  var invalidValues = { 1: -0x80, 2: -0x8000, 3: -0x800000, 4: -0x80000000, 6: -0x800000000000 };
  var result = readIntLE(buffer, idx, size);
  if (result === invalidValues[size]) {
    result = undefined;
  }
  return result;
}

// Type C — unsigned binary integer; all-ones pattern means invalid.
function typeC(buffer, idx, size) {
  var invalidValues = { 1: 0xff, 2: 0xffff, 3: 0xffffff, 4: 0xffffffff, 6: 0xffffffffffff };
  var result = readUIntLE(buffer, idx, size);
  if (result === invalidValues[size]) {
    result = undefined;
  }
  return result;
}

// Type D — raw unsigned (boolean array / bitfield).
function typeD(buffer, idx, size) {
  return readUIntLE(buffer, idx, size);
}

// Type F — date+time (CP32). Returns epoch ms (UTC) or undefined if invalid.
function typeF(buffer, idx, size) {
  var data = readUIntLE(buffer, idx, size);
  if ((data & 0x00000080) !== 0) {
    return undefined;
  }
  var minutes = data & 0x0000003f;
  var hours = (data >> 8) & 0x0000001f;
  var days = (data >> 16) & 0x0000001f;
  var months = (data >> 24) & 0x0000000f;
  var years = (data >> 21) & 0x00000007;
  years += ((data >> 28) & 0x0000000f) << 3;
  var hYears = (data >> 13) & 0x00000003;
  years += 1900 + hYears * 100;
  return Date.UTC(years, months - 1, days, hours, minutes);
}

// Type G — date (CP16). Returns epoch ms (UTC) or undefined if invalid.
function typeG(buffer, idx, size) {
  var data = readUIntLE(buffer, idx, size);
  if (data === 0xffff) {
    return undefined;
  }
  var days = (data >> 0) & 0x001f;
  var months = (data >> 8) & 0x000f;
  var years = 2000 + ((data >> 5) & 0x0007);
  years += ((data >> 12) & 0x000f) << 3;
  return Date.UTC(years, months - 1, days);
}

// Type I — date+time (CP48). Returns epoch ms (UTC) or undefined if invalid.
function typeI(buffer, idx, size) {
  if ((buffer[idx + 1] & 0x80) !== 0) {
    return undefined;
  }
  var seconds = buffer[idx] & 0x3f;
  var minutes = buffer[idx + 1] & 0x3f;
  var hours = buffer[idx + 2] & 0x1f;
  var days = buffer[idx + 3] & 0x1f;
  var months = buffer[idx + 4] & 0xf;
  var years = (buffer[idx + 3] >> 5) & 0x7;
  years += ((buffer[idx + 4] >> 4) & 0xf) << 3;
  years += 2000;
  return Date.UTC(years, months - 1, days, hours, minutes, seconds);
}

// Parse the Value Information Block. Returns null on unsupported VIF.
function parseVIB(vibArray) {
  var vib;
  if (vibArray[0] === 0xff) {
    if (vibArray[1] in MANU_VIFE_TABLE) {
      var m = MANU_VIFE_TABLE[vibArray[1]];
      vib = { type: m.type, unit: m.unit, resolution: m.resolution, conv: m.conv, orthoVife: 'NA' };
    } else {
      return null;
    }
  } else if ((vibArray[0] & 0x7f) in PRI_VIF_TABLE) {
    var p = PRI_VIF_TABLE[vibArray[0] & 0x7f];
    vib = { type: p.type, unit: p.unit, resolution: p.resolution, conv: p.conv };
    if ((vibArray[0] & 0x80) !== 0) {
      if (vibArray[1] in ORTHO_VIFE_TABLE) {
        vib.orthoVife = ORTHO_VIFE_TABLE[vibArray[1]];
      } else {
        return null;
      }
    } else {
      vib.orthoVife = 'NA';
    }
  } else {
    return null;
  }
  vib.isProfileData = vib.orthoVife === 'Inverse Compact Profile';
  return vib;
}

// Inverse Compact Profile (Annex F): a packed series of delta/absolute values.
function inverseCompactProfile(buffer, idx, size) {
  var result = { profileValues: [] };
  var spacingControl = buffer[idx];
  idx++;
  result.spacingValue = buffer[idx];
  idx++;
  var elementSize = spacingControl & 0x0f;
  result.spacingUnit = (spacingControl >> 4) & 0x03;
  result.incMode = (spacingControl >> 6) & 0x03;
  if (elementSize < 1 || elementSize > 4 || result.incMode === 0) {
    return null;
  }
  for (var k = 0; k < size - 2; k += elementSize) {
    if (result.incMode === 0x3) {
      result.profileValues.push(typeB(buffer, idx, elementSize));
    } else {
      result.profileValues.push(typeC(buffer, idx, elementSize));
    }
    idx += elementSize;
  }
  return result;
}

// Step a profile timestamp backwards by one spacing interval (Annex F).
function getNextTimestamp(date, spacingUnit, spacingValue) {
  if (spacingValue > 0 && spacingValue < 251) {
    if (spacingUnit === 0) {
      date.setUTCSeconds(date.getUTCSeconds() - spacingValue);
    } else if (spacingUnit === 1) {
      date.setUTCMinutes(date.getUTCMinutes() - spacingValue);
    } else if (spacingUnit === 2) {
      date.setUTCHours(date.getUTCHours() - spacingValue);
    } else if (spacingUnit === 3) {
      date.setUTCDate(date.getUTCDate() - spacingValue);
    }
  } else if (spacingValue === 254 && spacingUnit === 3) {
    date.setUTCMonth(date.getUTCMonth() - 1);
  } else if (spacingValue === 254 && spacingUnit === 2) {
    date.setUTCMonth(date.getUTCMonth() - 3);
  } else if (spacingValue === 254 && spacingUnit === 1) {
    date.setUTCMonth(date.getUTCMonth() - 6);
  } else {
    return false;
  }
  return true;
}

// Apply the VIF scale; round to 10 decimals to kill float noise (matches upstream).
function normalize(number, resolution) {
  return Math.round(number * resolution * 1e10) / 1e10;
}

// RFC3339 timestamp (UTC) from epoch ms.
function rfc3339(ms) {
  return new Date(ms).toISOString();
}

function decodeUplinkCore(input) {
  var raw = input.bytes;
  var i = 0;

  if (!raw || raw.length < 1) {
    return { errors: ['Invalid uplink payload: Could not retrieve CI field'] };
  }

  // ---- TPL header (EN 13757-7) ----
  var CI = raw[i];
  i++;
  if (CI === 0x7a) {
    // Short data header: ACC, STS, 2-byte config field.
    if (raw.length < i + 4) {
      return { errors: ['Invalid uplink payload: Could not retrieve TPL layer'] };
    }
    i += 2;
    var cfgShort = raw[i] | (raw[i + 1] << 8);
    i += 2;
    if ((cfgShort & 0x1f00) !== 0x0) {
      return { errors: ['Invalid uplink payload: MBus TPL encryption is not supported'] };
    }
  } else if (CI === 0x72) {
    // Long data header: IdentNo, Manu, Ver, DevType, ACC, STS, 2-byte config field.
    if (raw.length < i + 12) {
      return { errors: ['Invalid uplink payload: Could not retrieve TPL layer'] };
    }
    i += 10;
    var cfgLong = raw[i] | (raw[i + 1] << 8);
    i += 2;
    if ((cfgLong & 0x1f00) !== 0x0) {
      return { errors: ['Invalid uplink payload: MBus TPL encryption is not supported'] };
    }
  } else if (CI === 0x78) {
    // No data header.
  } else {
    return { errors: ['Invalid uplink payload: Invalid CI in TPL layer'] };
  }

  // ---- APL: sequence of M-Bus data records (EN 13757-3) ----
  var records = [];
  var temp;
  while (i < raw.length) {
    temp = raw[i];
    i++;
    if (temp === 0x2f) {
      continue; // filler byte
    }
    if (temp === 0x0f || temp === 0x1f || temp === 0x7f) {
      return { errors: ['Invalid uplink payload: Unsupported special DIF function'] };
    }

    // DIB
    var rec = { datafield: temp & 0xf, storagenumber: (temp & 0x40) >> 6, functionfield: (temp & 0x30) >> 4 };
    var snBitShift = 1;
    while ((temp & 0x80) !== 0 && i < raw.length) {
      temp = raw[i];
      i++;
      rec.storagenumber += (temp & 0xf) << snBitShift;
      snBitShift += 4;
    }

    // VIB
    temp = raw[i];
    i++;
    var vibBytes = [temp];
    while ((temp & 0x80) !== 0 && i < raw.length) {
      temp = raw[i];
      i++;
      vibBytes.push(temp);
    }
    rec.vib = parseVIB(vibBytes);
    if (rec.vib === null) {
      return { errors: ['Invalid uplink payload: Unsupported VIB'] };
    }

    // Data field size from DIF datafield code.
    var sizeByte = 0;
    var bcd = false;
    var lvar = false;
    var df = rec.datafield;
    if (df === 0x0 || df === 0x8) {
      sizeByte = 0;
    } else if (df === 0x9) {
      bcd = true;
      sizeByte = 1;
    } else if (df === 0x1) {
      sizeByte = 1;
    } else if (df === 0xa) {
      bcd = true;
      sizeByte = 2;
    } else if (df === 0x2) {
      sizeByte = 2;
    } else if (df === 0xb) {
      bcd = true;
      sizeByte = 3;
    } else if (df === 0x3) {
      sizeByte = 3;
    } else if (df === 0xc) {
      bcd = true;
      sizeByte = 4;
    } else if (df === 0x4 || df === 0x5) {
      sizeByte = 4;
    } else if (df === 0xe) {
      bcd = true;
      sizeByte = 6;
    } else if (df === 0x6) {
      sizeByte = 6;
    } else if (df === 0x7) {
      sizeByte = 8;
    } else if (df === 0xd) {
      sizeByte = 1;
      lvar = true;
    }

    if (raw.length < i + sizeByte || sizeByte > 6) {
      return { errors: ['Invalid uplink payload: Not enough bytes for datafield or datafield is larger than 6 bytes'] };
    }

    if (!lvar) {
      if (bcd) {
        rec.data = typeA(raw, i, sizeByte);
      } else if (rec.vib.conv === 'C') {
        rec.data = typeC(raw, i, sizeByte);
      } else if (rec.vib.conv === 'B') {
        rec.data = typeB(raw, i, sizeByte);
      } else if (rec.vib.conv === 'D') {
        rec.data = typeD(raw, i, sizeByte);
      } else if (rec.vib.conv === 'G') {
        rec.data = typeG(raw, i, sizeByte);
      } else if (rec.vib.conv === 'F/J/I/M') {
        if (sizeByte === 4) {
          rec.data = typeF(raw, i, sizeByte);
        } else if (sizeByte === 6) {
          rec.data = typeI(raw, i, sizeByte);
        }
      }
      i += sizeByte;
    } else {
      var nbBytes = raw[i];
      i++;
      if (raw.length < i + nbBytes || nbBytes < 3) {
        return { errors: ['Invalid uplink payload: Not enough bytes for LVAR'] };
      }
      if (!rec.vib.isProfileData) {
        return { errors: ['Invalid uplink payload: LVAR that is not Inverse Compact Profile is not supported'] };
      }
      rec.profileData = inverseCompactProfile(raw, i, nbBytes);
      i += nbBytes;
      if (rec.profileData === null) {
        return { errors: ['Invalid uplink payload: Could not parse Inverse Compact Profile'] };
      }
    }
    records.push(rec);
  }

  // Prefix orthogonal VIFE + function field onto the record type label.
  var l;
  for (l = 0; l < records.length; l++) {
    var v = records[l].vib;
    if (v.orthoVife !== 'NA' && v.orthoVife !== 'Inverse Compact Profile') {
      v.type = v.orthoVife + ' ' + v.type;
    }
    var ff = records[l].functionfield;
    if (ff === 0x1) {
      v.type = 'Max ' + v.type;
    } else if (ff === 0x2) {
      v.type = 'Min ' + v.type;
    } else if (ff === 0x3) {
      v.type = 'Error state ' + v.type;
    }
  }

  // Map timestamps by storage number.
  var timestamps = {};
  var k;
  for (k = 0; k < records.length; k++) {
    if (records[k].vib.type === 'Date/time' && records[k].data !== undefined) {
      timestamps[records[k].storagenumber] = records[k].data;
    }
  }

  // ---- Normalize ----
  var out = {};
  var volumeReadings = []; // { time, total } in litres
  var p;
  for (p = 0; p < records.length; p++) {
    var r = records[p];
    var vib = r.vib;
    var sn = r.storagenumber;
    var tsMs = sn in timestamps ? timestamps[sn] : undefined;

    if (vib.type === 'Date/time') {
      continue;
    }

    // Infocode may carry a Min/Max function-field prefix on its type label.
    if (vib.type.indexOf('Infocode') !== -1 && r.data !== undefined) {
      for (var bit = 0; bit < 8; bit++) {
        out[INFOCODE_KEYS[bit]] = (r.data & (1 << bit)) !== 0;
      }
      continue;
    }

    if (vib.isProfileData) {
      // Expand profile against its matching base record (same type/unit/resolution/storage).
      var base = null;
      var b;
      for (b = 0; b < records.length; b++) {
        var cand = records[b];
        if (cand.vib.type === vib.type && cand.vib.unit === vib.unit && cand.storagenumber === sn &&
            cand.vib.resolution === vib.resolution && cand.vib.isProfileData !== true) {
          base = cand;
          break;
        }
      }
      if (base === null || base.data === undefined) {
        return { errors: ['Invalid uplink payload: Could not find base value for profile data'] };
      }
      if (!(sn in timestamps)) {
        return { errors: ['Invalid uplink payload: Could not find base time for profile data'] };
      }
      var tempVal = base.data;
      var ts = new Date(timestamps[sn]);
      var m;
      for (m = 0; m < r.profileData.profileValues.length; m++) {
        var delta = r.profileData.profileValues[m];
        var stepOk = getNextTimestamp(ts, r.profileData.spacingUnit, r.profileData.spacingValue);
        if (delta === undefined || stepOk === false || isNaN(ts.getTime())) {
          break;
        }
        if (r.profileData.incMode === 2) {
          tempVal += delta;
        } else {
          tempVal -= delta;
        }
        if (vib.type === 'Volume') {
          volumeReadings.push({ time: rfc3339(ts.getTime()), total: round(normalize(tempVal, vib.resolution) * 1000, 3) });
        }
      }
      continue;
    }

    // Regular (non-profile) value.
    var data = r.data;
    if (vib.type === 'ALD last day' && data === 4095) {
      data = undefined;
    }
    if (data === undefined) {
      continue; // invalid reading — skip
    }
    var val = normalize(data, vib.resolution);

    if (vib.type === 'Volume') {
      volumeReadings.push({ time: tsMs !== undefined ? rfc3339(tsMs) : null, total: round(val * 1000, 3) });
    } else if (vib.type === 'Flow temperature') {
      out.water = out.water || {};
      out.water.temperature = out.water.temperature || {};
      out.water.temperature.current = round(val, 3);
    } else if (vib.type === 'Min Flow temperature') {
      out.flowTemperatureMin = round(val, 3);
    } else if (vib.type === 'Max Flow temperature') {
      out.flowTemperatureMax = round(val, 3);
    } else if (vib.type === 'External temperature') {
      out.ambientTemperature = round(val, 3);
    } else if (vib.type === 'Volume flow') {
      out.volumeFlow = round(val, 6);
    } else if (vib.type === 'Min Volume flow') {
      out.volumeFlowMin = round(val, 6);
    } else if (vib.type === 'Max Volume flow') {
      out.volumeFlowMax = round(val, 6);
    } else if (vib.type === 'ALD last day') {
      out.aldLastDay = val;
    } else if (vib.type === 'ALD') {
      out.accumulatedLeakageDuration = val;
    } else if (vib.type === 'Module type/config number') {
      out.moduleConfigNumber = val;
    }
  }

  // Promote the newest volume reading to the top level; the rest become history.
  if (volumeReadings.length > 0) {
    var newestIdx = 0;
    var j;
    for (j = 1; j < volumeReadings.length; j++) {
      var aTime = volumeReadings[j].time;
      var bTime = volumeReadings[newestIdx].time;
      if (aTime !== null && (bTime === null || aTime > bTime)) {
        newestIdx = j;
      }
    }
    var newest = volumeReadings[newestIdx];
    out.metering = { water: { total: round(newest.total, 3) } };
    if (newest.time !== null) {
      out.time = newest.time;
    }
    var history = [];
    for (j = 0; j < volumeReadings.length; j++) {
      if (j === newestIdx) {
        continue;
      }
      var vr = volumeReadings[j];
      if (vr.time !== null) {
        history.push({ time: vr.time, metering: { water: { total: round(vr.total, 3) } } });
      }
    }
    if (history.length > 0) {
      out.history = history;
    }
  }

  return { data: out };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "kamstrup";
    result.data.model = "flowiq2200-02k73a";
  }
  return result;
}
