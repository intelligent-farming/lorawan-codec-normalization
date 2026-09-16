// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for dragino/lt22222-l (LT-22222-L LoRaWAN I/O
// Controller: 2 analog voltage inputs (AVI, 0-30 V), 2 analog current inputs
// (ACI, 0-20 mA), 2 digital inputs (DI), 2 digital outputs (DO) and 2 relay
// outputs (RO); which inputs a frame reports depends on the configured work
// mode). The LT line shares one frame format and the hardware id in byte[10]
// says which board sent the payload, so the third DI/DO of the LT-33222-L
// sibling is still decoded when a payload declares that hardware.
// Category: analog-interface.
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format understood with reference to the upstream Apache-2.0 Dragino decoder
// (TheThingsNetwork/lorawan-devices vendor/dragino/lt22222-l.js, attributed in
// NOTICE). Upstream emits a flat bag of string-valued fields (AVI1_V, ACI1_mA,
// DI1_status 'H'/'L', DO/RO 'ON'/'OFF', Count*_times); this module authors the
// normalized vocabulary and keeps the rest as camelCase extras. Upstream
// normalization is never copied.
//
// fPort 2 telemetry (11-byte frame). byte[10]: bits 6-7 = hardware id (0 =
// LT33222 board, 3 DI / 3 DO; 1 = LT22222 board, 2 DI / 2 DO), bits 0-5 = work
// mode. byte[8] = digital I/O status bitfield (bit7 RO1, bit6 RO2, bit5 DI3 in
// work mode 1 and the FIRST flag otherwise, bit4 DI2, bit3 DI1, bit2 DO3,
// bit1 DO2, bit0 DO1). Analog inputs are signed 16-bit big-endian, value / 1000
// (AVI -> V, ACI -> mA); counters are unsigned 32-bit big-endian (16-bit in
// work mode 5).
//
// Multi-position output (`channels[]`, see AUTHORING.md "Multi-channel
// devices"). This controller reports FOUR independent banks of sub-sensor input
// positions - voltage inputs, current inputs, dry-contact digital inputs and
// pulse counters - and every position rides in the one reserved `channels`
// array. They are different physical things, so each position is its own entry
// rather than a merged one: entry labels only have to be unique within the
// array, and a single array keeps every position addressable in one flattener
// pass. Labels are the vendor's own term plus a ZERO-BASED index, so they are
// offset by one from Dragino's one-based field names:
//   voltage bank -> `avi0` = AVI1 (bytes[0..1]), `avi1` = AVI2 (bytes[2..3]),
//                   each carrying analog.voltage (V, s16 / 1000, 3 decimals).
//                   AVI is Dragino's own term (upstream AVI1_V / AVI2_V).
//   current bank -> `aci0` = ACI1 (bytes[4..5]), `aci1` = ACI2 (bytes[6..7]),
//                   each carrying analog.current (mA, s16 / 1000, 3 decimals).
//                   ACI is Dragino's own term (upstream ACI1_mA / ACI2_mA).
//   digital bank -> `input0` = DI1 (byte[8] bit3), `input1` = DI2 (bit4),
//                   `input2` = DI3 (bit5, LT33222 hardware only), each carrying
//                   action.contactState ("closed" when the bit is set - the 'H'
//                   upstream reports - else "open").
//   counter bank -> `counter0` = COUNT1, `counter1` = COUNT2, each carrying
//                   pulse.count (the cumulative index). Plus `acount0` =
//                   ACOUNT (work mode 4 only), also pulse.count. ACOUNT is a
//                   DIFFERENT physical input - Dragino's "1 x Voltage Counting"
//                   counts AVI1 threshold crossings, not DI pulses - so it
//                   takes the vendor's own name plus a zero-based index instead
//                   of being labelled `counter1`: `counter1` is COUNT2, the DI2
//                   pulse counter of work mode 2, and reusing that label across
//                   modes would conflate two different physical inputs (the
//                   conflation codecs/atim/acw-dind160 documents avoiding).
// CAUTION when reading old data: the labels are NOT the vendor's numbers.
// `avi1` is the vendor's AVI2 and `input1` is the vendor's DI2. The retired
// extras `voltage2` / `current2` / `input2` / `input3` / `count2` were named
// for the vendor's AVI2 / ACI2 / DI2 / DI3 / COUNT2, so the old `input2` (DI2)
// is now the entry `input1` and the old `input3` (DI3) is now the entry
// `input2`. Zero-based labels are the repo convention (netvox/r831d
// `input0..2`, atim/acw-dind160 `input0..15` + `counter0..7`,
// volley-boast/vobo-gp-1 `din0..2` + `adc0..2`).
//
// Work mode -> populated banks (byte[10] bits 0-5). `channels` is built LAZILY:
// an entry exists only for a position the current mode actually reports, so a
// consumer never sees a fabricated or stale position, and the key is omitted
// entirely when a frame carries no position reading at all.
//   mode 1  2ACI+2AVI              : avi0 avi1 aci0 aci1 input0 input1 [input2]
//   mode 2  double DI counting      : counter0 (bytes[0..3]) counter1 (bytes[4..7])
//   mode 3  1 DI count + 2ACI       : counter0 (bytes[0..3]) aci0 aci1
//   mode 4  1 DI count + AVI count  : counter0 (bytes[0..3]) acount0 (bytes[4..7])
//   mode 5  1 DI count + 2AVI + ACI : avi0 avi1 aci0 counter0 (16-bit bytes[6..7])
//   mode 6  exit/alarm mode         : none - flag/status bits only -> error
// Notes on that matrix: the analog inputs are physically wired in every mode
// but only sampled/reported in the modes listed (modes 2 and 4 repurpose the
// input bytes for counting), and the DI states are reported ONLY in mode 1 - in
// the counting modes DI1/DI2 are the counting inputs and byte[8] bit5 carries
// the FIRST flag instead of DI3, so this codec emits no digital-input entry
// outside mode 1 (matching upstream) rather than decoding bits whose meaning
// has changed. The `input2` (DI3) entry additionally requires the LT33222
// hardware id, as upstream gates DI3_status on hardware 0 with byte[10] == 0x01.
//
// What the shape change fixes: before this, only AVI1 became analog.voltage
// while AVI2 was the `voltage2` extra, only ACI1 became analog.current while
// ACI2 was `current2`, only DI1 became action.contactState while DI2/DI3 were
// the booleans `input2`/`input3`, and only one counter became pulse.count while
// the other was `count2` - positions of one bank spoke different key names, and
// in the digital bank even different value domains (a boolean where DI1 had an
// open/closed enum), so per-position truth was not addressable downstream.
// Every position of a bank now carries that bank's one vocabulary key with
// byte-identical scaling and rounding. In work mode 4 the change also RECOVERS
// a dropped position: that frame carries COUNT1 in bytes[0..3] and ACOUNT in
// bytes[4..7] (upstream emits both Count1_times and Acount_times), but the
// pre-channels codec mapped only bytes[4..7] onto pulse.count and dropped
// COUNT1 entirely.
//
// Digital outputs and relay outputs stay TOP-LEVEL extras - a deliberate,
// reviewed exception, mirroring codecs/netvox/r831d. DO1/DO2/DO3 are surfaced
// as `do1`/`do2`/`do3` (boolean, true = output high, upstream 'H') and RO1/RO2
// as `ro1`/`ro2` (boolean, true = relay energized/ON), and they are NOT
// converted to `channels[]` entries: an output is actuator state the network
// server commanded, not a measured sub-sensor reading, and AUTHORING explicitly
// allows naming an extra for something that is not a measured position. Mixing
// the five outputs into the same `channels` array as the input positions would
// also make an output indistinguishable from an input to a downstream flattener
// that treats every entry as telemetry. This is a policy call on outputs, not a
// settled convention: a reviewer may later want an output-position policy of its
// own (a separate reserved container, or an `outputs[]`-style extra) - which
// would supersede these five suffixed extras. Until then, only the measured
// input positions become channel entries.
//
// Whole-device values stay top-level and are never duplicated inside an entry:
// the `hardwareMode` extra (which board the payload came from) and the
// `workMode` extra (the numeric mode, so a consumer can tell why a bank is
// absent). The frame carries no battery reading - the LT is externally powered -
// so no `battery` is emitted.
//
// Sentinel policy: this frame format defines NO per-position disconnected or
// fault encoding, and none is invented here. Verified against
// reference/upstream-codec.js: every analog input is a plain signed 16-bit word
// divided by 1000 with no reserved value (an unwired 0-30 V input reads ~0 V and
// an open 4-20 mA loop reads ~0 mA, indistinguishable from a genuine low
// reading), every counter is a plain unsigned big-endian index with no reserved
// value, and each DI bit is a plain two-way H/L test with no third "terminal not
// wired" state. Dragino DOES use real sentinels on other products in this repo -
// ltc2's 0x8001 'NULL' thermocouple word, lsn50v2's 65535 - so the absence here
// was checked, not assumed. No position is therefore ever skipped on its
// reading; a position is absent only when the work mode does not report that
// bank. The 11-byte length guard covers every position byte, so no entry can be
// fabricated from `undefined`.
//
// Category `analog-interface` (atLeastOne: analog.current / analog.voltage /
// analog.ratio / analog.raw / pulse.count / pulse.total / action.contactState)
// stays satisfied in every decodable mode: those keys now live only inside the
// entries, and membership resolves through top-level `channels[]` entries -
// mode 1 supplies analog.voltage, analog.current and action.contactState,
// modes 2 and 4 pulse.count, mode 3 pulse.count and analog.current, mode 5 all
// three.
//
// fPort 5 (device status) carries no interface measurement -> error.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

// signed 16-bit big-endian
function s16(hi, lo) {
  var v = ((hi & 0xff) << 8) | (lo & 0xff);
  return v & 0x8000 ? v - 0x10000 : v;
}

function u32be(b, i) {
  return ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
}

// A set DI bit is a closed (connected) contact; upstream reports it as 'H'.
function contact(bit) {
  return bit ? 'closed' : 'open';
}

// One channels entry per analog voltage position (AVI), V = s16 / 1000.
function aviEntry(label, hi, lo) {
  return { channel: label, analog: { voltage: round(s16(hi, lo) / 1000, 3) } };
}

// One channels entry per analog current position (ACI), mA = s16 / 1000.
function aciEntry(label, hi, lo) {
  return { channel: label, analog: { current: round(s16(hi, lo) / 1000, 3) } };
}

// One channels entry per counter position (COUNT1/COUNT2/ACOUNT).
function countEntry(label, count) {
  return { channel: label, pulse: { count: count } };
}

function decodeUplinkCore(input) {
  var b = input.bytes;

  if (input.fPort === 5) {
    return { errors: ['device-status frame (fPort 5) carries no interface measurement'] };
  }
  if (input.fPort !== 2) {
    return { errors: ['unsupported fPort ' + input.fPort + ' (expected 2)'] };
  }
  if (!b || b.length !== 11) {
    return { errors: ['expected 11-byte telemetry frame, got ' + (b ? b.length : 0)] };
  }

  var hardware = (b[10] & 0xc0) >> 6;
  var mode = b[10] & 0x3f;
  var data = {};

  data.hardwareMode = hardware === 0 ? 'LT33222' : 'LT22222';
  data.workMode = mode;

  // Digital OUTPUTS / relays (present except in exit mode): actuator state, so
  // top-level extras rather than channels[] entries (see header).
  if (mode !== 6) {
    data.do1 = !(b[8] & 0x01);
    data.do2 = !(b[8] & 0x02);
    data.ro1 = Boolean(b[8] & 0x80);
    data.ro2 = Boolean(b[8] & 0x40);
    if (hardware === 0) {
      data.do3 = !(b[8] & 0x04);
    }
  }

  // Measured input positions, built lazily: only the banks this work mode
  // actually reports become entries (mode -> bank matrix in the header).
  var channels = [];

  if (mode === 1) {
    // 2ACI+2AVI: both voltage inputs, both current inputs, the DI states.
    channels.push(aviEntry('avi0', b[0], b[1]));
    channels.push(aviEntry('avi1', b[2], b[3]));
    channels.push(aciEntry('aci0', b[4], b[5]));
    channels.push(aciEntry('aci1', b[6], b[7]));
    channels.push({ channel: 'input0', action: { contactState: contact(b[8] & 0x08) } });
    channels.push({ channel: 'input1', action: { contactState: contact(b[8] & 0x10) } });
    if (hardware === 0) {
      // DI3 exists on the LT33222 board only.
      channels.push({ channel: 'input2', action: { contactState: contact(b[8] & 0x20) } });
    }
  } else if (mode === 2) {
    // Count mode 1: DI1 and DI2 pulse counters, both 32-bit.
    channels.push(countEntry('counter0', u32be(b, 0)));
    channels.push(countEntry('counter1', u32be(b, 4)));
  } else if (mode === 3) {
    // 2ACI+1Count: the DI1 counter plus both current inputs.
    channels.push(countEntry('counter0', u32be(b, 0)));
    channels.push(aciEntry('aci0', b[4], b[5]));
    channels.push(aciEntry('aci1', b[6], b[7]));
  } else if (mode === 4) {
    // Count mode 2: the DI1 pulse counter plus ACOUNT, the AVI1
    // threshold-crossing counter (a different input, hence its own label).
    channels.push(countEntry('counter0', u32be(b, 0)));
    channels.push(countEntry('acount0', u32be(b, 4)));
  } else if (mode === 5) {
    // 1ACI+2AVI+1Count: both voltage inputs, ACI1, and a 16-bit DI1 counter.
    channels.push(aviEntry('avi0', b[0], b[1]));
    channels.push(aviEntry('avi1', b[2], b[3]));
    channels.push(aciEntry('aci0', b[4], b[5]));
    channels.push(countEntry('counter0', ((b[6] << 8) | b[7]) & 0xffff));
  } else {
    // mode 6 (exit/alarm) and any other mode carry only flag/status bits, no
    // fresh interface reading to normalize.
    return { errors: ['work mode ' + mode + ' carries no normalizable interface reading'] };
  }

  if (channels.length > 0) {
    data.channels = channels;
  }

  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  // fPort 0 carries MAC commands only (LoRaWAN spec): there is no application
  // payload to decode, so this is not a decode failure. See AUTHORING.md.
  if (input && input.fPort === 0) {
    return { data: { make: "dragino", model: "lt22222-l" } };
  }
  if (!input || !input.bytes || input.bytes.length === 0) {
    return { errors: ['empty payload: no application bytes to decode'] };
  }

  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "dragino";
    result.data.model = "lt22222-l";
  }
  return result;
}
