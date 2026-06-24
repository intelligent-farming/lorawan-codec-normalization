// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for Milesight VS135 (4D AI ToF people-counting
// sensor: up to four line-crossing counters with directional in/out totals and
// per-period counts, optional region occupancy counts and dwell times, a child
// (slave) node mirror of all of the above, occlusion alarms, and datalog
// history). Sibling of the VS133.
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format (Milesight channel/type TLV) understood with reference to the upstream
// Apache-2.0 decoder (TheThingsNetwork/lorawan-devices
// vendor/milesight-iot/vs135.js, attributed in NOTICE). Ported faithfully from
// that decoder's uplink path (milesightDeviceDecode); we author the
// normalization here — we do NOT copy upstream normalizeUplink.
//
// Mapping decisions:
//   0xff/0x01 IPSO version       byte                  -> ipsoVersion extra
//   0xff/0x09 hardware version   2 bytes               -> hardwareVersion extra
//   0xff/0x1f firmware version   4 bytes               -> firmwareVersion extra
//   0xff/0x16 serial number      8 bytes               -> sn extra
//   line in   (0x03/06/09/0c)/0xd2  uint32 LE          -> lineNTotalIn extra
//   line out  (0x04/07/0a/0d)/0xd2  uint32 LE          -> lineNTotalOut extra
//   line per  (0x05/08/0b/0e)/0xcc  uint16 LE x2       -> lineNPeriodIn / Out extras
//   child line in  (0x11/14/17/1a)/0xd2                -> lineNChildTotalIn extra
//   child line out (0x12/15/18/1b)/0xd2                -> lineNChildTotalOut extra
//   child line per (0x13/16/19/1c)/0xcc                -> lineNChildPeriodIn / Out extras
//   region count   0x0f/0xe3      4 x uint8            -> regionNCount extras
//   region count (child) 0x1d/0xe3                     -> regionNChildCount extras
//   region dwell   0x10/0xe4      region + 2 x uint16  -> regionNAvgDwell / MaxDwell extras
//   region dwell (child) 0x1e/0xe4                     -> regionNChildAvgDwell / MaxDwell
//   alarm     0x50/0xfc          node + alarm byte     -> occlusionAlarm[] extra
//   history   0x20/0xce          datalog records       -> history[] (each with time)
//
// The VS135 is a counting device: the primary normalized measurement is
// action.motion.count, taken as the SUM of every decoded master line's
// directional total (all master-line in + out — child/region counters are kept
// as extras to avoid double-counting), with action.motion.detected =
// (count > 0). All raw directional, period, region and dwell counters are
// preserved as camelCase extras. The vocabulary `battery` is volts; Milesight
// devices report battery as a percentage, so should a battery channel appear it
// would be emitted as the extra batteryPercent (this SKU is line-powered and
// does not report one). Downlink command responses (channels 0xfe/0xff config
// echoes, 0xf8/0xf9) are not part of the uplink measurement path and are not
// decoded here.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function u16le(lo, hi) {
  return ((hi << 8) | lo) & 0xffff;
}

function u32le(b0, b1, b2, b3) {
  return ((b3 << 24) | (b2 << 16) | (b1 << 8) | b0) >>> 0;
}

function hex2(v) {
  return ('0' + (v & 0xff).toString(16)).slice(-2);
}

function alarmType(t) {
  if (t === 0) { return 'alarm_released'; }
  if (t === 1) { return 'alarm_triggered'; }
  return 'unknown';
}

function includes(list, value) {
  for (var k = 0; k < list.length; k++) {
    if (list[k] === value) { return true; }
  }
  return false;
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;
  if (!bytes || bytes.length === 0) {
    return { errors: ['empty payload'] };
  }

  var TOTAL_IN = [0x03, 0x06, 0x09, 0x0c];
  var TOTAL_OUT = [0x04, 0x07, 0x0a, 0x0d];
  var PERIOD = [0x05, 0x08, 0x0b, 0x0e];
  var CHILD_TOTAL_IN = [0x11, 0x14, 0x17, 0x1a];
  var CHILD_TOTAL_OUT = [0x12, 0x15, 0x18, 0x1b];
  var CHILD_PERIOD = [0x13, 0x16, 0x19, 0x1c];

  var data = {};
  var motionTotal = 0;
  var hasMotion = false;
  var recognized = false;

  var i = 0;
  while (i + 1 < bytes.length) {
    var channel = bytes[i];
    var type = bytes[i + 1];
    var j = i + 2;

    if (channel === 0xff && type === 0x01) {
      // IPSO version
      data.ipsoVersion = 'v' + ((bytes[j] & 0xf0) >> 4) + '.' + (bytes[j] & 0x0f);
      i = j + 1;
      recognized = true;
    } else if (channel === 0xff && type === 0x09) {
      // hardware version
      data.hardwareVersion = 'v' + (bytes[j] & 0xff) + '.' + (bytes[j + 1] & 0xff);
      i = j + 2;
      recognized = true;
    } else if (channel === 0xff && type === 0x1f) {
      // firmware version
      data.firmwareVersion = 'v' + (bytes[j] & 0xff) + '.' + (bytes[j + 1] & 0xff) +
        '.' + (bytes[j + 2] & 0xff) + '.' + (bytes[j + 3] & 0xff);
      i = j + 4;
      recognized = true;
    } else if (channel === 0xff && type === 0x16) {
      // serial number (8 bytes, hex)
      var sn = '';
      for (var s = 0; s < 8; s++) { sn += hex2(bytes[j + s]); }
      data.sn = sn;
      i = j + 8;
      recognized = true;
    } else if (includes(TOTAL_IN, channel) && type === 0xd2) {
      var inLine = (channel - TOTAL_IN[0]) / 3 + 1;
      var inVal = u32le(bytes[j], bytes[j + 1], bytes[j + 2], bytes[j + 3]);
      data['line' + inLine + 'TotalIn'] = inVal;
      motionTotal += inVal;
      hasMotion = true;
      i = j + 4;
      recognized = true;
    } else if (includes(TOTAL_OUT, channel) && type === 0xd2) {
      var outLine = (channel - TOTAL_OUT[0]) / 3 + 1;
      var outVal = u32le(bytes[j], bytes[j + 1], bytes[j + 2], bytes[j + 3]);
      data['line' + outLine + 'TotalOut'] = outVal;
      motionTotal += outVal;
      hasMotion = true;
      i = j + 4;
      recognized = true;
    } else if (includes(PERIOD, channel) && type === 0xcc) {
      var perLine = (channel - PERIOD[0]) / 3 + 1;
      data['line' + perLine + 'PeriodIn'] = u16le(bytes[j], bytes[j + 1]);
      data['line' + perLine + 'PeriodOut'] = u16le(bytes[j + 2], bytes[j + 3]);
      i = j + 4;
      recognized = true;
    } else if (includes(CHILD_TOTAL_IN, channel) && type === 0xd2) {
      var cInLine = (channel - CHILD_TOTAL_IN[0]) / 3 + 1;
      data['line' + cInLine + 'ChildTotalIn'] =
        u32le(bytes[j], bytes[j + 1], bytes[j + 2], bytes[j + 3]);
      i = j + 4;
      recognized = true;
    } else if (includes(CHILD_TOTAL_OUT, channel) && type === 0xd2) {
      var cOutLine = (channel - CHILD_TOTAL_OUT[0]) / 3 + 1;
      data['line' + cOutLine + 'ChildTotalOut'] =
        u32le(bytes[j], bytes[j + 1], bytes[j + 2], bytes[j + 3]);
      i = j + 4;
      recognized = true;
    } else if (includes(CHILD_PERIOD, channel) && type === 0xcc) {
      var cPerLine = (channel - CHILD_PERIOD[0]) / 3 + 1;
      data['line' + cPerLine + 'ChildPeriodIn'] = u16le(bytes[j], bytes[j + 1]);
      data['line' + cPerLine + 'ChildPeriodOut'] = u16le(bytes[j + 2], bytes[j + 3]);
      i = j + 4;
      recognized = true;
    } else if (channel === 0x0f && type === 0xe3) {
      // region counts (4 x uint8)
      data.region1Count = bytes[j] & 0xff;
      data.region2Count = bytes[j + 1] & 0xff;
      data.region3Count = bytes[j + 2] & 0xff;
      data.region4Count = bytes[j + 3] & 0xff;
      i = j + 4;
      recognized = true;
    } else if (channel === 0x1d && type === 0xe3) {
      // region counts (child)
      data.region1ChildCount = bytes[j] & 0xff;
      data.region2ChildCount = bytes[j + 1] & 0xff;
      data.region3ChildCount = bytes[j + 2] & 0xff;
      data.region4ChildCount = bytes[j + 3] & 0xff;
      i = j + 4;
      recognized = true;
    } else if (channel === 0x10 && type === 0xe4) {
      // region dwell time: region + avg + max
      var dwellRegion = bytes[j] & 0xff;
      data['region' + dwellRegion + 'AvgDwell'] = u16le(bytes[j + 1], bytes[j + 2]);
      data['region' + dwellRegion + 'MaxDwell'] = u16le(bytes[j + 3], bytes[j + 4]);
      i = j + 5;
      recognized = true;
    } else if (channel === 0x1e && type === 0xe4) {
      // region dwell time (child)
      var cDwellRegion = bytes[j] & 0xff;
      data['region' + cDwellRegion + 'ChildAvgDwell'] = u16le(bytes[j + 1], bytes[j + 2]);
      data['region' + cDwellRegion + 'ChildMaxDwell'] = u16le(bytes[j + 3], bytes[j + 4]);
      i = j + 5;
      recognized = true;
    } else if (channel === 0x50 && type === 0xfc) {
      // occlusion alarm: (reserved byte) + node id + alarm type
      var nodeId = bytes[j + 1] & 0xff;
      if (!data.occlusionAlarm) { data.occlusionAlarm = []; }
      data.occlusionAlarm.push({
        node: nodeId === 0 ? 'master' : 'node_' + nodeId,
        alarm: alarmType(bytes[j + 2])
      });
      i = j + 3;
      recognized = true;
    } else if (channel === 0x20 && type === 0xce) {
      // datalog / history: epoch + data_type + record
      var hEpoch = u32le(bytes[j], bytes[j + 1], bytes[j + 2], bytes[j + 3]);
      var dataType = bytes[j + 4] & 0xff;
      var point = {};
      if (hEpoch > 0) {
        point.time = new Date(hEpoch * 1000).toISOString();
      }
      var k = j + 5;
      if (includes(TOTAL_IN, dataType)) {
        point['line' + ((dataType - TOTAL_IN[0]) / 3 + 1) + 'TotalIn'] =
          u32le(bytes[k], bytes[k + 1], bytes[k + 2], bytes[k + 3]);
        k += 4;
      } else if (includes(TOTAL_OUT, dataType)) {
        point['line' + ((dataType - TOTAL_OUT[0]) / 3 + 1) + 'TotalOut'] =
          u32le(bytes[k], bytes[k + 1], bytes[k + 2], bytes[k + 3]);
        k += 4;
      } else if (includes(PERIOD, dataType)) {
        var pLine = (dataType - PERIOD[0]) / 3 + 1;
        point['line' + pLine + 'PeriodIn'] = u16le(bytes[k], bytes[k + 1]);
        point['line' + pLine + 'PeriodOut'] = u16le(bytes[k + 2], bytes[k + 3]);
        k += 4;
      } else if (includes(CHILD_TOTAL_IN, dataType)) {
        point['line' + ((dataType - CHILD_TOTAL_IN[0]) / 3 + 1) + 'ChildTotalIn'] =
          u32le(bytes[k], bytes[k + 1], bytes[k + 2], bytes[k + 3]);
        k += 4;
      } else if (includes(CHILD_TOTAL_OUT, dataType)) {
        point['line' + ((dataType - CHILD_TOTAL_OUT[0]) / 3 + 1) + 'ChildTotalOut'] =
          u32le(bytes[k], bytes[k + 1], bytes[k + 2], bytes[k + 3]);
        k += 4;
      } else if (includes(CHILD_PERIOD, dataType)) {
        var cpLine = (dataType - CHILD_PERIOD[0]) / 3 + 1;
        point['line' + cpLine + 'ChildPeriodIn'] = u16le(bytes[k], bytes[k + 1]);
        point['line' + cpLine + 'ChildPeriodOut'] = u16le(bytes[k + 2], bytes[k + 3]);
        k += 4;
      } else if (dataType === 0x0f) {
        point.region1Count = bytes[k] & 0xff;
        point.region2Count = bytes[k + 1] & 0xff;
        point.region3Count = bytes[k + 2] & 0xff;
        point.region4Count = bytes[k + 3] & 0xff;
        k += 4;
      } else if (dataType === 0x1d) {
        point.region1ChildCount = bytes[k] & 0xff;
        point.region2ChildCount = bytes[k + 1] & 0xff;
        point.region3ChildCount = bytes[k + 2] & 0xff;
        point.region4ChildCount = bytes[k + 3] & 0xff;
        k += 4;
      } else if (dataType === 0x10) {
        point['region' + (bytes[k] & 0xff) + 'AvgDwell'] = u16le(bytes[k + 1], bytes[k + 2]);
        k += 3;
      } else if (dataType === 0x20) {
        point['region' + (bytes[k] & 0xff) + 'MaxDwell'] = u16le(bytes[k + 1], bytes[k + 2]);
        k += 3;
      } else if (dataType === 0x1e) {
        point['region' + (bytes[k] & 0xff) + 'ChildAvgDwell'] = u16le(bytes[k + 1], bytes[k + 2]);
        k += 3;
      } else if (dataType === 0x3c) {
        point['region' + (bytes[k] & 0xff) + 'ChildMaxDwell'] = u16le(bytes[k + 1], bytes[k + 2]);
        k += 3;
      } else {
        return { errors: ['unknown datalog data type: ' + dataType] };
      }
      if (!data.history) { data.history = []; }
      data.history.push(point);
      i = k;
      recognized = true;
    } else {
      break;
    }
  }

  if (!recognized) {
    return { errors: ['no recognized Milesight channels'] };
  }

  if (hasMotion) {
    data.action = {
      motion: {
        count: round(motionTotal, 0),
        detected: motionTotal > 0
      }
    };
  }

  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "milesight-iot";
    result.data.model = "vs135";
  }
  return result;
}
