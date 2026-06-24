// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for the IoT Factory Personal Tracker (a LoRaWAN
// personal/asset GPS tracker on the "Taiga"-family generic protocol: an on-board
// GNSS receiver that resolves a position fix on-device, plus movement, WiFi/LBS
// scan, temperature, humidity and assorted I/O frames).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. The wire
// format was ported from and normalized against the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/iot-factory/generic-codec.js,
// attributed in NOTICE). The upstream framed binary layout (fixed little-endian
// header + chained type/reason frames) is reproduced faithfully; only the JSON
// shape is re-authored to the normalized vocabulary (never the upstream
// `Decode` / `frames[]` array output, which ChirpStack's Struct cannot carry).
//
// Wire layout (all multi-byte values little-endian):
//   byte 0   power     : bit0 source (0 battery / 1 external); bits1-7 charge %.
//   byte 1   protocol  : bit0 is_sn; bits1-3 version; bit4 is_payload_size.
//   [4 bytes serial number]   present when is_sn.
//   [2 bytes payload size]    present when is_payload_size.
//   then 0+ frames, each: 2-byte frameHeader (type = low 12 bits,
//   reason = high 4 bits) followed by a type-specific body.
//
// Frames mapped to the vocabulary:
//   0x03 GNSS        — on-device fix: int32 lat/lon * 1e-5 -> position.latitude/
//                      position.longitude; movement bit -> action.motion.detected;
//                      altitude/speed/satellites/hdop -> camelCase extras.
//   0x05 motion_activity / 0x13 movement — moving flag -> action.motion.detected.
//   0x0f temperature — int16 code/10 °C -> air.temperature.
//   0x18 humidity    — code/10 %RH      -> air.relativeHumidity.
//   0x11 SOS         — panic button event -> sosButton extra.
//   0x04 WiFi        — this is a RADIO SCAN, not an on-device fix. Access points
//                      are surfaced as the wifiAccessPoints extra for a cloud
//                      geolocation solver; they NEVER populate position.*.
//
// Only the first occurrence of each frame type contributes to the single
// normalized measurement object. battery is reported by the device as a charge
// PERCENTAGE, so it is emitted as the camelCase extra batteryPercent (the
// vocabulary `battery` is volts and is intentionally not synthesized).

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function u16le(bytes, o) {
  return bytes[o] | (bytes[o + 1] << 8);
}

function i16le(bytes, o) {
  var v = bytes[o] | (bytes[o + 1] << 8);
  return (v & 0x8000) ? v - 0x10000 : v;
}

function i8(b) {
  return (b & 0x80) ? b - 0x100 : b;
}

function u32le(bytes, o) {
  return (bytes[o] | (bytes[o + 1] << 8) | (bytes[o + 2] << 16)) +
    bytes[o + 3] * 0x1000000;
}

function i32le(bytes, o) {
  var v = u32le(bytes, o);
  return v >= 0x80000000 ? v - 0x100000000 : v;
}

function macFrom(bytes, o) {
  var s = '';
  for (var i = 0; i < 6; i++) {
    var b = (bytes[o + i] & 0xff).toString(16);
    if (b.length < 2) {
      b = '0' + b;
    }
    s += (i === 0 ? '' : ':') + b;
  }
  return s;
}

function bssidIsReal(bytes, o) {
  var c00 = 0;
  var cFF = 0;
  for (var i = 0; i < 6; i++) {
    var b = bytes[o + i];
    if (b === 0x00) {
      c00++;
    } else if (b === 0xff) {
      cFF++;
    }
  }
  return c00 !== 6 && cFF !== 6;
}

function setMotion(data, moving) {
  if (!data.action) {
    data.action = {};
  }
  if (!data.action.motion) {
    data.action.motion = {};
  }
  data.action.motion.detected = moving;
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;
  if (!bytes || bytes.length < 2) {
    return { errors: ['payload too short for an IoT Factory tracker frame'] };
  }

  var data = {};
  var warnings = [];

  // Header.
  data.powerSource = (bytes[0] & 0x01) === 0 ? 'battery' : 'external';
  data.batteryPercent = (bytes[0] & 0xfe) >> 1;

  var isSn = (bytes[1] & 0x01) !== 0;
  var isPayloadSize = (bytes[1] & 0x10) !== 0;

  var offset = 2;
  if (isSn) {
    if (offset + 4 > bytes.length) {
      return { errors: ['truncated serial number field'] };
    }
    data.serialNumber = u32le(bytes, offset);
    offset += 4;
  }
  if (isPayloadSize) {
    if (offset + 2 > bytes.length) {
      return { errors: ['truncated payload-size field'] };
    }
    offset += 2;
  }

  var seenPosition = false;
  var seenMotion = false;
  var seenTemperature = false;
  var seenHumidity = false;
  var sawAnyFrame = false;

  // Frame walk.
  while (offset + 2 <= bytes.length) {
    var header = bytes[offset] | (bytes[offset + 1] << 8);
    var type = header & 0x0fff;
    offset += 2;
    sawAnyFrame = true;

    if (type === 0x03) {
      // GNSS on-device fix: unixtime(4) lat(4) lon(4) alt(2) speed(2) hdop(1) flags(1).
      if (offset + 18 > bytes.length) {
        return { errors: ['truncated GNSS frame'] };
      }
      var lat = i32le(bytes, offset + 4) / 1e5;
      var lon = i32le(bytes, offset + 8) / 1e5;
      var alt = u16le(bytes, offset + 12);
      var speedKmh = u16le(bytes, offset + 14);
      var hdop = bytes[offset + 16] / 10;
      var flags = bytes[offset + 17];
      var usedSat = flags & 0x1f;
      var moving = (flags & 0x80) !== 0;

      if (!seenPosition) {
        var latOk = lat >= -90 && lat <= 90;
        var lonOk = lon >= -180 && lon <= 180;
        var position = {};
        if (latOk) {
          position.latitude = round(lat, 5);
        }
        if (lonOk) {
          position.longitude = round(lon, 5);
        }
        if (position.latitude !== undefined && position.longitude !== undefined) {
          data.position = position;
          data.altitude = alt;
          data.speedKmh = speedKmh;
          data.hdop = round(hdop, 1);
          data.satellites = usedSat;
          seenPosition = true;
        } else {
          warnings.push('GNSS fix out of range; position suppressed');
        }
      }
      if (!seenMotion) {
        setMotion(data, moving);
        seenMotion = true;
      }
      offset += 18;
    } else if (type === 0x13) {
      // movement: unixtime(4) is_movement(1).
      if (offset + 5 > bytes.length) {
        return { errors: ['truncated movement frame'] };
      }
      if (!seenMotion) {
        setMotion(data, bytes[offset + 4] === 1);
        seenMotion = true;
      }
      offset += 5;
    } else if (type === 0x05) {
      // motion_activity: unixtime(4) period(1) avg_index(1). avg_index > 0
      // indicates activity in the window.
      if (offset + 6 > bytes.length) {
        return { errors: ['truncated motion-activity frame'] };
      }
      if (!seenMotion) {
        setMotion(data, bytes[offset + 5] > 0);
        seenMotion = true;
      }
      offset += 6;
    } else if (type === 0x0f) {
      // temperature: unixtime(4) sensor(1) int16 code/10 °C(2).
      if (offset + 7 > bytes.length) {
        return { errors: ['truncated temperature frame'] };
      }
      if (!seenTemperature) {
        if (!data.air) {
          data.air = {};
        }
        data.air.temperature = round(i16le(bytes, offset + 5) / 10, 1);
        seenTemperature = true;
      }
      offset += 7;
    } else if (type === 0x18) {
      // humidity: unixtime(4) uint16 code/10 %RH(2).
      if (offset + 6 > bytes.length) {
        return { errors: ['truncated humidity frame'] };
      }
      if (!seenHumidity) {
        var rh = u16le(bytes, offset + 4);
        if (rh <= 1000) {
          if (!data.air) {
            data.air = {};
          }
          data.air.relativeHumidity = round(rh / 10, 1);
          seenHumidity = true;
        }
      }
      offset += 6;
    } else if (type === 0x11) {
      // SOS panic button: unixtime(4).
      if (offset + 4 > bytes.length) {
        return { errors: ['truncated SOS frame'] };
      }
      data.sosButton = true;
      offset += 4;
    } else if (type === 0x04) {
      // WiFi scan: unixtime(4) then 3 x (bssid(6) rssi(1)) + flags(1).
      // CLOUD-SOLVED — surfaced as an extra, never position.*.
      if (offset + 26 > bytes.length) {
        return { errors: ['truncated WiFi frame'] };
      }
      var aps = [];
      var wo = offset + 4;
      for (var w = 0; w < 3; w++) {
        if (bssidIsReal(bytes, wo)) {
          aps.push({ mac: macFrom(bytes, wo), rssi: i8(bytes[wo + 6]) });
        }
        wo += 7;
      }
      var wifiMoving = (bytes[offset + 25] & 0x10) !== 0;
      if (aps.length > 0) {
        data.wifiAccessPoints = aps;
      }
      if (!seenMotion) {
        setMotion(data, wifiMoving);
        seenMotion = true;
      }
      offset += 26;
    } else {
      // Unmodelled frame type: we cannot know its length, so stop walking and
      // keep what was decoded so far rather than misalign the stream.
      data.unparsedFrameType = type;
      break;
    }
  }

  if (!sawAnyFrame) {
    return { errors: ['no frames present in payload'] };
  }

  if (warnings.length > 0) {
    return { data: data, warnings: warnings };
  }
  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "iot-factory";
    result.data.model = "personal-tracker";
  }
  return result;
}
