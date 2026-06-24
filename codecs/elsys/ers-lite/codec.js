// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for ELSYS ERS Lite (indoor temperature & humidity
// room sensor).
//
// Wire format is ELSYS's shared TLV protocol (a stream of type-byte then value
// records). This decode is ported/normalized from the upstream Apache-2.0
// decoder (TheThingsNetwork/lorawan-devices vendor/elsys/elsys.js, attributed
// in NOTICE). The upstream `normalizeUplink` is NOT used; normalization to the
// shared vocabulary is authored here.
//
// ELSYS reports battery as VDD in millivolts; the vocabulary's `battery` is
// volts, so VDD is divided by 1000. Pressure is mapped to air.pressure only
// when it falls in the atmospheric band (900-1100 hPa); otherwise it is kept as
// the extra `pressureHpa`. Accelerometer axes and other sensor types the
// vocabulary does not model are emitted as camelCase extras.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function bin16dec(bin) {
  var num = bin & 0xffff;
  if (0x8000 & num) {
    num = -(0x010000 - num);
  }
  return num;
}

function bin8dec(bin) {
  var num = bin & 0xff;
  if (0x80 & num) {
    num = -(0x0100 - num);
  }
  return num;
}

// Faithful port of upstream DecodeElsysPayload: walks the TLV stream and
// returns a flat object keyed by the upstream field names. Throws a string on
// an unknown type byte so decodeUplink can surface an error (upstream silently
// bails to the end of the buffer instead).
function decodeElsysPayload(data) {
  var obj = {};
  var i;
  for (i = 0; i < data.length; i++) {
    switch (data[i]) {
      case 0x01: // TEMP: int16, tenths of a degree -> C
        obj.temperature = bin16dec((data[i + 1] << 8) | data[i + 2]) / 10;
        i += 2;
        break;
      case 0x02: // RH: 1 byte percentage
        obj.humidity = data[i + 1];
        i += 1;
        break;
      case 0x03: // ACC: 3-axis acceleration, +/-63 == 1G
        obj.x = bin8dec(data[i + 1]);
        obj.y = bin8dec(data[i + 2]);
        obj.z = bin8dec(data[i + 3]);
        i += 3;
        break;
      case 0x04: // LIGHT: uint16 lux
        obj.light = (data[i + 1] << 8) | data[i + 2];
        i += 2;
        break;
      case 0x05: // MOTION: 1 byte count
        obj.motion = data[i + 1];
        i += 1;
        break;
      case 0x06: // CO2: uint16 ppm
        obj.co2 = (data[i + 1] << 8) | data[i + 2];
        i += 2;
        break;
      case 0x07: // VDD: uint16 mV
        obj.vdd = (data[i + 1] << 8) | data[i + 2];
        i += 2;
        break;
      case 0x08: // ANALOG1: uint16 mV
        obj.analog1 = (data[i + 1] << 8) | data[i + 2];
        i += 2;
        break;
      case 0x09: // GPS: 3 bytes lat + 3 bytes long
        i++;
        obj.lat =
          (data[i + 0] |
            (data[i + 1] << 8) |
            (data[i + 2] << 16) |
            (data[i + 2] & 0x80 ? 0xff << 24 : 0)) /
          10000;
        obj.long =
          (data[i + 3] |
            (data[i + 4] << 8) |
            (data[i + 5] << 16) |
            (data[i + 5] & 0x80 ? 0xff << 24 : 0)) /
          10000;
        i += 5;
        break;
      case 0x0a: // PULSE1: uint16 relative count
        obj.pulse1 = (data[i + 1] << 8) | data[i + 2];
        i += 2;
        break;
      case 0x0b: // PULSE1_ABS: uint32 absolute count
        obj.pulseAbs =
          (data[i + 1] << 24) | (data[i + 2] << 16) | (data[i + 3] << 8) | data[i + 4];
        i += 4;
        break;
      case 0x0c: // EXT_TEMP1: int16 tenths -> C
        obj.externalTemperature = bin16dec((data[i + 1] << 8) | data[i + 2]) / 10;
        i += 2;
        break;
      case 0x0d: // EXT_DIGITAL: 1 byte 0/1
        obj.digital = data[i + 1];
        i += 1;
        break;
      case 0x0e: // EXT_DISTANCE: uint16 mm
        obj.distance = (data[i + 1] << 8) | data[i + 2];
        i += 2;
        break;
      case 0x0f: // ACC_MOTION: 1 byte count
        obj.accMotion = data[i + 1];
        i += 1;
        break;
      case 0x10: // IR_TEMP: int16 internal + int16 external, tenths -> C
        obj.irInternalTemperature = bin16dec((data[i + 1] << 8) | data[i + 2]) / 10;
        obj.irExternalTemperature = bin16dec((data[i + 3] << 8) | data[i + 4]) / 10;
        i += 4;
        break;
      case 0x11: // OCCUPANCY: 1 byte
        obj.occupancy = data[i + 1];
        i += 1;
        break;
      case 0x12: // WATERLEAK: 1 byte 0-255
        obj.waterleak = data[i + 1];
        i += 1;
        break;
      case 0x13: // GRIDEYE: 1 byte ref + 64 bytes
        var ref = data[i + 1];
        i++;
        obj.grideye = [];
        var j;
        for (j = 0; j < 64; j++) {
          obj.grideye[j] = ref + data[1 + i + j] / 10.0;
        }
        i += 64;
        break;
      case 0x14: // PRESSURE: uint32 / 1000 -> hPa
        obj.pressure =
          ((data[i + 1] << 24) | (data[i + 2] << 16) | (data[i + 3] << 8) | data[i + 4]) /
          1000;
        i += 4;
        break;
      case 0x15: // SOUND: peak + avg
        obj.soundPeak = data[i + 1];
        obj.soundAvg = data[i + 2];
        i += 2;
        break;
      case 0x16: // PULSE2: uint16 relative count
        obj.pulse2 = (data[i + 1] << 8) | data[i + 2];
        i += 2;
        break;
      case 0x17: // PULSE2_ABS: uint32 absolute count
        obj.pulseAbs2 =
          (data[i + 1] << 24) | (data[i + 2] << 16) | (data[i + 3] << 8) | data[i + 4];
        i += 4;
        break;
      case 0x18: // ANALOG2: uint16 mV
        obj.analog2 = (data[i + 1] << 8) | data[i + 2];
        i += 2;
        break;
      case 0x19: // EXT_TEMP2: int16 tenths -> C
        var extTemp2 = bin16dec((data[i + 1] << 8) | data[i + 2]) / 10;
        if (typeof obj.externalTemperature2 === 'number') {
          obj.externalTemperature2 = [obj.externalTemperature2];
        }
        if (Object.prototype.toString.call(obj.externalTemperature2) === '[object Array]') {
          obj.externalTemperature2.push(extTemp2);
        } else {
          obj.externalTemperature2 = extTemp2;
        }
        i += 2;
        break;
      case 0x1a: // EXT_DIGITAL2: 1 byte 0/1
        obj.digital2 = data[i + 1];
        i += 1;
        break;
      case 0x1b: // EXT_ANALOG_UV: uint32 uV
        obj.analogUv =
          (data[i + 1] << 24) | (data[i + 2] << 16) | (data[i + 3] << 8) | data[i + 4];
        i += 4;
        break;
      case 0x1c: // TVOC: uint16 ppb
        obj.tvoc = (data[i + 1] << 8) | data[i + 2];
        i += 2;
        break;
      default:
        throw 'unknown ELSYS type byte 0x' + (data[i] & 0xff).toString(16);
    }
  }
  return obj;
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;
  if (!bytes || bytes.length === 0) {
    return { errors: ['empty payload'] };
  }

  var obj;
  try {
    obj = decodeElsysPayload(bytes);
  } catch (e) {
    return { errors: [String(e)] };
  }

  var data = {};
  var air = {};
  var action = {};
  var motion = {};
  var hasAir = false;
  var hasMotion = false;

  if (obj.temperature !== undefined) {
    air.temperature = round(obj.temperature, 1);
    hasAir = true;
  }
  if (obj.humidity !== undefined) {
    air.relativeHumidity = obj.humidity;
    hasAir = true;
  }
  if (obj.light !== undefined) {
    air.lightIntensity = obj.light;
    hasAir = true;
  }
  if (obj.co2 !== undefined) {
    air.co2 = obj.co2;
    hasAir = true;
  }

  // PRESSURE -> air.pressure only inside the atmospheric band; otherwise extra.
  if (obj.pressure !== undefined) {
    if (obj.pressure >= 900 && obj.pressure <= 1100) {
      air.pressure = round(obj.pressure, 2);
      hasAir = true;
    } else {
      data.pressureHpa = round(obj.pressure, 3);
    }
  }

  // MOTION (PIR count) -> action.motion.detected + .count
  if (obj.motion !== undefined) {
    motion.detected = obj.motion > 0;
    motion.count = obj.motion;
    hasMotion = true;
  }
  // ACC_MOTION (accelerometer-based movement count) -> action.motion as well
  if (obj.accMotion !== undefined) {
    motion.detected = motion.detected || obj.accMotion > 0;
    motion.count = obj.accMotion;
    hasMotion = true;
  }
  // OCCUPANCY -> presence as motion.detected
  if (obj.occupancy !== undefined) {
    motion.detected = motion.detected || obj.occupancy > 0;
    hasMotion = true;
  }

  // VDD mV -> battery volts
  if (obj.vdd !== undefined) {
    data.battery = round(obj.vdd / 1000, 3);
  }

  // GPS -> position
  if (obj.lat !== undefined && obj.long !== undefined) {
    data.position = { latitude: round(obj.lat, 4), longitude: round(obj.long, 4) };
  }

  // Accelerometer axes and every other modeled-elsewhere field become extras
  // (camelCase; must not collide with vocabulary keys).
  if (obj.x !== undefined) {
    data.accelerationX = obj.x;
  }
  if (obj.y !== undefined) {
    data.accelerationY = obj.y;
  }
  if (obj.z !== undefined) {
    data.accelerationZ = obj.z;
  }
  if (obj.externalTemperature !== undefined) {
    data.externalTemperature = round(obj.externalTemperature, 1);
  }
  if (obj.externalTemperature2 !== undefined) {
    data.externalTemperature2 = obj.externalTemperature2;
  }
  if (obj.irInternalTemperature !== undefined) {
    data.irInternalTemperature = round(obj.irInternalTemperature, 1);
  }
  if (obj.irExternalTemperature !== undefined) {
    data.irExternalTemperature = round(obj.irExternalTemperature, 1);
  }
  if (obj.distance !== undefined) {
    data.distanceMm = obj.distance;
  }
  if (obj.digital !== undefined) {
    data.digital = obj.digital;
  }
  if (obj.digital2 !== undefined) {
    data.digital2 = obj.digital2;
  }
  if (obj.waterleak !== undefined) {
    data.waterleak = obj.waterleak;
  }
  if (obj.grideye !== undefined) {
    data.grideye = obj.grideye;
  }
  if (obj.soundPeak !== undefined) {
    data.soundPeak = obj.soundPeak;
  }
  if (obj.soundAvg !== undefined) {
    data.soundAvg = obj.soundAvg;
  }
  if (obj.analog1 !== undefined) {
    data.analog1Mv = obj.analog1;
  }
  if (obj.analog2 !== undefined) {
    data.analog2Mv = obj.analog2;
  }
  if (obj.analogUv !== undefined) {
    data.analogUv = obj.analogUv;
  }
  if (obj.tvoc !== undefined) {
    data.tvoc = obj.tvoc;
  }
  if (obj.pulse1 !== undefined) {
    data.pulse1 = obj.pulse1;
  }
  if (obj.pulse2 !== undefined) {
    data.pulse2 = obj.pulse2;
  }
  if (obj.pulseAbs !== undefined) {
    data.pulseAbs = obj.pulseAbs;
  }
  if (obj.pulseAbs2 !== undefined) {
    data.pulseAbs2 = obj.pulseAbs2;
  }

  if (hasMotion) {
    action.motion = motion;
    data.action = action;
  }
  if (hasAir) {
    data.air = air;
  }

  if (hasAir || hasMotion || data.battery !== undefined || data.position !== undefined) {
    return { data: data };
  }
  return { errors: ['no recognized ELSYS measurements'] };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "elsys";
    result.data.model = "ers-lite";
  }
  return result;
}
