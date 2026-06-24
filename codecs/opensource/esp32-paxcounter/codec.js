// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for the ESP32-Paxcounter (open-source people-counter
// firmware). The device primarily counts WiFi/BLE devices (pax) and, on add-on
// boards, reports a GPS fix and BME280/BME680 environmental data.
//
// Wire format understood with reference to the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/opensource/esp32-paxcounter-packed.js,
// attributed in NOTICE). The upstream uses the lora-serialization "PACKED"
// format and multiplexes telemetry across fPorts:
//   fPort 1  pax counts (wifi/ble), optionally GPS + PM (dust) variants
//   fPort 2  device status (voltage, uptime, cputemp, memory, restarts)
//   fPort 3  device config
//   fPort 4  GPS fix (lat/lon [+ sats/hdop/altitude])
//   fPort 5  button press
//   fPort 7  BME680 environment (temperature, pressure, humidity, gas)
//   fPort 8  battery voltage (mV)
//   fPort 9  timesync
//   fPort 10 ENS (exposure-notification) count
//
// Normalization decisions (we author these; do NOT copy upstream output):
//  - fPort 7 temperature -> air.temperature (BME big-endian s16/100, degC)
//  - fPort 7 pressure    -> air.pressure (uint16/10 = hPa, atmospheric)
//  - fPort 7 humidity    -> air.relativeHumidity (uint16/100, %)
//  - fPort 7 gas/VOC     -> camelCase extra airQuality (uint16/100; upstream "air")
//  - fPort 4 / fPort 1   -> position.latitude / position.longitude (int32/1e6)
//                          sats/hdop/altitude kept as camelCase extras
//  - fPort 1 wifi/ble    -> camelCase extras wifi/ble/pax (people counts;
//                          no vocabulary key models a device counter)
//  - fPort 8 voltage(mV) -> battery (V); fPort 2 voltage(mV) -> battery (V)
//  - PM10/PM2.5 (dust)   -> camelCase extras pm10 / pm25 (not air-quality vocab)
// Diagnostic-only fields (uptime, cputemp, memory, restarts, config, button,
// timesync, ENS) are emitted as camelCase extras so no telemetry is lost.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function bytesToIntLE(bytes, offset, len) {
  var v = 0;
  for (var x = 0; x < len; x++) {
    v |= bytes[offset + x] << (x * 8);
  }
  return v;
}

function u8(bytes, offset) {
  return bytes[offset] & 0xff;
}

function u16le(bytes, offset) {
  return bytesToIntLE(bytes, offset, 2) & 0xffff;
}

function u32le(bytes, offset) {
  return bytesToIntLE(bytes, offset, 4) >>> 0;
}

function s16le(bytes, offset) {
  var v = u16le(bytes, offset);
  return v > 0x7fff ? v - 0x10000 : v;
}

function s32le(bytes, offset) {
  var v = u32le(bytes, offset);
  return v > 0x7fffffff ? v - 0x100000000 : v;
}

// lora-serialization latLng: signed 32-bit little-endian / 1e6, 6 decimals.
function latLng(bytes, offset) {
  return round(s32le(bytes, offset) / 1e6, 6);
}

// lora-serialization hdop: unsigned 16-bit little-endian / 100, 2 decimals.
function hdop(bytes, offset) {
  return round(u16le(bytes, offset) / 100, 2);
}

// lora-serialization altitude: signed 16-bit, meters (integer resolution).
function altitude(bytes, offset) {
  return s16le(bytes, offset);
}

// lora-serialization "float": signed 16-bit BIG-endian (two's complement) / 100.
function bmeFloat(bytes, offset) {
  var raw = ((bytes[offset] << 8) | bytes[offset + 1]) & 0xffff;
  if (raw > 0x7fff) {
    raw -= 0x10000;
  }
  return round(raw / 100, 2);
}

// lora-serialization "ufloat": unsigned 16-bit little-endian / 100.
function bmeUfloat(bytes, offset) {
  return round(u16le(bytes, offset) / 100, 2);
}

// lora-serialization "pressure": unsigned 16-bit little-endian / 10 (hPa).
function bmePressure(bytes, offset) {
  return round(u16le(bytes, offset) / 10, 1);
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;
  var fPort = input.fPort;
  if (!bytes) {
    return { errors: ['no bytes'] };
  }
  var len = bytes.length;
  var data = {};
  var air = {};
  var position = {};

  if (fPort === 1) {
    // pax counts, optionally GPS / PM (dust). Layouts keyed by length.
    if (len === 2) {
      data.wifi = u16le(bytes, 0);
    } else if (len === 4) {
      data.wifi = u16le(bytes, 0);
      data.ble = u16le(bytes, 2);
    } else if (len === 8) {
      data.wifi = u16le(bytes, 0);
      data.ble = u16le(bytes, 2);
      data.pm10 = u16le(bytes, 4);
      data.pm25 = u16le(bytes, 6);
    } else if (len === 10) {
      position.latitude = latLng(bytes, 0);
      position.longitude = latLng(bytes, 4);
      data.wifi = u16le(bytes, 8);
    } else if (len === 12) {
      position.latitude = latLng(bytes, 0);
      position.longitude = latLng(bytes, 4);
      data.wifi = u16le(bytes, 8);
      data.ble = u16le(bytes, 10);
    } else if (len === 15) {
      data.wifi = u16le(bytes, 0);
      position.latitude = latLng(bytes, 2);
      position.longitude = latLng(bytes, 6);
      data.sats = u8(bytes, 10);
      data.hdop = hdop(bytes, 11);
      data.altitude = altitude(bytes, 13);
    } else if (len === 17) {
      data.wifi = u16le(bytes, 0);
      data.ble = u16le(bytes, 2);
      position.latitude = latLng(bytes, 4);
      position.longitude = latLng(bytes, 8);
      data.sats = u8(bytes, 12);
      data.hdop = hdop(bytes, 13);
      data.altitude = altitude(bytes, 15);
    } else {
      return { errors: ['fPort 1: unexpected payload length ' + len] };
    }
    // pax = total of recognized people counters.
    var pax = 0;
    if (data.wifi !== undefined) {
      pax += data.wifi;
    }
    if (data.ble !== undefined) {
      pax += data.ble;
    }
    data.pax = pax;
  } else if (fPort === 2) {
    // device status: voltage(mV) uptime(u64) cputemp memory reset0 restarts
    if (len !== 20) {
      return { errors: ['fPort 2: expected 20 bytes, got ' + len] };
    }
    var mv = u16le(bytes, 0);
    if (mv > 0) {
      data.battery = round(mv / 1000, 3);
    }
    // uptime is a 64-bit value; decode the low 32 bits as a safe integer.
    data.uptime = u32le(bytes, 2);
    data.cpuTemperature = u8(bytes, 10);
    data.freeMemory = u32le(bytes, 11);
    data.lastResetCause = u8(bytes, 15);
    data.restarts = u32le(bytes, 16);
  } else if (fPort === 3) {
    // device config (diagnostic).
    if (len < 11) {
      return { errors: ['fPort 3: expected at least 11 bytes, got ' + len] };
    }
    data.loraDr = u8(bytes, 0);
    data.txPower = u8(bytes, 1);
    data.rssiLimit = s16le(bytes, 2);
    data.sendCycle = u8(bytes, 4);
    data.wifiChannelCycle = u8(bytes, 5);
    data.bleScanTime = u8(bytes, 6);
    data.sleepCycle = u16le(bytes, 7);
  } else if (fPort === 4) {
    // GPS fix.
    if (len === 8) {
      position.latitude = latLng(bytes, 0);
      position.longitude = latLng(bytes, 4);
    } else if (len === 13) {
      position.latitude = latLng(bytes, 0);
      position.longitude = latLng(bytes, 4);
      data.sats = u8(bytes, 8);
      data.hdop = hdop(bytes, 9);
      data.altitude = altitude(bytes, 11);
    } else {
      return { errors: ['fPort 4: unexpected payload length ' + len] };
    }
  } else if (fPort === 5) {
    // button press.
    if (len !== 1) {
      return { errors: ['fPort 5: expected 1 byte, got ' + len] };
    }
    data.button = u8(bytes, 0);
  } else if (fPort === 7) {
    // BME680 environment: temperature, pressure, humidity, gas/VOC.
    if (len !== 8) {
      return { errors: ['fPort 7: expected 8 bytes, got ' + len] };
    }
    air.temperature = bmeFloat(bytes, 0);
    air.pressure = bmePressure(bytes, 2);
    air.relativeHumidity = bmeUfloat(bytes, 4);
    data.airQuality = bmeUfloat(bytes, 6);
  } else if (fPort === 8) {
    // battery voltage (mV).
    if (len !== 2) {
      return { errors: ['fPort 8: expected 2 bytes, got ' + len] };
    }
    data.battery = round(u16le(bytes, 0) / 1000, 3);
  } else if (fPort === 9) {
    // timesync.
    if (len === 1) {
      data.timesyncSeqno = u8(bytes, 0);
    } else if (len === 5) {
      data.deviceTime = u32le(bytes, 0);
      data.timeStatus = u8(bytes, 4);
    } else {
      return { errors: ['fPort 9: unexpected payload length ' + len] };
    }
  } else if (fPort === 10) {
    // ENS (exposure notification) count.
    if (len !== 2) {
      return { errors: ['fPort 10: expected 2 bytes, got ' + len] };
    }
    data.ens = u16le(bytes, 0);
  } else {
    return { errors: ['unsupported fPort ' + fPort] };
  }

  if (
    air.temperature !== undefined ||
    air.relativeHumidity !== undefined ||
    air.pressure !== undefined
  ) {
    data.air = air;
  }
  if (position.latitude !== undefined && position.longitude !== undefined) {
    data.position = position;
  }

  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "opensource";
    result.data.model = "esp32-paxcounter";
  }
  return result;
}
