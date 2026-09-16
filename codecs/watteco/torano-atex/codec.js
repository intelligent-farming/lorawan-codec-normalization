// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Watteco Toran'O ATEX, an ATEX-rated I/O
// interface node: analog inputs (0-5 V / 4-20 mA), dry contacts and pulse
// counters, functionally identical on the wire to In'O.
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format (Watteco ZCL-over-LoRa "standard report") understood with reference to
// the upstream Apache-2.0 decoder (TheThingsNetwork/lorawan-devices
// vendor/watteco/torano-atex.js, attributed in NOTICE). Ported from that
// decoder's standard-report path only (fPort 125, command 0x0A/0x8A/0x01); the
// Huffman "batch" path (byte0 bit0 clear) is NOT implemented and errors. Do NOT
// copy upstream normalizeUplink.
//
// Standard report layout: byte0 frame-control (bit0 SET = standard report; the
// endpoint rides in the top bits), byte1 command id, bytes2-3 cluster id (BE),
// bytes4-5 attribute id (BE), byte6 ZCL data-type, then the attribute value.
// Value offset is 7 for data/alarm reports (cmd 0x0A / 0x8A) and 8 for the
// read-attribute response (cmd 0x01).
//
// The inputs are distinguished by the ZCL endpoint, which upstream packs into
// the frame-control byte:
//   endpoint = ((byte0 & 0xE0) >> 5) | ((byte0 & 0x06) << 2)
// A ZCL standard report carries ONE attribute of ONE endpoint, so such a frame
// yields exactly one input reading. It rides in a single entry of the reserved
// `channels` array (see AUTHORING.md "Multi-channel devices"), labelled with
// Watteco's own positional term, the ZCL endpoint: `endpoint0` is Toran'O input
// 1 (the same position In'O calls input 1), `endpoint1` input 2, … up to
// `endpoint9` (input 10) on the shared ten-input In'O platform. Upstream renames
// the same values `analog_input_<endpoint + 1>` / `index_<endpoint + 1>` /
// `pin_state_<endpoint + 1>`; we keep the endpoint itself as the label because
// it is the identifier the wire format actually carries. The endpoint is decoded
// generically, so nothing is special-cased per input: whatever endpoint a frame
// reports becomes that frame's entry label, carrying the vocabulary key for that
// frame's measurement type. This retires the former `analog2Raw`, `pulseTotal2`
// and `contactState2` … `contactState10` suffixed extras, and with them the old
// behaviour where a frame from an endpoint past the hard-coded list was
// mis-attributed (silently renamed) instead of labelled for its position.
//
// The one exception to "one frame, one endpoint" is the proprietary
// multi-binary-input cluster 0x8005: its single bitmap16 value enumerates ten
// inputs at once, so that frame emits ten entries, `endpoint0` … `endpoint9`,
// one per bit (bits 0-7 = inputs 1-8 in the low byte, bits 8-9 = inputs 9-10 in
// the high byte). Nothing is fabricated there — every bit is present on the
// wire. The frame's own endpoint field is not a position for this cluster and is
// ignored, exactly as upstream fixes its pin_state_1 … pin_state_10 labels
// regardless of the endpoint the frame arrived on.
//
// Measurement mapping — each of these rides INSIDE the frame's channels entry:
//   cluster 0x000C (12)    attr 0x0055 Analog Input present value (float32)
//                          -> analog.raw (interface value; unit set by the probe)
//   cluster 0x000F (15)    attr 0x0055 Binary Input present value (bool)
//                          -> action.contactState (true=closed, false=open)
//   cluster 0x000F (15)    attr 0x0402 pulse count (uint32)
//                          -> pulse.total (cumulative index)
//   cluster 0x8005 (32773) attr 0x0000 consolidated digital states (bitmap16)
//                          -> action.contactState, one entry per input
// Whole-device and actuator readings stay TOP-LEVEL (never also inside an entry
// — downstream stores would double-count a leaf emitted in both places):
//   cluster 0x0050 (80)    attr 0x0006 power config -> battery (mV / 1000,
//                          volts). The rail is a whole-device reading, not an
//                          input's; a power report carries no input value, so it
//                          emits no `channels` key at all.
//   cluster 0x0006 (6)     attr 0x0000 relay output state -> outputState /
//                          outputState<endpoint + 1> extra ("ON"/"OFF"). A relay
//                          is actuator state, not a measured position, so per
//                          AUTHORING.md the extra stays top-level and is named
//                          for what it identifies; only measured inputs are
//                          positions here.
// Binary Input convention: present-value true = CLOSED contact, false = OPEN.
//
// Sentinel policy: the standard-report wire format defines NO invalid or
// disconnected encoding for any of these clusters. A Binary Input present value
// is a raw byte, the pulse index a plain uint32, and the Analog Input value a
// pass-through IEEE-754 float32; ZCL's nominal 0x8000 "invalid value" is not
// honoured by the upstream decoder for any of them, so this codec does not
// invent a sentinel either — no value is treated as one and no entry is ever
// suppressed for one. An unwired input simply stops reporting on its endpoint:
// no frame, no entry (and `channels` is omitted entirely on frames that carry no
// input value). The one consolidated 0x8005 frame always carries every bit, so
// an unwired input reads "open" there rather than being absent — the device
// gives no way to tell the two apart, and inventing one would be a guess.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function u16be(hi, lo) {
  return ((hi << 8) | lo) & 0xffff;
}

function u32be(b0, b1, b2, b3) {
  return (b0 * 0x1000000) + (b1 << 16) + (b2 << 8) + b3;
}

function float32(u) {
  var sign = (u & 0x80000000) ? -1 : 1;
  var exp = (u >> 23) & 0xff;
  var mant = u & 0x7fffff;
  if (exp === 0xff) {
    return mant ? NaN : sign * Infinity;
  }
  if (exp === 0) {
    return sign * mant * Math.pow(2, -149);
  }
  return sign * (mant + 0x800000) * Math.pow(2, exp - 150);
}

// ZCL endpoint (the input position) packed into frame-control byte 0.
function endpointOf(b0) {
  return ((b0 & 0xe0) >> 5) | ((b0 & 0x06) << 2);
}

function watHeader(input) {
  var bytes = input.bytes;
  if (input.fPort !== 125) {
    return { err: 'unsupported fPort ' + input.fPort + ' (expected 125)' };
  }
  if (!bytes || bytes.length < 6) {
    return { err: 'payload too short for a Watteco ZCL report' };
  }
  if ((bytes[0] & 0x01) === 0) {
    return { err: 'Watteco batch frame not supported (standard reports only)' };
  }
  var cmd = bytes[1];
  var h;
  if (cmd === 0x0a || cmd === 0x8a) {
    h = 7;
  } else if (cmd === 0x01) {
    h = 8;
  } else {
    return { err: 'unsupported Watteco command 0x' + cmd.toString(16) };
  }
  return {
    ep: endpointOf(bytes[0]),
    cmd: cmd,
    cluster: u16be(bytes[2], bytes[3]),
    attr: u16be(bytes[4], bytes[5]),
    h: h
  };
}

function decodeBattery(bytes, h) {
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
  return { data: { battery: round(voltage, 3) } };
}

function decodeUplinkCore(input) {
  var hdr = watHeader(input);
  if (hdr.err) {
    return { errors: [hdr.err] };
  }
  var bytes = input.bytes;
  var ep = hdr.ep;
  var cluster = hdr.cluster;
  var attr = hdr.attr;
  var h = hdr.h;
  var data = {};

  // Analog Input present value: 32-bit IEEE-754 float, no wire unit -> raw.
  if (cluster === 12 && attr === 85) {
    if (bytes.length < h + 4) {
      return { errors: ['analog report missing 4-byte value'] };
    }
    var raw = round(float32(u32be(bytes[h], bytes[h + 1], bytes[h + 2], bytes[h + 3])), 6);
    data.channels = [{ channel: 'endpoint' + ep, analog: { raw: raw } }];
    return { data: data };
  }

  // Binary Input present value: dry-contact state of this frame's endpoint.
  if (cluster === 15 && attr === 85) {
    if (bytes.length < h + 1) {
      return { errors: ['binary input report missing value'] };
    }
    var st = bytes[h] ? 'closed' : 'open';
    data.channels = [{ channel: 'endpoint' + ep, action: { contactState: st } }];
    return { data: data };
  }

  // Binary Input pulse counter (cumulative index): uint32 on this endpoint.
  if (cluster === 15 && attr === 1026) {
    if (bytes.length < h + 4) {
      return { errors: ['pulse report missing 4-byte counter'] };
    }
    var total = u32be(bytes[h], bytes[h + 1], bytes[h + 2], bytes[h + 3]);
    data.channels = [{ channel: 'endpoint' + ep, pulse: { total: total } }];
    return { data: data };
  }

  // Consolidated digital input states (bitmap16) at h..h+1: bit i is input
  // i+1 = endpoint i (inputs 1-8 in the low byte, 9-10 in the high byte). This
  // frame carries every input, hence one entry per bit.
  if (cluster === 32773 && attr === 0) {
    if (bytes.length < h + 2) {
      return { errors: ['Toran\'O state report missing 2-byte bitmap'] };
    }
    var bitmap = u16be(bytes[h], bytes[h + 1]);
    var entries = [];
    var i;
    for (i = 0; i < 10; i++) {
      entries.push({
        channel: 'endpoint' + i,
        action: { contactState: (bitmap & (1 << i)) ? 'closed' : 'open' }
      });
    }
    data.channels = entries;
    return { data: data };
  }

  // Relay output state (actuator echo): not a measured input position, so it
  // stays a top-level extra named for what it identifies (see header).
  if (cluster === 6 && attr === 0) {
    if (bytes.length < h + 1) {
      return { errors: ['output report missing value'] };
    }
    var okey = ep <= 0 ? 'outputState' : ('outputState' + (ep + 1));
    data[okey] = bytes[h] ? 'ON' : 'OFF';
    return { data: data };
  }

  if (cluster === 80 && attr === 6) {
    return decodeBattery(bytes, h);
  }

  return {
    errors: ['unrecognized Watteco cluster ' + cluster + ' attribute ' + attr]
  };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  // fPort 0 carries MAC commands only (LoRaWAN spec): there is no application
  // payload to decode, so this is not a decode failure. See AUTHORING.md.
  if (input && input.fPort === 0) {
    return { data: { make: "watteco", model: "torano-atex" } };
  }
  if (!input || !input.bytes || input.bytes.length === 0) {
    return { errors: ['empty payload: no application bytes to decode'] };
  }

  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "watteco";
    result.data.model = "torano-atex";
  }
  return result;
}
