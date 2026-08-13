// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for the Tektelic T00056xx Industrial Transceiver
// (LoRaWAN battery-powered radio transmitter). The device is primarily an
// analog/digital industrial I/O transceiver, but it carries an ONBOARD
// temperature + relative-humidity sensor whose readings satisfy the `climate`
// category (air.temperature + air.relativeHumidity).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format (Tektelic channel/type TLV on the data fPort 10, big-endian fields)
// understood with reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/tektelic
// decoder_industrial_transceiver.js, attributed in NOTICE). Author the
// normalization here; the upstream normalizeUplink/normalizedOutput is NOT
// copied.
//
// Mapping notes (channel 0xCC type 0xTT on fPort 10):
//   0x00 0xFF  battery_voltage    signed16 * 0.01 V  -> `battery` (volts, not %).
//   0x03 0x67  temperature        signed16 * 0.1 C   -> air.temperature
//                                  (onboard ambient air sensor).
//   0x04 0x68  relative_humidity  uint8 * 0.5 %      -> air.relativeHumidity.
//   0x01 0x01  output1 state      uint8              -> extra outputState1.
//   0x02 0x01  output2 state      uint8              -> extra outputState2.
//   0x05 0x00  input_1 digital    uint8              -> channels[] `input0`
//                                  action.contactState (dry contact).
//   0x06 0x02  input_2 current    uint16, raw = uA   -> channels[] `input1`
//                                  analog.current (mA; 4-20 mA current loop).
//   0x07 0x02  input_3 voltage    uint16, raw = mV   -> channels[] `input2`
//                                  analog.voltage (V; 0-10 V input).
//   0x08 0x04  input_1 count      uint16             -> channels[] `input0`
//                                  pulse.count (input 1's counter only).
//   0x09 0x67  mcu_temperature    signed16 * 0.1 C   -> extra mcuTemperature
//                                  (internal MCU die temp, NOT ambient air temp).
//
// Only fPort 10 carries measurement data. Configuration/diagnostic ports
// (20 serial, 100 register read-back) are not measurement uplinks and are
// rejected rather than surfaced as telemetry.
//
// Multi-position shape (`channels[]`): the three field-wiring INPUTS are this
// device's genuine measured sub-sensor positions — three physically distinct
// terminals of one transceiver, in the vendor's own numbering — so each rides in
// the reserved `channels` array (see AUTHORING.md "Multi-channel devices")
// instead of the suffixed `digitalInput1` / `analogInput2Current` /
// `analogInput3Voltage` / `digitalInput1Count` extras this codec used to emit.
// Entries are labelled with the vendor's own term plus a ZERO-BASED index while
// TEKTELIC's own field names are one-based, so the renumbering is:
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
// `action.contactState` replaces the pre-channels raw 0/1 `digitalInput1` extra:
// it is the vocabulary key for a dry-contact state and the shape the converted
// siblings (netvox/r831d, enginko/mcf-lw13io) emit. Adding it does not disturb
// the declared `climate` category, whose contract is a plain requires list
// (air.temperature + air.relativeHumidity, satisfied by the top-level onboard
// readings) with no exclusions; the extra vocabulary keys mean this device would
// now also satisfy `analog-interface` (atLeastOne includes action.contactState,
// analog.current, analog.voltage and pulse.count), but declaring that second
// category is a metadata call left as a follow-up.
//
// Unit mapping for the two analog terminals. Upstream expresses input 2 with
// coefficient 1e-6 (i.e. the raw uint16 is microamps, reported in AMPS) and
// input 3 with coefficient 0.001 (raw millivolts, reported in volts). The
// vocabulary unit for analog.current is mA, so input1's value is the same raw
// count divided by 1000 — numerically 1000x the AMPS this codec used to emit as
// `analogInput2Current`, at identical precision (three decimals of mA == six
// decimals of A). analog.voltage is V, so input2's number is unchanged from the
// pre-channels `analogInput3Voltage` extra. That input 3 is a VOLTAGE input
// while input 2 is a current loop is established from the upstream config table,
// which sizes their thresholds differently: 0x32
// (input2_current_high/low_threshold) steps 0.0001 per LSB over 8 bits, capping
// at 0.0255 A = 25.5 mA — a 4-20 mA loop — while 0x33 (input3_..._threshold)
// steps 0.05 over 8 bits, capping at 12.75, which fits a 0-10 V input and no
// plausible loop current. Upstream labels both parameters "current"; the scales
// separate them, and the sibling t00053xx/t00055xx codecs read the same wire
// format the same way (all three devices ship a byte-identical upstream
// reference decoder).
//
// The pulse counter is INPUT 1 ONLY — it is not a per-input counter, so it rides
// inside `input0`'s entry as an unsuffixed `pulse.count` and no
// `digitalInput1Count` name (nor a fabricated `input2Count`/`input3Count`)
// survives. Established from the wire format: the port-10 descriptor table
// carries exactly one counter TLV (0x08 0x04 `input_1_count`), and the upstream
// config port gives input 1 alone the counting parameters — 0x2A rising/falling
// edge select, 0x2B `input1_count_threshold`, 0x2C `input_state`/`counter_value`,
// all under upstream's `input1` category — while inputs 2 and 3 get only analog
// threshold parameters (0x32/0x33 thresholds, 0x34 enables) and a shared sample
// period (0x30/0x31 `input23_sample_period_*`). Only the dry-contact terminal
// counts edges; an analog loop input has nothing to count.
//
// Digital OUTPUTS stay exactly where they were — the top-level `outputState1` /
// `outputState2` extras, raw 0/1 as upstream reports them — a deliberate,
// reviewed exception, and unchanged by this conversion. An output is actuator
// state the network server commanded, not a measured sub-sensor reading, and
// AUTHORING explicitly allows naming an extra for something that is not a
// measured position. Mixing the outputs into the same `channels` array as the
// inputs would also make an output indistinguishable from an input to a
// downstream flattener that treats every entry as telemetry. This is a policy
// call on outputs, not a settled convention: a reviewer may later want an
// output-position policy of its own (a separate reserved container, or an
// `outputs[]`-style extra) — which would supersede these extras. Until then,
// only the measured input positions become channel entries; the siblings
// netvox/r831d (`relay1`..`relay3`) and enginko/mcf-lw13io (`output1`..`output8`)
// apply the same policy.
//
// Whole-device readings stay TOP-LEVEL and are never duplicated inside an entry:
// `air.temperature`, `air.relativeHumidity`, `battery`, the `mcuTemperature`
// diagnostic and the two output-state extras.
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
// `channels` key is omitted entirely when a frame carries no input reading.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

// Big-endian unsigned integer from a byte slice (MSB first).
function uintBE(bytes, offset, length) {
  var out = 0;
  for (var i = 0; i < length; i++) {
    out = out * 256 + (bytes[offset + i] & 0xff);
  }
  return out;
}

// Big-endian signed (two's complement) integer from a byte slice.
function intBE(bytes, offset, length) {
  var out = uintBE(bytes, offset, length);
  var max = Math.pow(2, 8 * length);
  if (out >= max / 2) {
    out -= max;
  }
  return out;
}

function hex2(n) {
  return ('0' + (n & 0xff).toString(16)).slice(-2);
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;

  if (input.fPort !== 10) {
    return {
      errors: [
        'unsupported fPort ' + input.fPort + ' (expected data uplink on fPort 10)',
      ],
    };
  }
  if (!bytes || bytes.length === 0) {
    return { errors: ['empty payload'] };
  }

  var data = {};
  var air = {};
  var extras = {};

  // channels[] entries, built lazily: one per input terminal actually reported
  // in this frame (input0 = TEKTELIC input 1, input1 = input 2, input2 = input 3).
  var in0 = null;
  var in1 = null;
  var in2 = null;

  var i = 0;

  while (i < bytes.length) {
    var channel = bytes[i];
    var type = bytes[i + 1];

    if (channel === 0x00 && type === 0xff) {
      // Battery voltage: signed16 BE * 0.01 V.
      data.battery = round(intBE(bytes, i + 2, 2) * 0.01, 2);
      i += 4;
    } else if (channel === 0x01 && type === 0x01) {
      // Relay/output 1 commanded state: uint8 (0/1) -> extra.
      extras.outputState1 = uintBE(bytes, i + 2, 1);
      i += 3;
    } else if (channel === 0x02 && type === 0x01) {
      // Relay/output 2 commanded state: uint8 (0/1) -> extra.
      extras.outputState2 = uintBE(bytes, i + 2, 1);
      i += 3;
    } else if (channel === 0x03 && type === 0x67) {
      // Onboard ambient temperature: signed16 BE * 0.1 C.
      air.temperature = round(intBE(bytes, i + 2, 2) * 0.1, 1);
      i += 4;
    } else if (channel === 0x04 && type === 0x68) {
      // Onboard relative humidity: uint8 * 0.5 %.
      air.relativeHumidity = round(uintBE(bytes, i + 2, 1) * 0.5, 1);
      i += 3;
    } else if (channel === 0x05 && type === 0x00) {
      // Input 1 state: uint8 dry contact -> `input0` action.contactState
      // (non-zero = closed/connected, zero = open — the pre-channels polarity).
      if (!in0) { in0 = { channel: 'input0' }; }
      in0.action = { contactState: uintBE(bytes, i + 2, 1) !== 0 ? 'closed' : 'open' };
      i += 3;
    } else if (channel === 0x06 && type === 0x02) {
      // Input 2: uint16 BE, 4-20 mA current loop. Raw count is microamps
      // (upstream coefficient 1e-6 reports amps); analog.current is mA.
      in1 = { channel: 'input1', analog: { current: round(uintBE(bytes, i + 2, 2) / 1000, 3) } };
      i += 4;
    } else if (channel === 0x07 && type === 0x02) {
      // Input 3: uint16 BE, 0-10 V analog input. Raw count is millivolts
      // (upstream coefficient 0.001); analog.voltage is V — same number.
      in2 = { channel: 'input2', analog: { voltage: round(uintBE(bytes, i + 2, 2) * 0.001, 3) } };
      i += 4;
    } else if (channel === 0x08 && type === 0x04) {
      // Input 1 pulse count: uint16 BE. The counter belongs to input 1 only, so
      // it rides inside `input0`'s entry as pulse.count (see header).
      if (!in0) { in0 = { channel: 'input0' }; }
      in0.pulse = { count: uintBE(bytes, i + 2, 2) };
      i += 4;
    } else if (channel === 0x09 && type === 0x67) {
      // MCU die temperature: signed16 BE * 0.1 C -> extra (not ambient air).
      extras.mcuTemperature = round(intBE(bytes, i + 2, 2) * 0.1, 1);
      i += 4;
    } else {
      return {
        errors: [
          'unrecognized channel/type 0x' +
            hex2(channel) +
            ' 0x' +
            hex2(type === undefined ? 0 : type) +
            ' at byte ' +
            i,
        ],
      };
    }
  }

  if (air.temperature !== undefined || air.relativeHumidity !== undefined) {
    data.air = air;
  }

  var extraKeys = [];
  var k;
  for (k in extras) {
    if (Object.prototype.hasOwnProperty.call(extras, k)) {
      extraKeys.push(k);
    }
  }
  for (var j = 0; j < extraKeys.length; j++) {
    data[extraKeys[j]] = extras[extraKeys[j]];
  }

  // Ascending terminal order; omitted entirely when the frame reported no input.
  var channels = [];
  if (in0) { channels.push(in0); }
  if (in1) { channels.push(in1); }
  if (in2) { channels.push(in2); }
  if (channels.length > 0) {
    data.channels = channels;
  }

  var hasData = false;
  for (k in data) {
    if (Object.prototype.hasOwnProperty.call(data, k)) {
      hasData = true;
      break;
    }
  }
  if (!hasData) {
    return { errors: ['no decodable measurements in payload'] };
  }

  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "tektelic";
    result.data.model = "t00056xx-industrial-transceiver";
  }
  return result;
}
