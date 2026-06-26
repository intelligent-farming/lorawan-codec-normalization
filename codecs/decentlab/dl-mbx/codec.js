// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for decentlab/dl-mbx (DL-MBX Ultrasonic Distance / Level Sensor).
//
// Decentlab decoder embedded verbatim from the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/decentlab/dl-mbx.js, attributed in
// NOTICE), renamed dlDecoder. Decentlab's self-describing protocol (version,
// device id, sensor-present flags, 16-bit words) yields named fields with units;
// decodeUplinkCore maps the top-mounted ranging distance (mm) to tank.distance
// (m) and battery voltage to battery, keeping the remaining fields as extras.
function round(value, decimals) { var f = Math.pow(10, decimals); return Math.round(value * f) / f; }

var dlDecoder = {
  PROTOCOL_VERSION: 2,
  SENSORS: [
    {length: 2,
     values: [{name: 'distance',
               displayName: 'Distance',
               convert: function (x) { return x[0]; },
               unit: 'mm'},
              {name: 'number_of_valid_samples',
               displayName: 'Number of valid samples',
               convert: function (x) { return x[1]; }}]},
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
  for (p = 0; p < parts.length; p++) {
    if (!parts[p]) { continue; }
    out = out === '' ? parts[p].charAt(0).toLowerCase() + parts[p].slice(1) : out + parts[p].charAt(0).toUpperCase() + parts[p].slice(1);
  }
  return out || 'field';
}

function decodeUplinkCore(input) {
  var res = dlDecoder.decode(input.bytes);
  if (res.error) { return { errors: [res.error] }; }
  var data = {};
  if (res['distance'] && typeof res['distance'].value === 'number') {
    data.tank = { distance: round(res['distance'].value / 1000, 3) };
  } else { return { errors: ['no distance field in payload'] }; }
  if (res.battery_voltage && typeof res.battery_voltage.value === 'number') { data.battery = round(res.battery_voltage.value, 3); }
  var k;
  for (k in res) {
    if (k === 'distance' || k === 'battery_voltage' || k === 'protocol_version' || k === 'device_id') { continue; }
    if (res[k] && typeof res[k] === 'object' && typeof res[k].value === 'number') { data[camel(k)] = res[k].value; }
  }
  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) { result.data.make = "decentlab"; result.data.model = "dl-mbx"; }
  return result;
}
