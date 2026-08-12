// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for ELV BM-TRX1 (LoRIS modular experimental
// platform for LoRaWAN).
//
// Ported from the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/elv/elv-bm-trx1.js, "ELV modular
// system Payload-Parser" V1.10.1, attributed in NOTICE). The upstream
// Decoder() wire walk (port 10, 5-byte header, then a TLV stream keyed by a
// datatype byte) is reproduced faithfully here; only the OUTPUT is renormalized
// to the shared vocabulary.
//
// Renormalization notes (deliberate divergence from upstream's raw output):
//   * Upstream emits temperature / humidity / brightness / pressure as STRINGS
//     (toFixed/String); the vocabulary requires numbers, so we parse to numbers
//     with the sensor's real resolution.
//   * Header "Supply_Voltage" is the device supply rail in millivolts; the
//     vocabulary `battery` is volts, so it is divided by 1000.
//   * The TLV "Concentration" (0x08) datatype is the ELV CO2 module reading in
//     ppm -> air.co2.
//   * Sensor special values (Unknown / Overflow / Underflow / SensorError /
//     CalibrationError / reserved) are NOT vocabulary numbers; they are dropped
//     from the normalized fields and surfaced as camelCase status extras.
//   * Non-climate datatypes upstream decodes (binary I/O, position, time,
//     distance, V/I/P, angle, wind, rain, 6-axis, window, UV, irradiance) are
//     decoded into camelCase extras so no device data is silently lost.
//
// Multi-position output (`channels[]`, see AUTHORING.md "Multi-channel
// devices"). This modular platform carries TWO independent positional banks and
// both ride in the one reserved `channels` array, under DISTINCT label
// namespaces: the four digital inputs of the binary-input datatype (0x00) are
// `input0` ... `input3`, and the four measurement channels of the
// Voltage+Current+Power datatype (0x0d) are `channel0` ... `channel3`. They are
// NOT the same four terminals (see "Label namespace" below), so an uplink
// carrying both records emits up to eight entries with no label clash. Entry
// order is the two banks in wire order: the reported inputs in Input_1..Input_4
// order, then the reported V/I/P channels in bitfield-bit order.
//
// Bank 1 — digital inputs (0x00). The four digital inputs are sub-sensor
// positions of one device all carrying the same quantity — a dry-contact state —
// so each rides in the reserved `channels` array rather than in the
// suffixed `input1` ... `input4` extras this codec used to emit: one entry
// per input, each carrying the `action.contactState` vocabulary key. Labels are
// the vendor's own term plus a zero-based index — `input0` ... `input3`, ELV
// calling them Input_1..Input_4; the labels are zero-based while ELV numbers
// from 1, so `input0` is Input_1 (bitfield bits 0/1). The state VALUE changes
// with the shape: upstream's (and this codec's previous) 'Active' / 'Inactive'
// strings are not vocabulary values, so an active input is now reported as
// contactState 'closed' and an inactive one as 'open' — the same mapping the
// other dry-contact banks in this repo use (netvox/r831d, atim/acw-dind160).
// This does not disturb category membership: the declared categories here are
// air-quality, climate, light, motion and weather-station, none of which lists
// `action.contactState` in its requires/atLeastOne set, and none of which was
// ever satisfied by the old `input1..4` extras (they are extras, invisible to
// membership). Adding `action.contactState` inside entries only widens what this
// device provides. No leaf is emitted both inside an entry and at the top level:
// the top-level `action` object carries only `action.motion` (0x0c), and each
// entry's `action` is its own object.
//
// Bank 2 — Voltage + Current + Power measurement channels (0x0d). This datatype
// carries a channel bitfield byte followed by six bytes (V, I, P) for every
// channel whose bit is set: a genuine four-position bank reporting the same
// three quantities at each position. It used to be written out as the suffixed
// keys `voltage`/`voltage2..4`, `current`/`current2..4`, `power`/`power2..4` via
// a putChannel() helper (now deleted — nothing else used it); each position is
// now one entry instead:
//   channel<n>.power.voltage  <- 16-bit unsigned x 0.001            (V)
//   channel<n>.power.current  <- 16-bit SIGNED   x 0.001            (A)
//   channel<n>.power.active   <- 14-bit base x its 2-bit resolution (W)
// The numbers are byte-identical to what the suffixed keys carried — same
// x 0.001 scaling rounded to 3 dp for voltage and current, same
// 0.001/0.01/0.1/1 power-resolution table rounded to 3 dp — only their names
// changed. The move also settles a pre-existing SHAPE BUG of the suffixed form:
// channel 0's power was written to a bare top-level `power` NUMBER, but the
// vocabulary defines `power` as an object GROUP (power.voltage / power.current /
// power.active / power.apparent / power.factor / power.frequency), so any real
// 0x0d uplink failed validate(). No vector exercised 0x0d, so CI never saw it —
// two vectors now do.
//
// Units: power.voltage (RMS volts), power.current (RMS amps) and power.active
// (active watts) are the vocabulary's home for a V/I/P triple, and no conversion
// beyond the wire scaling above is needed — the raw fields are millivolts,
// milliamps and watts-at-a-selectable-resolution, which land on V, A and W
// directly. The vocabulary describes the `power` group as single-phase AC; the
// unsigned voltage field here tops out at 65.535 V, so this is a low-voltage/DC
// measurement module rather than a mains meter, but the members are the same
// physical quantities in the same units and no other group models them.
//
// Signed current: the vocabulary bounds power.current at `minimum: 0` (RMS
// amps), while this record's current field is a SIGNED 16-bit value, so a
// reverse-flow reading is negative. A negative reading is therefore NOT forced
// into power.current — it is kept as that entry's camelCase extra
// `signedCurrentA` (amps, sign preserved) and the entry carries no power.current
// at all, the same "don't force a possibly-negative reading into a non-negative
// key" policy decentlab/dl-alb uses for reflected radiation. A non-negative
// reading always goes to power.current. The voltage (unsigned) and power
// (14-bit magnitude) fields can never go negative, so they always map.
//
// Label namespace — why `channel0..3` and not the existing `input0..3`. These
// are a DIFFERENT set of terminals from the digital inputs, so they get their
// own labels; if they were the same four terminals, one terminal would deserve
// one label and this bank would reuse `input0..3`. The wire format is what
// settles it: 0x00 and 0x0d are independent TLV records of the shared "ELV
// modular system Payload-Parser" (this device is the LoRIS base transceiver, so
// its datatype stream is the union of what every application module of the
// modular system can send); they encode presence differently (0x00 spends two
// bits per position — enable + state — inside one byte, while 0x0d spends one
// bit per position in a bitfield byte and then six data bytes per present
// position); they can both appear in one payload; and no field of either record
// references the other. Nothing in the payload lets channel 0 be asserted to be
// Input_1, and a dry-contact input and a V/I/P measurement channel are not the
// same hardware. Upstream gives the 0x0d positions no name beyond their index
// (Voltage/Voltage2..4, iterated over a variable it calls `bitfield`), so the
// label uses the datatype's own term for them — a measurement channel —
// zero-based to match the `input0`-style banks: `channel0` is bitfield bit 0,
// i.e. upstream's `Voltage`/`Current`/`Power`, and `channel3` is bit 3, i.e.
// `Voltage4`/`Current4`/`Power4`. Should ELV documentation later show that these
// four channels ARE the four digital-input terminals, the fix is to merge the
// banks onto the `input0..3` labels — one terminal, one channel label.
//
// Category membership is unaffected by this bank: the declared categories
// (air-quality, climate, light, motion, weather-station) list no `power.*` key
// in their requires/atLeastOne sets, and the suffixed keys this bank used to
// emit were extras, invisible to membership either way. Worth a reviewer's note
// though: with power.voltage / power.current / power.active now reaching
// `provides` through the entries, this device does satisfy the `power-meter`
// category's atLeastOne set. `categories` is deliberately left untouched here —
// declaring it is a separate category decision, not part of this conversion.
//
// Binary OUTPUTS stay TOP-LEVEL extras — the standard policy on actuator state,
// mirroring netvox/r831d's `relay1` / `relay2` / `relay3`. The binary-output
// datatype (0x01) keeps emitting `output1` ... `output4` ('Active' / 'Inactive',
// unchanged) and is NOT converted to `channels[]` entries: an output is actuator
// state the network server commanded, not a measured sub-sensor reading, and
// AUTHORING explicitly allows naming an extra for something that is not a
// measured position. Mixing the four outputs into the same `channels` array as
// the four inputs would also make an output indistinguishable from an input to a
// downstream flattener that treats every entry as telemetry. This is a policy
// call on outputs, not a settled convention: a reviewer may later want an
// output-position policy of its own (a separate reserved container, or an
// `outputs[]`-style extra) — which would supersede these four suffixed extras.
// (The sibling elv/elv-lw-oc8 is a deliberate, documented exception to this
// policy: there the output states are the device's entire reading, so they do
// become entries. See that codec's header.)
//
// `tiltArea0` / `tiltArea1` / `tiltArea2` are deliberately NOT channel entries
// and are left exactly as they are. They are not sub-sensor positions: the
// acceleration datatype (0x0c) reports ONE tilt measurement — the single
// `tiltAngle` — plus three boolean flags saying which of the device's configured
// tilt-angle areas (histogram bins/zones over that one angle) the device
// currently occupies. Three views of one reading are not three positions
// carrying the same quantity, so turning them into entries would invent
// positions the hardware does not have. Same for the 6-axis flags (`accX` ...
// `gyrZ`), which are per-axis enable/trigger bits, not per-axis measurements.
//
// Sentinel policy: BOTH positional banks carry their own per-position "present"
// encoding, and this codec honors both.
//   * Digital inputs (0x00): each input occupies two bits of the payload byte —
//     an enabled/configured bit (0x02, 0x08, 0x20, 0x80) and a state bit (0x01,
//     0x04, 0x10, 0x40) — and a position whose enabled bit is clear is NOT
//     reported by the device: it is skipped, exactly as upstream emits no
//     Input_n key for it, so a disabled input yields no entry rather than a
//     fabricated 'open'. There is no other sentinel: an enabled input's state
//     bit is always a valid open/closed state, and the record carries no fault
//     code.
//   * V/I/P channels (0x0d): the record's leading bitfield byte has one bit per
//     channel and the six V/I/P bytes exist only for a set bit, so a channel
//     whose bit is clear is not reported at all and yields no entry — again
//     exactly what upstream does (it writes no Voltage<n>/Current<n>/Power<n>
//     key for it). Inside a reported channel there is NO sentinel or fault code:
//     all three fields are plain scaled integers and 0 V / 0 A / 0 W is a
//     legitimate reading (an idle load), so a reported channel is never skipped
//     for its values. The one value-dependent behavior is the signed-current
//     policy above, and it drops only power.current — the entry still exists,
//     carrying power.voltage, power.active and `signedCurrentA`.
// The rest of the device's readings use the special values documented above
// (Unknown / Overflow / Underflow / SensorError / CalibrationError), which are
// whole-sensor statuses, not positions. `channels` is built lazily and OMITTED
// entirely when an uplink carries neither a 0x00 record with an enabled input
// nor a 0x0d record with a selected channel — most payloads from this modular
// platform carry only climate modules. Both banks are held in per-position slots
// rather than pushed as they are parsed, so a repeated 0x00 or 0x0d record
// overwrites its position (upstream's key assignment does the same) instead of
// emitting a duplicate label.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

var TX_REASON = [
  'Timer_Event', // 0x00
  'User_Button_Event', // 0x01
  'App_Event', // 0x02
  'FUOTA_Event', // 0x03
  'Cyclic_Event', // 0x04
  'Timeout_Event' // 0x05
];

// 16-bit signed temperature (0.1 resolution) with the device's special codes.
// Returns { value: <number> } for a real reading or { status: <string> } for a
// special code.
function decodeTemp16(raw) {
  if (raw === 0x8000) return { status: 'Unknown' };
  if (raw === 0x8001) return { status: 'Overflow' };
  if (raw === 0x8002) return { status: 'Underflow' };
  var v = raw;
  if (v > 0x7fff) v -= 0x10000;
  return { value: round(v * 0.1, 1) };
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;
  var port = input.fPort;

  if (port !== 10) {
    return { errors: ['Wrong Port Number'] };
  }
  if (bytes.length < 5) {
    return { errors: ['Not enough data'] };
  }

  var data = {};
  var air = {};
  var motion = {};
  var warnings = [];

  // The TH module (0x03) and a standalone temperature probe (0x02) can both
  // appear in one payload. Air temperature comes from the TH module when
  // present; a lone 0x02 probe then maps to air.temperature, otherwise it is
  // preserved as the camelCase extra `temperatureSensor` so neither reading is
  // lost to the single-scalar vocabulary key.
  var thTemp; // { value } | { status } from a 0x03 datatype
  var probeTemps = []; // ordered { value } | { status } from each 0x02 datatype

  // Digital-input positions: contactState per input, or undefined while the
  // input has not been reported as enabled by a 0x00 datatype. Slot i is ELV's
  // Input_(i+1) and becomes the `input<i>` channels entry. Held in slots (rather
  // than pushed) so a repeated 0x00 record overwrites the position, as upstream's
  // key assignment does, instead of duplicating its label.
  var inputStates = [undefined, undefined, undefined, undefined];

  // V/I/P positions: per channel a partially-built measurement
  // ({ power: {...} } plus the optional signedCurrentA extra), or undefined
  // while the 0x0d bitfield has not selected that channel. Slot i is bitfield
  // bit i (upstream's Voltage/Voltage(i+1)) and becomes the `channel<i>`
  // channels entry. Slots again, so a repeated 0x0d record overwrites the
  // position instead of duplicating its label.
  var vipStates = [undefined, undefined, undefined, undefined];

  // Header -------------------------------------------------------------------
  if (bytes[0] === 0xff) {
    data.txReason = 'UNDEFINED_EVENT';
  } else if (bytes[0] >= TX_REASON.length) {
    data.txReason = 'UNKNOWN_EVENT --> Please update your payload parser';
  } else {
    data.txReason = TX_REASON[bytes[0]];
  }

  // Supply rail in millivolts -> battery volts.
  var supplymV = (bytes[3] << 8) | bytes[4];
  data.battery = round(supplymV / 1000, 3);

  // Application TLV stream ---------------------------------------------------
  var parserError = false;
  var index = 5;

  if (bytes.length >= 6) {
    do {
      var type = bytes[index];

      if (type === 0x00) {
        // Binary input bitfield: per input an enabled bit and a state bit. Only
        // enabled inputs are reported (see the sentinel policy in the header);
        // each becomes a channels[] entry with action.contactState.
        index++;
        var bi = bytes[index];
        if (bi & 0x02) inputStates[0] = bi & 0x01 ? 'closed' : 'open';
        if (bi & 0x08) inputStates[1] = bi & 0x04 ? 'closed' : 'open';
        if (bi & 0x20) inputStates[2] = bi & 0x10 ? 'closed' : 'open';
        if (bi & 0x80) inputStates[3] = bi & 0x40 ? 'closed' : 'open';
      } else if (type === 0x01) {
        // Binary output bitfield
        index++;
        var bo = bytes[index];
        if (bo & 0x02) data.output1 = bo & 0x01 ? 'Active' : 'Inactive';
        if (bo & 0x08) data.output2 = bo & 0x04 ? 'Active' : 'Inactive';
        if (bo & 0x20) data.output3 = bo & 0x10 ? 'Active' : 'Inactive';
        if (bo & 0x80) data.output4 = bo & 0x40 ? 'Active' : 'Inactive';
      } else if (type === 0x02) {
        // Temperature (standalone probe, no humidity). Deferred: resolved
        // after the full stream so the TH module can claim air.temperature.
        index++;
        var traw = bytes[index] * 256;
        index++;
        traw += bytes[index];
        probeTemps.push(decodeTemp16(traw));
      } else if (type === 0x03) {
        // Temperature + relative humidity (the climate TH module)
        index++;
        var thraw = bytes[index] * 256;
        index++;
        thraw += bytes[index];
        thTemp = decodeTemp16(thraw);

        index++;
        var hum = bytes[index];
        if (hum === 0xff) data.humidityStatus = 'Unknown';
        else if (hum === 0xfe) data.humidityStatus = 'Overflow';
        else if (hum === 0xfd) data.humidityStatus = 'Underflow';
        else air.relativeHumidity = hum;
      } else if (type === 0x04) {
        // Positioning data (TTN Mapper conform)
        var lat = bytes[++index] | (bytes[++index] << 8) | (bytes[++index] << 16) | (bytes[++index] << 24);
        data.position = { latitude: round(lat / 1000000, 6) };
        var lon = bytes[++index] | (bytes[++index] << 8) | (bytes[++index] << 16) | (bytes[++index] << 24);
        data.position.longitude = round(lon / 1000000, 6);
        var alt = bytes[++index] | (bytes[++index] << 8) | (bytes[++index] << 16) | (bytes[++index] << 24);
        data.altitude = round(alt / 10000, 2);
        var hd = String(bytes[++index]) + '.' + lpad2(bytes[++index] * 4);
        data.hdop = round(parseFloat(hd), 2);
      } else if (type === 0x05) {
        // Time value (encoded units in top 2 bits)
        index++;
        var tv = bytes[index] * 256;
        index++;
        tv += bytes[index];
        if (tv === 0x3fff) {
          data.timeValueStatus = 'Unknown';
        } else if (tv === 0x3ffe) {
          data.timeValueStatus = 'Overflow';
        } else {
          var unit = tv >> 14;
          var base = tv & 0x3fff;
          if (unit === 0) data.timeValueSeconds = base;
          else if (unit === 1) data.timeValueSeconds = base * 60;
          else if (unit === 2) data.timeValueSeconds = base * 3600;
          else data.timeValueSeconds = base * 86400;
        }
      } else if (type === 0x06) {
        // Distance
        index++;
        var dist = bytes[index] * 256;
        index++;
        dist += bytes[index];
        data.distance = dist;
      } else if (type === 0x07) {
        // Battery indicator (categorical, not a voltage)
        index++;
        var bind = bytes[index];
        if (bind === 0x01) data.batteryIndicator = 'Battery_LOW';
        else if (bind === 0x02) data.batteryIndicator = 'Battery_OKAY';
        else if (bind === 0x03) data.batteryIndicator = 'Battery_HIGH';
        else data.batteryIndicator = 'Invalid_Value!';
      } else if (type === 0x08) {
        // Concentration (ELV CO2 module) -> ppm
        index++;
        var craw = bytes[index] * 256;
        index++;
        craw += bytes[index];
        if (craw === 0x7fff) data.co2Status = 'Unknown';
        else if (craw === 0x7ffe) data.co2Status = 'Overflow';
        else if (craw === 0x7ffd) data.co2Status = 'SensorError';
        else if (craw === 0x7ffc) data.co2Status = 'CalibrationError';
        else if (craw >= 0x7ff0 && craw <= 0x7ffb) data.co2Status = 'reserved';
        else {
          var cval = craw;
          if (cval > 0x7fff) cval -= 0x10000;
          air.co2 = cval;
        }
      } else if (type === 0x0b) {
        // Brightness [lx]
        index++;
        var braw = bytes[index] * 65536;
        index++;
        braw += bytes[index] * 256;
        index++;
        braw += bytes[index];
        if (braw === 0xffffff) data.lightStatus = 'Overflow';
        else air.lightIntensity = round(braw * 0.01, 2);
      } else if (type === 0x0c) {
        // Acceleration / motion
        index++;
        var acc = bytes[index];
        motion.detected = !!(acc & 0x80);
        data.tiltArea2 = !!(acc & 0x08);
        data.tiltArea1 = !!(acc & 0x04);
        data.tiltArea0 = !!(acc & 0x02);
        data.acceleration = !!(acc & 0x01);
        index++;
        data.tiltAngle = bytes[index];
      } else if (type === 0x0d) {
        // Voltage + Current + Power per measurement channel, the channels
        // selected by a leading bitfield (one bit each; an unselected channel
        // carries no bytes and is not reported — see the sentinel policy in the
        // header). Each selected channel fills its `channel<n>` slot and becomes
        // a channels[] entry carrying power.voltage / power.current /
        // power.active.
        index++;
        var bf = bytes[index];
        for (var ch = 0; ch < 4; ch++) {
          if (bf & (1 << ch)) {
            var vipPower = {};
            var vipEntry = { power: vipPower };

            index++;
            var vraw = bytes[index] * 256;
            index++;
            vraw += bytes[index];
            vipPower.voltage = round(vraw * 0.001, 3);

            index++;
            var iraw = bytes[index] * 256;
            index++;
            iraw += bytes[index];
            if (iraw > 0x7fff) iraw -= 0x10000;
            var ival = round(iraw * 0.001, 3);
            // Reverse flow: the vocabulary's power.current is non-negative RMS
            // amps, so a negative reading stays a signed extra instead.
            if (ival < 0) vipEntry.signedCurrentA = ival;
            else vipPower.current = ival;

            index++;
            var praw = bytes[index] * 256;
            index++;
            praw += bytes[index];
            var pscale = praw >> 14;
            var pbase = praw & 0x3fff;
            var pval;
            if (pscale === 1) pval = pbase * 0.01;
            else if (pscale === 2) pval = pbase * 0.1;
            else if (pscale === 3) pval = pbase * 1;
            else pval = pbase * 0.001;
            vipPower.active = round(pval, 3);

            vipStates[ch] = vipEntry;
          }
        }
      } else if (type === 0x0e) {
        // Pressure (24-bit, 0.1 hPa) -> hPa
        index++;
        var praw2 = bytes[index] * 65536;
        index++;
        praw2 += bytes[index] * 256;
        index++;
        praw2 += bytes[index];
        air.pressure = round(praw2 / 10, 1);
      } else if (type === 0x0f) {
        // Error bitfield
        index++;
        var ebits = bytes[index];
        if (ebits) {
          var es = '';
          for (var eb = 0; eb < 8; eb++) {
            if (ebits & (1 << eb)) es += 'Bit' + eb + ' ';
          }
          data.error = es;
        } else {
          data.error = 'None ';
        }
      } else if (type === 0x10) {
        // Absolute angle (2.5 deg resolution)
        index++;
        if (bytes[index] === 0xff) data.absoluteAngleStatus = 'Unknown';
        else data.absoluteAngle = round(bytes[index] * 2.5, 1);
      } else if (type === 0x11) {
        // Speed
        index++;
        var sraw = bytes[index] * 256;
        index++;
        sraw += bytes[index];
        data.windDetection = sraw & 0x0800 ? 1 : 0;
        var sval = sraw & 0x07ff;
        if (sval === 0x7ff) data.windSpeedStatus = 'Unknown';
        else if (sval === 0x7fe) data.windSpeedStatus = 'Overflow';
        else data.windSpeedKmh = round(sval * 0.1, 1);
      } else if (type === 0x12) {
        // Wind (variation angle + speed + absolute angle)
        index++;
        var wraw = bytes[index] * 256;
        index++;
        wraw += bytes[index];
        var varRange = (wraw & 0xf000) / 4096;
        if (varRange === 0xf) data.variationAngleStatus = 'Unknown';
        else if (varRange === 0xe) data.variationAngleStatus = 'Overflow';
        else data.variationAngle = round(11.25 * varRange, 2);
        data.windDetection = wraw & 0x0800 ? 1 : 0;
        var wval = wraw & 0x07ff;
        if (wval === 0x7ff) data.windSpeedStatus = 'Unknown';
        else if (wval === 0x7fe) data.windSpeedStatus = 'Overflow';
        else data.windSpeedKmh = round(wval * 0.1, 1);
        index++;
        if (bytes[index] === 0xff) data.absoluteAngleStatus = 'Unknown';
        else data.absoluteAngle = round(bytes[index] * 2.5, 1);
      } else if (type === 0x13) {
        // Rainfall
        index++;
        var rraw = bytes[index] * 256;
        index++;
        rraw += bytes[index];
        data.rainDetection = rraw & 0x8000 ? 1 : 0;
        data.rainCounterOverflow = rraw & 0x4000 ? 1 : 0;
        var rval = rraw & 0x3fff;
        if (rval === 0x3fff) data.rainAmountStatus = 'Unknown';
        else data.rainAmount = round(rval * 0.1, 1);
      } else if (type === 0x14) {
        // 6-axis sensor flags
        index++;
        var ax = bytes[index];
        data.accX = !!(ax & 0x01);
        data.accY = !!(ax & 0x02);
        data.accZ = !!(ax & 0x04);
        data.gyrX = !!(ax & 0x08);
        data.gyrY = !!(ax & 0x10);
        data.gyrZ = !!(ax & 0x20);
      } else if (type === 0x15) {
        // Window state
        index++;
        var ws = bytes[index];
        if (ws < 100) data.windowState = ws;
        else if (ws === 255) data.windowState = 'Tilted';
        else data.windowState = 'Undefined';
      } else if (type === 0x16) {
        index++;
        data.situation = bytes[index];
      } else if (type === 0x17) {
        // UV index
        data.uvIndex = bytes[++index];
      } else if (type === 0x18) {
        // UV-A
        data.uvA = round(((bytes[++index] << 24) | (bytes[++index] << 16) | (bytes[++index] << 8) | bytes[++index]) / 1000000, 6);
      } else if (type === 0x19) {
        // UV-B
        data.uvB = round(((bytes[++index] << 24) | (bytes[++index] << 16) | (bytes[++index] << 8) | bytes[++index]) / 1000000, 6);
      } else if (type === 0x1a) {
        // UV-C
        data.uvC = round(((bytes[++index] << 24) | (bytes[++index] << 16) | (bytes[++index] << 8) | bytes[++index]) / 1000000, 6);
      } else if (type === 0x1b) {
        // Irradiance
        var irr = (bytes[++index] << 8) | bytes[++index];
        if (irr === 0xffff) irr = 0;
        data.irradiance = round(irr / 10, 1);
      } else {
        parserError = true;
      }
    } while (++index < bytes.length && !parserError);
  }

  if (parserError) {
    return { errors: ['Data Type Failure --> Please update your payload parser'] };
  }

  // Resolve temperatures. The TH module (0x03) owns air.temperature when
  // present; otherwise the first standalone probe does. Any probes that do not
  // claim air.temperature are preserved as camelCase extras: a lone probe is
  // `temperatureSensor` (upstream's naming), multiples are temperatureT1..Tn.
  if (thTemp !== undefined) {
    if (thTemp.value !== undefined) air.temperature = thTemp.value;
    else data.temperatureStatus = thTemp.status;
  }
  // Index of the probe (if any) that is promoted to air.temperature.
  var promoted = thTemp === undefined && probeTemps.length > 0 ? 0 : -1;
  for (var pi = 0; pi < probeTemps.length; pi++) {
    var pt = probeTemps[pi];
    if (pi === promoted) {
      if (pt.value !== undefined) air.temperature = pt.value;
      else data.temperatureStatus = pt.status;
      continue;
    }
    var extraKey = probeTemps.length === 1 ? 'temperatureSensor' : 'temperatureT' + (pi + 1);
    if (pt.value !== undefined) data[extraKey] = pt.value;
    else data[extraKey + 'Status'] = pt.status;
  }

  if (motion.detected !== undefined) {
    data.action = { motion: motion };
  }

  // One channels[] entry per REPORTED position of either bank: first the
  // digital inputs in Input_1..Input_4 order (`input0`..`input3`), then the
  // V/I/P measurement channels in bitfield-bit order (`channel0`..`channel3`).
  // Attached only when this uplink reported at least one position.
  var channels = [];
  var ci;
  for (ci = 0; ci < inputStates.length; ci++) {
    if (inputStates[ci] !== undefined) {
      channels.push({ channel: 'input' + ci, action: { contactState: inputStates[ci] } });
    }
  }
  for (ci = 0; ci < vipStates.length; ci++) {
    if (vipStates[ci] !== undefined) {
      var vip = vipStates[ci];
      var vipOut = { channel: 'channel' + ci, power: vip.power };
      if (vip.signedCurrentA !== undefined) vipOut.signedCurrentA = vip.signedCurrentA;
      channels.push(vipOut);
    }
  }
  if (channels.length > 0) {
    data.channels = channels;
  }

  for (var k in air) {
    if (air.hasOwnProperty(k)) {
      data.air = air;
      break;
    }
  }

  if (warnings.length) return { data: data, warnings: warnings };
  return { data: data };
}

function lpad2(n) {
  var s = String(n);
  return s.length >= 2 ? s : '0' + s;
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "elv";
    result.data.model = "elv-bm-trx1";
  }
  return result;
}
