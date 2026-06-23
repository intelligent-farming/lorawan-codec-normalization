// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for aquascope/aqs (Aqua-Scope Monitor AQSWIE02), a
// leak-detecting water monitor that records temperature, water pressure and, on
// metering-capable firmware, cumulative water consumption, and that can drive a
// remote shut-off valve.
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format (Aqua-Scope command/sensor TLV on fPort 1) understood with reference
// to the upstream Apache-2.0 decoder (TheThingsNetwork/lorawan-devices
// vendor/aquascope/aqs.js, attributed in NOTICE). Ported from the upstream
// decodeUplink faithfully; the only normalization changes are:
//   - cumulative consumption (sensor 0x11, litres) -> metering.water.total (L)
//   - water temperature (sensor 0x01, 0.1 deg C) -> water.temperature.current
//   - battery level (sensor 0x13, mV) -> `battery` (V)
//   - water pressure (sensor 0x10, hydrostatic, mbar==hPa) -> `waterPressureKpa`
//   - all remaining device fields preserved verbatim as camelCase extras
//   - an {errors} envelope on a bad fPort instead of upstream's bare object.
// Aqua-Scope reports consumption directly in litres, so metering.water.total
// takes the value as-is (no m^3 x 1000 conversion).

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

// Big-endian unsigned 16-bit value, matching upstream's (hi<<8)+lo reads.
function u16(bytes, index) {
  return ((bytes[index] << 8) + bytes[index + 1]) >>> 0;
}

function decodeUplink(input) {
  var bytes = input.bytes;
  var fPort = input.fPort;

  if (fPort !== 1) {
    return { errors: ['invalid FPort'] };
  }
  if (!bytes || bytes.length === 0) {
    return { errors: ['empty payload'] };
  }

  var data = {};
  var extras = {};
  var i;

  for (i = 0; i < bytes.length; i = i + 1) {
    var cmd = bytes[i];

    if (cmd === 0x03) {
      // Hardware version + capabilities bitfield.
      extras.hwVersion = bytes[i + 1];
      extras.capabilities = u16(bytes, i + 2);
      i = i + 3;
    } else if (cmd === 0x04) {
      // Configuration parameter readback: parameter id + 16-bit value.
      var p = bytes[i + 1];
      var v = u16(bytes, i + 2);
      i = i + 3;
      var cfg = {
        1: 'cSystem',
        2: 'cAlgo',
        3: 'cLora',
        4: 'cValveaction',
        5: 'cNormpressure',
        6: 'cOverpressureTh',
        7: 'cUnderpressureTh',
        9: 'cJamming',
        10: 'cFlowTh',
        11: 'cFrostTh',
        13: 'cPcDuration',
        14: 'cPcAbortTh',
        15: 'cPcAlarmTh',
        19: 'cAlarm',
        29: 'cReportInterval',
        30: 'cHeartbeatInterval'
      };
      var cfgName = cfg[p];
      if (cfgName) {
        extras[cfgName] = v;
      } else {
        return { errors: ['unknown config parameter ' + p] };
      }
    } else if (cmd === 0x06) {
      // Sensor reading: sensor id + 16-bit value.
      var sensor = bytes[i + 1];
      var sv = u16(bytes, i + 2);
      i = i + 3;
      if (sensor === 0x01) {
        // Water temperature in 0.1 deg C.
        if (!data.water) {
          data.water = {};
        }
        if (!data.water.temperature) {
          data.water.temperature = {};
        }
        data.water.temperature.current = round(sv / 10, 1);
      } else if (sensor === 0x03) {
        extras.uptime = sv;
      } else if (sensor === 0x10) {
        // Hydrostatic water pressure in mbar (== hPa); kPa = hPa / 10.
        extras.waterPressureKpa = round(sv / 10, 2);
      } else if (sensor === 0x11) {
        // Cumulative water consumption, in litres.
        if (!data.metering) {
          data.metering = {};
        }
        if (!data.metering.water) {
          data.metering.water = {};
        }
        data.metering.water.total = sv;
      } else if (sensor === 0x13) {
        // Battery level in mV -> volts.
        data.battery = round(sv / 1000, 3);
      } else {
        return { errors: ['unknown sensor type ' + sensor] };
      }
    } else if (cmd === 0x07) {
      // Valve / flow / pipe-check state machine.
      var state = bytes[i + 1];
      i = i + 1;
      if (state === 0) {
        extras.valve = 0;
      } else if (state === 1) {
        extras.flow = 0;
        extras.consumptionTime = u16(bytes, i + 1);
        extras.consumptionLiter = u16(bytes, i + 3);
        i = i + 4;
      } else if (state === 2) {
        extras.pipeCheck = 'ok';
      } else if (state === 3) {
        extras.pipeCheck = 'alarm';
        extras.pipeCheckDiff = u16(bytes, i + 1);
        extras.pipeCheckElevation = u16(bytes, i + 3);
        i = i + 4;
      } else if (state === 4 || state === 7) {
        extras.pipeCheck = 'abort/flow';
      } else if (state === 5) {
        extras.pipeCheck = 'abort/heat';
      } else if (state === 6) {
        extras.pipeCheck = 'abort/valve';
      } else if (state === 8) {
        extras.pipeCheck = 'pending';
      } else if (state === 0x0f) {
        extras.flow = 1;
      } else {
        extras.valve = 255;
      }
    } else if (cmd === 0x0a) {
      // 32-bit firmware version.
      extras.fwVersion =
        ((bytes[i + 1] << 24) +
          (bytes[i + 2] << 16) +
          (bytes[i + 3] << 8) +
          bytes[i + 4]) >>> 0;
      i = i + 4;
    } else if (cmd === 0x0b) {
      // Alarm report.
      extras.alarmStatus = bytes[i + 1];
      extras.alarmType = bytes[i + 2];
      extras.alarmValue = u16(bytes, i + 3);
      i = i + 4;
    } else {
      return { errors: ['unknown command ' + cmd] };
    }
  }

  var key;
  for (key in extras) {
    if (Object.prototype.hasOwnProperty.call(extras, key)) {
      data[key] = extras[key];
    }
  }

  return { data: data };
}
