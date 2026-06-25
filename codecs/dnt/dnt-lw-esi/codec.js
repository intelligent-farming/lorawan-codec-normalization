// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for dnt LoRaWAN Energy Sensor Interface
// (dnt-lw-esi).
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format (fPort 10; a 3-byte header of TX reason, supply voltage and frame
// type, followed by a frame-type-specific body) understood with reference to
// the upstream Apache-2.0 decoder (TheThingsNetwork/lorawan-devices
// vendor/dnt/dnt-lw-esi.js, attributed in NOTICE). The decode is ported
// faithfully from that reference; we do NOT copy upstream's parallel-array
// {Type,Channel,Value,Unit} Energy_Data output shape.
//
// The device integrates electricity / gas meters and reports, in a Sensor_Data
// frame, up to four energy channels:
//   block 0  Type=Power            -> instantaneous active power (W)
//   block 1  Energy Counter, HT    -> cumulative consumption, high tariff (Wh)
//   block 2  Energy Counter, NT    -> cumulative consumption, low tariff (Wh)
//   block 3  Energy Counter, Delivery -> cumulative delivered energy (Wh)
// Mappings:
//   Power channel (W)                 -> power.active (raw/100 W)
//   Energy Counter Consumption HT (Wh)-> metering.energy.total (raw/10 Wh, the
//                                        primary cumulative active energy)
//   Energy Counter Consumption NT (Wh)-> extra energyConsumptionNt (Wh)
//   Energy Counter Delivery (Wh)      -> extra energyDelivery (Wh)
//   supply voltage (V)                -> battery (already volts)
// For a gas-meter configuration the energy block can instead carry Type=Flow
// (m^3/h) or Type=Volume (m^3); those have no electrical-power vocabulary home
// and are surfaced as the extras flowRate / volume. Channels whose raw value
// is the device's Unknown/Overflow/Underflow sentinel are not mapped to a
// numeric vocabulary key; they raise a warning and are surfaced as a string
// extra (energyStatus / powerStatus / ...).
//
// Non-Sensor_Data frames (Device_Info, the Config_Data_* frames) carry only
// device diagnostics / configuration with no calibrated measurement, so they
// are surfaced entirely as camelCase extras alongside make/model.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

var TX_REASON = ['Reserved', 'Join_Button_Pressed', 'Cyclic_Timer', 'Settings', 'Joined'];
var ERROR_MSG = ['No_Error', 'No_Sensor_Connected', 'Sensor_Communication_Error'];
var ENERGY_TYPE = ['Reserved', 'Power', 'Flow', 'Energy Counter', 'Reserved', 'Volume'];
var ENERGY_CHANNEL = ['Reserved', 'Power', 'Energy Counter Consumption HT', 'Energy Counter Consumption NT', 'Energy Counter Delivery'];
var SPREADING_FACTOR = ['ADR', 'SF7', 'SF8', 'SF9', 'SF10', 'SF11', 'SF12'];

// Build an unsigned little-endian integer from `count` bytes starting at off.
function leUint(bytes, off, count) {
  var v = 0;
  var mul = 1;
  for (var i = 0; i < count; i++) {
    v += bytes[off + i] * mul;
    mul *= 256;
  }
  return v;
}

function txReason(code) {
  return TX_REASON[code] !== undefined ? TX_REASON[code] : 'Reserved';
}

// Supply voltage in volts: (1 + (b>>6)) + (b & 0x3F) * 0.02.
function supplyVolts(b) {
  return round((1 + (b >> 6)) + (b & 0x3f) * 0.02, 2);
}

// Decode the 3-byte (24-bit) Power/Flow value block at offset off.
// Returns { value:<number>, status:<string|null> }.
function decode24(bytes, off) {
  var raw = leUint(bytes, off, 3);
  if (raw > 0x7fffef) {
    if (raw === 0x800000) { return { value: null, status: 'Unknown' }; }
    if (raw === 0x800001) { return { value: null, status: 'Overflow' }; }
    if (raw === 0x800002) { return { value: null, status: 'Underflow' }; }
    return { value: round((raw - 0x1000000) / 100, 2), status: null };
  }
  return { value: round(raw / 100, 2), status: null };
}

// Decode the 5-byte (40-bit) Energy/Volume counter block at offset off.
// `divisor` is 10 for an energy counter (Wh), 10000 for a volume (m^3).
// Returns { value:<number>, status:<string|null> }.
function decode40(bytes, off, divisor) {
  var raw = leUint(bytes, off, 5);
  // 0xFFFFFFFFFF == Unknown; > 0xFFFFFFFFEF == Overflow.
  if (raw === 1099511627775) { return { value: null, status: 'Unknown' }; }
  if (raw > 1099511627759) { return { value: null, status: 'Overflow' }; }
  return { value: round(raw / divisor, 4), status: null };
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;
  var port = input.fPort;

  if (port !== 10) {
    return { errors: ['unsupported fPort ' + port + ' (expected 10)'] };
  }
  if (!bytes || bytes.length < 3) {
    return { errors: ['truncated header'] };
  }

  var data = {};
  var warnings = [];

  data.txReason = txReason(bytes[0]);
  // Supply voltage is a battery/supply rail voltage -> vocabulary battery (V).
  data.battery = supplyVolts(bytes[1]);

  var frame = bytes[2];

  if (frame === 0x00 || frame === 0x01) {
    // Sensor_Data
    data.frameType = 'Sensor_Data';
    if (bytes.length < 16) {
      return { errors: ['truncated Sensor_Data frame'] };
    }
    data.errorMsg = ERROR_MSG[bytes[3]] !== undefined ? ERROR_MSG[bytes[3]] : 'Unknown';

    // Block 0: 3-byte instantaneous value (Power or Flow).
    var type0 = ENERGY_TYPE[bytes[4]] !== undefined ? ENERGY_TYPE[bytes[4]] : 'Reserved';
    var d0 = decode24(bytes, 6);
    if (d0.status !== null) {
      data.powerStatus = d0.status;
      warnings.push('block 0 sentinel: ' + d0.status);
    } else if (type0 === 'Power') {
      data.power = { active: d0.value };
    } else if (type0 === 'Flow') {
      data.flowRate = d0.value;
    }

    // Block 1: 5-byte cumulative counter (Energy Counter or Volume).
    var type1 = ENERGY_TYPE[(bytes[9] >> 3) + 1] !== undefined ? ENERGY_TYPE[(bytes[9] >> 3) + 1] : 'Reserved';
    var chan1 = ENERGY_CHANNEL[bytes[10]] !== undefined ? ENERGY_CHANNEL[bytes[10]] : 'Reserved';
    var div1 = type1 === 'Volume' ? 10000 : 10;
    var d1 = decode40(bytes, 11, div1);
    applyCounter(data, warnings, type1, chan1, d1, 'block 1');

    // Optional blocks 2 and 3 (5-byte counters) when the frame is long enough.
    if (bytes.length > 0x10) {
      if (bytes.length < 30) {
        return { errors: ['truncated extended Sensor_Data frame'] };
      }
      var type2 = ENERGY_TYPE[(bytes[16] >> 3) + 1] !== undefined ? ENERGY_TYPE[(bytes[16] >> 3) + 1] : 'Reserved';
      var chan2 = ENERGY_CHANNEL[bytes[17]] !== undefined ? ENERGY_CHANNEL[bytes[17]] : 'Reserved';
      var d2 = decode40(bytes, 18, 10);
      applyCounter(data, warnings, type2, chan2, d2, 'block 2');

      var type3 = ENERGY_TYPE[(bytes[23] >> 3) + 1] !== undefined ? ENERGY_TYPE[(bytes[23] >> 3) + 1] : 'Reserved';
      var chan3 = ENERGY_CHANNEL[bytes[24]] !== undefined ? ENERGY_CHANNEL[bytes[24]] : 'Reserved';
      var d3 = decode40(bytes, 25, 10);
      applyCounter(data, warnings, type3, chan3, d3, 'block 3');
    }
  } else if (frame === 0xf8) {
    // Config_Data_Spreading_Factor
    data.frameType = 'Config_Data_Spreading_Factor';
    if (bytes.length < 4) {
      return { errors: ['truncated Config_Data_Spreading_Factor frame'] };
    }
    var sf = bytes[3];
    if (sf === 0x00) {
      data.spreadingFactor = SPREADING_FACTOR[0];
    } else if (sf >= 0x07 && sf <= 0x0c) {
      data.spreadingFactor = SPREADING_FACTOR[sf - 6];
    } else {
      data.spreadingFactor = sf;
    }
  } else if (frame === 0xfa) {
    // Config_Data_Rejoin
    data.frameType = 'Config_Data_Rejoin';
    if (bytes.length < 5) {
      return { errors: ['truncated Config_Data_Rejoin frame'] };
    }
    data.rejoinCycleOnTime = bytes[3] >> 7;
    data.rejoinCycleInterval = ((bytes[3] & 0x7f) << 8) | bytes[4];
  } else if (frame === 0xfc) {
    // Config_Data_All
    data.frameType = 'Config_Data_All';
    if (bytes.length < 4) {
      return { errors: ['truncated Config_Data_All frame'] };
    }
    var channel = bytes[3];
    data.configChannel = channel;
    if (channel === 0x0a) {
      if (bytes.length < 5) {
        return { errors: ['truncated Config_Data_All send-cycle frame'] };
      }
      data.sendCycle = bytes[4];
    } else if (channel === 0x01) {
      if (bytes.length < 25) {
        return { errors: ['truncated Config_Data_All meter frame'] };
      }
      data.meterType = bytes[4];
      data.gasMeterConstant = (bytes[5] << 8) | bytes[6];
      data.ledMeterConstant = (bytes[7] << 8) | bytes[8];
      data.obisPowerStr = charsFrom(bytes, 9, 16);
    } else if (channel === 0x02) {
      if (bytes.length < 20) {
        return { errors: ['truncated Config_Data_All OBIS frame'] };
      }
      data.obisEnergyCounterConsumptionHtStr = charsFrom(bytes, 4, 16);
    } else if (channel === 0x03) {
      if (bytes.length < 20) {
        return { errors: ['truncated Config_Data_All OBIS frame'] };
      }
      data.obisEnergyCounterConsumptionNtStr = charsFrom(bytes, 4, 16);
    } else if (channel === 0x04) {
      if (bytes.length < 20) {
        return { errors: ['truncated Config_Data_All OBIS frame'] };
      }
      data.obisEnergyCounterDeliveryStr = charsFrom(bytes, 4, 16);
    }
  } else if (frame === 0xff) {
    // Device_Info
    data.frameType = 'Device_Info';
    if (bytes.length < 11) {
      return { errors: ['truncated Device_Info frame'] };
    }
    data.bootloaderVersion = bytes[3] + '.' + bytes[4] + '.' + bytes[5];
    data.firmwareVersion = bytes[6] + '.' + bytes[7] + '.' + bytes[8];
    data.hwRevision = (bytes[9] << 8) | bytes[10];
  } else {
    return { errors: ['unsupported frame type 0x' + frame.toString(16)] };
  }

  if (warnings.length > 0) {
    return { data: data, warnings: warnings };
  }
  return { data: data };
}

// Map a decoded 5-byte counter block to the right vocabulary key / extra.
function applyCounter(data, warnings, type, channel, decoded, label) {
  if (decoded.status !== null) {
    data.energyStatus = decoded.status;
    warnings.push(label + ' sentinel: ' + decoded.status);
    return;
  }
  if (type === 'Volume') {
    data.volume = decoded.value;
    return;
  }
  // type === 'Energy Counter' (or Reserved fallthrough): place by channel.
  if (channel === 'Energy Counter Consumption HT') {
    if (!data.metering) { data.metering = {}; }
    if (!data.metering.energy) { data.metering.energy = {}; }
    data.metering.energy.total = decoded.value;
  } else if (channel === 'Energy Counter Consumption NT') {
    data.energyConsumptionNt = decoded.value;
  } else if (channel === 'Energy Counter Delivery') {
    data.energyDelivery = decoded.value;
  }
}

// Build a string from `count` bytes starting at off, dropping NUL padding.
function charsFrom(bytes, off, count) {
  var s = '';
  for (var i = 0; i < count; i++) {
    var c = bytes[off + i];
    if (c === 0) { break; }
    s += String.fromCharCode(c);
  }
  return s;
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "dnt";
    result.data.model = "dnt-lw-esi";
  }
  return result;
}
