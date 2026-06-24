// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Ezurio / Laird Sentrius RS1xx Temperature +
// Humidity sensor.
//
// Ported/normalized from the upstream Apache-2.0 decoder ("Laird Protocol TTI
// Payload Library", Greg Leach @ Ezurio Connectivity;
// TheThingsNetwork/lorawan-devices vendor/ezurio/rs1xx-temp-rh-sensor.js,
// attributed in NOTICE). The upstream message-type byte + sensor-field layout
// is the source of truth; we author the normalization here and do NOT reuse the
// upstream normalizeUplink (which hard-codes only air.temperature /
// air.relativeHumidity and drops every other field and the datalog history).
//
// Wire format: byte[0] is the uplink message type. Temperature/humidity values
// are an "RS1xx float": a 2-byte pair [fractional, decimal] where each byte is a
// signed int8 and value = decimal + fractional / 100. Multi-byte integers
// (counts, read period) are big-endian. Aggregated (0x02) and backlog (0x04)
// frames carry multiple timestamped readings; the newest is emitted at the top
// level and older readings go into the `history` array (newest-first), each with
// an RFC3339 `time`. Battery is reported two ways: a coarse capacity band
// (camelCase extra `batteryCapacityRange`) on the data frames, and an actual
// voltage on the dedicated 0x0A frame (vocabulary `battery`, in volts).

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function int8(b) {
  return b > 127 ? b - 256 : b;
}

// RS1xx "float": [fractional, decimal], each a signed int8.
function rsFloat(frac, dec) {
  return round(int8(dec) + int8(frac) / 100, 2);
}

// Big-endian unsigned 16-bit.
function u16be(hi, lo) {
  return ((hi << 8) | lo) & 0xffff;
}

// Big-endian unsigned 32-bit.
function u32be(b0, b1, b2, b3) {
  return ((b0 * 16777216) + (b1 << 16) + (b2 << 8) + b3);
}

function pad2(n) {
  return n < 10 ? '0' + n : '' + n;
}

// RS1xx timestamp: big-endian U32 seconds since 2015-01-01T00:00:00Z. Returns an
// RFC3339 string (UTC). 2015-01-01 is 1420070400 s after the Unix epoch.
function decodeTime(b0, b1, b2, b3) {
  var secs = u32be(b0, b1, b2, b3) + 1420070400;
  var d = new Date(secs * 1000);
  return (
    d.getUTCFullYear() +
    '-' +
    pad2(d.getUTCMonth() + 1) +
    '-' +
    pad2(d.getUTCDate()) +
    'T' +
    pad2(d.getUTCHours()) +
    ':' +
    pad2(d.getUTCMinutes()) +
    ':' +
    pad2(d.getUTCSeconds()) +
    'Z'
  );
}

// Decodes the uplink options bitfield into a list of flag strings ([] when none
// are set). Mirrors the upstream uplinkOptionsBitfield.
function decodeOptions(b) {
  var flags = [];
  if (b & 0x01) {
    flags.push('serverTimeRequest');
  }
  if (b & 0x02) {
    flags.push('configurationError');
  }
  if (b & 0x04) {
    flags.push('alarm');
  }
  if (b & 0x08) {
    flags.push('reset');
  }
  if (b & 0x10) {
    flags.push('fault');
  }
  return flags;
}

var BATTERY_CAPACITY = ['0-5%', '5-20%', '20-40%', '40-60%', '60-80%', '80-100%'];

function decodeUplinkCore(input) {
  var bytes = input.bytes;
  if (!bytes || bytes.length < 1) {
    return { errors: ['empty payload'] };
  }

  var msgType = bytes[0];

  // 0x01 - Temp/RH data notification (11 bytes).
  if (msgType === 0x01) {
    if (bytes.length !== 11) {
      return { errors: ['Invalid uplink message length!'] };
    }
    var data1 = {
      messageType: 'tempRh',
      air: {
        relativeHumidity: rsFloat(bytes[2], bytes[3]),
        temperature: rsFloat(bytes[4], bytes[5])
      },
      batteryCapacityRange: BATTERY_CAPACITY[bytes[6]],
      options: decodeOptions(bytes[1]),
      alarmMsgCount: u16be(bytes[7], bytes[8]),
      backlogMsgCount: u16be(bytes[9], bytes[10])
    };
    return { data: data1 };
  }

  // 0x02 - Aggregated Temp/RH notification. Header is 11 bytes, then N 4-byte
  // [hFrac, hDec, tFrac, tDec] readings.
  if (msgType === 0x02) {
    var n2 = bytes[6];
    if (bytes.length <= 11 || bytes.length !== n2 * 4 + 11) {
      return { errors: ['Invalid uplink message length!'] };
    }
    var time2 = decodeTime(bytes[7], bytes[8], bytes[9], bytes[10]);
    var readings2 = [];
    var o2 = 11;
    var j;
    for (j = 0; j < n2; j++) {
      readings2.push({
        air: {
          relativeHumidity: rsFloat(bytes[o2], bytes[o2 + 1]),
          temperature: rsFloat(bytes[o2 + 2], bytes[o2 + 3])
        },
        time: time2
      });
      o2 += 4;
    }
    if (readings2.length === 0) {
      return { errors: ['no readings in aggregated frame'] };
    }
    var newest2 = readings2[readings2.length - 1];
    var data2 = {
      messageType: 'aggregatedTempRh',
      air: newest2.air,
      time: newest2.time,
      batteryCapacityRange: BATTERY_CAPACITY[bytes[5]],
      options: decodeOptions(bytes[1]),
      alarmMsgCount: bytes[2],
      backlogMsgCount: u16be(bytes[3], bytes[4]),
      numberOfReadings: n2
    };
    if (readings2.length > 1) {
      var history2 = [];
      var k2;
      for (k2 = readings2.length - 2; k2 >= 0; k2--) {
        history2.push(readings2[k2]);
      }
      data2.history = history2;
    }
    return { data: data2 };
  }

  // 0x03 - Single backlog message (10 bytes): options, timestamp(4), hum, temp.
  if (msgType === 0x03) {
    if (bytes.length !== 10) {
      return { errors: ['Invalid uplink message length!'] };
    }
    var data3 = {
      messageType: 'backlog',
      air: {
        relativeHumidity: rsFloat(bytes[6], bytes[7]),
        temperature: rsFloat(bytes[8], bytes[9])
      },
      time: decodeTime(bytes[2], bytes[3], bytes[4], bytes[5]),
      options: decodeOptions(bytes[1])
    };
    return { data: data3 };
  }

  // 0x04 - Multiple backlog messages. Header is 3 bytes, then N 8-byte
  // [ts(4), hFrac, hDec, tFrac, tDec] readings.
  if (msgType === 0x04) {
    if (bytes.length < 11 || (bytes.length - 3) % 8 !== 0) {
      return { errors: ['Invalid uplink message length!'] };
    }
    var n4 = bytes[2];
    var readings4 = [];
    var o4 = 3;
    while (o4 + 8 <= bytes.length) {
      readings4.push({
        air: {
          relativeHumidity: rsFloat(bytes[o4 + 4], bytes[o4 + 5]),
          temperature: rsFloat(bytes[o4 + 6], bytes[o4 + 7])
        },
        time: decodeTime(bytes[o4], bytes[o4 + 1], bytes[o4 + 2], bytes[o4 + 3])
      });
      o4 += 8;
    }
    if (readings4.length === 0) {
      return { errors: ['no readings in backlog frame'] };
    }
    var newest4 = readings4[readings4.length - 1];
    var data4 = {
      messageType: 'backlogMultiple',
      air: newest4.air,
      time: newest4.time,
      options: decodeOptions(bytes[1]),
      numberOfReadings: n4
    };
    if (readings4.length > 1) {
      var history4 = [];
      var k4;
      for (k4 = readings4.length - 2; k4 >= 0; k4--) {
        history4.push(readings4[k4]);
      }
      data4.history = history4;
    }
    return { data: data4 };
  }

  // 0x0A - Battery voltage notification (4 bytes): options, voltage(2).
  if (msgType === 0x0a) {
    if (bytes.length !== 4) {
      return { errors: ['Invalid uplink message length!'] };
    }
    var data10 = {
      messageType: 'batteryVoltage',
      battery: rsFloat(bytes[2], bytes[3]),
      options: decodeOptions(bytes[1])
    };
    return { data: data10 };
  }

  return { errors: ['Invalid message type used!'] };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "ezurio";
    result.data.model = "rs1xx-temp-rh-sensor";
  }
  return result;
}
