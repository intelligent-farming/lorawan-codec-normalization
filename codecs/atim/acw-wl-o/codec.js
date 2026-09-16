// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for ATIM ACW-WL-O (Outdoor Liquid / Water-Leak
// Monitoring). Category: water-leak.
//
// Ported from the upstream Apache-2.0 ATIM generic decoder
// (TheThingsNetwork/lorawan-devices vendor/atim/decodeur.js, attributed in
// NOTICE). The upstream module is a single generic decoder shared across the
// whole ATIM ACW range; this codec ports only the frame types the WL-O emits
// and normalizes them to the shared vocabulary. We author the normalization
// here; we do NOT reuse upstream normalizeUplink output.
//
// Wire format (per upstream):
//   byte0 high-nibble bit2 set (e.g. 0xA0) => "Trame de mesure" (measurement):
//     a stream of type-tagged channels. Each channel = 1 marker byte
//     (low nibble = type, high nibble = channel index) followed by its data:
//       0x01 digital input  -> 1 byte, low nibble = 4 input bits (bit0..bit3)
//       0x08 temperature    -> 2 bytes, signed, /100 = degC
//   byte0 high bit set with byte1 == 0x01 => "Trame de vie" (life/keep-alive):
//     [v_hi v_lo c_hi c_lo], battery voltage = (v<<8|v)/1000 V.
//   byte1 low nibble == 0x0E => "Trame d'erreur" (error): byte2 = error code.
//   empty payload => error.
//
// Multi-position shape (`channels[]`, see AUTHORING.md "Multi-channel devices").
// A temperature marker's high nibble is a real sub-sensor index — ATIM calls it
// the *voie* (0..3), and upstream's own struct names carry it (`temp0`, `temp1`,
// with `temperature<n>.voie` in its output). One measurement frame can therefore
// carry several thermal voies, so each becomes its own entry in the reserved
// `channels` array, labelled with the vendor's term plus the decoded index:
//   temperature TLV (0x08) -> { channel: 'voie<n>', water.temperature.current }
// matching the already-converted ATIM siblings ACW-TM2P / ACW-THX. Entries are
// created on the first healthy reading, so entry order follows the payload; a
// repeated TLV for a voie already seen keeps the first (most recent) reading.
// This fixes real data loss: the previous shape wrote every voie's temperature to
// the same top-level `water.temperature.current`, so in a multi-voie frame the
// last channel silently overwrote all earlier ones. (It also reads voie 2 and 3,
// which upstream's postProcessTemp drops — it only shapes temp0/temp1.)
//
// Leak mapping — `water.leak` stays TOP-LEVEL (whole-device), deliberately, and
// is therefore never repeated inside an entry: unlike the temperature TLV, the
// digital-input TLV is not positional in this wire format. Upstream's struct
// builder names it plain `entree` with no voie suffix (contrast `temp0`/`temp1`/
// `compte0`) and its four decoded values are the four input *lines* carried in
// that single byte's low nibble, not four voies. The WL-O is a single-probe
// liquid detector with the probe wired to line bit0, so bit0 high (1) =
// liquid/leak detected => `water.leak`; the raw four lines stay as the top-level
// `digitalInputs` extra. Nothing in the payload identifies a second probe, so
// scoping the leak into a channels entry would invent a position the device does
// not report.
//
// Sentinel policy: a temperature voie reading the raw sentinel -32768
// (= -327.68 degC, upstream's "erreur") is a faulted/disconnected probe. That
// voie is skipped — it gets no entry, so no bogus -327.68 is ever published —
// and a warning names the voie ('temperature sensor error on channel <n>'). A
// frame whose every voie faults yields no entries at all: if the frame also
// carried the digital-input line it still decodes (leak only, no `channels`
// key, warnings listing each faulted voie); if it carried nothing else it is an
// error ('measurement frame contained no recognized channels'). `channels` is
// built lazily and omitted whenever no healthy voie is present.
//
// Whole-device readings stay top-level: `water.leak`, the `digitalInputs` extra,
// and the life frame's `battery` / `chargeVoltage`.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

// ERR_* codes (0x81..0x9F) mapped to English text.
var ERR_TEXT = {
  129: 'Sensor returned no data',
  130: 'Data buffer full',
  131: 'History depth out of range',
  132: 'Sample count out of range',
  133: 'Channel count out of range',
  134: 'Measurement type out of range',
  135: 'Bad sampling-period structure',
  136: 'Subtask ended unexpectedly',
  137: 'Null pointer',
  138: 'Battery level critical',
  139: 'EEPROM corrupted',
  140: 'ROM corrupted',
  141: 'RAM corrupted',
  142: 'Radio module init failed',
  143: 'Radio module busy',
  144: 'Radio module in bridge mode',
  145: 'Radio queue full',
  146: 'Black-box init failed',
  147: 'Bad keep-alive-period structure',
  148: 'Entered deep sleep',
  149: 'Battery level low',
  150: 'Radio transmission error',
  151: 'Payload too large for network',
  152: 'Network pairing timeout',
  153: 'Sensor timeout',
  154: 'Sensor returned no value',
  155: 'Sensor not detected at startup',
  156: 'Enclosure opened',
  157: 'Enclosure closed',
  158: 'Movement/theft detected',
  159: 'Sensor data corrupted'
};

function decodeUplinkCore(input) {
  var bytes = input.bytes;
  if (!bytes || bytes.length === 0) {
    return { errors: ['empty payload'] };
  }

  var b0 = bytes[0];
  var b1 = bytes.length > 1 ? bytes[1] : -1;

  // --- Frame-type detection (ported from upstream getFrameType) ---
  // byte0 high nibble: bit0 (0x80) distinguishes new vs legacy product;
  // bit2 (0x20) marks a measurement frame.
  var newProduct = (b0 & 0x80) !== 0;
  if (!newProduct) {
    return { errors: ['legacy ATIM product frame not supported by this codec'] };
  }

  var isMeasurement = (b0 & 0x20) !== 0;
  if (isMeasurement) {
    return decodeMeasurement(bytes);
  }
  // Non-measurement new-product frames are typed by byte1.
  if (b1 === 0x01) {
    return decodeLife(bytes);
  }
  if ((b1 & 0x0f) === 0x0e) {
    return decodeError(bytes);
  }
  return { errors: ['unsupported frame type (byte1=0x' + b1.toString(16) + ')'] };
}

// One channels entry per temperature voie, created on the first healthy reading
// so entry order follows the payload. `index` maps a label to its slot.
function entryFor(entries, index, channel) {
  var label = 'voie' + channel;
  if (index[label] === undefined) {
    index[label] = entries.length;
    entries.push({ channel: label });
  }
  return entries[index[label]];
}

function decodeMeasurement(bytes) {
  var data = {};
  var warnings = [];
  var entries = []; // channels[]: one entry per healthy temperature voie
  var entryIndex = {};
  var i = 1; // skip byte0 (frame header); WL-O measurement frames are not timestamped
  while (i < bytes.length) {
    var marker = bytes[i];
    var type = marker & 0x0f;
    var channel = (marker & 0xf0) >> 4; // high nibble = channel index (0..3)

    if (type === 0x01) {
      // digital input: 1 data byte, low nibble holds 4 input bits. Not a
      // positional voie (see header): the byte's four bits are input lines on
      // the one connector, so this stays a whole-device reading.
      var v = bytes[i + 1];
      if (v === undefined) {
        return { errors: ['truncated digital-input channel'] };
      }
      // bit0 = probe / liquid-detect line for the WL-O
      if (data.water === undefined) {
        data.water = {};
      }
      data.water.leak = (v & 0x01) !== 0;
      // expose all four raw input lines as an extra (bit0..bit3)
      data.digitalInputs = [
        (v & 0x01) !== 0 ? 1 : 0,
        (v & 0x02) !== 0 ? 1 : 0,
        (v & 0x04) !== 0 ? 1 : 0,
        (v & 0x08) !== 0 ? 1 : 0
      ];
      i += 2;
    } else if (type === 0x08) {
      // temperature: 2 bytes, signed, /100 degC, scoped to its own voie entry
      var hi = bytes[i + 1];
      var lo = bytes[i + 2];
      if (hi === undefined || lo === undefined) {
        return { errors: ['truncated temperature channel'] };
      }
      var raw = ((hi << 8) | lo) << 16 >> 16; // sign-extend 16-bit
      if (raw === -32768) {
        // faulted/disconnected probe: skip the position, name it in a warning
        warnings.push('temperature sensor error on channel ' + channel);
      } else {
        var entry = entryFor(entries, entryIndex, channel);
        if (entry.water === undefined) {
          entry.water = { temperature: { current: round(raw / 100, 2) } };
        }
      }
      i += 3;
    } else {
      return { errors: ['unsupported measurement channel type 0x' + type.toString(16)] };
    }
  }

  if (data.water === undefined && entries.length === 0) {
    return { errors: ['measurement frame contained no recognized channels'] };
  }
  if (entries.length > 0) {
    data.channels = entries;
  }
  var out = { data: data };
  if (warnings.length) {
    out.warnings = warnings;
  }
  return out;
}

function decodeLife(bytes) {
  // byte0 byte1 then [v_hi v_lo c_hi c_lo]
  if (bytes.length < 6) {
    return { errors: ['truncated life frame'] };
  }
  var v = (bytes[2] << 8) | bytes[3]; // battery voltage, mV
  var c = (bytes[4] << 8) | bytes[5]; // supply / charge voltage, mV
  return {
    data: {
      battery: round(v / 1000, 3),
      chargeVoltage: round(c / 1000, 3)
    }
  };
}

function decodeError(bytes) {
  if (bytes.length < 3) {
    return { errors: ['truncated error frame'] };
  }
  var code = bytes[2];
  var text = ERR_TEXT[code];
  if (text === undefined) {
    text = 'unknown error (0x' + code.toString(16) + ')';
  }
  // ERR_BATTERY_LEVEL_DEAD (0x8A) / ERR_BATTERY_LEVEL_LOW (0x95) append a
  // battery voltage in the following two bytes.
  if ((code === 0x8a || code === 0x95) && bytes.length >= 5) {
    var mv = (bytes[3] << 8) | bytes[4];
    return { errors: ['device error: ' + text + ' (battery ' + round(mv / 1000, 3) + ' V)'] };
  }
  return { errors: ['device error: ' + text] };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  // fPort 0 carries MAC commands only (LoRaWAN spec): there is no application
  // payload to decode, so this is not a decode failure. See AUTHORING.md.
  if (input && input.fPort === 0) {
    return { data: { make: "atim", model: "acw-wl-o" } };
  }
  if (!input || !input.bytes || input.bytes.length === 0) {
    return { errors: ['empty payload: no application bytes to decode'] };
  }

  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "atim";
    result.data.model = "acw-wl-o";
  }
  return result;
}
