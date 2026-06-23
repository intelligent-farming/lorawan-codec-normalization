// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Aquascope AQMLWE01 (Ultrasonic Clamp-On Water
// Meter — MID-compliant volumetric water meter; reports cumulative consumption).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format understood with reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/aquascope/aqm.js, attributed in
// NOTICE). Author the normalization here; do NOT copy upstream normalizeUplink.
//
// All AQM telemetry rides fPort 1 as a stream of TLV-style records that the
// upstream decoder walks byte-by-byte. The records relevant to the water-meter
// category are the 0x06 "sensor" records:
//   0x06 0x01 hi lo  -> temperature   (water/probe temperature, °C)
//   0x06 0x11 hi lo  -> consumption   (cumulative metered volume, litres)
//   0x06 0x13 hi lo  -> batterylevel  (0-100 %, NOT volts)
// 16-bit sensor values are reconstructed with upstream's exact
// ((hi << 8) + lo) expression so decoded numbers match the source of truth;
// only the canonical key remap is applied. No scaling: this meter totalises in
// whole litres (firmware exposes a c_litertranslation config), so consumption
// maps to metering.water.total as-is rather than m^3 x1000.
//
// Mapping to the shared vocabulary:
//   consumption  -> metering.water.total      (litres, as-is)
//   temperature  -> water.temperature.current (°C, upstream value verbatim)
//   batterylevel -> batteryPercent (extra)    (vocabulary `battery` is volts;
//                                              this channel is a 0-100 percentage)
//
// Other records (valve/flow state 0x07, alarms 0x0b, hw/fw) carry no metering
// total; the ones with a vocabulary-less meaning are surfaced as camelCase
// extras (valveState, flowActive, consumptionLiter, alarmType, pipeCheck).
// A leading record byte the codec does not model is reported as an error rather
// than silently mis-walking the stream.

function decodeUplink(input) {
  if (input.fPort !== 1) {
    return { errors: ['invalid FPort'] };
  }

  var bytes = input.bytes;
  var data = {};
  var i;
  var sensor;
  var sensorvalue;
  var state;

  for (i = 0; i < bytes.length; i++) {
    switch (bytes[i]) {
      case 0x06:
        sensor = bytes[++i];
        sensorvalue = (bytes[++i] << 8) + bytes[++i];
        if (sensor === 0x01) {
          if (!data.water) { data.water = {}; }
          if (!data.water.temperature) { data.water.temperature = {}; }
          data.water.temperature.current = sensorvalue;
        } else if (sensor === 0x03) {
          data.uptime = sensorvalue;
        } else if (sensor === 0x10) {
          data.pressureRaw = sensorvalue;
        } else if (sensor === 0x11) {
          if (!data.metering) { data.metering = {}; }
          if (!data.metering.water) { data.metering.water = {}; }
          data.metering.water.total = sensorvalue;
        } else if (sensor === 0x13) {
          data.batteryPercent = sensorvalue;
        } else {
          return { errors: ['unknown sensor type 0x' + sensor.toString(16)] };
        }
        break;

      case 0x07:
        state = bytes[++i];
        if (state === 0) {
          data.valveState = 'closed';
        } else if (state === 1) {
          data.flowActive = false;
          data.consumptionTime = (bytes[++i] << 8) + bytes[++i];
          data.consumptionLiter = (bytes[++i] << 8) + bytes[++i];
        } else if (state === 2) {
          data.pipeCheck = 'ok';
        } else if (state === 3) {
          data.pipeCheck = 'alarm';
          data.pipeCheckDiff = (bytes[++i] << 8) + bytes[++i];
          data.pipeCheckElevation = (bytes[++i] << 8) + bytes[++i];
        } else if (state === 4 || state === 7) {
          data.pipeCheck = 'abort/flow';
        } else if (state === 5) {
          data.pipeCheck = 'abort/heat';
        } else if (state === 6) {
          data.pipeCheck = 'abort/valve';
        } else if (state === 8) {
          data.pipeCheck = 'pending';
        } else if (state === 0x0f) {
          data.flowActive = true;
        } else {
          data.valveState = 'open';
        }
        break;

      case 0x0b:
        data.alarmStatus = bytes[++i];
        data.alarmType = bytes[++i];
        data.alarmValue = (bytes[++i] << 8) + bytes[++i];
        break;

      case 0x03:
        data.hwVersion = bytes[++i];
        data.capabilities = (bytes[++i] << 8) + bytes[++i];
        break;

      case 0x0a:
        data.fwVersion = (bytes[++i] << 24) + (bytes[++i] << 16) + (bytes[++i] << 8) + bytes[++i];
        break;

      default:
        return { errors: ['unsupported record 0x' + bytes[i].toString(16) + ' at byte ' + i] };
    }
  }

  return { data: data };
}
