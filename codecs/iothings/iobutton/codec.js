// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for IoThings ioButton (LoRaWAN panic/SOS button
// with onboard temperature, light, humidity, barometer, accelerometer, tilt,
// man-down and GNSS positioning).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format (flag header -> CRC/battery -> sensor-content bitmask(s) -> ordered
// sensor blocks -> optional GPS block) ported from the upstream Apache-2.0
// decoder (TheThingsNetwork/lorawan-devices vendor/iothings/iobutton.js,
// attributed in NOTICE). The upstream Decoder is the source of truth for the
// wire layout; normalization is authored here and the upstream normalizeUplink
// is NOT copied.
//
// Mapping notes:
//   - GPS latitude/longitude    -> position.latitude / position.longitude
//   - onboard temperature       -> air.temperature (int16 x 0.01 degC)
//   - onboard light             -> air.lightIntensity (lux, float12 + exp)
//   - relative humidity         -> air.relativeHumidity (uint16 x 0.01 %)
//   - air pressure (uint24 Pa)  -> air.pressure (hPa = Pa / 100)
//   - tilt currentTilt          -> tilt.angle (uint16 x 0.01 deg)
//   - battery level (1..254)    -> batteryPercent (device reports a level, not
//                                  volts; 255 = external power, omitted)
//   - accelerometer / man-down / tilt direction+history / GPS quality /
//     button / wifi             -> camelCase extras

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function s16be(hi, lo) {
  var v = ((hi & 0xff) << 8) | (lo & 0xff);
  return v > 0x7fff ? v - 0x10000 : v;
}

function u16be(hi, lo) {
  return ((hi & 0xff) << 8) | (lo & 0xff);
}

function s32be(b1, b2, b3, b4) {
  // Bitwise OR yields a signed 32-bit result in JS, which is what we want.
  return (b1 << 24) | (b2 << 16) | (b3 << 8) | b4;
}

function hex2(b) {
  var s = (b & 0xff).toString(16);
  return s.length < 2 ? '0' + s : s;
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;
  if (!bytes || bytes.length < 3) {
    return { errors: ['payload too short: need at least the 3-byte header'] };
  }

  var data = {};
  var air = {};
  var i = 0;

  var header = bytes[i++];
  var reasonButton = !!(header & 0x01);
  var reasonMovement = !!(header & 0x02);
  var reasonGpio = !!(header & 0x04);
  var containsGps = !!(header & 0x08);
  var containsOnboard = !!(header & 0x10);
  var containsSpecial = !!(header & 0x20);

  // B1: CRC of last downlink command (diagnostic). B2: battery status.
  data.crc = bytes[i++];
  var battery = bytes[i++];
  if (battery === 255) {
    data.externalPower = true;
  } else {
    data.batteryPercent = round((battery / 254) * 100, 1);
  }

  data.uplinkReasonButton = reasonButton;
  data.uplinkReasonMovement = reasonMovement;
  data.uplinkReasonGpio = reasonGpio;
  data.containsSpecial = containsSpecial;

  if (containsOnboard) {
    if (i >= bytes.length) {
      return { errors: ['truncated payload: missing sensor-content byte'] };
    }
    var sc = bytes[i++];
    var hasTemperature = !!(sc & 0x01);
    var hasLight = !!(sc & 0x02);
    var hasAccelCurrent = !!(sc & 0x04);
    var hasAccelMax = !!(sc & 0x08);
    var hasWifi = !!(sc & 0x10);
    var buttonEventInfo = !!(sc & 0x20);
    var hasExternal = !!(sc & 0x40);
    var hasSecond = !!(sc & 0x80);

    var hasBluetooth = false;
    var hasHumidity = false;
    var hasPressure = false;
    var hasManDown = false;
    var hasTilt = false;
    var hasRetransmit = false;
    if (hasSecond) {
      if (i >= bytes.length) {
        return { errors: ['truncated payload: missing second sensor-content byte'] };
      }
      var sc2 = bytes[i++];
      hasBluetooth = !!(sc2 & 0x01);
      hasHumidity = !!(sc2 & 0x02);
      hasPressure = !!(sc2 & 0x04);
      hasManDown = !!(sc2 & 0x08);
      hasTilt = !!(sc2 & 0x10);
      hasRetransmit = !!(sc2 & 0x20);
    }

    // Button click reason mirrors upstream's header(b0)/buttonEvent(b5) matrix.
    var reason = 'none';
    if (buttonEventInfo && reasonButton) {
      reason = 'double';
    } else if (buttonEventInfo && !reasonButton) {
      reason = 'long';
    } else if (!buttonEventInfo && reasonButton) {
      reason = 'single';
    }
    data.buttonClickReason = reason;

    if (hasTemperature) {
      if (i + 1 >= bytes.length) {
        return { errors: ['truncated temperature field'] };
      }
      air.temperature = round(s16be(bytes[i], bytes[i + 1]) / 100, 2);
      i += 2;
    }

    if (hasLight) {
      if (i + 1 >= bytes.length) {
        return { errors: ['truncated light field'] };
      }
      var raw = u16be(bytes[i], bytes[i + 1]);
      var exponent = (raw >> 12) & 0x0f;
      var mantissa = raw & 0x0fff;
      air.lightIntensity = round((mantissa << exponent) / 100, 2);
      i += 2;
    }

    if (hasAccelCurrent) {
      if (i + 5 >= bytes.length) {
        return { errors: ['truncated accelerometer field'] };
      }
      data.accelerationG = {
        x: round(s16be(bytes[i], bytes[i + 1]) / 1000, 3),
        y: round(s16be(bytes[i + 2], bytes[i + 3]) / 1000, 3),
        z: round(s16be(bytes[i + 4], bytes[i + 5]) / 1000, 3)
      };
      i += 6;
    }

    if (hasAccelMax) {
      if (i + 3 >= bytes.length) {
        return { errors: ['truncated accelerometer-max field'] };
      }
      data.maxAccelerationG = round(s16be(bytes[i], bytes[i + 1]) / 1000, 3);
      data.maxAccelerationHistoryG = round(s16be(bytes[i + 2], bytes[i + 3]) / 1000, 3);
      i += 4;
    }

    if (hasWifi) {
      if (i >= bytes.length) {
        return { errors: ['truncated WiFi-scan field'] };
      }
      var wifiInfo = bytes[i++];
      var numAccessPoints = wifiInfo & 0x07;
      var hasSignalStrength = !!(wifiInfo & 0x20);
      var bytesPerAp = hasSignalStrength ? 7 : 6;
      if (i + numAccessPoints * bytesPerAp > bytes.length) {
        return { errors: ['truncated WiFi access-point list'] };
      }
      var accessPoints = [];
      var ap = 0;
      while (ap < numAccessPoints) {
        var mac = '';
        var b = 0;
        while (b < 6) {
          mac += (b === 0 ? '' : ':') + hex2(bytes[i++]);
          b++;
        }
        var rssi = null;
        if (hasSignalStrength) {
          var raw8 = bytes[i++];
          rssi = raw8 > 0x7f ? raw8 - 0x100 : raw8;
        }
        accessPoints.push({ macAddress: mac, signalStrength: rssi });
        ap++;
      }
      data.wifiAccessPoints = accessPoints;
    }

    if (hasExternal) {
      // External-sensor blocks are variable-length and vendor-specific; we
      // cannot reliably skip them to reach later fields, so bail rather than
      // misalign the stream.
      return { errors: ['unsupported external-sensor block'] };
    }

    if (hasBluetooth) {
      // Bluetooth beacon lists are variable-length with multiple slot formats;
      // skipping them safely is not possible here.
      return { errors: ['unsupported bluetooth-beacon block'] };
    }

    if (hasHumidity) {
      if (i + 1 >= bytes.length) {
        return { errors: ['truncated humidity field'] };
      }
      air.relativeHumidity = round(u16be(bytes[i], bytes[i + 1]) / 100, 2);
      i += 2;
    }

    if (hasPressure) {
      if (i + 2 >= bytes.length) {
        return { errors: ['truncated air-pressure field'] };
      }
      // uint24 Pascals -> hPa
      var pa = (bytes[i] << 16) + (bytes[i + 1] << 8) + bytes[i + 2];
      air.pressure = round(pa / 100, 1);
      i += 3;
    }

    if (hasManDown) {
      if (i >= bytes.length) {
        return { errors: ['truncated man-down field'] };
      }
      var md = bytes[i++];
      var mdState = md & 0x0f;
      var mdLabel = 'unknown';
      if (mdState === 0x00) {
        mdLabel = 'ok';
      } else if (mdState === 0x01) {
        mdLabel = 'sleeping';
      } else if (mdState === 0x02) {
        mdLabel = 'preAlarm';
      } else if (mdState === 0x03) {
        mdLabel = 'alarm';
      }
      data.manDown = {
        state: mdLabel,
        positionAlarm: !!(md & 0x10),
        movementAlarm: !!(md & 0x20)
      };
    }

    if (hasTilt) {
      if (i + 5 >= bytes.length) {
        return { errors: ['truncated tilt field'] };
      }
      var tiltAngle = round(u16be(bytes[i], bytes[i + 1]) / 100, 2);
      var tiltDirection = Math.round(bytes[i + 2] * (360 / 255));
      var tiltMaxHistory = round(u16be(bytes[i + 3], bytes[i + 4]) / 100, 2);
      var tiltDirHistory = Math.round(bytes[i + 5] * (360 / 255));
      i += 6;
      data.tilt = { angle: tiltAngle };
      data.tiltDirection = tiltDirection;
      data.tiltMaxHistory = tiltMaxHistory;
      data.tiltDirectionHistory = tiltDirHistory;
    }

    if (hasRetransmit) {
      if (i >= bytes.length) {
        return { errors: ['truncated retransmit-count field'] };
      }
      data.retransmitCount = bytes[i++];
    }
  }

  if (containsGps) {
    if (i + 18 >= bytes.length) {
      return { errors: ['truncated GPS block: expected 19 bytes'] };
    }
    var navStat = bytes[i++];
    var lat = s32be(bytes[i], bytes[i + 1], bytes[i + 2], bytes[i + 3]) / 1e7;
    i += 4;
    var lon = s32be(bytes[i], bytes[i + 1], bytes[i + 2], bytes[i + 3]) / 1e7;
    i += 4;
    var altitude = u16be(bytes[i], bytes[i + 1]) / 10;
    i += 2;
    var hAcc = bytes[i++];
    var vAcc = bytes[i++];
    var speed = u16be(bytes[i], bytes[i + 1]) / 10;
    i += 2;
    var course = u16be(bytes[i], bytes[i + 1]) / 10;
    i += 2;
    var hdop = bytes[i++] / 10;
    var numSvs = bytes[i++];

    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
      return { errors: ['GPS fix out of range'] };
    }

    data.position = {
      latitude: round(lat, 7),
      longitude: round(lon, 7)
    };
    data.gpsNavStatus = navStat;
    data.gpsAltitude = round(altitude, 1);
    data.gpsHorizontalAccuracy = hAcc;
    data.gpsVerticalAccuracy = vAcc;
    data.gpsSpeedKmh = round(speed, 1);
    data.gpsCourse = round(course, 1);
    data.gpsHdop = round(hdop, 1);
    data.gpsSatellites = numSvs;
  }

  if (air.temperature !== undefined || air.relativeHumidity !== undefined ||
      air.pressure !== undefined || air.lightIntensity !== undefined) {
    data.air = air;
  }

  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "iothings";
    result.data.model = "iobutton";
  }
  return result;
}
