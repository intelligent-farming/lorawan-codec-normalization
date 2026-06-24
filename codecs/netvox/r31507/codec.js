// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Netvox R31507 (R315 - Wireless PIR / Emergency
// Button / Dry Contact Input / Digital Output / Glass Break Sensor), data
// report on fPort 6.
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format understood with reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/netvox/payload/r315.js, attributed
// in NOTICE). Author the normalization here; do NOT copy upstream
// normalizeUplink.
//
// fPort 6 carries periodic data reports; bytes[1] is the device-type id and
// bytes[2] is the report-type discriminator. Battery is volts (high bit of
// bytes[3] is the low-battery flag, surfaced as the camelCase extra
// `lowBattery`; the low 7 bits are the voltage -> battery V).
//
// The R31507 is a multi-input motion/intrusion node. The only frame that
// carries sensor state is report 0x11, the sensor-enable + BinarySensorReport
// snapshot. BinarySensorReport = (bytes[7] << 8) | bytes[8]:
//   bit 0  PIRSensorState            -> motion
//   bit 1  EmergenceButtonAlarmState -> extra buttonPressed
//   bit 6  InternalShockSensorState  -> motion (vibration)
//   bit 7  ExternalShockSensorState  -> motion (vibration)
//   bit 8  ExternalDryContactPointINState -> extra digitalInput
// PIR and either shock/vibration channel are all motion, so
// action.motion.detected is the logical OR of those three bits. The device
// reports an event state, not a count, so action.motion.count is not emitted.
// Button and dry-contact-input states are genuine device data the motion
// vocabulary does not model -> camelCase extras.
//
// Other report types carry no motion measurement: 0x00 is a device-info /
// startup frame (version + datecode); 0x01/0x02/0x12 are temperature /
// humidity / illuminance frames belonging to other R315 variants; config
// responses arrive on fPort 7. All are reported as errors.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;

  if (input.fPort !== 6) {
    return { errors: ['unsupported fPort ' + input.fPort + ' (expected 6, data report)'] };
  }
  if (bytes.length < 9) {
    return { errors: ['expected at least 9 bytes, got ' + bytes.length] };
  }

  var reportType = bytes[2];

  if (reportType !== 0x11) {
    return { errors: ['report type 0x' + reportType.toString(16) + ' carries no motion measurement'] };
  }

  var data = {};

  // Byte 3: battery voltage in 0.1 V; high bit flags low battery.
  if (bytes[3] & 0x80) {
    data.lowBattery = true;
  }
  data.battery = round((bytes[3] & 0x7f) / 10, 1);

  var binarySensorReport = (bytes[7] << 8) | bytes[8];
  var pir = binarySensorReport & 0x01;
  var internalShock = (binarySensorReport >> 6) & 0x01;
  var externalShock = (binarySensorReport >> 7) & 0x01;

  data.action = {
    motion: {
      detected: (pir || internalShock || externalShock) ? true : false
    }
  };

  // Button and dry-contact input are genuine state the motion vocabulary does
  // not model -> camelCase extras.
  data.buttonPressed = ((binarySensorReport >> 1) & 0x01) ? true : false;
  data.digitalInput = ((binarySensorReport >> 8) & 0x01) ? true : false;

  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "netvox";
    result.data.model = "r31507";
  }
  return result;
}
