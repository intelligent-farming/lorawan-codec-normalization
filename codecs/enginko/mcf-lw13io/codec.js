// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for enginko/mcf-lw13io (Enginko EGK-LW13IO LoRaWAN I/O module:
// one opto-isolated digital input and one relay output; also reports pulse
// counters when a channel is configured as a counter). Category: analog-interface.
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format understood with reference to the upstream Apache-2.0 enginko decoder (mcf88 hardware, shared codec)
// (TheThingsNetwork/lorawan-devices vendor/mcf88/decoder-digital.js, attributed
// in NOTICE). Upstream converts each status byte to a bare binary string
// (inputStatus8_1, outputStatus8_1, ...) and a locale-formatted date string;
// this module authors normalized vocabulary keys and boolean per-channel extras.
// Upstream normalization is never copied.
//
// Frame is selected by byte[0] (uplink id):
//   0x0A I/O status : [0x0A, date(4), inputStatus(4), outputStatus(4), trigger(4)]
//        inputStatus[0] bit b = input (b+1) state (1 = active).
//        outputStatus[0] bit b = output (b+1) state.
//   0x10 digital counters, sub-type byte[1]:
//        0x00 counter list: repeated 2-byte little-endian counters
//        (value = (byte[i+1]<<8) + byte[i]).
//
// Mapping into the normalized vocabulary:
//   input 1                 -> action.contactState ('closed' if active else 'open')
//   inputs 2..16            -> input2..input16 (boolean camelCase extras)
//   outputs 1..8            -> output1..output8 (boolean camelCase extras)
//   first counter (0x10)    -> pulse.count; further counters -> count2..countN
// The embedded date is locale-dependent in upstream and is not emitted. Frames
// other than 0x0A / 0x10 carry no interface reading and return an error.

function bitStates(byteVal) {
  var s = [];
  var i;
  for (i = 0; i < 8; i++) {
    s.push(Boolean(byteVal & (1 << i)));
  }
  return s;
}

function decodeIoStatus(bytes) {
  // id(1) + date(4) = 5, then input(4), output(4), trigger(4).
  if (bytes.length < 9) {
    return { errors: ['I/O status frame too short'] };
  }
  var inputs = bitStates(bytes[5])
    .concat(bitStates(bytes[6]))
    .concat(bitStates(bytes[7]))
    .concat(bitStates(bytes[8]));
  var outputs = bitStates(bytes[9]);

  var data = { action: { contactState: inputs[0] ? 'closed' : 'open' } };
  var i;
  for (i = 1; i < 16; i++) {
    data['input' + (i + 1)] = inputs[i];
  }
  for (i = 0; i < 8; i++) {
    data['output' + (i + 1)] = outputs[i];
  }
  data.frameType = 'ioStatus';
  return { data: data };
}

function decodeCounters(bytes) {
  var subType = bytes[1];
  if (subType !== 0x00) {
    return { errors: ['unsupported digital sub-type 0x' + subType.toString(16)] };
  }
  var counts = [];
  var i;
  for (i = 2; i + 1 < bytes.length; i += 2) {
    counts.push(((bytes[i + 1] & 0xff) << 8) + (bytes[i] & 0xff));
  }
  if (counts.length === 0) {
    return { errors: ['counter frame carries no counter'] };
  }
  var data = { pulse: { count: counts[0] } };
  for (i = 1; i < counts.length; i++) {
    data['count' + (i + 1)] = counts[i];
  }
  data.frameType = 'counters';
  return { data: data };
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;
  if (!bytes || bytes.length < 2) {
    return { errors: ['empty or truncated payload'] };
  }

  var id = bytes[0];
  if (id === 0x0a) {
    return decodeIoStatus(bytes);
  }
  if (id === 0x10) {
    return decodeCounters(bytes);
  }
  return {
    errors: ['uplink id 0x' + id.toString(16) +
      ' carries no I/O interface reading (this codec decodes 0x0A and 0x10)']
  };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "enginko";
    result.data.model = "mcf-lw13io";
  }
  return result;
}
