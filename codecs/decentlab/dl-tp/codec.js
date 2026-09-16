// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for decentlab/dl-tp (DL-TP Temperature Profile
// Sensor) — a probe string carrying up to 16 temperature sensors at discrete
// levels, plus a whole-device battery voltage.
//
// Decentlab decoder embedded verbatim from the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/decentlab/dl-tp.js, attributed in
// NOTICE), renamed dlDecoder — do not edit it; it is the wire-format source of
// truth (Decentlab protocol v2: version byte, 16-bit big-endian device id,
// 16-bit big-endian sensor-flags bitmap, then per-flagged-sensor blocks of
// 16-bit big-endian words). It emits one raw object per level,
// `temperature_at_level_0` .. `temperature_at_level_15`
// (= (word - 32768) / 100 °C), plus `battery_voltage` (= word / 1000 V).
// Only the normalization below (decodeUplinkCore) is our own work.
//
// Mapping: every level on the string is a sub-sensor position of one physical
// probe, so each connected level becomes one entry in the reserved `channels`
// array (see AUTHORING.md "Multi-channel devices") instead of the suffixed
// extras (`temperatureAtLevel1`…) this codec used to emit. Entries are
// labelled with the vendor's own term plus the wire level index — `level0` ..
// `level15` — and each carries that level's `temperature` (°C). The
// `temperature` vocabulary key therefore appears ONLY inside entries: there is
// no whole-device temperature on this device, and level 0 is just the topmost
// position, not a device-level reading. Whole-device battery voltage is
// reported already in volts and stays top-level as `battery`.
//
// No per-entry `soil.depth` is emitted (nor the soil.* group at all): the DL-TP
// is a bare temperature profile string sold in configurable lengths and level
// counts, and the payload carries level indices only — never the physical
// depth in centimetres, and not necessarily a soil installation.
//
// Sentinel policy: an unconnected or out-of-range level reads word 0x0000,
// which the upstream conversion turns into -327.68 °C (see
// reference/upstream-examples.json example 1: levels 0-10 connected, levels
// 11-15 at -327.68 on an 11-sensor string). That is outside the vocabulary
// bound for `temperature` (>= -273.15 °C), so such a level is skipped and gets
// no channels entry — a shorter string simply yields fewer entries. A frame
// with no connected level at all — including a battery-only frame whose
// sensor-flags bitmap clears the profile block (upstream example 2) — is
// rejected with the error `no temperature field in payload`, as before this
// codec grew `channels[]`; the DL-TP is a single-purpose temperature device and
// a frame carrying no temperature is not a usable measurement.
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

function decodeUplinkCore(input) {
  var res = dlDecoder.decode(input.bytes);
  if (res.error) { return { errors: [res.error] }; }

  // One channels entry per connected level of the probe string; a level reading
  // the disconnected sentinel (-327.68 °C, i.e. below the vocabulary bound for
  // temperature) is skipped rather than reported as junk.
  var channels = [];
  var k, field, value;
  for (k = 0; k < 16; k++) {
    field = res['temperature_at_level_' + k];
    if (!field || typeof field.value !== 'number') { continue; }
    value = round(field.value, 2);
    if (value < -273.15) { continue; }
    channels.push({ channel: 'level' + k, temperature: value });
  }
  if (channels.length === 0) { return { errors: ['no temperature field in payload'] }; }

  var data = {};
  data.channels = channels;
  if (res.battery_voltage && typeof res.battery_voltage.value === 'number') { data.battery = round(res.battery_voltage.value, 3); }
  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  // fPort 0 carries MAC commands only (LoRaWAN spec): there is no application
  // payload to decode, so this is not a decode failure. See AUTHORING.md.
  if (input && input.fPort === 0) {
    return { data: { make: "decentlab", model: "dl-tp" } };
  }
  if (!input || !input.bytes || input.bytes.length === 0) {
    return { errors: ['empty payload: no application bytes to decode'] };
  }

  var result = decodeUplinkCore(input);
  if (result && result.data) { result.data.make = "decentlab"; result.data.model = "dl-tp"; }
  return result;
}
