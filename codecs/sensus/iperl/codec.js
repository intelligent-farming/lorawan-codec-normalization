// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for sensus/iperl (Sensus iPERL residential water meter).
//
// Ported from the upstream Apache-2.0 OMS / wireless M-Bus decoder
// (TheThingsNetwork/lorawan-devices vendor/sensus/iperl-oms.js, attributed in
// NOTICE). The upstream ships as a minified Kotlin/JS bundle; the wire format
// (OMS short transport-layer header CI=0x7A, then DIF/VIF data records) was
// recovered by running the upstream decoder as an oracle and reproduced here as
// plain, console-safe ES5. The iPERL emits a PLAINTEXT OMS payload (no AES key
// required): the cumulative volume is read directly from the first VOLUME data
// record. We author the normalization ourselves; we do not copy upstream
// normalizeUplink.
//
// Mapping:
//   first VOLUME data record (m^3, VIF scale) -> metering.water.total (LITRES, m^3 x 1000)
//   status byte                               -> alarms[] (camelCase extra), statusByte, accessNo
// The iPERL OMS frame carries no water temperature, so water.temperature.current
// is not produced.

function decodeUplinkCore(input) {
  var fPort = input.fPort;
  if (fPort !== 20 && fPort !== 21 && fPort !== 22) {
    return { errors: ['unsupported fPort ' + fPort + ' (expected 20, 21 or 22)'] };
  }

  var bytes = input.bytes;
  if (!bytes || bytes.length < 5) {
    return { errors: ['payload too short for OMS short header'] };
  }

  // Round to the meter's real resolution (litres are integers for an m^3*1000 reading,
  // but smaller VIF scales can produce fractions; clamp floating drift to 3 decimals).
  function round(value, decimals) {
    var f = Math.pow(10, decimals);
    return Math.round(value * f) / f;
  }

  // ---- OMS short transport-layer header (CI=0x7A) -------------------------
  // Layout: CI(1) AccessNo(1) Status(1) ConfigWord(2), then data records.
  var ci = bytes[0];
  if (ci !== 0x7a) {
    return { errors: ['unsupported CI field 0x' + ci.toString(16) + ' (expected 0x7A short header)'] };
  }
  var accessNo = bytes[1];
  var statusByte = bytes[2];
  // ConfigWord at bytes[3..4] is the encryption / config word; for plaintext
  // frames the encryption-mode nibble is 0. A non-zero mode would mean the
  // records are AES-encrypted and unreadable without a key.
  var configWord = bytes[3] | (bytes[4] << 8);
  var encryptionMode = configWord & 0x1f;
  if (encryptionMode !== 0) {
    return { errors: ['encrypted OMS payload (mode ' + encryptionMode + '); no key available'] };
  }

  // ---- Status byte -> alarm flags (M-Bus application-status semantics) -----
  var alarms = [];
  if (statusByte & 0x04) { alarms.push('LOW_BATTERY'); }
  if ((statusByte & 0x10) && (statusByte & 0x80)) { alarms.push('LEAKAGE'); }
  if ((statusByte & 0x40) && (statusByte & 0x10)) { alarms.push('MAGNETIC_TAMPERING'); }
  if ((statusByte & 0x40) && (statusByte & 0x08)) { alarms.push('HW_SW_ERROR'); }
  if ((statusByte & 0x10) && (statusByte & 0x20)) { alarms.push('SENSOR_OUT_OF_RANGE'); }
  if ((statusByte & 0x10) && (statusByte & 0x80)) { alarms.push('BROKEN_PIPE'); }
  if ((statusByte & 0x10) && (statusByte & 0x20)) { alarms.push('EMPTY_PIPE'); }

  // ---- Data-record parsing --------------------------------------------------
  // Walk DIF (+DIFEs) / VIF (+VIFEs) / data, find the first VOLUME record.
  // DIF data-field codes (low nibble): 0x0=none, 0x1..0x4 = 1..4 byte integer,
  // 0x5=4-byte real (unused here), 0x6=6-byte int, 0x7=8-byte int,
  // 0x9..0xC = 1..4 byte BCD, 0xD=variable-length (LVAR), 0xE=6-byte BCD,
  // 0xF=special. VIF volume codes 0x10..0x17 = m^3 with exponent (vif&0x07)-6.
  var DIF_INT_LEN = { 0x0: 0, 0x1: 1, 0x2: 2, 0x3: 3, 0x4: 4, 0x6: 6, 0x7: 8 };
  var DIF_BCD_LEN = { 0x9: 1, 0xa: 2, 0xb: 3, 0xc: 4, 0xe: 6 };

  function readIntLE(buf, off, len) {
    var v = 0;
    var mul = 1;
    for (var i = 0; i < len; i++) {
      v += buf[off + i] * mul;
      mul *= 256;
    }
    return v;
  }

  function readBcdLE(buf, off, len) {
    var v = 0;
    var mul = 1;
    for (var i = 0; i < len; i++) {
      var b = buf[off + i];
      v += (b & 0x0f) * mul;
      mul *= 10;
      v += ((b >> 4) & 0x0f) * mul;
      mul *= 10;
    }
    return v;
  }

  var litres = null;
  var pos = 5;
  var guard = 0;
  while (pos < bytes.length && guard < 64) {
    guard++;
    var dif = bytes[pos];
    pos++;
    if (dif === 0x0f || dif === 0x1f) {
      // manufacturer-specific data block; stop record parsing.
      break;
    }
    var fieldCode = dif & 0x0f;
    // Skip DIF extensions (storage/tariff/subunit bits) — not needed for the total.
    while ((bytes[pos - 1] & 0x80) && pos < bytes.length) {
      pos++; // consume DIFE
    }
    if (pos >= bytes.length) { break; }

    var vif = bytes[pos];
    pos++;
    var isVolume = (vif & 0x7f) >= 0x10 && (vif & 0x7f) <= 0x17;
    var exponent = (vif & 0x07) - 6;
    // Skip VIF extensions.
    while ((bytes[pos - 1] & 0x80) && pos < bytes.length) {
      pos++; // consume VIFE
    }

    // Determine data length from the DIF field code.
    var dataLen;
    if (fieldCode === 0x0d) {
      // LVAR: next byte is the length.
      if (pos >= bytes.length) { break; }
      dataLen = bytes[pos];
      pos++;
    } else if (DIF_INT_LEN[fieldCode] !== undefined) {
      dataLen = DIF_INT_LEN[fieldCode];
    } else if (DIF_BCD_LEN[fieldCode] !== undefined) {
      dataLen = DIF_BCD_LEN[fieldCode];
    } else {
      // Unknown field code — cannot reliably continue.
      break;
    }
    if (pos + dataLen > bytes.length) { break; }

    if (isVolume && litres === null && dataLen > 0) {
      var raw;
      if (DIF_BCD_LEN[fieldCode] !== undefined) {
        raw = readBcdLE(bytes, pos, dataLen);
      } else {
        raw = readIntLE(bytes, pos, dataLen);
      }
      // raw is in m^3 * 10^exponent; convert m^3 to litres (x1000).
      var cubicMetres = raw * Math.pow(10, exponent);
      litres = round(cubicMetres * 1000, 3);
    }

    pos += dataLen;
  }

  if (litres === null) {
    return { errors: ['no volume data record found in OMS payload'] };
  }

  var data = {
    'metering.water.total': litres,
    accessNo: accessNo,
    statusByte: statusByte,
    alarms: alarms
  };

  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "sensus";
    result.data.model = "iperl";
  }
  return result;
}
