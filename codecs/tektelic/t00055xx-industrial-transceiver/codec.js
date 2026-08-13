// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for tektelic/t00055xx-industrial-transceiver
// (TEKTELIC Industrial Transceiver — analog/digital I/O with onboard
// temperature + humidity).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format (TEKTELIC TLV: 1- or 2-byte header + fixed-size value) understood with
// reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/tektelic/decoder_industrial_transceiver.js,
// attributed in NOTICE).
//
// Ported from upstream port-"10" data uplink only: the generic upstream engine
// also handles config/diagnostic ports (20/32/100), which carry no measurement
// data and are out of scope for a normalized climate codec. The field semantics
// (header -> data_size / signed|unsigned / coefficient / round) are reproduced
// faithfully from the upstream `sensor["10"]` table, including upstream's
// `Number(value.toFixed(round))` rounding. The sibling
// codecs/tektelic/t00053xx-industrial-transceiver shares this upstream
// descriptor and the same normalized shape.
//
// Onboard sensors map to the vocabulary: temperature (0x03 0x67) ->
// air.temperature; relative humidity (0x04 0x68) -> air.relativeHumidity;
// battery voltage (0x00 0xFF, already volts) -> battery. The MCU's internal
// temperature (0x09 0x67) is a diagnostic, NOT the onboard air sensor, so it is
// emitted as the camelCase extra `mcuTemperature`. Digital outputs are grouped
// under `changeOutputStates` (mirroring upstream's change_output_states
// category).
//
// Multi-position shape (`channels[]`): the three field-wiring INPUTS are this
// device's genuine measured sub-sensor positions — three physically distinct
// terminals of one transceiver, in the vendor's own numbering — so each rides in
// the reserved `channels` array (see AUTHORING.md "Multi-channel devices")
// instead of the suffixed `input1` / `input2` / `input3` / `input1Count` extras
// this codec used to emit. Entries are labelled with the vendor's own term plus a
// ZERO-BASED index while TEKTELIC's own field names are one-based, so the
// renumbering is:
//   `input0` = TEKTELIC input 1 (0x05 0x00 state, 0x08 0x04 pulse count)
//   `input1` = TEKTELIC input 2 (0x06 0x02, 4-20 mA current loop)
//   `input2` = TEKTELIC input 3 (0x07 0x02, 0-10 V analog input)
// The three positions are NOT interchangeable dry contacts: this transceiver's
// input block is heterogeneous, one terminal per interface type, so each entry
// carries the vocabulary key its own terminal measures (the sibling
// codecs/adeunis/analog does the same, one entry per interface channel with
// analog.voltage or analog.current per that channel's type):
//   input0 -> action.contactState ('closed' when the state byte is non-zero,
//             'open' when it is zero) plus pulse.count (see below)
//   input1 -> analog.current (mA)
//   input2 -> analog.voltage (V)
// `action.contactState` replaces the pre-channels raw 0/1 extra: it is the
// vocabulary key for a dry-contact state and the shape the converted siblings
// (netvox/r831d, enginko/mcf-lw13io) emit. Adding it does not disturb the
// declared `climate` category, whose contract is a plain requires list
// (air.temperature + air.relativeHumidity, satisfied by the top-level onboard
// readings) with no exclusions; the extra vocabulary keys mean these devices
// would now also satisfy `analog-interface` (atLeastOne includes
// action.contactState, analog.current, analog.voltage and pulse.count), but
// declaring that second category is a metadata call left as a follow-up.
//
// Unit mapping for the two analog terminals. Upstream expresses input 2 with
// coefficient 1e-6 (i.e. the raw uint16 is microamps, reported in AMPS) and
// input 3 with coefficient 0.001 (raw millivolts, reported in volts). The
// vocabulary unit for analog.current is mA, so input1's value is the same raw
// count divided by 1000 — numerically 1000x upstream's amps at identical
// precision (three decimals of mA == six decimals of A). analog.voltage is V, so
// input2's number is unchanged from the pre-channels `input3` extra. That input 3
// is a VOLTAGE input while input 2 is a current loop is established from the
// upstream config table, which sizes their thresholds differently: 0x32
// (input2_current_high/low_threshold) steps 0.0001 per LSB over 8 bits, capping
// at 0.0255 A = 25.5 mA — a 4-20 mA loop — while 0x33 (input3_..._threshold)
// steps 0.05 over 8 bits, capping at 12.75, which fits a 0-10 V input and no
// plausible loop current. Upstream labels both parameters "current"; the scales
// separate them, and the sibling t00056xx codec reads the same wire format the
// same way.
//
// The pulse counter is INPUT 1 ONLY — it is not a per-input counter, so it rides
// inside `input0`'s entry as an unsuffixed `pulse.count` and no `input1Count`
// name (nor a fabricated `input2Count`/`input3Count`) survives. Established from
// the wire format: the port-10 descriptor table carries exactly one counter TLV
// (0x08 0x04 `input_1_count`), and the upstream config port gives input 1 alone
// the counting parameters — 0x2A rising/falling edge select, 0x2B
// `input1_count_threshold`, 0x2C `input_state`/`counter_value`, all under
// upstream's `input1` category — while inputs 2 and 3 get only analog threshold
// parameters (0x32/0x33 thresholds, 0x34 enables) and a shared sample period
// (0x30/0x31 `input23_sample_period_*`). Only the dry-contact terminal counts
// edges; an analog loop input has nothing to count.
//
// Digital OUTPUTS stay exactly where they were — the top-level
// `changeOutputStates` extra group (`output1`, `output2`, raw 0/1 as upstream
// reports them) — a deliberate, reviewed exception, and unchanged by this
// conversion. An output is actuator state the network server commanded, not a
// measured sub-sensor reading, and AUTHORING explicitly allows naming an extra
// for something that is not a measured position; the group is already the nested
// shape AUTHORING suggests for a non-position thing. Mixing the outputs into the
// same `channels` array as the inputs would also make an output
// indistinguishable from an input to a downstream flattener that treats every
// entry as telemetry. This is a policy call on outputs, not a settled
// convention: a reviewer may later want an output-position policy of its own (a
// separate reserved container, or an `outputs[]`-style extra) — which would
// supersede this group. Until then, only the measured input positions become
// channel entries; the siblings netvox/r831d (`relay1`..`relay3`) and
// enginko/mcf-lw13io (`output1`..`output8`) apply the same policy.
//
// Whole-device readings stay TOP-LEVEL and are never duplicated inside an entry:
// `air.temperature`, `air.relativeHumidity`, `battery`, the `mcuTemperature`
// diagnostic and the `changeOutputStates` output group.
//
// Sentinel policy: this wire format defines NO disconnected/fault sentinel for
// any input. Upstream reads each TLV value at face value — no reserved
// "terminal not wired" code, no out-of-range marker — so an unwired terminal is
// indistinguishable from an open contact or a 0 mA / 0 V reading, no value is
// treated as a sentinel, and no position is ever suppressed on its reading. What
// does vary is PRESENCE: TEKTELIC uplinks are sparse TLV streams, and most
// frames from this device (periodic temperature/humidity/battery reports, output
// state changes) carry no input field at all. `channels` is therefore built
// lazily — an entry exists only for an input whose TLV appears in this frame,
// `input0` merging the state and count TLVs when both appear — and the
// `channels` key is omitted entirely when a frame carries no input reading. A
// truncated input field returns an error before any entry is built, so no entry
// is ever fabricated from missing bytes.

function round(value, decimals) {
  // Mirror upstream Number(value.toFixed(round)): fixed-decimal then numeric.
  return Number(value.toFixed(decimals));
}

// Read `size` bytes big-endian starting at offset; returns an unsigned integer.
function readUintBE(bytes, offset, size) {
  var v = 0;
  for (var i = 0; i < size; i++) {
    v = v * 256 + (bytes[offset + i] & 0xff);
  }
  return v;
}

// Big-endian two's-complement signed integer over `size` bytes.
function readIntBE(bytes, offset, size) {
  var v = readUintBE(bytes, offset, size);
  var limit = Math.pow(2, 8 * size - 1);
  if (v >= limit) {
    v -= Math.pow(2, 8 * size);
  }
  return v;
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;
  var port = input.fPort;

  // Only port 10 carries measurement data. Other ports (config/diagnostics)
  // are out of scope for this normalized codec.
  if (port !== 10) {
    return { errors: ['unsupported fPort ' + port + '; expected data uplink on fPort 10'] };
  }
  if (!bytes || bytes.length === 0) {
    return { errors: ['empty payload'] };
  }

  var data = {};
  var air = {};
  var changeOutputStates = {};
  var hasOutput = false;

  // channels[] entries, built lazily: one per input terminal actually reported
  // in this frame (input0 = TEKTELIC input 1, input1 = input 2, input2 = input 3).
  var in0 = null;
  var in1 = null;
  var in2 = null;

  var i = 0;
  while (i < bytes.length) {
    var h0 = bytes[i] & 0xff;
    var h1 = (i + 1 < bytes.length) ? (bytes[i + 1] & 0xff) : -1;

    if (h0 === 0x00 && h1 === 0xff) {
      // battery_voltage: signed 2 bytes, coefficient 0.01, round 2 -> volts.
      if (i + 4 > bytes.length) { return { errors: ['truncated battery_voltage field'] }; }
      data.battery = round(readIntBE(bytes, i + 2, 2) * 0.01, 2);
      i += 4;
    } else if (h0 === 0x01 && h1 === 0x01) {
      // output1: unsigned 1 byte (actuator state -> extra group, not a channel).
      if (i + 3 > bytes.length) { return { errors: ['truncated output1 field'] }; }
      changeOutputStates.output1 = readUintBE(bytes, i + 2, 1);
      hasOutput = true;
      i += 3;
    } else if (h0 === 0x02 && h1 === 0x01) {
      // output2: unsigned 1 byte (actuator state -> extra group, not a channel).
      if (i + 3 > bytes.length) { return { errors: ['truncated output2 field'] }; }
      changeOutputStates.output2 = readUintBE(bytes, i + 2, 1);
      hasOutput = true;
      i += 3;
    } else if (h0 === 0x03 && h1 === 0x67) {
      // temperature: signed 2 bytes, coefficient 0.1, round 1 -> degC.
      if (i + 4 > bytes.length) { return { errors: ['truncated temperature field'] }; }
      air.temperature = round(readIntBE(bytes, i + 2, 2) * 0.1, 1);
      i += 4;
    } else if (h0 === 0x04 && h1 === 0x68) {
      // relative_humidity: unsigned 1 byte, coefficient 0.5, round 1 -> %.
      if (i + 3 > bytes.length) { return { errors: ['truncated relative_humidity field'] }; }
      air.relativeHumidity = round(readUintBE(bytes, i + 2, 1) * 0.5, 1);
      i += 3;
    } else if (h0 === 0x05 && h1 === 0x00) {
      // input_1 state: unsigned 1 byte dry contact -> `input0` action.contactState
      // (non-zero = closed/connected, zero = open — the pre-channels polarity).
      if (i + 3 > bytes.length) { return { errors: ['truncated input_1 field'] }; }
      if (!in0) { in0 = { channel: 'input0' }; }
      in0.action = { contactState: readUintBE(bytes, i + 2, 1) !== 0 ? 'closed' : 'open' };
      i += 3;
    } else if (h0 === 0x06 && h1 === 0x02) {
      // input_2: unsigned 2 bytes, 4-20 mA current loop. Raw count is microamps
      // (upstream coefficient 0.000001 reports amps); analog.current is mA.
      if (i + 4 > bytes.length) { return { errors: ['truncated input_2 field'] }; }
      in1 = { channel: 'input1', analog: { current: round(readUintBE(bytes, i + 2, 2) / 1000, 3) } };
      i += 4;
    } else if (h0 === 0x07 && h1 === 0x02) {
      // input_3: unsigned 2 bytes, 0-10 V analog input. Raw count is millivolts
      // (upstream coefficient 0.001); analog.voltage is V — same number.
      if (i + 4 > bytes.length) { return { errors: ['truncated input_3 field'] }; }
      in2 = { channel: 'input2', analog: { voltage: round(readUintBE(bytes, i + 2, 2) * 0.001, 3) } };
      i += 4;
    } else if (h0 === 0x08 && h1 === 0x04) {
      // input_1_count: unsigned 2 bytes. Counter belongs to input 1 only, so it
      // rides inside `input0`'s entry as pulse.count (see header).
      if (i + 4 > bytes.length) { return { errors: ['truncated input_1_count field'] }; }
      if (!in0) { in0 = { channel: 'input0' }; }
      in0.pulse = { count: readUintBE(bytes, i + 2, 2) };
      i += 4;
    } else if (h0 === 0x09 && h1 === 0x67) {
      // mcu_temperature: signed 2 bytes, coefficient 0.1, round 1 (diagnostic).
      if (i + 4 > bytes.length) { return { errors: ['truncated mcu_temperature field'] }; }
      data.mcuTemperature = round(readIntBE(bytes, i + 2, 2) * 0.1, 1);
      i += 4;
    } else {
      return {
        errors: ['unrecognized TLV header at byte ' + i +
          ' (0x' + ('0' + h0.toString(16)).slice(-2) +
          (h1 >= 0 ? ' 0x' + ('0' + h1.toString(16)).slice(-2) : '') + ')']
      };
    }
  }

  if (air.temperature !== undefined || air.relativeHumidity !== undefined) {
    data.air = air;
  }
  if (hasOutput) {
    data.changeOutputStates = changeOutputStates;
  }

  // Ascending terminal order; omitted entirely when the frame reported no input.
  var channels = [];
  if (in0) { channels.push(in0); }
  if (in1) { channels.push(in1); }
  if (in2) { channels.push(in2); }
  if (channels.length > 0) {
    data.channels = channels;
  }

  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "tektelic";
    result.data.model = "t00055xx-industrial-transceiver";
  }
  return result;
}
