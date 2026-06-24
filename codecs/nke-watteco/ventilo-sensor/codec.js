// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for nke-watteco Ventil'O (differential-pressure /
// airflow + temperature sensor).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format (Watteco ZCL-over-LoRa "standard report") understood with reference to
// the upstream Apache-2.0 decoder (TheThingsNetwork/lorawan-devices
// vendor/nke-watteco/ventilo-sensor.js, attributed in NOTICE). Ported from that
// decoder's standard-report path (Decoder() port===125, decodedBatch===false);
// do NOT copy upstream normalizeUplink.
//
// Watteco frames arrive on fPort 125. Byte 0 bit0 distinguishes the report
// kind: when CLEAR the frame is a Huffman-compressed "batch" frame (upstream
// brUncompress) which requires the per-device coding tables and prior reference
// frames; that state is unavailable to a stateless console codec, so batch
// frames are reported as an error rather than mis-decoded. When SET the frame is
// a ZCL standard report: frame control (byte 0), command id (byte 1), 16-bit
// cluster id (bytes 2-3), 16-bit attribute id (bytes 4-5), a report-parameters
// byte (byte 6) and then the attribute value. Value offset is 7 for data/alarm
// reports (cmd 0x0A / 0x8A) and 8 for the read-attribute response (cmd 0x01).
//
// Measurement-bearing clusters mapped to the shared vocabulary:
//   cluster 0x8008 (32776) attr 0x0000 differential pressure -> pressure.differential
//       (Watteco reports this as a 16-bit value already in Pascals, 1 Pa/count;
//       upstream applies divide=1, i.e. no scaling -> the count is calibrated Pa)
//   cluster 0x0402 (1026) attr 0x0000 temperature -> air.temperature
//       (signed centi-degrees Celsius, value / 100)
//   cluster 0x0050 (80) attr 0x0006 power descriptor -> battery (mV / 1000, volts)
// The lorawan-configuration cluster 0x8004 (32772) attr 0 (message type) carries
// no measurement and is surfaced as the camelCase extra `messageType`.
//
// Divergence from upstream: upstream's power-descriptor handler writes a
// rechargeable/solar/TIC source onto `decoded.data` before that field is the
// measurement array, throwing on those sources. This port mirrors the
// nke-watteco TH / Atm'O / Skydome codecs instead: it emits the first present
// power source as the volts `battery` reading without crashing.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function u16be(hi, lo) {
  return ((hi << 8) | lo) & 0xffff;
}

// Sign-extend a 16-bit two's-complement value.
function s16(u) {
  return u & 0x8000 ? u - 0x10000 : u;
}

function decodeUplink(input) {
  var bytes = input.bytes;
  var fPort = input.fPort;

  if (fPort !== 125) {
    return { errors: ['unsupported fPort ' + fPort + ' (expected 125)'] };
  }
  if (!bytes || bytes.length < 6) {
    return { errors: ['payload too short for a Watteco ZCL report'] };
  }
  // Byte 0 bit0 clear => Huffman batch frame (upstream brUncompress); unsupported.
  if ((bytes[0] & 0x01) === 0) {
    return {
      errors: [
        'batch report not supported (requires per-device coding tables and prior frames)',
      ],
    };
  }

  var cmd = bytes[1];
  var cluster = u16be(bytes[2], bytes[3]);
  var attr = u16be(bytes[4], bytes[5]);

  // Standard data report (cmd 0x0A) or alarm report (cmd 0x8A): value at index 7.
  // Read-attribute response (cmd 0x01): a status byte sits at index 6, value at 8.
  var h;
  if (cmd === 0x0a || cmd === 0x8a) {
    h = 7;
  } else if (cmd === 0x01) {
    h = 8;
  } else {
    return { errors: ['unsupported Watteco command 0x' + cmd.toString(16)] };
  }

  var data = {};

  if (cluster === 32776 && attr === 0) {
    // Differential pressure: 16-bit value, already calibrated in Pascals.
    // Upstream reads this attribute UNSIGNED (no UintToInt call), unlike the
    // temperature attribute; mirror that — the Ventil'O reports the magnitude
    // of the depression in an outdoor ventilation chamber.
    if (bytes.length < h + 2) {
      return { errors: ['standard report missing differential pressure value'] };
    }
    var pa = u16be(bytes[h], bytes[h + 1]);
    data.pressure = { differential: round(pa, 0) };
    return { data: data };
  }
  if (cluster === 1026 && attr === 0) {
    // Temperature: signed centi-degrees Celsius.
    if (bytes.length < h + 2) {
      return { errors: ['standard report missing temperature value'] };
    }
    var t = s16(u16be(bytes[h], bytes[h + 1])) / 100;
    data.air = { temperature: round(t, 2) };
    return { data: data };
  }
  if (cluster === 80 && attr === 6) {
    // Power configuration report. A presence-flags byte (h+2) selects which
    // 2-byte millivolt sources follow from h+3; emit the first present one as
    // the volts battery reading.
    if (bytes.length < h + 3) {
      return { errors: ['power report missing flags byte'] };
    }
    var flags = bytes[h + 2];
    var p = h + 3;
    var voltage;
    // bit0 external/main, bit1 rechargeable, bit2 disposable battery,
    // bit3 solar, bit4 TIC harvesting — each a 2-byte millivolt value.
    if ((flags & 0x01) && p + 1 < bytes.length) {
      voltage = u16be(bytes[p], bytes[p + 1]) / 1000;
    } else if ((flags & 0x02) && p + 1 < bytes.length) {
      voltage = u16be(bytes[p], bytes[p + 1]) / 1000;
    } else if ((flags & 0x04) && p + 1 < bytes.length) {
      voltage = u16be(bytes[p], bytes[p + 1]) / 1000;
    } else if ((flags & 0x08) && p + 1 < bytes.length) {
      voltage = u16be(bytes[p], bytes[p + 1]) / 1000;
    } else if ((flags & 0x10) && p + 1 < bytes.length) {
      voltage = u16be(bytes[p], bytes[p + 1]) / 1000;
    }
    if (voltage === undefined) {
      return { errors: ['power report carried no battery source'] };
    }
    data.battery = round(voltage, 3);
    return { data: data };
  }
  if (cluster === 32772 && attr === 0) {
    // LoRaWAN configuration: message type. No measurement; surface as an extra.
    if (bytes.length <= h) {
      return { errors: ['lorawan config report missing value'] };
    }
    data.messageType = bytes[h] === 1 ? 'confirmed' : 'unconfirmed';
    return { data: data };
  }

  return {
    errors: ['unrecognized Watteco cluster ' + cluster + ' attribute ' + attr],
  };
}
