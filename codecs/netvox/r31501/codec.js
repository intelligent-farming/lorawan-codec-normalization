// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Netvox R31501 (Wireless Internal Vibration /
// PIR / Water Leak / Reed Switch / Glass Break Sensor), data report on fPort 6.
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format understood with reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/netvox/payload/r315.js, attributed
// in NOTICE). Author the normalization here; do NOT copy upstream
// normalizeUplink.
//
// The R31501 is a contact / multi-detector node. Per its datasheet it carries
// NO temperature, humidity or light sensor (those report types belong to other
// members of the shared R315 codec family), so the only measurement frame this
// device emits is the binary-sensor snapshot, report type 0x11. Frame layout:
//   bytes[0]      frame version
//   bytes[1]      device type (0xD2 == 210 == R315 family)
//   bytes[2]      report type (discriminator)
//   bytes[3]      battery voltage in 0.1 V; high bit flags low battery
//   bytes[4..6]   FunctionEnable bitmap (which sensors are provisioned)
//   bytes[7..8]   BinarySensorReport bitmap (current state of each sensor)
//
// FunctionEnable is parsed by upstream as (bytes[5]<<8 | bytes[6]);
// BinarySensorReport as (bytes[7]<<8 | bytes[8]). We preserve those bit
// positions exactly.
//
// Mapping decisions:
//   reed / magnetic door switch state -> action.contactState
//     Netvox reports binary-sensor state as 1 = triggered (contact open) and
//     0 = idle (contact closed). The vocabulary enum is "open"/"closed", so a
//     set state bit -> "open", a clear bit -> "closed". The internal contact
//     (reed) switch is the device's primary contact; if it is not provisioned
//     but an external contact switch is, the external one is used instead.
//   battery (bytes[3], 0.1 V; high bit = low) -> battery (V) + lowBattery extra
//   PIR / tilt / vibration(shock) / water-leak / glass-break / emergency-button
//     states -> camelCase boolean extras (categorical, not vocabulary data)
//
// Report type 0x00 is a device-info/startup frame (no measurement). Config
// responses arrive on fPort 7 (no measurement). Both are reported as errors.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function bit(value, position) {
  return (value >> position) & 1 ? true : false;
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;

  if (input.fPort === 7) {
    return { errors: ['config response on fPort 7 (no measurement)'] };
  }
  if (input.fPort !== 6) {
    return { errors: ['unsupported fPort ' + input.fPort + ' (expected 6, data report)'] };
  }
  if (bytes.length < 9) {
    return { errors: ['expected at least 9 bytes, got ' + bytes.length] };
  }

  var reportType = bytes[2];

  if (reportType === 0x00) {
    return { errors: ['device info frame (no measurement)'] };
  }
  if (reportType !== 0x11) {
    return { errors: ['report type 0x' + reportType.toString(16) + ' carries no measurement for this device'] };
  }

  var data = {};

  // Byte 3: battery voltage in 0.1 V; high bit flags low battery.
  if (bytes[3] & 0x80) {
    data.lowBattery = true;
  }
  data.battery = round((bytes[3] & 0x7f) / 10, 1);

  // FunctionEnable: provisioning bitmap (bytes[5]<<8 | bytes[6]).
  var functionEnable = (bytes[5] << 8) | bytes[6];
  var internalContactEnabled = bit(functionEnable, 5);
  var externalContact1Enabled = bit(functionEnable, 6);
  var externalContact2Enabled = bit(functionEnable, 7);

  // BinarySensorReport: current state of each provisioned sensor.
  var binaryState = (bytes[7] << 8) | bytes[8];

  // Reed / magnetic contact switch -> action.contactState. Prefer the internal
  // contact; fall back to an external contact switch if the internal one is
  // not provisioned.
  var contactBitPos;
  if (internalContactEnabled || (!externalContact1Enabled && !externalContact2Enabled)) {
    contactBitPos = 3; // InternalContactSwitchSensorState
  } else if (externalContact1Enabled) {
    contactBitPos = 4; // ExternalContactSwitch1SensorState
  } else {
    contactBitPos = 5; // ExternalContactSwitch2SensorState
  }
  data.action = {
    contactState: bit(binaryState, contactBitPos) ? 'open' : 'closed'
  };

  // Remaining binary-sensor states surfaced as categorical camelCase extras.
  data.pirState = bit(binaryState, 0);
  data.emergencyButtonAlarm = bit(binaryState, 1);
  data.tiltState = bit(binaryState, 2);
  data.internalShockState = bit(binaryState, 6);
  data.externalShockState = bit(binaryState, 7);
  data.externalDryContactInState = bit(binaryState, 8);
  data.waterLeak1State = bit(binaryState, 9);
  data.waterLeak2State = bit(binaryState, 10);
  data.seatState = bit(binaryState, 11);
  data.glassBreak1State = bit(binaryState, 12);
  data.glassBreak2State = bit(binaryState, 13);

  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "netvox";
    result.data.model = "r31501";
  }
  return result;
}
