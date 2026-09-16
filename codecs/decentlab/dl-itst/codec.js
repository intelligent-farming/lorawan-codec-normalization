// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for decentlab/dl-itst (DL-ITST Infrared Surface Temperature Sensor).
//
// Decentlab decoder embedded verbatim from the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/decentlab/dl-itst.js, attributed in
// NOTICE), renamed dlDecoder. decodeUplinkCore maps the primary temperature
// reading (C) -> temperature and battery -> battery; other fields are extras.
function round(value, decimals) { var f = Math.pow(10, decimals); return Math.round(value * f) / f; }

var dlDecoder = {
  PROTOCOL_VERSION: 2,
  SENSORS: [
    {length: 2,
     values: [{name: 'temperature_target',
               displayName: 'Temperature target',
               convert: function (x) { return (x[0] - 1000) / 10; },
               unit: '°C'},
              {name: 'temperature_head',
               displayName: 'Temperature head',
               convert: function (x) { return (x[1] - 1000) / 10; },
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
  if (res['temperature_target'] && typeof res['temperature_target'].value === 'number') {
    data.temperature = round(res['temperature_target'].value, 2);
  } else { return { errors: ['no temperature field in payload'] }; }
  if (res.battery_voltage && typeof res.battery_voltage.value === 'number') { data.battery = round(res.battery_voltage.value, 3); }
  var k;
  for (k in res) {
    if (k === 'temperature_target' || k === 'battery_voltage' || k === 'protocol_version' || k === 'device_id') { continue; }
    if (res[k] && typeof res[k] === 'object' && typeof res[k].value === 'number') { data[camel(k)] = round(res[k].value, 3); }
  }
  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  // fPort 0 carries MAC commands only (LoRaWAN spec): there is no application
  // payload to decode, so this is not a decode failure. See AUTHORING.md.
  if (input && input.fPort === 0) {
    return { data: { make: "decentlab", model: "dl-itst" } };
  }
  if (!input || !input.bytes || input.bytes.length === 0) {
    return { errors: ['empty payload: no application bytes to decode'] };
  }

  var result = decodeUplinkCore(input);
  if (result && result.data) { result.data.make = "decentlab"; result.data.model = "dl-itst"; }
  return result;
}
