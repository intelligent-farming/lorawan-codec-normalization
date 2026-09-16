// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for mcf88/mcf-lw13io (MCF-LW13IO LoRaWAN I/O module:
// one opto-isolated digital input and one relay output; also reports pulse
// counters when a channel is configured as a counter). Category: analog-interface.
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format understood with reference to the upstream Apache-2.0 mcf88 decoder
// (TheThingsNetwork/lorawan-devices vendor/mcf88/decoder-digital.js, attributed
// in NOTICE). Upstream converts each status byte to a bare binary string
// (inputStatus8_1, outputStatus8_1, ...) and a locale-formatted date string;
// this module authors normalized vocabulary keys, channels[] entries and boolean
// output extras. Upstream normalization is never copied.
//
// Frame is selected by byte[0] (uplink id):
//   0x0A I/O status : [0x0A, date(4), inputStatus(4), outputStatus(4), trigger(4)]
//        inputStatus[0] bit b = input (b+1) state (1 = active).
//        outputStatus[0] bit b = output (b+1) state.
//   0x10 digital counters, sub-type byte[1]:
//        0x00 counter list: repeated 2-byte little-endian counters
//        (value = (byte[i+1]<<8) + byte[i]).
//
// Multi-position shape (`channels[]`): the digital inputs are this board's genuine
// measured positions — the same quantity read at several isolated input terminals
// of one device — so each rides in the reserved `channels` array (see AUTHORING.md
// "Multi-channel devices") instead of the suffixed `input2` ... `input16` extras
// this codec used to emit. Entries are labelled with the vendor's own term plus a
// zero-based index, `input0` ... `input15`. The labels are zero-based while the
// vendor's own field names are one-based, so `input0` IS THE BOARD'S INPUT 1
// (upstream inputStatus8_1 bit 0), `input1` is input 2, ... `input15` is input 16.
// Per frame type an entry carries:
//   0x0A I/O status -> action.contactState: 'closed' when the input bit is active
//        (1), 'open' when it is not — the exact polarity the pre-channels codec
//        used, unchanged.
//   0x10 counters   -> pulse.count for that input (see below).
//
// Pulse counters are PER-INPUT, not one whole-device counter. Established from
// the wire format: upstream parseDigitalData (0x10, sub-type 0x00) walks the
// payload in 2-byte steps and emits a (`measure`, `counter`) pair per step, where
// `measure` is the 1-based index of the input the counter belongs to and runs up
// to the family's 16 inputs. Counter n therefore belongs to input n, and each
// counter goes INSIDE its input's entry as pulse.count — the first pair
// (upstream measure 1) into `input0`, the second into `input1`, and so on. The
// old top-level `pulse.count` (which surfaced the first counter only) and the
// suffixed `count2` ... `countN` extras both retire with this.
//
// Relay outputs stay TOP-LEVEL extras — a deliberate, reviewed exception. The
// output states are surfaced as the extras `output1` ... `output8` (boolean,
// true = energized/ON) and are NOT converted to `channels[]` entries: an output
// is actuator state the network server commanded, not a measured sub-sensor
// reading, and AUTHORING explicitly allows naming an extra for something that is
// not a measured position. Mixing outputs into the same `channels` array as the
// inputs would also make an output indistinguishable from an input to a
// downstream flattener that treats every entry as telemetry. This is a policy
// call on outputs, not a settled convention: a reviewer may later want an
// output-position policy of its own (a separate reserved container, or an
// `outputs[]`-style extra) — which would supersede these eight suffixed extras.
// Until then, only the measured input positions become channel entries. The
// sibling netvox/r831d applies exactly this policy to its `relay1` ... `relay3`.
//
// Whole-device values stay top-level: `frameType` (the frame discriminator) plus
// the output extras above. Neither decodable frame carries a battery voltage,
// temperature or other whole-device diagnostic, so none is emitted; the embedded
// date is locale-dependent in upstream and is not emitted either. No leaf is
// emitted both inside an entry and at the top level. The `analog-interface`
// category still resolves through the entries — its atLeastOne list includes both
// `action.contactState` (0x0A frames) and `pulse.count` (0x10 frames), and
// membership sees through top-level `channels[]` entries.
//
// Known limitation — a fixed 16 entries, not the variant's physical input count:
// the 0x0A frame is fixed-width and always carries the full input-status bitfield
// regardless of how many inputs the specific model physically has, and nothing in
// the frame reports the board's input count. This codec therefore emits an entry
// for every input the frame carries (16) rather than inferring a per-variant
// count, so a one-input MCF-LW13IO reports `input1` ... `input15` as 'open'
// beside its one real reading in `input0`. That is the pre-channels behavior
// (which emitted `input2` ... `input16` the same way) preserved deliberately; a
// follow-up could narrow the emitted positions from device metadata (the sibling
// ATIM DIND family has the same property). Upstream also decodes two further
// input-status bytes (bytes[7], bytes[8] = inputs 17-32) and three further output
// bytes; the maxima across this product family are 16 inputs and 8 outputs, so —
// as before — only the first 16 input bits and first 8 output bits are surfaced.
// Counters are not assumed either: the entry count follows the number of 2-byte
// counters the frame actually carries.
//
// Sentinel policy: the frame defines NO per-input "disconnected" encoding. Every
// input bit is a valid contact state (1 = closed, 0 = open) and every counter
// value is a valid count, so no reading is treated as a sentinel and no position
// is ever skipped on its value — an unwired terminal is indistinguishable from an
// open contact. `channels` is built lazily per frame and omitted when a frame
// carries no per-input reading: 0x0A carries contact states, 0x10 carries
// counters (a counter frame with no counter pair errors out before any entry is
// built, so `channels` is never emitted empty), and every other uplink id returns
// an error with no data. The length guard below covers all four input-status
// bytes (bytes[5..8]), so no entry is ever built from an `undefined` byte. The
// output byte bytes[9] sits just outside that guard, so a minimal 9-byte 0x0A
// frame reports all eight outputs as false — pre-existing behavior, left
// unchanged (outputs are top-level extras, not entries), noted as a follow-up.

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

  var data = {};
  var i;
  // Outputs 1..8: actuator status -> top-level extras, never channels entries.
  for (i = 0; i < 8; i++) {
    data['output' + (i + 1)] = outputs[i];
  }
  // One channels[] entry per input the frame carries: `input0` = board input 1.
  var channels = [];
  for (i = 0; i < 16; i++) {
    channels.push({
      channel: 'input' + i,
      action: { contactState: inputs[i] ? 'closed' : 'open' }
    });
  }
  data.channels = channels;
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
  // Counter n belongs to input n (upstream `measure`): pulse.count per entry.
  var channels = [];
  for (i = 0; i < counts.length; i++) {
    channels.push({ channel: 'input' + i, pulse: { count: counts[i] } });
  }
  return { data: { channels: channels, frameType: 'counters' } };
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
  // fPort 0 carries MAC commands only (LoRaWAN spec): there is no application
  // payload to decode, so this is not a decode failure. See AUTHORING.md.
  if (input && input.fPort === 0) {
    return { data: { make: "mcf88", model: "mcf-lw13io" } };
  }
  if (!input || !input.bytes || input.bytes.length === 0) {
    return { errors: ['empty payload: no application bytes to decode'] };
  }

  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "mcf88";
    result.data.model = "mcf-lw13io";
  }
  return result;
}
