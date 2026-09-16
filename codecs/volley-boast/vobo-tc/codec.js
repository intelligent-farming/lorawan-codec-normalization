// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Volley Boast VoBo-TC (Thermocouple Endpoint).
//
// Ported/normalized from the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/volley-boast/vobo-decoder.js,
// attributed in NOTICE). Upstream dispatches on fPort into many payload shapes;
// the source of truth for this codec is its FPort-1 standard measurement path
// (`parseStandardPayload`), the only shape that yields a fully unit-defined
// temperature (degrees C) and battery (mV). The 12 thermocouple probe channels
// travel as raw 16-bit Modbus registers (`parseModbusStandardPayload`) with no
// scaling or engineering unit fixed by the upstream decoder, so they are not
// normalized here.
//
// FPort-1 standard payload byte mapping (ported faithfully from upstream):
//   Temperature (bytes[6] hi nibble + bytes[7], 12-bit, 0.125 C/LSB, sign in
//     bytes[7] bit 7) -> temperature   (degrees C, top level)
//   Battery ((bytes[6]&0x0f)<<8 | bytes[5]) * 4 mV -> battery (V; mV / 1000)
//   DIN1/DIN2/DIN3 (bytes[0] bits 0..2) -> channels[] entries din0/din1/din2,
//     each carrying action.contactState
//   WKUP (bytes[0] bit 3)               -> wakeup (boolean extra, top level)
//   Modbus0 (bytes[9]<<8 | bytes[8])    -> channels[] entry modbus0
//
// Only fPort 1 is normalized; the heartbeat, analog-sensor, config, digital and
// event-log payloads carry no unit-defined temperature and yield errors.
//
// Multi-position output (`channels[]`, see AUTHORING.md "Multi-channel
// devices"). The Standard frame reports two independent banks of sub-sensor
// positions -- three dry-contact digital inputs and one Modbus register slot --
// and both ride in the one reserved `channels` array. They are different
// physical things, so each position is its own entry: entry labels only have to
// be unique within the array, and one array keeps every position addressable in
// a single flattener pass. Labels use the vendor's own term plus a ZERO-BASED
// index:
//   digital bank -> `din0` = DIN1 (bytes[0] bit0), `din1` = DIN2 (bit1),
//                   `din2` = DIN3 (bit2), each carrying action.contactState
//                   ("closed" when the bit is set, else "open").
//   Modbus slot  -> `modbus0` = Modbus payload slot 0 (bytes[8..9]), carrying
//                   the raw 16-bit register as the `modbusRegister` extra.
// CAUTION when reading old data: this codec's retired extras `din1`/`din2`/`din3`
// were the vendor's one-based DIN1/DIN2/DIN3, while the entry labels are
// zero-based -- the label `din1` is now the vendor's DIN2, not DIN1. Zero-based
// labels are the repo convention (netvox/r831d `input0..input2`,
// atim/acw-dind160 `input0..input15`) and match the GP-1 / HL-1 / XP siblings,
// so the whole VoBo family shares one label scheme.
//
// The three digital inputs previously shipped as plain boolean extras and this
// codec emitted no action.contactState at all. They now carry the vocabulary
// key with the family's convention (bit set -> "closed"), so per-position truth
// is addressable downstream instead of hiding in three differently-named
// booleans. Adding the key is safe for the declared `temperature` category:
// definitions/categories/temperature.json has `requires: ["temperature"]` and no
// closed-world key restriction, `temperature` is still emitted at the top level
// (so membership resolves without looking at entries at all), and validate()
// only rejects keys that are schema-invalid or case-collide -- an extra
// vocabulary key in an entry is legal.
//
// Modbus0 is a positional slot, not a fixed field -- investigated in upstream,
// not inferred from the name. Upstream's Modbus Standard payload
// (`parseModbusStandardPayload`, fPorts 2..9) emits Modbus1..Modbus40 with the
// index derived from the fPort ((fport-1)*5-4), the variable-length variant
// (`parseModbusStandardVariableLengthPayload`, fPorts 120..129) emits
// `Modbus<slot>` from a first-slot number in the frame, and the configuration
// payload defines the slot table itself (mbGroupPaySlot0/mbRegPaySlot0 ..
// mbGroupPaySlot40/mbRegPaySlot40). The Standard frame's `Modbus0` is slot 0 of
// that 41-slot bank, so the trailing 0 is a slot index and the value belongs in
// a channels entry rather than in a metric name; were fPorts 2..9 ever
// normalized their registers -- which on this model is where the 12 thermocouple
// probes report -- they would join the array as `modbus1`..`modbus40`. The entry
// carries the register as the camelCase extra `modbusRegister` because each slot
// is independently pointed by configuration at an arbitrary (Modbus group,
// register) pair on an arbitrary slave, so upstream fixes no engineering unit
// for it.
//
// `temperature` stays TOP-LEVEL: it is a single position, not a bank. The
// fPort-1 field is the endpoint's own 12-bit ADC temperature (upstream's analog
// sensor table for the TC names the equivalent analog channel "Cold Joint
// Temperature"); the 12 thermocouple probes TC1..TC12 are separate analog
// sensors that report only on the analog-sensor payloads (fPorts 30..49 /
// 110..119, float32 with a units code) and the Modbus register slots, none of
// which this codec normalizes. So the Standard frame carries exactly one
// temperature, and there is no second thermocouple position in it to convert.
// If those payloads are ever normalized, the TC probes become channels entries
// (`tc0`..`tc11`) and this field must stay whole-device.
//
// Whole-device readings stay TOP-LEVEL and are never duplicated inside an
// entry: `temperature`, `battery` (V) and the `wakeup` extra. WKUP is digital
// sensor 0 in upstream's digital-sensor name table (the only digital sensor it
// lists for the TC), but it is the wake-cause housekeeping flag of the whole
// device rather than a measured contact terminal, so it keeps its top-level
// boolean shape instead of becoming a fourth `din*` entry.
//
// Sentinel policy: there is no sentinel to honor. `parseStandardPayload`
// extracts each DIN bit with a plain 1-bit test and reserves no "input unwired"
// value, so an unwired terminal is indistinguishable from an open contact; the
// temperature word likewise has no fault/open-thermocouple encoding (both sign
// branches are ordinary readings and the 12-bit range is fully used), and the
// Modbus register is a plain unsigned 16-bit value. No reading is therefore
// treated as a sentinel and no position is suppressed on its value. The length
// guard below requires all 10 Standard-payload bytes, so all four positions are
// present whenever a frame decodes; `channels` is still built lazily and
// omitted when empty so no future short/variable-length path can ship an empty
// array.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function contact(bit) {
  return bit ? 'closed' : 'open';
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;
  if (!bytes) {
    return { errors: ['missing payload bytes'] };
  }
  if (input.fPort !== 1) {
    return {
      errors: [
        'unsupported fPort ' + input.fPort +
          ' (only the fPort 1 standard measurement payload is normalized)'
      ]
    };
  }
  if (bytes.length < 10) {
    return { errors: ['standard payload too short (expected 10 bytes)'] };
  }

  var data = {};

  // ADC temperature: 12-bit, 0.125 C/LSB; bytes[7] bit 7 selects sign.
  var tRaw = (((bytes[6] & 0xf0) >> 4) | (bytes[7] << 4)) & 0xfff;
  if ((bytes[7] >> 7 & 0x01) === 0) {
    data.temperature = round(tRaw * 0.125, 3);
  } else {
    data.temperature = round((4096 - tRaw) * 0.125 * -1, 3);
  }

  // Battery: 12-bit ADC, 4 mV/LSB -> volts.
  var battMv = ((bytes[6] & 0x0f) << 8 | bytes[5]) * 4;
  data.battery = round(battMv / 1000, 3);

  // Wakeup cause flag (whole-device housekeeping extra).
  data.wakeup = Boolean((bytes[0] >> 3) & 0x01);

  // One entry per sub-sensor position: DIN1..DIN3 -> din0..din2, Modbus
  // payload slot 0 -> modbus0 (raw register, no fixed engineering unit).
  var channels = [];
  channels.push({ channel: 'din0', action: { contactState: contact(bytes[0] & 0x01) } });
  channels.push({ channel: 'din1', action: { contactState: contact((bytes[0] >> 1) & 0x01) } });
  channels.push({ channel: 'din2', action: { contactState: contact((bytes[0] >> 2) & 0x01) } });
  channels.push({ channel: 'modbus0', modbusRegister: (bytes[9] << 8) | bytes[8] });
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
    return { data: { make: "volley-boast", model: "vobo-tc" } };
  }
  if (!input || !input.bytes || input.bytes.length === 0) {
    return { errors: ['empty payload: no application bytes to decode'] };
  }

  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "volley-boast";
    result.data.model = "vobo-tc";
  }
  return result;
}
