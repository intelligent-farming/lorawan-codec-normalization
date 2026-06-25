// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Aquascope LoRain Rain Gauge RANLWE01 — a
// collector rain gauge that reports cumulative collected rainfall plus
// auxiliary enclosure/air temperature, humidity and battery telemetry.
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format understood with reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/aquascope/ran.js, attributed in
// NOTICE). Author the normalization here; do NOT copy upstream normalizeUplink.
//
// All RAN telemetry rides fPort 10 as a stream of TLV-style records that the
// upstream decoder walks byte-by-byte. The records relevant to the rain-gauge
// category are the 0x06 "sensor" records and the 0x12 battery record:
//   0x06 0x01 hi lo -> temperature_C    enclosure temperature (signed /10, °C)
//   0x06 0x02 hi lo -> humidity         relative humidity (%)
//   0x06 0x03 hi lo -> uptime           (extra)
//   0x06 0x08 hi lo -> airtemperature_C air temperature (signed /10, °C)
//   0x06 0x11 hi lo -> consumption      (extra)
//   0x06 0x12 hi lo -> flow             (extra)
//   0x06 0x81 hi lo -> rainlevel = sensorvalue * 0.5   cumulative rainfall
//   0x12 v hi lo    -> bat_volt = v/10 (V), bat_mAh    battery
// 16-bit values are reconstructed with upstream's exact ((hi << 8) + lo)
// expression and signed values use upstream's (v - 0xffff)/10 branch so decoded
// numbers match the source of truth; only the canonical key remap + units apply.
//
// Mapping to the shared vocabulary:
//   rainlevel        -> rain.cumulative        (upstream's calibrated value:
//                                               sensorvalue * 0.5, the device's
//                                               own collected-rain unit; see note)
//   airtemperature_C -> air.temperature        (°C, signed /10 verbatim)
//   humidity         -> air.relativeHumidity   (%)
//   bat_volt         -> battery                 (V; v/10 verbatim)
//
// Note on rain units: the vocabulary rain.cumulative is mm and the device's
// firmware comment marks one raw count as 500 ml of collected water. The
// device-to-mm factor depends on the collector mouth area, which is not in the
// payload, so we surface the device's own calibrated accumulation value
// (sensorvalue * 0.5) directly rather than fabricate a mm conversion.
//
// Genuine non-vocabulary fields become camelCase extras (uptime, consumption,
// flow, batterymAh, enclosureTemperature, hwVersion, capabilities,
// motorPosition, fwVersion, alarm*, conf*, duration, diff). A leading record
// byte the codec does not model is reported as an error rather than silently
// mis-walking the stream.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function decodeUplinkCore(input) {
  if (input.fPort !== 10) {
    return { errors: ['invalid FPort'] };
  }

  var bytes = input.bytes;
  var data = {};
  var i;
  var sensor;
  var sensorvalue;
  var p;
  var v;
  var astatus;
  var atype;
  var avalue;
  var label;

  for (i = 0; i < bytes.length; i++) {
    switch (bytes[i]) {
      case 0x03:
        data.hwVersion = bytes[++i];
        data.capabilities = (bytes[++i] << 8) + bytes[++i];
        break;

      case 0x04:
        p = bytes[++i];
        v = (bytes[++i] << 8) + bytes[++i];
        if (p === 0x01) {
          data.confSystem = v;
        } else if (p === 0x02) {
          data.confHeartbeat = v;
        } else if (p === 0x03) {
          data.confHeavyrain = v;
        } else if (p === 0x04) {
          data.confInterval = v;
        } else if (p > 16) {
          return { errors: ['unknown config parameter 0x' + p.toString(16)] };
        } else {
          data.confParameter = p;
          data.confValue = v;
        }
        break;

      case 0x06:
        sensor = bytes[++i];
        sensorvalue = (bytes[++i] << 8) + bytes[++i];
        if (sensor === 0x01) {
          if (sensorvalue < 0x4000) {
            data.enclosureTemperature = round(sensorvalue / 10.0, 1);
          } else {
            data.enclosureTemperature = round((sensorvalue - 0xffff) / 10.0, 1);
          }
        } else if (sensor === 0x02) {
          if (!data.air) { data.air = {}; }
          data.air.relativeHumidity = sensorvalue;
        } else if (sensor === 0x03) {
          data.uptime = sensorvalue;
        } else if (sensor === 0x08) {
          if (!data.air) { data.air = {}; }
          if (sensorvalue < 0x4000) {
            data.air.temperature = round(sensorvalue / 10.0, 1);
          } else {
            data.air.temperature = round((sensorvalue - 0xffff) / 10.0, 1);
          }
        } else if (sensor === 0x11) {
          data.consumption = sensorvalue;
        } else if (sensor === 0x12) {
          data.flow = sensorvalue;
        } else if (sensor === 0x81) {
          if (!data.rain) { data.rain = {}; }
          data.rain.cumulative = round(sensorvalue * 0.5, 1);
        } else {
          return { errors: ['unknown sensor type 0x' + sensor.toString(16)] };
        }
        break;

      case 0x07:
        data.motorPosition = bytes[++i];
        break;

      case 0x0a:
        data.fwVersion = (bytes[++i] << 24) + (bytes[++i] << 16) + (bytes[++i] << 8) + bytes[++i];
        break;

      case 0x0b:
        astatus = bytes[++i];
        atype = bytes[++i];
        avalue = (bytes[++i] << 8) + bytes[++i];
        if (atype === 0x01) {
          label = 'Flood';
        } else if (atype === 0x02) {
          label = 'Temperature Low';
          if (avalue > 0x4000) { avalue = round((avalue - 0xffff) / 10.0, 1); }
        } else if (atype === 0x03) {
          label = 'Heavyrain';
        } else if (atype === 0x04) {
          label = 'Humidity';
        } else if (atype === 0x05) {
          label = 'Vibration';
        } else if (atype === 0x06) {
          label = 'Temperature High';
          if (avalue > 0x4000) { avalue = round((avalue - 0xffff) / 10.0, 1); }
        } else if (atype === 0x07) {
          label = 'Air Temperature Low';
          if (avalue > 0x4000) { avalue = round((avalue - 0xffff) / 10.0, 1); }
        } else if (atype === 0x0c) {
          label = 'Battery';
        } else {
          return { errors: ['unknown alarm type 0x' + atype.toString(16)] };
        }
        data.alarmType = label;
        data.alarmActive = astatus ? true : false;
        data.alarmValue = avalue;
        break;

      case 0x12:
        data.battery = round(bytes[++i] / 10.0, 1);
        data.batterymAh = (bytes[++i] << 8) + bytes[++i];
        break;

      case 0x33:
        data.duration = (bytes[++i] << 8) + bytes[++i];
        data.diff = (bytes[++i] << 8) + bytes[++i];
        break;

      default:
        return { errors: ['unsupported record 0x' + bytes[i].toString(16) + ' at byte ' + i] };
    }
  }

  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "aquascope";
    result.data.model = "ran";
  }
  return result;
}
