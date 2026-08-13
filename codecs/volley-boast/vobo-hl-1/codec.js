// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Volley Boast VoBo-HL-1 (input endpoint /
// LoRaWAN bridge, Class 1 Div 2 hazardous-location variant).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format understood with reference to the upstream (vendor-maintained) decoder
// (TheThingsNetwork/lorawan-devices vendor/volley-boast/vobo-decoder.js,
// attributed in NOTICE). Upstream emits raw ADC counts plus metadata; this
// module normalizes the fPort-1 Standard payload's defined fields to the shared
// vocabulary and does NOT copy upstream. HL-1 shares the VoBo Standard payload
// format with GP-1 / XP, so it carries the same three digital, three ADC and one
// Modbus-slot positions and uses the identical channels[] label scheme.
//
// Only the fPort-1 "Standard" payload is decoded here -- it is the one payload
// with a fixed, unit-defined layout (10 bytes). The Modbus / analog-sensor /
// heartbeat / config payloads on other fPorts carry either opaque raw Modbus
// registers (no scale) or non-measurement data and are reported as errors.
//
// Standard payload (fPort 1) bit layout:
//   byte0 bit0..2   = DIN1..DIN3 (digital inputs)
//   byte0 bit3      = WKUP (wakeup digital input)
//   ADC1 (12-bit)   = (byte0>>4) | (byte1<<4)
//   ADC2 (12-bit)   = (byte3&0x0f)<<8 | byte2
//   ADC3 (12-bit)   = (byte3>>4) | (byte4<<4)
//   Battery (12-bit)= ((byte6&0x0f)<<8 | byte5) * 4  [millivolts]
//   Temperature     = 12-bit signed ADC, 0.125 degC/count
//   Modbus0 (16-bit)= byte9<<8 | byte8
//
// Multi-position output (`channels[]`, see AUTHORING.md "Multi-channel
// devices"). This endpoint reports three independent banks of sub-sensor
// positions in the one Standard frame -- three dry-contact digital inputs,
// three analog (ADC) inputs, and one Modbus register slot -- and all of them
// ride in the single reserved `channels` array. They are different physical
// things, so each position is its own entry rather than a merged one: entry
// labels only have to be unique within the array, and one array keeps every
// position addressable in a single flattener pass. Labels use the vendor's own
// term plus a ZERO-BASED index, so they are offset by one from the vendor's
// one-based field names:
//   digital bank -> `din0` = DIN1 (byte0 bit0), `din1` = DIN2 (bit1),
//                   `din2` = DIN3 (bit2), each carrying action.contactState
//                   ("closed" when the bit is set, else "open").
//   ADC bank     -> `adc0` = ADC1/AIN1, `adc1` = ADC2/AIN2, `adc2` = ADC3/AIN3,
//                   each carrying analog.raw (the 12-bit count, unscaled).
//   Modbus slot  -> `modbus0` = Modbus payload slot 0 (byte8..byte9), carrying
//                   the raw 16-bit register as the `modbusRegister` extra.
// CAUTION when reading old data: the labels are NOT the vendor's numbers.
// `din1` is the vendor's DIN2 and `adc1` is the vendor's ADC2; the retired
// extras `digitalInput2` / `adc2Raw` were named for the vendor's DIN2 / ADC2
// and are now `din1` / `adc1`. Zero-based labels are the repo convention
// (netvox/r831d `input0..input2`, atim/acw-dind160 `input0..input15`).
//
// Why `din` and not `digitalInput`: DIN is the vendor's own term everywhere in
// the wire documentation -- upstream `parseStandardPayload` emits DIN1..DIN3,
// the configuration payload has din1TransmitEnable..din3TransmitEnable, and the
// digital-sensor name table reads "DIN1"/"DIN2"/"DIN3". `digitalInput2` /
// `digitalInput3` were codec-local names upstream never uses. The VoBo-TC
// sibling already labelled these inputs `din*`, so the whole VoBo family now
// shares one label scheme.
//
// What the shape change fixes: before this, only DIN1 became
// action.contactState while DIN2/DIN3 were raw 0/1 extras, and only ADC1 became
// analog.raw while ADC2/ADC3 were `adc2Raw`/`adc3Raw` counts -- three
// positions of one bank spoke three different key names, so per-position truth
// was not addressable downstream. All three digital positions now share the
// contactState enum with the unchanged convention (bit set -> "closed", clear
// -> "open") and all three ADC positions share analog.raw with the unchanged
// 12-bit extraction.
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
// normalized their registers would join the array as `modbus1`..`modbus40`.
// The entry carries the register as the camelCase extra `modbusRegister`, not
// as analog.raw: each slot is independently pointed by configuration at an
// arbitrary (Modbus group, register) pair on an arbitrary slave, so upstream
// fixes no engineering unit for it. (codecs/adeunis/modbus does map an opaque
// register onto analog.raw, but there the register is the device's only
// reading; here analog.raw is this device's own ADC counts and folding a
// slave's register into the same metric would conflate the two.)
//
// Whole-device readings stay TOP-LEVEL and are never duplicated inside an
// entry: `battery` (V), `air.temperature` (the board's own ADC temperature,
// degC) and the `wakeup` extra. WKUP is digital sensor 0 in upstream's
// digital-sensor name table, but it is the wake-cause housekeeping flag of the
// whole device rather than a measured contact terminal, so it keeps its
// top-level 0/1 shape instead of becoming a fourth `din*` entry.
//
// Sentinel policy: there is no sentinel to honor. `parseStandardPayload`
// extracts each DIN bit with a plain 1-bit test and each ADC as a plain 12-bit
// count, and reserves no "input unwired" / "probe disconnected" value -- an
// unwired terminal is indistinguishable from an open contact and a floating
// ADC input from a real count -- so no reading is treated as a sentinel and no
// position is suppressed on its value. The length guard below requires all 10
// Standard-payload bytes, so every one of the seven positions is present
// whenever a frame decodes; `channels` is still built lazily and omitted when
// empty so no future short/variable-length path can ship an empty array.
//
// Category `analog-interface` (atLeastOne: analog.raw / action.contactState) is
// still satisfied: both keys now live only inside entries, and membership
// resolves through top-level `channels[]` entries.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function contact(bit) {
  return bit ? 'closed' : 'open';
}

function decodeVoboStandard(bytes) {
  if (!bytes || bytes.length < 10) {
    return { errors: ['Standard payload too short (' + (bytes ? bytes.length : 0) + '), expected 10 bytes'] };
  }

  var adc1 = ((bytes[0] & 0xf0) >> 4) | (bytes[1] << 4);
  var adc2 = ((bytes[3] & 0x0f) << 8) | bytes[2];
  var adc3 = ((bytes[3] & 0xf0) >> 4) | (bytes[4] << 4);
  var batteryMv = (((bytes[6] & 0x0f) << 8) | bytes[5]) * 4;

  var tempRaw = ((bytes[6] & 0xf0) >> 4) | (bytes[7] << 4);
  var temperature;
  if ((bytes[7] >> 7 & 0x01) === 0) {
    temperature = tempRaw * 0.125;
  } else {
    temperature = (4096 - tempRaw) * 0.125 * -1;
  }

  var data = {};
  data.battery = round(batteryMv / 1000, 3);
  data.air = { temperature: round(temperature, 3) };
  data.wakeup = (bytes[0] >> 3) & 0x01;

  // One entry per sub-sensor position: DIN1..DIN3 -> din0..din2,
  // ADC1..ADC3 -> adc0..adc2, Modbus payload slot 0 -> modbus0.
  var channels = [];
  channels.push({ channel: 'din0', action: { contactState: contact(bytes[0] & 0x01) } });
  channels.push({ channel: 'din1', action: { contactState: contact((bytes[0] >> 1) & 0x01) } });
  channels.push({ channel: 'din2', action: { contactState: contact((bytes[0] >> 2) & 0x01) } });
  channels.push({ channel: 'adc0', analog: { raw: adc1 } });
  channels.push({ channel: 'adc1', analog: { raw: adc2 } });
  channels.push({ channel: 'adc2', analog: { raw: adc3 } });
  channels.push({ channel: 'modbus0', modbusRegister: (bytes[9] << 8) | bytes[8] });
  if (channels.length > 0) {
    data.channels = channels;
  }

  return { data: data };
}

function decodeUplinkCore(input) {
  if (input.fPort !== 1) {
    return { errors: ['unsupported fPort ' + input.fPort + ' (only the Standard payload on fPort 1 is normalized)'] };
  }
  return decodeVoboStandard(input.bytes);
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "volley-boast";
    result.data.model = "vobo-hl-1";
  }
  return result;
}
