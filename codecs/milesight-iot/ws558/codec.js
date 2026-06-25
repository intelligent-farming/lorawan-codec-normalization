// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for milesight-iot/ws558 (Milesight smart power
// switch / socket with electrical metering).
//
// Milesight TLV uplink decoder ported verbatim from the upstream Apache-2.0
// decoder (TheThingsNetwork/lorawan-devices vendor/milesight-iot/ws558.js,
// attributed in NOTICE), renamed milesightDecode. decodeUplinkCore maps
// voltage (V) -> power.voltage, active_power (W) -> power.active, current (mA)
// -> power.current (A), power_factor (%) -> power.factor, power_consumption (Wh)
// -> metering.energy.total; switch/socket state and other channels -> camelCase
// extras.

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
 * @product WS558
 */
function Decoder(bytes, port) {
    var decoded = {};

    for (var i = 0; i < bytes.length;) {
        var channel_id = bytes[i++];
        var channel_type = bytes[i++];
        // VOLTAGE
        if (channel_id === 0x03 && channel_type === 0x74) {
            decoded.voltage = readUInt16LE(bytes.slice(i, i + 2)) / 10;
            i += 2;
        }
        // ACTIVE POWER
        else if (channel_id === 0x04 && channel_type === 0x80) {
            decoded.active_power = readUInt32LE(bytes.slice(i, i + 4));
            i += 4;
        }
        // POWER FACTOR
        else if (channel_id === 0x05 && channel_type === 0x81) {
            decoded.power_factor = bytes[i];
            i += 1;
        }
        // POWER CONSUMPTION
        else if (channel_id === 0x06 && channel_type === 0x83) {
            decoded.power_consumption = readUInt32LE(bytes.slice(i, i + 4));
            i += 4;
        }
        // TOTAL CURRENT
        else if (channel_id === 0x07 && channel_type === 0xC9) {
            decoded.total_current = readUInt16LE(bytes.slice(i, i + 2));
            i += 2;
        }
        // SWITCH STATUS
        else if (channel_id === 0x08 && channel_type === 0x31) {
            var switchFlags = bytes[i + 1];

            // output all switch status
            for (var idx = 0; idx < 8; idx++) {
                var switchTag = "switch_" + (idx + 1);
                decoded[switchTag] = (switchFlags >> idx) & 1 === 1 ? "on" : "off";
            }

            i += 2;
        } else {
            break;
        }
    }

    return decoded;
}

/* ******************************************
 * bytes to number
 ********************************************/
function readUInt8LE(bytes) {
    return (bytes & 0xFF);
}

function readInt8LE(bytes) {
    var ref = readUInt8LE(bytes);
    return (ref > 0x7F) ? ref - 0x100 : ref;
}

function readUInt16LE(bytes) {
    var value = (bytes[1] << 8) + bytes[0];
    return (value & 0xFFFF);
}

function readInt16LE(bytes) {
    var ref = readUInt16LE(bytes);
    return (ref > 0x7FFF) ? ref - 0x10000 : ref;
}


function readUInt32LE(bytes) {
    var value = (bytes[3] << 24) + (bytes[2] << 16) + (bytes[1] << 8) + bytes[0];
    return (value & 0xFFFFFFFF);
}

function readInt32LE(bytes) {
    var ref = readUInt32LE(bytes);
    return (ref > 0x7FFFFFFF) ? ref - 0x100000000 : ref;
}
// ---- normalization layer (authored) ----
function round(value, decimals){var f=Math.pow(10,decimals);return Math.round(value*f)/f;}
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
    if (k === "voltage" && typeof val === "number") { data.power = data.power || {}; data.power.voltage = val; continue; }
    if (k === "active_power" && typeof val === "number") { data.power = data.power || {}; data.power.active = val; continue; }
    if (k === "current" && typeof val === "number") { data.power = data.power || {}; data.power.current = round(val / 1000, 5); continue; }
    if (k === "power_factor" && typeof val === "number") { data.power = data.power || {}; data.power.factor = round(val / 100, 4); continue; }
    if (k === "power_consumption" && typeof val === "number") { data.metering = data.metering || {}; data.metering.energy = { total: val }; continue; }
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
    result.data.model = "ws558";
  }
  return result;
}
