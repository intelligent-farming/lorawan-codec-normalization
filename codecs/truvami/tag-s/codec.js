// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for truvami/tag-s (Truvami "tag S" asset tracker:
// GPS + WiFi/BLE + accelerometer).
//
// Ported/normalized from the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/truvami/tag-s-l.js, attributed in
// NOTICE) — the same Truvami codec family shared with truvami/tag-l. The wire
// format below was understood with reference to that decoder; the normalization
// is authored here and does NOT copy upstream normalizeUplink.
//
// Decoded uplinks that carry normalized vocabulary data:
//   - fPort 10  : GNSS position fix
//   - fPort 110 : buffered GNSS position fix (2-byte buffer level prefix)
//   - fPort 51  : combined GNSS fix + WiFi scan
//   - fPort 151 : buffered combined GNSS fix + WiFi scan (2-byte buffer level)
// These yield position.latitude/longitude (GPS fix, category gps-tracker) and
// an accelerometer-derived motion flag action.motion.detected (motion), plus
// battery voltage. Altitude, satellites, PDOP, TTF, WiFi MAC scan results and
// config/status flags are device-specific extras (camelCase, no vocab key).
//
// Other ports (3 BLE scan, 4 config, 5/7/105 WiFi-only, 6 button, 8 BLE config,
// 15 battery) carry no normalized vocabulary measurement and are reported as
// unsupported here; only the position-bearing ports are normalized.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function readI32(bytes, i) {
  // Signed 32-bit big-endian (JS << yields a signed 32-bit int).
  return (bytes[i] << 24) | (bytes[i + 1] << 16) | (bytes[i + 2] << 8) | bytes[i + 3];
}

function readU16(bytes, i) {
  return (bytes[i] << 8) | bytes[i + 1];
}

function macString(bytes, start) {
  var parts = [];
  for (var i = 0; i < 6; i++) {
    var h = (bytes[start + i] & 0xff).toString(16);
    if (h.length < 2) h = '0' + h;
    parts.push(h);
  }
  return parts.join(':');
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;
  var port = input.fPort;

  if (port !== 10 && port !== 110 && port !== 51 && port !== 151) {
    return { errors: ['unsupported fPort ' + port + ' (this codec normalizes only GNSS/combined position ports 10, 110, 51, 151)'] };
  }

  var buffered = port === 110 || port === 151;
  var combined = port === 51 || port === 151;

  var minLen = (buffered ? 2 : 0) + 20;
  if (combined) minLen = (buffered ? 2 : 0) + 27;
  if (bytes.length < minLen) {
    return { errors: ['Invalid payload length for ' + (combined ? 'combined' : 'GNSS') + ' packet. Expected at least ' + minLen + ' bytes.'] };
  }

  var bufferLevel = null;
  var index = 0;
  var statusByte;
  if (buffered) {
    bufferLevel = readU16(bytes, 0);
    index = 2;
    statusByte = bytes[2];
  } else {
    index = 0;
    statusByte = bytes[0];
  }

  var confChangeId = (statusByte >> 3) & 0x0f;
  var confSuccess = ((statusByte >> 2) & 0x01) === 1;
  var moving = (statusByte & 0x01) === 1;

  // Field layout begins at index+1 (status byte occupies index+0).
  var latRaw = readI32(bytes, index + 1);
  var lonRaw = readI32(bytes, index + 5);
  var altRaw = readU16(bytes, index + 9);
  var unixTimestamp = (bytes[index + 11] << 24) | (bytes[index + 12] << 16) | (bytes[index + 13] << 8) | bytes[index + 14];
  var batteryRaw = readU16(bytes, index + 15);
  var ttf = bytes[index + 17];
  var pdopRaw = bytes[index + 18];
  var numSatellites = bytes[index + 19];

  var data = {
    position: {
      latitude: round(latRaw / 1000000, 6),
      longitude: round(lonRaw / 1000000, 6)
    },
    action: {
      motion: {
        detected: moving
      }
    },
    battery: round(batteryRaw / 1000, 3),
    altitude: round(altRaw / 10, 1),
    gnssTimestamp: unixTimestamp,
    numSatellites: numSatellites,
    pdop: round(pdopRaw / 2, 1),
    ttf: ttf,
    confChangeId: confChangeId,
    confSuccess: confSuccess
  };

  if (bufferLevel !== null) {
    data.bufferLevel = bufferLevel;
  }

  if (combined) {
    var accessPoints = [];
    var wifiIndex = index + 20;
    while (wifiIndex + 7 <= bytes.length) {
      accessPoints.push({
        mac: macString(bytes, wifiIndex),
        rssi: bytes[wifiIndex + 6] - 256
      });
      wifiIndex += 7;
    }
    data.accessPoints = accessPoints;
    data.wifiTimestamp = unixTimestamp - ttf + 10;
  }

  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "truvami";
    result.data.model = "tag-s";
  }
  return result;
}
