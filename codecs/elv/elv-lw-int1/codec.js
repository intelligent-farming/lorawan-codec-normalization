// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for the ELV LW-INT1 (LoRaWAN Interface), a
// multi-sensor interface module. With the SoMo1 soil probe attached it reports
// calibrated soil moisture (%) and soil temperature (°C); it can also carry a
// DUS1 ultrasonic distance/level sensor and two digital inputs. It additionally
// emits supply voltage on every uplink.
//
// Original work for @intelligent-farming/lorawan-codec-normalization. The wire
// format was ported from and normalized against the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/elv/elv-lw-int1.js, attributed in
// NOTICE). The upstream field extraction (a 2-byte header plus a frame-type
// dispatch on fPort 10, with a channel/sensor-ID loop for Status-Info frames)
// is reproduced faithfully; only the JSON shape is re-authored to the
// normalized vocabulary (never the upstream `decoded` object).
//
// All application data arrives on fPort 10. Header:
//   bytes[0]  supply voltage: (byte + 150) * 0.01 V  -> battery (V)
//   bytes[1]  frame type: 0x00 Status-Info, 0xff Device-Info, 0xfc Config-Info,
//             0x03 Firmware-ID-Info, 0xfa Rejoin-Info, 0xf8 Spreading-Info
//
// Status-Info (0x00) is a stream of {channel, sensorId, payload} records,
// starting at index 2, looped while (length > index + 2). Sensor IDs:
//   0 Device (digital input states / events)  -> in1/in2 extras
//   1 DUS1   (ultrasonic distance & level)    -> distance/level extras
//   2 SoMo1H (soil moisture)  eventflags, Level%, 2-byte raw -> soil.moisture
//   3 SoMo1T (soil temperature) eventflags, 2-byte signed 0.1 C -> soil.temperature
//
// SoMo1H Level and SoMo1T Value carry sentinel codes (Error/Unknown/Overflow/
// Underflow) that are NOT real measurements; those records are skipped for the
// vocabulary key and surfaced as a camelCase status extra instead. The 2-byte
// SoMo1H raw reading is uncalibrated and is emitted as the extra
// soilMoistureRaw (the calibrated % is the vocabulary value).

var FRAME_TYPE = {
  0: 'Status-Info',
  3: 'Firmware-ID-Info',
  248: 'Spreading-Info',
  250: 'Rejoin-Info',
  252: 'Config-Info',
  255: 'Device-Info'
};

var FIRMWARE_TYPE = [
  'ELV-LW-INT1',
  'ELV-LW-INT1+DUS1',
  'ELV-LW-INT1+SoMo1',
  'ELV-LW-INT1+DUS1+SoMo1'
];

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;
  var port = input.fPort;

  if (!bytes) {
    return { errors: ['missing payload bytes'] };
  }
  if (port !== 10) {
    return { errors: ['unsupported FPort ' + port + ' (expected 10)'] };
  }
  if (bytes.length < 2) {
    return { errors: ['header requires at least 2 bytes'] };
  }

  var frameType = FRAME_TYPE[bytes[1]];
  if (frameType === undefined) {
    return { errors: ['unknown frame type 0x' + bytes[1].toString(16)] };
  }

  var data = {};
  // Supply voltage: (byte + 150) * 0.01 V.
  data.battery = round((bytes[0] + 150) * 0.01, 2);
  data.frameType = frameType;

  if (frameType === 'Status-Info') {
    return decodeStatus(bytes, data);
  }
  if (frameType === 'Firmware-ID-Info') {
    if (bytes.length < 4) {
      return { errors: ['truncated Firmware-ID-Info frame'] };
    }
    var fwIndex = (bytes[2] * 256) + bytes[3];
    data.firmwareId = FIRMWARE_TYPE[fwIndex] !== undefined ? FIRMWARE_TYPE[fwIndex] : String(fwIndex);
    return { data: data };
  }
  if (frameType === 'Device-Info') {
    if (bytes.length < 12) {
      return { errors: ['truncated Device-Info frame'] };
    }
    var typeVal = (bytes[2] << 16) + (bytes[3] << 8) + bytes[4];
    data.deviceType = typeVal === 0x000215 ? 'ELV-LW-INT1' : String(typeVal);
    data.application = bytes[5] + '.' + bytes[6] + '.' + bytes[7];
    data.bootloader = bytes[8] + '.' + bytes[9] + '.' + bytes[10];
    data.hardware = String.fromCharCode(bytes[11] + 0x40);
    return { data: data };
  }
  // Config-Info, Rejoin-Info, Spreading-Info: configuration / diagnostic
  // frames with no measurement payload. Report the frame type only.
  return { data: data };
}

function decodeStatus(bytes, data) {
  var warnings = [];
  var index = 2;
  while (bytes.length > (index + 2)) {
    // channel id (positional, unused) then sensor id
    index++;
    var sensorId = bytes[index];
    index++;

    if (sensorId === 0) {
      // Device: digital input states & event flags.
      var eventflags = bytes[index];
      index++;
      var states = bytes[index];
      index++;
      data.in1Level = (states & 0x01) ? 'Hi' : 'Lo';
      data.in2Level = (states & 0x10) ? 'Hi' : 'Lo';
      data.in1Changed = !!(states & 0x02);
      data.in2Changed = !!(states & 0x20);
      data.deviceEventCyclic = !!(eventflags & 0x01);
      data.deviceEventBoot = !!(eventflags & 0x02);
      data.deviceEventHeartbeat = !!(eventflags & 0x04);
      data.deviceEventButton = !!(eventflags & 0x08);
    } else if (sensorId === 1) {
      // DUS1 ultrasonic: 16-bit distance (mm) + level (%).
      index++; // eventflags (not surfaced)
      var distance = (bytes[index] * 256) + bytes[index + 1];
      index += 2;
      var level = bytes[index];
      index++;
      if (distance === 8000) {
        data.distanceStatus = 'Error';
      } else if (distance === 7999) {
        data.distanceStatus = 'Unknown';
      } else if (distance === 7501) {
        data.distanceStatus = 'Overflow';
      } else {
        data.distanceMm = distance;
      }
      if (level === 255) {
        data.levelStatus = 'Error';
      } else if (level === 254) {
        data.levelStatus = 'Unknown';
      } else if (level <= 100) {
        data.levelPercent = level;
      }
    } else if (sensorId === 2) {
      // SoMo1H: soil moisture. eventflags, Level (%), 16-bit raw reading.
      index++; // eventflags
      var moisture = bytes[index];
      index++;
      var raw = (bytes[index] * 256) + bytes[index + 1];
      index += 2;
      if (moisture === 255) {
        data.soilMoistureStatus = 'Error';
        warnings.push('SoMo1H moisture: Error');
      } else if (moisture === 254) {
        data.soilMoistureStatus = 'Unknown';
        warnings.push('SoMo1H moisture: Unknown');
      } else if (moisture <= 100) {
        if (!data.soil) { data.soil = {}; }
        data.soil.moisture = moisture;
      }
      if (raw === 8000) {
        data.soilMoistureRawStatus = 'Error';
      } else if (raw === 7999) {
        data.soilMoistureRawStatus = 'Unknown';
      } else if (raw === 4100) {
        data.soilMoistureRawStatus = 'Overflow';
      } else {
        data.soilMoistureRaw = raw;
      }
    } else if (sensorId === 3) {
      // SoMo1T: soil temperature. eventflags, 16-bit signed value * 0.1 C.
      index++; // eventflags
      var rawTemp = (bytes[index] * 256) + bytes[index + 1];
      index += 2;
      if (rawTemp === 8000) {
        data.soilTemperatureStatus = 'Error';
        warnings.push('SoMo1T temperature: Error');
      } else if (rawTemp === 7999) {
        data.soilTemperatureStatus = 'Unknown';
        warnings.push('SoMo1T temperature: Unknown');
      } else if (rawTemp === 1201) {
        data.soilTemperatureStatus = 'Overflow';
        warnings.push('SoMo1T temperature: Overflow');
      } else if (rawTemp === 65135) {
        data.soilTemperatureStatus = 'Underflow';
        warnings.push('SoMo1T temperature: Underflow');
      } else {
        if (rawTemp > 0x7fff) {
          rawTemp -= 0x10000;
        }
        if (!data.soil) { data.soil = {}; }
        data.soil.temperature = round(rawTemp * 0.1, 1);
      }
    } else {
      return { errors: ['unknown Status-Info sensor id ' + sensorId] };
    }
  }

  var result = { data: data };
  if (warnings.length) {
    result.warnings = warnings;
  }
  return result;
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "elv";
    result.data.model = "elv-lw-int1";
  }
  return result;
}
