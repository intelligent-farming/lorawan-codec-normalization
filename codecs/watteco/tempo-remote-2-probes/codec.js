// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Watteco Temp'O remote 2 probes, a dual-probe
// temperature sensor.
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format (Watteco ZCL-over-LoRa "standard report") understood with reference
// to the upstream Apache-2.0 decoder (TheThingsNetwork/lorawan-devices
// vendor/watteco/tempo-remote-2-probes.js, attributed in NOTICE). Ported from
// that decoder's standard-report path only (fPort 125, command 0x0A/0x8A/0x01);
// do NOT copy upstream normalizeUplink.
//
// Watteco frames arrive on fPort 125. Byte 0 bit0 distinguishes the report
// kind: when SET the frame is a ZCL standard report; when CLEAR it is a
// Huffman-compressed "batch" frame (upstream brUncompress / normalisation_batch)
// which this codec does NOT decode and reports as an error. A standard data
// report carries the frame control (byte 0), command id (byte 1), 16-bit
// cluster id (bytes 2-3), 16-bit attribute id (bytes 4-5), a ZCL data-type byte
// (byte 6) and then the attribute value. Value offset is 7 for data/alarm
// reports (cmd 0x0A / 0x8A) and 8 for the read-attribute response (cmd 0x01).
//
// This device has two temperature probes distinguished by the ZCL endpoint,
// which upstream packs into the frame-control byte:
//   endpoint = ((byte0 & 0xE0) >> 5) | ((byte0 & 0x06) << 2)
// Both probes report cluster 0x0402 attr 0, and a ZCL standard report carries
// ONE attribute of ONE endpoint — so a frame yields exactly one probe reading.
// That reading rides in a single entry of the reserved `channels` array (see
// AUTHORING.md "Multi-channel devices"), labelled with Watteco's own
// positional term, the ZCL endpoint: `endpoint0` (probe 1), `endpoint1`
// (probe 2). Upstream renames the same value temperature_1 / temperature_2 off
// the endpoint index; we keep the endpoint itself as the label because it is
// the identifier the wire format actually carries. The endpoint is decoded
// generically, so nothing is special-cased per probe: whatever endpoint a
// frame reports becomes that frame's entry label. This retires the former
// `temperature2` suffixed extra.
//
// Measurement mapping:
//   cluster 0x0402 (1026) attr 0 -> channels[{ channel: 'endpoint<n>',
//                                   temperature }] (signed centi-deg C / 100)
//   cluster 0x0050 (80)   attr 6 power -> battery (mV / 1000, volts), which
//                                   stays TOP-LEVEL: the power rail is a
//                                   whole-device reading, not a probe's. A
//                                   power report carries no temperature, so it
//                                   emits no `channels` key at all.
//
// Sentinel policy: the standard-report wire format defines NO invalid or
// disconnected encoding for temperature. Upstream sign-extends the 16-bit
// value (UintToInt) and publishes whatever comes out; ZCL's nominal 0x8000
// "invalid value" is not honoured by the upstream decoder, so this codec does
// not invent one either — no value is treated as a sentinel and no entry is
// ever suppressed for one. An absent or unplugged probe simply stops reporting
// on its endpoint: no frame, no entry (and `channels` is omitted entirely on
// frames that carry no temperature). An endpoint this device does not have is
// still passed through under its own `endpoint<n>` label rather than dropped —
// upstream's shared driver would mark an unused endpoint "NA" in its per-device
// label table (publishing the string "NA"), but this device's table declares
// both endpoints, so no "NA" case exists here; an endpoint past the end of that
// table loses its label upstream altogether.

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
  var fPort = input.fPort;

  if (fPort !== 125) {
    return { errors: ['unsupported fPort ' + fPort + ' (expected 125)'] };
  }
  if (!bytes || bytes.length < 6) {
    return { errors: ['payload too short for a Watteco ZCL report'] };
  }
  // Byte 0 bit0 clear => Huffman batch frame (upstream brUncompress); unsupported.
  if ((bytes[0] & 0x01) === 0) {
    return { errors: ['Watteco batch frame not supported (standard reports only)'] };
  }

  var endpoint = ((bytes[0] & 0xe0) >> 5) | ((bytes[0] & 0x06) << 2);
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

  if (cluster === 1026 && attr === 0) {
    // Temperature: signed 16-bit centi-degrees Celsius. The frame's endpoint is
    // the probe position, so the reading rides in one channels entry labelled
    // for that endpoint (no per-probe special-casing, no sentinel to skip).
    if (bytes.length < h + 2) {
      return { errors: ['standard report missing temperature value'] };
    }
    var t = round(s16be(bytes[h], bytes[h + 1]) / 100, 2);
    data.channels = [{ channel: 'endpoint' + endpoint, temperature: t }];
    return { data: data };
  }
  if (cluster === 80 && attr === 6) {
    // Power configuration report. A presence-flags byte at h+2 selects which
    // 2-byte millivolt sources follow from h+3 (bit0 external, bit1 rechargeable,
    // bit2 disposable battery, bit3 solar, bit4 TIC). Emit the first present
    // source, in wire (bit) order, as the volts battery reading.
    if (bytes.length < h + 3) {
      return { errors: ['power report missing flags byte'] };
    }
    var flags = bytes[h + 2];
    var p = h + 3;
    var voltage;
    var bit;
    for (bit = 0; bit < 5; bit++) {
      if ((flags & (1 << bit)) && p + 1 < bytes.length) {
        voltage = u16be(bytes[p], bytes[p + 1]) / 1000;
        break;
      }
    }
    if (voltage === undefined) {
      return { errors: ['power report carried no battery source'] };
    }
    data.battery = round(voltage, 3);
    return { data: data };
  }

  return {
    errors: ['unrecognized Watteco cluster ' + cluster + ' attribute ' + attr],
  };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "watteco";
    result.data.model = "tempo-remote-2-probes";
  }
  return result;
}
