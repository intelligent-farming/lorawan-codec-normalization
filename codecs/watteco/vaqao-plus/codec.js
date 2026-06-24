// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Watteco Vaqa'O+ (indoor air-quality monitor:
// temperature, relative humidity, CO2, IAQ, illuminance, pressure, motion).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format (Watteco ZCL-over-LoRa "standard report") understood with reference to
// the upstream Apache-2.0 decoder (TheThingsNetwork/lorawan-devices
// vendor/watteco/vaqao-lite.js, attributed in NOTICE). The upstream
// normalizeUplink is NOT copied; the normalization below is authored here.
//
// Scope: this codec decodes Watteco "standard report" uplinks (fPort 125, first
// byte odd). The Huffman-compressed "batch report" format (first byte even) is a
// stateful, multi-series time-compression scheme that this normalized codec does
// not reimplement; such payloads are reported as an error rather than guessed.
//
// Watteco reports a Sensirion-style IAQ index that has no vocabulary key, so it
// is emitted as the camelCase extra `iaq`. Battery is reported as a voltage and
// maps to the vocabulary `battery` (V).

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

function decodeUplinkCore(input) {
  var bytes = input.bytes;

  if (!bytes || bytes.length < 2) {
    return { errors: ['empty payload'] };
  }
  if (input.fPort !== 125) {
    return { errors: ['unsupported fPort ' + input.fPort + ' (expected 125)'] };
  }

  // First byte odd => standard report; even => batch report.
  if ((bytes[0] & 1) === 0) {
    return { errors: ['batch (compressed) report not supported by this codec'] };
  }

  var cmd = bytes[1];

  // 0x0A = ReportAttributes, 0x8A = ReportAttributesAlarm, 0x01 = ReadAttributesResponse.
  if (cmd !== 0x0a && cmd !== 0x8a && cmd !== 0x01) {
    return { errors: ['unsupported ZCL command 0x' + cmd.toString(16)] };
  }
  if (bytes.length < 6) {
    return { errors: ['truncated standard report'] };
  }

  var cluster = u16be(bytes[2], bytes[3]);
  var attr = u16be(bytes[4], bytes[5]);

  // Data offset: ReportAttributes carries a 1-byte ZCL type at index 6, so the
  // value begins at index 7. ReadAttributesResponse carries a status byte and
  // the value begins at index 8.
  var h = cmd === 0x01 ? 8 : 7;

  var data = {};
  var air = {};
  var recognized = false;

  if (cluster === 1026 && attr === 0) {
    // Temperature, hundredths of a degree, signed.
    if (bytes.length < h + 2) {
      return { errors: ['truncated temperature report'] };
    }
    air.temperature = round(s16be(bytes[h], bytes[h + 1]) / 100, 2);
    recognized = true;
  } else if (cluster === 1029 && attr === 0) {
    // Relative humidity, hundredths of a percent, unsigned.
    if (bytes.length < h + 2) {
      return { errors: ['truncated humidity report'] };
    }
    air.relativeHumidity = round(u16be(bytes[h], bytes[h + 1]) / 100, 2);
    recognized = true;
  } else if (cluster === 1027 && attr === 0) {
    // Atmospheric pressure, hPa, signed.
    if (bytes.length < h + 2) {
      return { errors: ['truncated pressure report'] };
    }
    air.pressure = s16be(bytes[h], bytes[h + 1]);
    recognized = true;
  } else if (cluster === 1024 && attr === 0) {
    // Illuminance, lux, unsigned.
    if (bytes.length < h + 2) {
      return { errors: ['truncated illuminance report'] };
    }
    air.lightIntensity = u16be(bytes[h], bytes[h + 1]);
    recognized = true;
  } else if (cluster === 32780 && attr === 0) {
    // IAQ index (no vocabulary key) -> camelCase extra.
    if (bytes.length < h + 2) {
      return { errors: ['truncated IAQ report'] };
    }
    data.iaq = u16be(bytes[h], bytes[h + 1]);
    recognized = true;
  } else if (cluster === 80 && attr === 6) {
    // Power-status report. bytes[h+2] is a present-source bitmask; the present
    // voltages (mV, big-endian uint16) follow at bytes[h+3] in source order:
    // bit0 main/external, bit1 rechargeable, bit2 disposable, bit3 solar,
    // bit4 TIC. We surface a single battery voltage, preferring the disposable
    // / rechargeable cell over a mains/external supply.
    if (bytes.length < h + 3) {
      return { errors: ['truncated battery report'] };
    }
    var present = bytes[h + 2];
    var p = h + 3;
    var srcBit;
    var mainV;
    var cellV;
    for (srcBit = 0; srcBit < 5; srcBit++) {
      if ((present & (1 << srcBit)) !== 0) {
        if (bytes.length < p + 2) {
          return { errors: ['truncated battery voltage'] };
        }
        var v = u16be(bytes[p], bytes[p + 1]) / 1000;
        p += 2;
        if (srcBit === 1 || srcBit === 2) {
          cellV = v;
        } else if (srcBit === 0) {
          mainV = v;
        }
      }
    }
    if (cellV !== undefined) {
      data.battery = round(cellV, 3);
      recognized = true;
    } else if (mainV !== undefined) {
      data.battery = round(mainV, 3);
      recognized = true;
    }
  }

  if (!recognized) {
    return {
      errors: [
        'unhandled standard report cluster ' + cluster + ' attribute ' + attr
      ]
    };
  }

  if (
    air.temperature !== undefined ||
    air.relativeHumidity !== undefined ||
    air.pressure !== undefined ||
    air.lightIntensity !== undefined
  ) {
    data.air = air;
  }

  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "watteco";
    result.data.model = "vaqao-plus";
  }
  return result;
}
