// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Mutelcor MTC-CO2-05 (LoRa wireless CO2 sensor:
// CO2 + temperature + relative humidity, with optional pressure, light, TVOC,
// distance, digital inputs and particulate matter).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format (Mutelcor LoRaButton framing: version, battery/input voltage, OpCode,
// then OpCode-specific body) understood with reference to the upstream
// Apache-2.0 decoder (TheThingsNetwork/lorawan-devices vendor/mutelcor/
// mutelcor.js, attributed in NOTICE). Ported from upstream
// MutelcorLoRaButtonDecode; we author the normalization ourselves and do NOT
// copy upstream normalizeUplink / Descriptions output.
//
// Mutelcor reports the battery/input voltage in centivolts (value / 100), i.e.
// already in volts, so it maps directly to the vocabulary `battery` (V) key.
// Temperature is a signed 16-bit value in tenths of a degree Celsius. CO2,
// light and distance are unsigned 16-bit; relative humidity is one byte.
// Pressure is tenths of a hPa. The vocabulary has no key for TVOC, particulate
// matter, switch state or the message framing fields, so those are emitted as
// camelCase extras (tvoc, pm1_0, pm2_5, pm10, distance, switchState,
// messageType, payloadVersion).
//
// Multi-channel shape (`channels[]`) — the digital inputs are the one
// multi-position reading on this node: the same quantity (a dry-contact / logic
// level) at up to four terminals of one device. They move into the reserved
// `channels` array (see AUTHORING.md "Multi-channel devices") and the
// `digitalInputs` extra group that used to wrap them (`digitalInputs.input1`,
// `digitalInputs.input2`, …) is GONE — one entry per fitted input instead.
//
// Label scheme and renumbering — the labels are the vendor's own term for the
// terminal ("digital input", upstream field `[08] Digital Inputs`) plus a
// zero-based index, so they are renumbered against upstream's one-based keys:
//   `input0` = upstream dinputs[1] = presence bit 0x01, level bit 0x10
//   `input1` = upstream dinputs[2] = presence bit 0x02, level bit 0x20
//   `input2` = upstream dinputs[3] = presence bit 0x04, level bit 0x40
//   `input3` = upstream dinputs[4] = presence bit 0x08, level bit 0x80
// The label `input1` therefore means the SECOND terminal here and meant the
// FIRST upstream — read the bit mask, not the digit, when comparing to upstream.
// The wire format carries four inputs (upstream loops `diginp < 4`), not two, so
// all four are decoded; a real frame simply reports only the fitted ones.
//
// Each entry carries the `action.contactState` vocabulary key ("open" |
// "closed") rather than the raw boolean the old `digitalInputs.inputN` extras
// held: a level bit set is a closed contact, clear is open. Promoting to the
// vocabulary key disturbs nothing — this device declares only `climate`
// (requires air.temperature + air.relativeHumidity) and `air-quality` (requires
// air.co2), so its membership never depended on the inputs — and it matches the
// sibling Mutelcor switch device (mtc-mf01) and the netvox dry-contact family,
// so a downstream consumer sees one contact metric across all of them instead of
// a per-vendor boolean extra.
//
// Everything else stays TOP-LEVEL (whole-device readings, never duplicated in
// entries): the whole `air` block, `battery`, `tvoc`, `distance`, `pm1_0` /
// `pm2_5` / `pm10`, `switchState`, `messageType`, `payloadVersion`.
//
// NOT positions — deliberately left alone: the digits in `air.co2`, `pm1_0`,
// `pm2_5` and `pm10` are part of the pollutant's NAME (carbon dioxide; the
// 1.0 / 2.5 / 10 µm particulate size bins), not sub-sensor position indices.
// They were explicitly triaged out of the channels[] conversion — do not "fix"
// them into `channels[]` entries later; each names a different quantity, so they
// are not the same quantity at several positions and the reserved array does not
// apply.
//
// Sentinel policy: the digital-inputs byte carries its own presence mask, and
// that mask IS the disconnected-position policy. The low nibble flags which
// terminals are fitted and the matching high-nibble bit gives that terminal's
// level, so an input whose presence bit is CLEAR is not connected and is skipped
// entirely — no entry, rather than a fabricated "open" from a level bit that
// means nothing. This is exactly upstream's own gate
// (`if (digital_inputs & (1 << diginp)) dinputs[diginp + 1] = …`); no other
// value is treated as a sentinel. `channels` is built lazily and attached only
// when at least one input is present, so the far more common frame — a
// CO2/climate measurement with no digital-inputs field at all, or one where no
// terminal is fitted — omits the key rather than shipping an empty array.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function u16be(hi, lo) {
  return ((hi * 256) + lo) & 0xffff;
}

function s16be(hi, lo) {
  var v = u16be(hi, lo);
  return v > 0x7fff ? v - 0x10000 : v;
}

// Mutelcor OpCode -> camelCase message-type name.
var OPCODES = {
  0: 'heartbeat',
  1: 'alarm',
  2: 'votes',
  3: 'measurements',
  4: 'location',
  5: 'thresholds',
  6: 'switch',
  7: 'reminder',
  80: 'feedback',
  112: 'info',
  113: 'show',
  114: 'update',
  128: 'scd30'
};

function decodeUplinkCore(input) {
  var bytes = input.bytes;

  if (!bytes || bytes.length === 0) {
    return { errors: ['empty payload'] };
  }

  var pos = 0;
  var data = {};
  var air = {};
  // Built lazily: stays null (and the `channels` key is omitted) unless the
  // frame reports at least one fitted digital input.
  var channels = null;

  // Byte 0: payload version.
  data.payloadVersion = bytes[pos];
  pos += 1;

  // Bytes 1..2: battery / input voltage in centivolts -> volts.
  if (bytes.length < pos + 2) {
    return { errors: ['unexpected end, no (complete) voltage'] };
  }
  data.battery = round(u16be(bytes[pos], bytes[pos + 1]) / 100, 2);
  pos += 2;

  // Byte 3: OpCode (message type).
  if (bytes.length < pos + 1) {
    return { errors: ['unexpected end, no OpCode'] };
  }
  var opcode = bytes[pos];
  pos += 1;

  if (!Object.prototype.hasOwnProperty.call(OPCODES, opcode)) {
    return { errors: ['unknown OpCode ' + opcode] };
  }
  data.messageType = OPCODES[opcode];

  // Measurements (OpCode 3). This is the primary uplink for the CO2 variant.
  // Thresholds (OpCode 5) carries the same measurement block; this codec only
  // normalizes the measurement readings, not the threshold trigger flags.
  if (opcode === 3 || opcode === 5) {
    if (bytes.length < pos + 1) {
      return { errors: ['unexpected end, measurements OpCode requires a measurement bitmask'] };
    }
    var mask = bytes[pos];
    pos += 1;

    if (mask & 1) {
      // Temperature: signed 16-bit, tenths of a degree Celsius.
      if (bytes.length < pos + 2) {
        return { errors: ['unexpected end, no (complete) temperature value'] };
      }
      air.temperature = round(s16be(bytes[pos], bytes[pos + 1]) / 10, 1);
      pos += 2;
    }
    if (mask & 2) {
      // Relative humidity: one byte, percent.
      if (bytes.length < pos + 1) {
        return { errors: ['unexpected end, no relative humidity value'] };
      }
      air.relativeHumidity = bytes[pos];
      pos += 1;
    }
    if (mask & 4) {
      // Pressure: unsigned 16-bit, tenths of a hPa.
      if (bytes.length < pos + 2) {
        return { errors: ['unexpected end, no (complete) pressure value'] };
      }
      air.pressure = round(u16be(bytes[pos], bytes[pos + 1]) / 10, 1);
      pos += 2;
    }
    if (mask & 8) {
      // Light: unsigned 16-bit, lux.
      if (bytes.length < pos + 2) {
        return { errors: ['unexpected end, no (complete) light value'] };
      }
      air.lightIntensity = u16be(bytes[pos], bytes[pos + 1]);
      pos += 2;
    }
    if (mask & 16) {
      // CO2: unsigned 16-bit, ppm.
      if (bytes.length < pos + 2) {
        return { errors: ['unexpected end, no (complete) CO2 value'] };
      }
      air.co2 = u16be(bytes[pos], bytes[pos + 1]);
      pos += 2;
    }
    if (mask & 32) {
      // TVOC: unsigned 16-bit, ppb. No vocabulary key -> extra.
      if (bytes.length < pos + 2) {
        return { errors: ['unexpected end, no (complete) TVOC value'] };
      }
      data.tvoc = u16be(bytes[pos], bytes[pos + 1]);
      pos += 2;
    }
    if (mask & 64) {
      // Distance: unsigned 16-bit, mm. No vocabulary key -> extra.
      if (bytes.length < pos + 2) {
        return { errors: ['unexpected end, no (complete) distance value'] };
      }
      data.distance = u16be(bytes[pos], bytes[pos + 1]);
      pos += 2;
    }
    if (mask & 128) {
      // Extended-measurement byte: a second bitmask for digital inputs / PM.
      if (bytes.length < pos + 1) {
        return { errors: ['unexpected end, no extended measurement bitmask'] };
      }
      var ext = bytes[pos];
      pos += 1;

      if (ext & 1) {
        // Digital inputs: one byte. Low nibble flags which inputs are present;
        // the matching high-nibble bit gives that input's level. One channels[]
        // entry per PRESENT input (zero-based label, `input0` = presence bit
        // 0x01), each carrying action.contactState; an absent input is skipped.
        if (bytes.length < pos + 1) {
          return { errors: ['unexpected end, no digital inputs value'] };
        }
        var di = bytes[pos];
        pos += 1;
        for (var n = 0; n < 4; n += 1) {
          if (di & (1 << n)) {
            if (!channels) {
              channels = [];
            }
            channels.push({
              channel: 'input' + n,
              action: { contactState: (di & (1 << (n + 4))) !== 0 ? 'closed' : 'open' }
            });
          }
        }
      }
      if (ext & 2) {
        // Particulate matter: three unsigned 16-bit values (PM1.0, PM2.5,
        // PM10) in µg/m³. No vocabulary key -> camelCase extras.
        if (bytes.length < pos + 6) {
          return { errors: ['unexpected end, no (complete) particulate matter values'] };
        }
        data.pm1_0 = u16be(bytes[pos], bytes[pos + 1]);
        data.pm2_5 = u16be(bytes[pos + 2], bytes[pos + 3]);
        data.pm10 = u16be(bytes[pos + 4], bytes[pos + 5]);
        pos += 6;
      }
    }

    // A trailing byte after the measurement block is the switch state.
    if (pos + 1 <= bytes.length) {
      data.switchState = bytes[pos] !== 0;
      pos += 1;
    }
  }

  if (air.temperature !== undefined ||
      air.relativeHumidity !== undefined ||
      air.pressure !== undefined ||
      air.lightIntensity !== undefined ||
      air.co2 !== undefined) {
    data.air = air;
  }

  if (channels && channels.length > 0) {
    data.channels = channels;
  }

  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  // fPort 0 carries MAC commands only (LoRaWAN spec): there is no application
  // payload to decode, so this is not a decode failure. See AUTHORING.md.
  if (input && input.fPort === 0) {
    return { data: { make: "mutelcor", model: "mtc-co2-05" } };
  }
  if (!input || !input.bytes || input.bytes.length === 0) {
    return { errors: ['empty payload: no application bytes to decode'] };
  }

  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "mutelcor";
    result.data.model = "mtc-co2-05";
  }
  return result;
}
