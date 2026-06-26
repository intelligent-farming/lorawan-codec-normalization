// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for decentlab/dl-tp (DL-TP Temperature Profile Sensor).
//
// Decentlab decoder embedded verbatim from the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/decentlab/dl-tp.js, attributed in
// NOTICE), renamed dlDecoder. decodeUplinkCore maps the primary temperature
// reading (C) -> temperature and battery -> battery; other fields are extras.
function round(value, decimals) { var f = Math.pow(10, decimals); return Math.round(value * f) / f; }

var dlDecoder = {
  PROTOCOL_VERSION: 2,
  SENSORS: [
    {length: 16,
     values: [{name: 'temperature_at_level_0',
               displayName: 'Temperature at level 0',
               convert: function (x) { return (x[0] - 32768) / 100; },
               unit: '°C'},
              {name: 'temperature_at_level_1',
               displayName: 'Temperature at level 1',
               convert: function (x) { return (x[1] - 32768) / 100; },
               unit: '°C'},
              {name: 'temperature_at_level_2',
               displayName: 'Temperature at level 2',
               convert: function (x) { return (x[2] - 32768) / 100; },
               unit: '°C'},
              {name: 'temperature_at_level_3',
               displayName: 'Temperature at level 3',
               convert: function (x) { return (x[3] - 32768) / 100; },
               unit: '°C'},
              {name: 'temperature_at_level_4',
               displayName: 'Temperature at level 4',
               convert: function (x) { return (x[4] - 32768) / 100; },
               unit: '°C'},
              {name: 'temperature_at_level_5',
               displayName: 'Temperature at level 5',
               convert: function (x) { return (x[5] - 32768) / 100; },
               unit: '°C'},
              {name: 'temperature_at_level_6',
               displayName: 'Temperature at level 6',
               convert: function (x) { return (x[6] - 32768) / 100; },
               unit: '°C'},
              {name: 'temperature_at_level_7',
               displayName: 'Temperature at level 7',
               convert: function (x) { return (x[7] - 32768) / 100; },
               unit: '°C'},
              {name: 'temperature_at_level_8',
               displayName: 'Temperature at level 8',
               convert: function (x) { return (x[8] - 32768) / 100; },
               unit: '°C'},
              {name: 'temperature_at_level_9',
               displayName: 'Temperature at level 9',
               convert: function (x) { return (x[9] - 32768) / 100; },
               unit: '°C'},
              {name: 'temperature_at_level_10',
               displayName: 'Temperature at level 10',
               convert: function (x) { return (x[10] - 32768) / 100; },
               unit: '°C'},
              {name: 'temperature_at_level_11',
               displayName: 'Temperature at level 11',
               convert: function (x) { return (x[11] - 32768) / 100; },
               unit: '°C'},
              {name: 'temperature_at_level_12',
               displayName: 'Temperature at level 12',
               convert: function (x) { return (x[12] - 32768) / 100; },
               unit: '°C'},
              {name: 'temperature_at_level_13',
               displayName: 'Temperature at level 13',
               convert: function (x) { return (x[13] - 32768) / 100; },
               unit: '°C'},
              {name: 'temperature_at_level_14',
               displayName: 'Temperature at level 14',
               convert: function (x) { return (x[14] - 32768) / 100; },
               unit: '°C'},
              {name: 'temperature_at_level_15',
               displayName: 'Temperature at level 15',
               convert: function (x) { return (x[15] - 32768) / 100; },
               unit: '°C'}]},
    {length: 1,
     values: [{name: 'battery_voltage',
               displayName: 'Battery voltage',
               convert: function (x) { return x[0] / 1000; },
               unit: 'V'}]}
  ],

  read_int: function (bytes, pos) {
    return (bytes[pos] << 8) + bytes[pos + 1];
  },

  decode: function (msg) {
    var bytes = msg;
    var i, j;
    if (typeof msg === 'string') {
      bytes = [];
      for (i = 0; i < msg.length; i += 2) {
        bytes.push(parseInt(msg.substring(i, i + 2), 16));
      }
    }

    var version = bytes[0];
    if (version != this.PROTOCOL_VERSION) {
      return {error: "protocol version " + version + " doesn't match v2"};
    }

    var deviceId = this.read_int(bytes, 1);
    var flags = this.read_int(bytes, 3);
    var result = {'protocol_version': version, 'device_id': deviceId};
    // decode payload
    var pos = 5;
    for (i = 0; i < this.SENSORS.length; i++, flags >>= 1) {
      if ((flags & 1) !== 1)
        continue;

      var sensor = this.SENSORS[i];
      var x = [];
      // convert data to 16-bit integer array
      for (j = 0; j < sensor.length; j++) {
        x.push(this.read_int(bytes, pos));
        pos += 2;
      }

      // decode sensor values
      for (j = 0; j < sensor.values.length; j++) {
        var value = sensor.values[j];
        if ('convert' in value) {
          result[value.name] = {displayName: value.displayName,
                                value: value.convert.bind(this)(x)};
          if ('unit' in value)
            result[value.name]['unit'] = value.unit;
        }
      }
    }
    return result;
  }
};

function camel(name) {
  var parts = String(name).replace(/[^A-Za-z0-9]+/g, ' ').trim().split(' ');
  var out = '';
  var p;
  for (p = 0; p < parts.length; p++) { if (!parts[p]) { continue; } out = out === '' ? parts[p].charAt(0).toLowerCase() + parts[p].slice(1) : out + parts[p].charAt(0).toUpperCase() + parts[p].slice(1); }
  return out || 'field';
}

function decodeUplinkCore(input) {
  var res = dlDecoder.decode(input.bytes);
  if (res.error) { return { errors: [res.error] }; }
  var data = {};
  if (res['temperature_at_level_0'] && typeof res['temperature_at_level_0'].value === 'number') {
    data.temperature = round(res['temperature_at_level_0'].value, 2);
  } else { return { errors: ['no temperature field in payload'] }; }
  if (res.battery_voltage && typeof res.battery_voltage.value === 'number') { data.battery = round(res.battery_voltage.value, 3); }
  var k;
  for (k in res) {
    if (k === 'temperature_at_level_0' || k === 'battery_voltage' || k === 'protocol_version' || k === 'device_id') { continue; }
    if (res[k] && typeof res[k] === 'object' && typeof res[k].value === 'number') { data[camel(k)] = round(res[k].value, 3); }
  }
  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) { result.data.make = "decentlab"; result.data.model = "dl-tp"; }
  return result;
}
