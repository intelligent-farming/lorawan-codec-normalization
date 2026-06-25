// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for milesight-iot/ws301 (Milesight magnetic door/
// window contact sensor).
//
// Milesight TLV uplink decoder ported verbatim from the upstream Apache-2.0
// decoder (TheThingsNetwork/lorawan-devices vendor/milesight-iot/ws301.js,
// attributed in NOTICE), renamed milesightDecode. decodeUplinkCore maps the
// door state -> action.contactState (open/closed); battery % -> batteryPercent;
// install/other status -> camelCase extras.

function milesightDecode(input) {
    var res = Decoder(input.bytes, input.fPort);
    if (res.error) {
        return {
            errors: [res.error],
        };
    }
    return {
        data: res,
    };
}
/**
 * Payload Decoder for The Things Network
 *
 * Copyright 2021 Milesight IoT
 *
 * @product WS301
 */
function Decoder(bytes, port) {
    var decoded = {};

    for (var i = 0; i < bytes.length;) {
        var channel_id = bytes[i++];
        var channel_type = bytes[i++];
        // BATTERY
        if (channel_id === 0x01 && channel_type === 0x75) {
            decoded.battery = bytes[i];
            i += 1;
        }
        // DOOR / WINDOW STATE
        else if (channel_id === 0x03 && channel_type === 0x00) {
            decoded.door = bytes[i] === 0 ? "close" : "open";
            i += 1;
        }
        //
        else if (channel_id === 0x04 && channel_type === 0x00) {
            decoded.install = bytes[i] === 0 ? "yes" : "no";
            i += 1;
        } else {
            break;
        }
    }

    return decoded;
}


function normalizeUplink(input) {
    var data = {};

    if (input.data.door && (input.data.door === "close" || input.data.door === "open")) {
        data.action = {
            contactState: input.data.door === "close" ? "closed" : "open"
        };
    }

    if (input.data.battery) {
        data.battery = input.data.battery;
    }

    return { data: data };
}

// ---- normalization layer (authored) ----
function decodeUplinkCore(input) {
  var raw = milesightDecode(input);
  if (raw && raw.errors && raw.errors.length) { return { errors: raw.errors }; }
  var d = (raw && raw.data) || raw || {};
  var data = {};
  var k;
  for (k in d) {
    if (!Object.prototype.hasOwnProperty.call(d, k)) { continue; }
    var val = d[k];
    if (val === null || val === undefined) { continue; }
    if (k === "door" && (val === "open" || val === "closed")) { data.action = data.action || {}; data.action.contactState = val; continue; }
    if (k === "battery" && typeof val === "number") { data.batteryPercent = val; continue; }
    var ck = k.replace(/_([a-z])/g, function (m, c) { return c.toUpperCase(); });
    data[ck] = val;
  }
  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "milesight-iot";
    result.data.model = "ws301";
  }
  return result;
}
