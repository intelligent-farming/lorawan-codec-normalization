// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for IoThings ioTracker 3 (LoRaWAN GPS asset tracker
// with accelerometer, temperature, light, barometer and humidity sensors).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format (1-byte flag header -> fixed CRC/battery -> sensor-content bitmask ->
// optional GPS block) understood with reference to the upstream Apache-2.0
// decoder (TheThingsNetwork/lorawan-devices vendor/iothings/iotracker3.js,
// attributed in NOTICE) and the official decoder docs at
// https://docs.iotracker.eu/decoding/uplinks/ . The upstream normalizeUplink is
// NOT copied; normalization is authored here.
//
// Mapping notes:
//   - GPS latitude/longitude  -> position.latitude / position.longitude
//   - onboard temperature     -> air.temperature (int16 x 0.01 degC)
//   - onboard light           -> air.lightIntensity (lux, numeric only)
//   - header movement flag     -> action.motion.detected (real device trigger)
//   - battery status (1..254)  -> batteryPercent (device reports a level, not
//                                 volts; 255 = external power, omitted)
//   - accelerometer / GPS quality / nav status -> camelCase extras

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

function decodeUplinkCore(input) {
  var bytes = input.bytes;
  if (!bytes || bytes.length < 3) {
    return { errors: ['payload too short: need at least the 3-byte header'] };
  }

  var data = {};
  var i = 0;

  var header = bytes[i++];
  var reasonButton = !!(header & 0x01);
  var reasonMovement = !!(header & 0x02);
  var reasonGpio = !!(header & 0x04);
  var containsGps = !!(header & 0x08);
  var containsOnboard = !!(header & 0x10);

  // B1: CRC of last downlink command (diagnostic). B2: battery status.
  data.crc = bytes[i++];
  var battery = bytes[i++];
  if (battery === 255) {
    data.externalPower = true;
  } else {
    data.batteryPercent = round((battery / 254) * 100, 1);
  }

  // Movement is a genuine device trigger flag -> normalized motion.
  data.action = { motion: { detected: reasonMovement } };
  data.uplinkReasonButton = reasonButton;
  data.uplinkReasonGpio = reasonGpio;

  var air = {};

  if (containsOnboard) {
    if (i >= bytes.length) {
      return { errors: ['truncated payload: missing sensor-content byte'] };
    }
    var sensor = bytes[i++];
    var hasTemperature = !!(sensor & 0x01);
    var hasLight = !!(sensor & 0x02);
    var hasAccelCurrent = !!(sensor & 0x04);
    var hasAccelMax = !!(sensor & 0x08);
    var hasWifi = !!(sensor & 0x10);
    var hasSecond = !!(sensor & 0x80);

    // Extended-reason (b5), external sensors (b6) and the continuation byte
    // (b7) carry vendor-specific blocks this codec does not decode; bail out
    // rather than misalign the stream.
    if ((sensor & 0x20) || (sensor & 0x40)) {
      return { errors: ['unsupported sensor content (extended-reason/external)'] };
    }
    if (hasSecond) {
      return { errors: ['unsupported extended sensor content byte'] };
    }

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
      data.accelerationMg = {
        x: s16be(bytes[i], bytes[i + 1]),
        y: s16be(bytes[i + 2], bytes[i + 3]),
        z: s16be(bytes[i + 4], bytes[i + 5])
      };
      i += 6;
    }

    if (hasAccelMax) {
      if (i + 3 >= bytes.length) {
        return { errors: ['truncated accelerometer-max field'] };
      }
      data.maxAccelerationMg = s16be(bytes[i], bytes[i + 1]);
      data.maxAccelerationHistoryMg = s16be(bytes[i + 2], bytes[i + 3]);
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
          var octet = bytes[i++].toString(16);
          if (octet.length < 2) {
            octet = '0' + octet;
          }
          mac += (b === 0 ? '' : ':') + octet;
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

  if (air.temperature !== undefined || air.lightIntensity !== undefined) {
    data.air = air;
  }

  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "iothings";
    result.data.model = "iotracker3";
  }
  return result;
}
