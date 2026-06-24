// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for SenseCAP (SeeedStudio) Wireless Light Intensity
// Sensor - LoRaWAN.
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format (SenseCAP common decoder: CRC16 + 7-byte frames keyed by a numeric
// measurementId) understood with reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/sensecap sensecap-common-decoder,
// attributed in NOTICE). The normalization below is authored here; the upstream
// `messages` array is NOT reproduced.
//
// Each frame is 7 bytes: channel(1) + dataID(2, little-endian) + value(4). The
// final 2 bytes of the payload are a CRC16 trailer that makes the running CRC of
// the whole payload zero. Telemetry dataIDs (> 4096) carry the value as a 4-byte
// little-endian, two's-complement fixed-point integer scaled by 1/1000. SenseCAP
// measurement IDs: 4097 air temperature (C), 4098 air humidity (%), 4199 light
// intensity (lux). Battery (special dataID 7) is a percentage -> batteryPercent
// extra (vocabulary `battery` is volts). Sensor-id / version / interval /
// remove-sensor frames carry no measurement and are ignored.

var CRC16TAB = [
  0x0000, 0x1189, 0x2312, 0x329b, 0x4624, 0x57ad, 0x6536, 0x74bf, 0x8c48, 0x9dc1, 0xaf5a, 0xbed3, 0xca6c, 0xdbe5, 0xe97e, 0xf8f7,
  0x1081, 0x0108, 0x3393, 0x221a, 0x56a5, 0x472c, 0x75b7, 0x643e, 0x9cc9, 0x8d40, 0xbfdb, 0xae52, 0xdaed, 0xcb64, 0xf9ff, 0xe876,
  0x2102, 0x308b, 0x0210, 0x1399, 0x6726, 0x76af, 0x4434, 0x55bd, 0xad4a, 0xbcc3, 0x8e58, 0x9fd1, 0xeb6e, 0xfae7, 0xc87c, 0xd9f5,
  0x3183, 0x200a, 0x1291, 0x0318, 0x77a7, 0x662e, 0x54b5, 0x453c, 0xbdcb, 0xac42, 0x9ed9, 0x8f50, 0xfbef, 0xea66, 0xd8fd, 0xc974,
  0x4204, 0x538d, 0x6116, 0x709f, 0x0420, 0x15a9, 0x2732, 0x36bb, 0xce4c, 0xdfc5, 0xed5e, 0xfcd7, 0x8868, 0x99e1, 0xab7a, 0xbaf3,
  0x5285, 0x430c, 0x7197, 0x601e, 0x14a1, 0x0528, 0x37b3, 0x263a, 0xdecd, 0xcf44, 0xfddf, 0xec56, 0x98e9, 0x8960, 0xbbfb, 0xaa72,
  0x6306, 0x728f, 0x4014, 0x519d, 0x2522, 0x34ab, 0x0630, 0x17b9, 0xef4e, 0xfec7, 0xcc5c, 0xddd5, 0xa96a, 0xb8e3, 0x8a78, 0x9bf1,
  0x7387, 0x620e, 0x5095, 0x411c, 0x35a3, 0x242a, 0x16b1, 0x0738, 0xffcf, 0xee46, 0xdcdd, 0xcd54, 0xb9eb, 0xa862, 0x9af9, 0x8b70,
  0x8408, 0x9581, 0xa71a, 0xb693, 0xc22c, 0xd3a5, 0xe13e, 0xf0b7, 0x0840, 0x19c9, 0x2b52, 0x3adb, 0x4e64, 0x5fed, 0x6d76, 0x7cff,
  0x9489, 0x8500, 0xb79b, 0xa612, 0xd2ad, 0xc324, 0xf1bf, 0xe036, 0x18c1, 0x0948, 0x3bd3, 0x2a5a, 0x5ee5, 0x4f6c, 0x7df7, 0x6c7e,
  0xa50a, 0xb483, 0x8618, 0x9791, 0xe32e, 0xf2a7, 0xc03c, 0xd1b5, 0x2942, 0x38cb, 0x0a50, 0x1bd9, 0x6f66, 0x7eef, 0x4c74, 0x5dfd,
  0xb58b, 0xa402, 0x9699, 0x8710, 0xf3af, 0xe226, 0xd0bd, 0xc134, 0x39c3, 0x284a, 0x1ad1, 0x0b58, 0x7fe7, 0x6e6e, 0x5cf5, 0x4d7c,
  0xc60c, 0xd785, 0xe51e, 0xf497, 0x8028, 0x91a1, 0xa33a, 0xb2b3, 0x4a44, 0x5bcd, 0x6956, 0x78df, 0x0c60, 0x1de9, 0x2f72, 0x3efb,
  0xd68d, 0xc704, 0xf59f, 0xe416, 0x90a9, 0x8120, 0xb3bb, 0xa232, 0x5ac5, 0x4b4c, 0x79d7, 0x685e, 0x1ce1, 0x0d68, 0x3ff3, 0x2e7a,
  0xe70e, 0xf687, 0xc41c, 0xd595, 0xa12a, 0xb0a3, 0x8238, 0x93b1, 0x6b46, 0x7acf, 0x4854, 0x59dd, 0x2d62, 0x3ceb, 0x0e70, 0x1ff9,
  0xf78f, 0xe606, 0xd49d, 0xc514, 0xb1ab, 0xa022, 0x92b9, 0x8330, 0x7bc7, 0x6a4e, 0x58d5, 0x495c, 0x3de3, 0x2c6a, 0x1ef1, 0x0f78
];

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

// Running CRC16 over the full payload (data + 2-byte trailer) must reach 0.
function crc16IsValid(bytes) {
  var crc = 0;
  for (var i = 0; i < bytes.length; i++) {
    crc = (crc >> 8) ^ CRC16TAB[(crc ^ (bytes[i] & 0xff)) & 0xff];
  }
  return crc === 0;
}

// Little-endian unsigned integer over a slice of `bytes`.
function leUint(bytes, offset, length) {
  var v = 0;
  for (var i = length - 1; i >= 0; i--) {
    v = v * 256 + (bytes[offset + i] & 0xff);
  }
  return v;
}

// SenseCAP telemetry value: 4 little-endian bytes, two's-complement, scaled /1000.
function telemetryValue(bytes, offset) {
  var raw = leUint(bytes, offset, 4);
  if (raw >= 0x80000000) {
    raw = raw - 0x100000000;
  }
  return raw / 1000;
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;

  if (!bytes || bytes.length === 0) {
    return { errors: ['empty payload'] };
  }

  // Whole payload (incl. CRC trailer) must be CRC16-clean.
  if (!crc16IsValid(bytes)) {
    return { errors: ['crc check fail'] };
  }

  // Payload is N (>=1) 7-byte frames followed by a 2-byte CRC trailer.
  if (bytes.length < 9 || (bytes.length - 2) % 7 !== 0) {
    return { errors: ['length check fail'] };
  }

  var frameCount = (bytes.length - 2) / 7;

  var data = {};
  var air = {};
  var hasAir = false;
  var measurementCount = 0;

  for (var f = 0; f < frameCount; f++) {
    var base = f * 7;
    var dataID = leUint(bytes, base + 1, 2);

    if (dataID > 4096) {
      // Telemetry frame.
      var value = telemetryValue(bytes, base + 3);
      measurementCount++;
      if (dataID === 4097) {
        air.temperature = round(value, 3);
        hasAir = true;
      } else if (dataID === 4098) {
        air.relativeHumidity = round(value, 3);
        hasAir = true;
      } else if (dataID === 4199) {
        air.lightIntensity = round(value, 3);
        hasAir = true;
      } else {
        // Telemetry with no vocabulary key -> camelCase extra.
        data['telemetry' + dataID] = round(value, 3);
      }
    } else if (dataID === 7) {
      // Special battery && interval frame; low 16 bits are battery percent.
      data.batteryPercent = leUint(bytes, base + 3, 2);
      measurementCount++;
    }
    // All other dataIDs (version, sensor-id, interval, remove-sensor, unknown)
    // carry no normalized measurement and are intentionally ignored.
  }

  if (measurementCount === 0) {
    return { errors: ['no measurement frames present'] };
  }

  if (hasAir) {
    data.air = air;
  }

  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "sensecap";
    result.data.model = "sensecap-light";
  }
  return result;
}
