// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for ELV ELV-LW-ESI (Energy Sensing Interface): an
// optical/IR reader that sits on an existing electricity, gas or heat meter and
// transmits the meter's cumulative counter plus an instantaneous rate.
//
// Ported from the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/elv/elv-lw-esi.js,
// "ELV-LW-ESI-Payload-Parser" V1.0.0, attributed in NOTICE). The upstream wire
// walk is reproduced faithfully: port 10, a leading header-length byte, a
// TX-reason nibble + big-endian supply voltage in the header, then an
// application stream keyed by a datatype byte (0x01 energy block, 0x02 IR
// configuration). Only the OUTPUT is renormalized to the shared vocabulary.
//
// Renormalization notes (deliberate divergence from upstream's raw output):
//   * Electrical energy block (Energy_Counter_Unit Wh/kWh) -> metering.energy.total
//     in Wh (kWh x1000); the cumulative counter is the meter index.
//   * Electrical power (Energy_Power_Unit W/kW) -> power.active in W (kW x1000),
//     signed negative when the meter reports Delivery / Negative power direction.
//   * A gas/heat meter block (units m^3, m^3/h) is NOT electrical energy/power;
//     it has no vocabulary home, so volume and flow are preserved as the
//     camelCase extras volumeM3 / flowRateM3h with consumptionType/unit context.
//   * Header Supply_Voltage is the device supply rail in millivolts; the
//     vocabulary `battery` is volts, so it is divided by 1000.
//   * TX reason, consumption type, signum, boot/overflow flag and the IR reader
//     configuration are device telemetry, surfaced as camelCase extras.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

var TX_REASON = ['Reserved', 'Timer_Event', 'User_Button', 'Power_Event', 'Calibration'];
var CONSUMPTION_TYPE = ['Reserved', 'Consumption', 'Delivery'];
var ENERGY_COUNTER_UNIT = ['Wh', 'kWh', 'm^3'];
var ENERGY_POWER_UNIT = ['W', 'kW', 'm^3/h'];
var BOOT_FLAG = ['No_Overflow', 'Overflow'];
var SIGNUM_OF_POWER = ['Positive', 'Negative'];

// Signed 16-bit from an already-combined 16-bit value.
function toInt16(value) {
  var ref = value & 0xffff;
  return ref > 0x7fff ? ref - 0x10000 : ref;
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;
  var port = input.fPort;

  if (port !== 10) {
    return { errors: ['Wrong Port Number'] };
  }
  if (!bytes || bytes.length < 1) {
    return { errors: ['Not enough data'] };
  }

  var data = {};
  var headerLen = bytes[0];

  // Header --------------------------------------------------------------------
  // index 1: TX reason nibble; index 2..3: big-endian supply voltage (mV).
  if (headerLen >= 1 && bytes.length > 1) {
    data.txReason = TX_REASON[bytes[1] & 0x0f];
  }
  if (headerLen >= 3 && bytes.length > 3) {
    var supplymV = (bytes[2] << 8) | bytes[3];
    data.battery = round(supplymV / 1000, 3); // mV -> V
  }

  var metering = {};
  var power = {};
  var energyBlockCount = 0;

  // Application stream --------------------------------------------------------
  if (bytes.length > headerLen + 1) {
    var index = headerLen + 1;

    while (index < bytes.length) {
      var type = bytes[index];

      if (type === 0x01) {
        // Energy block: consumption-type byte, then a counter-unit/boot byte,
        // a 5-byte little-endian counter (/10000), a power-unit/signum byte and
        // a 4-byte little-endian power (/100).
        index++;
        var consumptionType = CONSUMPTION_TYPE[bytes[index] & 0x3f];
        index++;
        var counterUnit = ENERGY_COUNTER_UNIT[bytes[index] & 0x03];
        var bootFlag = BOOT_FLAG[(bytes[index] >> 2) & 0x03];
        index++;
        var counterRaw =
          bytes[index] +
          bytes[index + 1] * 256 +
          bytes[index + 2] * 65536 +
          bytes[index + 3] * 16777216 +
          bytes[index + 4] * 4294967296;
        var counter = counterRaw / 10000.0;
        index += 5;
        var powerUnit = ENERGY_POWER_UNIT[bytes[index] & 0x03];
        var signum = SIGNUM_OF_POWER[(bytes[index] >> 2) & 0x01];
        index++;
        var powerRaw =
          bytes[index] +
          bytes[index + 1] * 256 +
          bytes[index + 2] * 65536 +
          bytes[index + 3] * 16777216;
        var powerVal = powerRaw / 100.0;
        index += 3;

        var suffix = energyBlockCount === 0 ? '' : String(energyBlockCount + 1);

        if (counterUnit === 'Wh' || counterUnit === 'kWh') {
          // Electrical meter -> vocabulary metering.energy.total (Wh) + power.active (W).
          var wh = counterUnit === 'kWh' ? counter * 1000 : counter;
          var watt = powerUnit === 'kW' ? powerVal * 1000 : powerVal;
          if (signum === 'Negative') watt = -watt;
          if (energyBlockCount === 0) {
            metering.energy = { total: round(wh, 1) };
            power.active = round(watt, 2);
          } else {
            data['energyTotal' + suffix + 'Wh'] = round(wh, 1);
            data['activePower' + suffix + 'W'] = round(watt, 2);
          }
        } else {
          // Gas / heat (m^3) has no electrical-vocabulary home -> extras.
          data['volume' + suffix + 'M3'] = round(counter, 4);
          data['flowRate' + suffix + 'M3h'] = round(powerVal, 3);
        }

        data['consumptionType' + suffix] = consumptionType;
        data['counterUnit' + suffix] = counterUnit;
        data['powerUnit' + suffix] = powerUnit;
        data['powerSign' + suffix] = signum;
        data['counterOverflow' + suffix] = bootFlag === 'Overflow';

        energyBlockCount++;
      } else if (type === 0x02) {
        // IR reader configuration (sensibility + two thresholds), each a signed
        // 16-bit little-endian value with a -100 offset. Device config -> extras.
        index++;
        data.irMeterSensibility = toInt16((bytes[index + 1] << 8) | bytes[index]) - 100;
        index += 2;
        data.irThreshold1 = toInt16((bytes[index + 1] << 8) | bytes[index]) - 100;
        index += 2;
        data.irThreshold2 = toInt16((bytes[index + 1] << 8) | bytes[index]) - 100;
        index += 2;
      } else {
        return { errors: ['Data Type Failure'] };
      }

      // Upstream's do/while advances past the last consumed byte before the
      // next datatype is read; mirror that single post-block increment.
      index++;
    }
  }

  for (var ek in metering.energy) {
    if (metering.energy.hasOwnProperty(ek)) {
      data.metering = metering;
      break;
    }
  }
  if (power.active !== undefined) {
    data.power = power;
  }

  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "elv";
    result.data.model = "elv-lw-esi";
  }
  return result;
}
