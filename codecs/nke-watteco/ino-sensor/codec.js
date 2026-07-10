// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for nke-watteco In'O sensor (OEM rebrand of the
// Watteco In'O), a generic I/O interface with 10 opto-coupled digital inputs
// (dry contacts / pulse counters) and 4 relay outputs.
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format (Watteco ZCL-over-LoRa "standard report") understood with reference to
// the upstream Apache-2.0 decoder (TheThingsNetwork/lorawan-devices
// vendor/nke-watteco/ino-sensor.js, attributed in NOTICE). Ported from that
// decoder's standard-report path only (fPort 125, command 0x0A/0x8A/0x01); the
// Huffman "batch" path (byte0 bit0 clear) is NOT implemented and errors.
//
// Standard layout: byte0 frame-control (bit0 SET = standard report; endpoint in
// top bits), byte1 command, bytes2-3 cluster (BE), bytes4-5 attribute (BE),
// byte6 ZCL type, value at offset 7 for cmd 0x0A/0x8A and 8 for cmd 0x01.
// Channel = endpoint; channel 1 (endpoint 0) uses the vocab key, higher
// channels a numbered camelCase extra.
//
// Measurement mapping:
//   cluster 0x000C (12)    attr 0x0055 Analog Input present value (float32)
//                          -> analog.raw (interface value; unit set by the probe)
//   cluster 0x000F (15)    attr 0x0055 Binary Input present value (bool)
//                          -> action.contactState  (true=closed, false=open)
//   cluster 0x000F (15)    attr 0x0402 pulse count (uint32) -> pulse.total
//   cluster 0x8005 (32773) attr 0x0000 consolidated digital states (bitmap16)
//                          -> action.contactState (input 1) + contactStateN extras
//   cluster 0x0050 (80)    attr 0x0006 power config -> battery (mV/1000, volts)
//   cluster 0x0006 (6)     attr 0x0000 relay output state -> outputState extra
// Binary Input convention: present-value true = CLOSED contact, false = OPEN.

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
    ch: endpointOf(bytes[0]),
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
  var ch = hdr.ch;
  var cluster = hdr.cluster;
  var attr = hdr.attr;
  var h = hdr.h;
  var data = {};

  if (cluster === 12 && attr === 85) {
    if (bytes.length < h + 4) {
      return { errors: ['analog report missing 4-byte value'] };
    }
    var raw = round(float32(u32be(bytes[h], bytes[h + 1], bytes[h + 2], bytes[h + 3])), 6);
    if (ch <= 0) {
      data['analog.raw'] = raw;
    } else {
      data['analog' + (ch + 1) + 'Raw'] = raw;
    }
    return { data: data };
  }

  if (cluster === 15 && attr === 85) {
    if (bytes.length < h + 1) {
      return { errors: ['binary input report missing value'] };
    }
    var st = bytes[h] ? 'closed' : 'open';
    if (ch <= 0) {
      data['action.contactState'] = st;
    } else {
      data['contactState' + (ch + 1)] = st;
    }
    return { data: data };
  }

  if (cluster === 15 && attr === 1026) {
    if (bytes.length < h + 4) {
      return { errors: ['pulse report missing 4-byte counter'] };
    }
    var total = u32be(bytes[h], bytes[h + 1], bytes[h + 2], bytes[h + 3]);
    if (ch <= 0) {
      data['pulse.total'] = total;
    } else {
      data['pulseTotal' + (ch + 1)] = total;
    }
    return { data: data };
  }

  if (cluster === 32773 && attr === 0) {
    if (bytes.length < h + 2) {
      return { errors: ['In\'O state report missing 2-byte bitmap'] };
    }
    var low = bytes[h + 1];
    var high = bytes[h];
    var i;
    for (i = 0; i < 8; i++) {
      var s = (low & (1 << i)) ? 'closed' : 'open';
      if (i === 0) {
        data['action.contactState'] = s;
      } else {
        data['contactState' + (i + 1)] = s;
      }
    }
    data.contactState9 = (high & 0x01) ? 'closed' : 'open';
    data.contactState10 = (high & 0x02) ? 'closed' : 'open';
    return { data: data };
  }

  if (cluster === 6 && attr === 0) {
    if (bytes.length < h + 1) {
      return { errors: ['output report missing value'] };
    }
    var okey = ch <= 0 ? 'outputState' : ('outputState' + (ch + 1));
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
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "nke-watteco";
    result.data.model = "ino-sensor";
  }
  return result;
}
