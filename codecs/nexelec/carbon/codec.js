// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Nexelec Carbon (indoor CO2 + temperature +
// humidity air-quality monitor with the iZiAiR air-quality / hygrothermal
// comfort indices).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. The wire
// format (Nexelec bit-packed frame: a 4-bit product nibble, a 4-bit message
// type, then MSB-first bit fields) was ported from and normalized against the
// upstream Apache-2.0 decoder (TheThingsNetwork/lorawan-devices
// vendor/nexelec/carbon-codec-v1.js, attributed in NOTICE). The upstream
// MSB-first bit-stream slicing is reproduced exactly; only the Real-Time
// periodic data message (type 0x2) for the Carbon product (0x7,
// "Insafe_Carbon_LoRa") is decoded here. The upstream `decodeUplink` shim is
// itself non-functional (it references an undefined `bytes`/`msg`); the working
// logic lives in its `Decoder(bytes)`, which is what is ported.
//
// Field mapping (Real-Time frame, MSB-first bit offsets across the payload):
//   product       bits  0..3  ( 4b) must be 0x7 (Insafe_Carbon_LoRa)
//   messageType   bits  4..7  ( 4b) must be 0x2 (Real-Time)
//   co2           bits  8..15 ( 8b) value = code*20 ppm   -> air.co2
//   temperature   bits 16..23 ( 8b) value = code*0.2 °C   -> air.temperature
//   humidity      bits 24..31 ( 8b) value = code*0.5 %RH  -> air.relativeHumidity
//   iaqGlobal     bits 32..34 ( 3b) iZiAiR overall index  -> iaqGlobal (extra)
//   iaqSource     bits 35..38 ( 4b) dominant index source -> iaqSource (extra)
//   iaqCo2        bits 39..41 ( 3b) CO2 sub-index         -> iaqCo2 (extra)
//   iaqDryness    bits 42..44 ( 3b) dryness sub-index     -> iaqDryness (extra)
//   iaqMould      bits 45..47 ( 3b) mould sub-index       -> iaqMould (extra)
//   iaqDustMites  bits 48..50 ( 3b) dust-mite sub-index   -> iaqDustMites (extra)
//   iaqComfort    bits 51..52 ( 2b) hygrothermal comfort  -> iaqComfort (extra)
//   frameIndex    bits 53..55 ( 3b) rolling frame counter -> frameIndex (extra)
//
// The Carbon has no CO2-trend, presence/motion, light, or battery-voltage field
// in its Real-Time frame, so none of those normalized keys are emitted. (The
// separate Product-Status message carries only a coarse High/Medium/Critical
// battery level, not a voltage or percentage, and is not decoded here.) The
// iZiAiR indices have no vocabulary key, so they are emitted as camelCase
// extras carrying the upstream human-readable labels.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

// Convert the byte array to a single MSB-first bit string, mirroring the
// upstream decoder's per-byte binary concatenation.
function bytesToBits(bytes) {
  var s = '';
  for (var i = 0; i < bytes.length; i++) {
    var b = (bytes[i] & 0xff).toString(2);
    while (b.length < 8) {
      b = '0' + b;
    }
    s += b;
  }
  return s;
}

// iZiAiR index label tables (ported verbatim from the upstream `get_iaq`,
// `get_iaq_SRC`, and `get_IAQ_HCI` switch statements, including upstream's
// French "Erreur" label). Codes the upstream maps to no label (it returns the
// empty string "") decode to undefined here and are suppressed rather than
// emitted as a meaningless empty extra.
var IAQ = ['Excellent', 'Good', 'Fair', 'Poor', 'Bad', 'Erreur'];
var IAQ_SRC = ['All', 'Dryness Indicator', 'Mould Indicator', 'Dust Mites Indicator', 'CO', 'CO2'];
var IAQ_HCI = ['Good', 'Fair', 'Bad', 'Erreur'];

function iaqLabel(code) {
  return IAQ[code];
}
function iaqSrcLabel(code) {
  if (code === 15) {
    return 'Erreur';
  }
  return IAQ_SRC[code];
}
function iaqHciLabel(code) {
  return IAQ_HCI[code];
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;
  if (!bytes || bytes.length < 7) {
    return { errors: ['payload too short for a Nexelec Carbon Real-Time frame'] };
  }

  var bits = bytesToBits(bytes);

  // Product is the high nibble of byte 0, message type the low nibble.
  var product = parseInt(bits.substring(0, 4), 2);
  var messageType = parseInt(bits.substring(4, 8), 2);

  if (product !== 0x7) {
    return { errors: ['unexpected product byte (expected 0x7 for Nexelec Carbon)'] };
  }
  if (messageType !== 0x2) {
    return { errors: ['unsupported message type (only Real-Time data 0x2 is decoded)'] };
  }

  // Bit-field extraction ported from the upstream Real-Time decode table
  // (tab_decodage_Real_Time = [4,4,8,8,8,3,4,3,3,3,3,2,3]).
  var co2Code = parseInt(bits.substring(8, 16), 2);
  var tempCode = parseInt(bits.substring(16, 24), 2);
  var humCode = parseInt(bits.substring(24, 32), 2);
  var iaqGlobalCode = parseInt(bits.substring(32, 35), 2);
  var iaqSrcCode = parseInt(bits.substring(35, 39), 2);
  var iaqCo2Code = parseInt(bits.substring(39, 42), 2);
  var iaqDryCode = parseInt(bits.substring(42, 45), 2);
  var iaqMouldCode = parseInt(bits.substring(45, 48), 2);
  var iaqDmCode = parseInt(bits.substring(48, 51), 2);
  var iaqHciCode = parseInt(bits.substring(51, 53), 2);
  var frameIndex = parseInt(bits.substring(53, 56), 2);

  var data = {
    air: {
      co2: co2Code * 20,
      temperature: round(tempCode * 0.2, 1),
      relativeHumidity: round(humCode * 0.5, 1)
    }
  };

  // iZiAiR indices — no vocabulary key; emit the upstream human-readable labels
  // as camelCase extras, suppressing reserved/unmapped codes.
  var iaqGlobal = iaqLabel(iaqGlobalCode);
  if (iaqGlobal !== undefined) {
    data.iaqGlobal = iaqGlobal;
  }
  var iaqSource = iaqSrcLabel(iaqSrcCode);
  if (iaqSource !== undefined) {
    data.iaqSource = iaqSource;
  }
  var iaqCo2 = iaqLabel(iaqCo2Code);
  if (iaqCo2 !== undefined) {
    data.iaqCo2 = iaqCo2;
  }
  var iaqDryness = iaqLabel(iaqDryCode);
  if (iaqDryness !== undefined) {
    data.iaqDryness = iaqDryness;
  }
  var iaqMould = iaqLabel(iaqMouldCode);
  if (iaqMould !== undefined) {
    data.iaqMould = iaqMould;
  }
  var iaqDustMites = iaqLabel(iaqDmCode);
  if (iaqDustMites !== undefined) {
    data.iaqDustMites = iaqDustMites;
  }
  var iaqComfort = iaqHciLabel(iaqHciCode);
  if (iaqComfort !== undefined) {
    data.iaqComfort = iaqComfort;
  }

  data.frameIndex = frameIndex;

  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "nexelec";
    result.data.model = "carbon";
  }
  return result;
}
