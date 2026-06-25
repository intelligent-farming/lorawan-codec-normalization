// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Dragino CPL01 (Outdoor LoRaWAN Open/Close Dry
// Contact Sensor).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format understood with reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/dragino/cpl01.js, attributed in
// NOTICE). Do NOT copy upstream normalizeUplink.
//
// The CPL01 is a dry-contact (door/open-close) sensor. The dry-contact state is
// the calibrated measurement and maps to the vocabulary `action.contactState`
// ("open" | "closed"). Upstream calls this PIN_STATUS: bit0 set => DISCONNECT
// (circuit open => "open"); bit0 clear => CONNECT (circuit shorted => "closed").
//
// Uplinks by fPort:
//   2  real-time status: contact state + alarm flag + pulse/duration counters + epoch.
//   3  datalog/history: N x 11-byte records, each a past contact state with a timestamp.
//   4  read-config reply (TDC, DISALARM, etc.) -- device config, no contact state.
//   5  device status (model, band, firmware, battery volts).
//
// Note: upstream formats TIME with local-timezone Date getters and a non-RFC3339
// string; we emit RFC3339 UTC from the raw epoch instead, so the extra is portable.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

// uint24 big-endian.
function u24(bytes, i) {
  return (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
}

// uint32 big-endian (kept positive; uplink epochs are < 2^31 so this is safe).
function u32(bytes, i) {
  return ((bytes[i] << 24) | (bytes[i + 1] << 16) | (bytes[i + 2] << 8) | bytes[i + 3]) >>> 0;
}

// RFC3339 UTC from a unix epoch (seconds).
function rfc3339(epoch) {
  return new Date(epoch * 1000).toISOString().replace('.000Z', 'Z');
}

// Decode one real-time status frame (the 11-byte fPort 2 layout).
function decodeStatus(bytes, i) {
  var out = {};
  out.action = { contactState: (bytes[i] & 0x01) ? 'open' : 'closed' };
  out.alarm = (bytes[i] & 0x02) === 0x02;
  out.calculateFlag = (bytes[i] & 0xfc) >> 2;
  out.totalPulse = u24(bytes, i + 1);
  out.disconnectDuration = u24(bytes, i + 4); // minutes
  out.time = rfc3339(u32(bytes, i + 7));
  return out;
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;
  var port = input.fPort;
  var data;
  var i;

  if (port === 2) {
    if (bytes.length < 11) {
      return { errors: ['expected 11 bytes on fPort 2, got ' + bytes.length] };
    }
    return { data: decodeStatus(bytes, 0) };
  }

  if (port === 3) {
    if (bytes.length < 11 || (bytes.length % 11) !== 0) {
      return { errors: ['fPort 3 datalog length must be a positive multiple of 11, got ' + bytes.length] };
    }
    // Newest record first at the top level; older records go into history.
    data = decodeStatus(bytes, 0);
    if (bytes.length > 11) {
      var history = [];
      for (i = 11; i < bytes.length; i = i + 11) {
        history.push(decodeStatus(bytes, i));
      }
      data.history = history;
    }
    return { data: data };
  }

  if (port === 4) {
    if (bytes.length < 8) {
      return { errors: ['expected 8 bytes on fPort 4, got ' + bytes.length] };
    }
    data = {};
    data.tdc = u24(bytes, 0); // transmit interval, seconds
    data.disalarm = (bytes[3] & 0x01) === 0x01;
    data.keepStatus = (bytes[4] & 0x01) === 0x01;
    data.keepTime = (bytes[5] << 8) | bytes[6]; // seconds
    data.triggerMode = bytes[7] & 0x01;
    return { data: data };
  }

  if (port === 5) {
    if (bytes.length < 7) {
      return { errors: ['expected 7 bytes on fPort 5, got ' + bytes.length] };
    }
    data = {};
    if (bytes[0] === 0x0e) {
      data.deviceModel = 'CPL01';
    }
    data.firmwareVersion = (bytes[1] & 0x0f) + '.' + ((bytes[2] >> 4) & 0x0f) + '.' + (bytes[2] & 0x0f);
    data.battery = round(((bytes[5] << 8) | bytes[6]) / 1000, 3); // volts
    return { data: data };
  }

  return { errors: ['unknown FPort ' + port] };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "dragino";
    result.data.model = "cpl01";
  }
  return result;
}
