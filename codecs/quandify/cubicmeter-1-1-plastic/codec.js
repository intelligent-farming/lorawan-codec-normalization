// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for quandify/cubicmeter-1-1-plastic (Quandify CubicMeter 1.1 Plastic).
// Category: water-meter.
//
// Ported from the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/quandify/cubicmeter-1-1-uplink.js,
// attributed in NOTICE). The wire format and scaling were taken from that
// reference; the normalization below is authored for this repo's vocabulary and
// does NOT reuse the upstream normalizeUplink (which emits a top-level array and
// no water.temperature.current).
//
// Wire format (fPort 1, status report, 28 bytes, little-endian):
//   error           u16 @4   (bit 0x8000 = NOT sensing; low 15 bits = error code)
//   totalVolume     u32 @6   litres, all-time cumulative
//   leakState       u8  @22  (3=medium, 4=large leak -> water.leak true)
//   batteryActive   u8  @23  -> 1800 + (v<<3) mV
//   batteryRecovered u8 @24  -> 1800 + (v<<3) mV
//   waterTempMin    u8  @25  -> v*0.5 - 20 degC
//   waterTempMax    u8  @26  -> v*0.5 - 20 degC
//   ambientTemp     u8  @27  -> v*0.5 - 20 degC

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function u16le(bytes, off) {
  return bytes[off] | (bytes[off + 1] << 8);
}

function u32le(bytes, off) {
  return (
    bytes[off] +
    bytes[off + 1] * 256 +
    bytes[off + 2] * 65536 +
    bytes[off + 3] * 16777216
  );
}

function decodeBatteryMv(v) {
  return 1800 + (v << 3);
}

function decodeTempC(v) {
  return v * 0.5 - 20.0;
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;
  var fPort = input.fPort;

  if (fPort !== 1) {
    return {
      errors: [
        'unsupported fPort ' +
          fPort +
          ': only fPort 1 (status report) yields normalized measurements',
      ],
    };
  }

  if (!bytes || bytes.length !== 28) {
    return {
      errors: [
        'wrong payload length (' +
          (bytes ? bytes.length : 0) +
          '), status report should be 28 bytes',
      ],
    };
  }

  var error = u16le(bytes, 4);
  var isSensing = !(error & 0x8000);
  var errorCode = error & 0x7fff;

  var totalVolume = u32le(bytes, 6); // litres, cumulative
  var leakState = bytes[22];
  var batteryActiveMv = decodeBatteryMv(bytes[23]);
  var batteryRecoveredMv = decodeBatteryMv(bytes[24]);
  var waterTempMin = decodeTempC(bytes[25]);
  var waterTempMax = decodeTempC(bytes[26]);
  var ambientTemp = decodeTempC(bytes[27]);

  var leak = leakState === 3 || leakState === 4;

  var data = {
    metering: {
      water: {
        total: totalVolume, // L
      },
    },
    water: {
      temperature: {
        min: round(waterTempMin, 1),
        max: round(waterTempMax, 1),
        current: round((waterTempMin + waterTempMax) / 2, 1),
      },
      leak: leak,
    },
    air: {
      temperature: round(ambientTemp, 1),
    },
    battery: round(batteryRecoveredMv / 1000, 3), // V (recovered)
    // extras: vendor diagnostics the vocabulary does not model
    errorCode: errorCode,
    isSensing: isSensing,
    leakState: leakState,
    batteryActiveMv: batteryActiveMv,
    batteryRecoveredMv: batteryRecoveredMv,
  };

  var warnings = [];
  if (!isSensing) {
    warnings.push('Not sensing water');
  }
  if (errorCode) {
    warnings.push(
      errorCode === 384 ? 'Reverse flow' : 'Contact support, error ' + errorCode
    );
  }
  if (batteryRecoveredMv <= 3100) {
    warnings.push('Low battery');
  }

  if (warnings.length) {
    return { data: data, warnings: warnings };
  }
  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "quandify";
    result.data.model = "cubicmeter-1-1-plastic";
  }
  return result;
}
