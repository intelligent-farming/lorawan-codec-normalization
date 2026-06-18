// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Thermokon Thanos EVO LRW (full-touch Room
// Operating Unit — temperature, humidity, CO2/VOC, setpoint, occupancy, fan).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format understood by faithfully porting the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/thermokon/thermokon-codec-ext.js,
// attributed in NOTICE). The upstream supports two payload shapes selected by
// fPort:
//   - fPort 4    -> "holding register" frame: repeating 2-byte big-endian
//                   register id + 2-byte big-endian value (DecodeHR).
//   - any other  -> Thermokon LPP stream: a tag (1 byte when <= 0x7F, otherwise
//                   2 bytes big-endian) followed by its value (DecodeLPPPayload).
//
// Scalings are ported verbatim from upstream:
//   LPP 0x0010 INT16  TEMP   /10  -> air.temperature
//   LPP 0x0011 INT8   RHUM   /1   -> air.relativeHumidity
//   LPP 0x0012 UINT16 CO2    /1   -> air.co2
//   LPP 0x0013 UINT16 VOC    /1   -> extra `voc`
//   LPP 0x0030 UINT16 ATM_P  /1   -> air.pressure (already hPa/mbar)
//   LPP 0x0040 UINT16 VISIBLE_LIGHT /1 -> air.lightIntensity (lux)
//   LPP 0x0041 UINT8  OCCU0: bit0 = state, bits1-7 = motion count
//   LPP 0x0054 UINT8  VBAT  x20 = mV -> battery (V, /1000)
//   LPP 0x0063 UINT8  SETPOINT /1 -> extra `setpoint`
//   LPP 0x8540 UINT16 VBAT_HI_RES (mV) -> battery (V, /1000)
//   HR  500 INT16 TEMP /10, 501 RHUM /1, 505 CO2 /1, 506 VOC /1,
//   HR  100 OCCU, 101 ECO, 103 SETPOINT INT16 /10, 104 FAN.
//
// Battery is reported in millivolts; the vocabulary `battery` is volts, so the
// millivolt value is divided by 1000. VOC/setpoint/fan/eco/occupancy-count and
// other vendor data points are emitted as camelCase extras.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function u16be(hi, lo) {
  return ((hi << 8) | lo) & 0xffff;
}

function s16be(hi, lo) {
  var v = u16be(hi, lo);
  return v > 0x7fff ? v - 0x10000 : v;
}

function s8(v) {
  v = v & 0xff;
  return v > 0x7f ? v - 0x100 : v;
}

// Apply a single decoded raw point onto the normalized accumulators.
// `acc` carries air/data/motion objects and the haveAir/haveMotion flags.
function applyTemp(acc, raw) {
  acc.air.temperature = round(raw / 10, 1);
  acc.haveAir = true;
}

function applyRhum(acc, raw) {
  acc.air.relativeHumidity = raw;
  acc.haveAir = true;
}

function applyCo2(acc, raw) {
  acc.air.co2 = raw;
  acc.haveAir = true;
}

function applyPressure(acc, raw) {
  acc.air.pressure = raw;
  acc.haveAir = true;
}

function applyLight(acc, raw) {
  acc.air.lightIntensity = raw;
  acc.haveAir = true;
}

function applyOccupancy(acc, state, count) {
  acc.motion.detected = state === 1;
  acc.motion.count = count;
  acc.haveMotion = true;
}

function applyBatteryMv(acc, mv) {
  acc.data.battery = round(mv / 1000, 3);
}

// Decode the Thermokon LPP stream (DecodeLPPPayload, ported faithfully).
function decodeLpp(bytes, acc) {
  var i = 0;
  while (i < bytes.length) {
    var tag;
    if (bytes[i] <= 0x7f) {
      tag = bytes[i];
      i += 1;
    } else {
      if (i + 1 >= bytes.length) {
        return 'truncated identifier at offset ' + i;
      }
      tag = ((bytes[i] << 8) | bytes[i + 1]) & 0xffff;
      i += 2;
    }

    if (tag === 0x0010) {
      if (i + 1 >= bytes.length) {
        return 'truncated temperature value at offset ' + i;
      }
      applyTemp(acc, s16be(bytes[i], bytes[i + 1]));
      acc.recognized = true;
      i += 2;
    } else if (tag === 0x0011) {
      if (i >= bytes.length) {
        return 'truncated humidity value at offset ' + i;
      }
      applyRhum(acc, s8(bytes[i]));
      acc.recognized = true;
      i += 1;
    } else if (tag === 0x0012) {
      if (i + 1 >= bytes.length) {
        return 'truncated CO2 value at offset ' + i;
      }
      applyCo2(acc, u16be(bytes[i], bytes[i + 1]));
      acc.recognized = true;
      i += 2;
    } else if (tag === 0x0013) {
      if (i + 1 >= bytes.length) {
        return 'truncated VOC value at offset ' + i;
      }
      acc.data.voc = u16be(bytes[i], bytes[i + 1]);
      acc.recognized = true;
      i += 2;
    } else if (tag === 0x0030) {
      if (i + 1 >= bytes.length) {
        return 'truncated pressure value at offset ' + i;
      }
      applyPressure(acc, u16be(bytes[i], bytes[i + 1]));
      acc.recognized = true;
      i += 2;
    } else if (tag === 0x0040) {
      if (i + 1 >= bytes.length) {
        return 'truncated light value at offset ' + i;
      }
      applyLight(acc, u16be(bytes[i], bytes[i + 1]));
      acc.recognized = true;
      i += 2;
    } else if (tag === 0x0041) {
      if (i >= bytes.length) {
        return 'truncated occupancy value at offset ' + i;
      }
      applyOccupancy(acc, bytes[i] & 0x01, bytes[i] >> 1);
      acc.recognized = true;
      i += 1;
    } else if (tag === 0x0054) {
      if (i >= bytes.length) {
        return 'truncated battery value at offset ' + i;
      }
      applyBatteryMv(acc, bytes[i] * 20);
      acc.recognized = true;
      i += 1;
    } else if (tag === 0x0063) {
      if (i >= bytes.length) {
        return 'truncated setpoint value at offset ' + i;
      }
      acc.data.setpoint = bytes[i];
      acc.recognized = true;
      i += 1;
    } else if (tag === 0x8540) {
      if (i + 1 >= bytes.length) {
        return 'truncated battery value at offset ' + i;
      }
      applyBatteryMv(acc, u16be(bytes[i], bytes[i + 1]));
      acc.recognized = true;
      i += 2;
    } else {
      return 'unrecognized Thermokon LPP identifier 0x' + tag.toString(16);
    }
  }
  return null;
}

// Decode the Thermokon holding-register frame (DecodeHR, ported faithfully):
// repeating 2-byte big-endian register id + 2-byte big-endian value.
function decodeHr(bytes, acc) {
  var i = 0;
  while (i < bytes.length) {
    if (i + 3 >= bytes.length) {
      return 'truncated holding register at offset ' + i;
    }
    var reg = u16be(bytes[i], bytes[i + 1]);
    var rawU = u16be(bytes[i + 2], bytes[i + 3]);
    var rawS = s16be(bytes[i + 2], bytes[i + 3]);
    i += 4;

    if (reg === 500) {
      applyTemp(acc, rawS);
      acc.recognized = true;
    } else if (reg === 501) {
      applyRhum(acc, rawU);
      acc.recognized = true;
    } else if (reg === 505) {
      applyCo2(acc, rawU);
      acc.recognized = true;
    } else if (reg === 506) {
      acc.data.voc = rawU;
      acc.recognized = true;
    } else if (reg === 100) {
      acc.data.occupancy = rawU;
      acc.recognized = true;
    } else if (reg === 101) {
      acc.data.eco = rawU;
      acc.recognized = true;
    } else if (reg === 103) {
      acc.data.setpoint = round(rawS / 10, 1);
      acc.recognized = true;
    } else if (reg === 104) {
      acc.data.fan = rawU;
      acc.recognized = true;
    } else {
      return 'unrecognized Thermokon holding register ' + reg;
    }
  }
  return null;
}

function decodeUplink(input) {
  var bytes = input.bytes;
  if (!bytes || bytes.length === 0) {
    return { errors: ['empty payload'] };
  }

  var acc = {
    data: {},
    air: {},
    motion: {},
    haveAir: false,
    haveMotion: false,
    recognized: false,
  };

  var err;
  if (input.fPort === 4) {
    err = decodeHr(bytes, acc);
  } else {
    err = decodeLpp(bytes, acc);
  }
  if (err) {
    return { errors: [err] };
  }
  if (!acc.recognized) {
    return { errors: ['no recognized Thermokon data points'] };
  }

  if (acc.haveAir) {
    acc.data.air = acc.air;
  }
  if (acc.haveMotion) {
    acc.data.action = { motion: acc.motion };
  }
  return { data: acc.data };
}
