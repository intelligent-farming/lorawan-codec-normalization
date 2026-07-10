// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for the MClimate 16A DS (16ads) — 16 A dry-switch
// relay controller.
//
// Derivation: wire format understood from the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/mclimate/16ads.js, attributed in
// NOTICE). Normalization authored here; upstream decodeUplink is NOT copied.
//
// The device always ends its uplink with a 3-byte keepalive block:
//   byte[0]  keepalive marker (0x01)
//   byte[1]  internal temperature: bit7 = sign, bits0..6 = magnitude in whole °C
//            -> air.temperature (°C)
//   byte[2]  relay state (0x01 = ON) -> action.switch.state (bool)
// A "keepalive" uplink is exactly these 3 bytes (byte[0] == 0x01). A "response"
// uplink prepends configuration command TLVs before the trailing keepalive
// block; those config fields carry no measurement, so only the last 3 bytes
// (the keepalive) are decoded for switch state + temperature. The 16ads reports
// no power/energy in its uplink, so power.active is not emitted.

function decodeKeepalive(marker, tempByte, relayByte) {
  var magnitude = tempByte & 0x7f;
  var temperature = (tempByte & 0x80) ? -magnitude : magnitude;
  return {
    action: { switch: { state: relayByte === 0x01 } },
    air: { temperature: temperature }
  };
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;

  if (!bytes || bytes.length < 3) {
    return { errors: ['expected at least 3 bytes, got ' + (bytes ? bytes.length : 0)] };
  }

  var data;
  if (bytes[0] === 0x01 && bytes.length === 3) {
    // Pure keepalive frame.
    data = decodeKeepalive(bytes[0], bytes[1], bytes[2]);
  } else {
    // Response frame: the keepalive block is the trailing 3 bytes.
    var n = bytes.length;
    data = decodeKeepalive(bytes[n - 3], bytes[n - 2], bytes[n - 1]);
  }

  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "mclimate";
    result.data.model = "16ads";
  }
  return result;
}
