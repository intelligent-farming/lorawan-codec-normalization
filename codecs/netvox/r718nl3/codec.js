// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for netvox/r718nl3 (light sensor + 3-phase AC current
// meter with three 150 A clamp-on/split-core current transformers).
//
// Netvox payload decoder ported verbatim from the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/netvox/r718nl3.js, attributed in
// NOTICE), renamed netvoxDecode; the upstream downlink encoder/decoder are
// renamed to inert helpers. That decoder's own output object keeps the vendor's
// capitalised field names (Volt, Current1, Multiplier1, Illuminance, ...)
// untouched; decodeUplinkCore below is the authored normalization layer and is
// the only place the emitted key names are decided.
//
// Multi-CT shape: the meter's three CTs sit on the three supply phases, so each
// phase is a sub-sensor position and its readings ride in the reserved
// `channels` array (see AUTHORING.md "Multi-channel devices") instead of the
// suffixed extras this codec used to emit (`current2`, `current3`,
// `multiplier1`..`multiplier3`). Entries are labelled `phaseA`/`phaseB`/`phaseC`
// after the upstream field's 1-based suffix (Current1 -> phaseA), the same label
// scheme the 3-phase arwin-technology/lrs2m001-4xxx meter uses for this concept
// and the same as the sibling solid-core netvox/r718n3. Per entry:
//   Current<N> (mA)          -> power.current (A, mA / 1000, unchanged rounding)
//   Multiplier<N>            -> multiplier (extra: that CT's configured scale
//                               factor — per-position config belongs in its own
//                               position's entry)
//   Low/HighCurrent<N>Alarm  -> lowCurrentAlarm / highCurrentAlarm (extras, 0/1
//                               exactly as emitted; not carried by this model's
//                               frames, handled for parity with r718n3)
// Whole-device fields stay top-level and are never repeated in an entry: the
// on-board ambient light reading Illuminance -> air.lightIntensity (lux, one
// sensor, not per phase), Volt -> battery (V), Device -> deviceName.
//
// Frame variants (fPort 6, discriminator bytes[2]): 0x01 carries all three CT
// currents plus phase A's raw multiplier byte; 0x02 carries the phase B/C
// multipliers plus the illuminance reading. A frame therefore emits an entry
// only for the phases it mentions, and the 0x02 frame's entries carry only that
// phase's configuration extra.
//
// Sentinel policy: the wire format has no disconnected-CT encoding — a current
// is a plain unsigned 16-bit mA value with no reserved code, and 0 mA is a
// legitimate reading (unloaded circuit), not a sentinel — so no phase is ever
// skipped and every phase a frame mentions is emitted as-is. Frames that carry
// no measurement at all (device info on fPort 6 with bytes[2]==0x00,
// configuration responses on fPort 7) still return an error.

function getCfgCmd(cfgcmd){
  var cfgcmdlist = {
    1:   "ConfigReportReq",
    129: "ConfigReportRsp",
    2:   "ReadConfigReportReq",
    130: "ReadConfigReportRsp"
  };
  return cfgcmdlist[cfgcmd];
}

function getCmdToID(cmdtype){
  if (cmdtype == "ConfigReportReq")
	  return 1;
  else if (cmdtype == "ConfigReportRsp")
	  return 129;
  else if (cmdtype == "ReadConfigReportReq")
	  return 2;
  else if (cmdtype == "ReadConfigReportRsp")
	  return 130;
}

function getDeviceName(dev){
  var deviceName = {
	153: "R718NL3"
  };
  return deviceName[dev];
}

function getDeviceID(devName){
  if (devName == "R718NL3")
	  return 153;
}

function padLeft(str, len) {
    str = '' + str;
    if (str.length >= len) {
        return str;
    } else {
        return padLeft("0" + str, len);
    }
}

function netvoxDecode(input) {
  var data = {};
  switch (input.fPort) {
    case 6:
		if (input.bytes[2] === 0x00)
		{
			data.Device = getDeviceName(input.bytes[1]);
			data.SWver =  input.bytes[3]/10;
			data.HWver =  input.bytes[4];
			data.Datecode = padLeft(input.bytes[5].toString(16), 2) + padLeft(input.bytes[6].toString(16), 2) + padLeft(input.bytes[7].toString(16), 2) + padLeft(input.bytes[8].toString(16), 2);
			
			return {
				data: data,
			};
		}
		
		data.Device = getDeviceName(input.bytes[1]);
		if (input.bytes[3] & 0x80)
		{
			var tmp_v = input.bytes[3] & 0x7F;
			data.Volt = (tmp_v / 10).toString() + '(low battery)';
		}
		else
			data.Volt = input.bytes[3]/10;

		if (input.bytes[2] === 0x01)
		{
			data.Current1 = (input.bytes[4]<<8 | input.bytes[5]);
			data.Current2 = (input.bytes[6]<<8 | input.bytes[7]);
			data.Current3 = (input.bytes[8]<<8 | input.bytes[9]);
			data.Multiplier1 = input.bytes[10];
		}
		else if (input.bytes[2] === 0x02)
		{	
			data.Multiplier2 = input.bytes[4];
			data.Multiplier3 = input.bytes[5];
			data.Illuminance = ((input.bytes[6]<<24) | (input.bytes[7]<<16) | (input.bytes[8]<<8) | input.bytes[9]);
		}
		break;
		
	case 7:
		data.Cmd = getCfgCmd(input.bytes[0]);
		data.Device = getDeviceName(input.bytes[1]);
		if (input.bytes[0] === getCmdToID("ConfigReportRsp"))
		{
			data.Status = (input.bytes[2] === 0x00) ? 'Success' : 'Failure';
		}
		else if (input.bytes[0] === getCmdToID("ReadConfigReportRsp"))
		{
			data.MinTime = (input.bytes[2]<<8 | input.bytes[3]);
			data.MaxTime = (input.bytes[4]<<8 | input.bytes[5]);
			data.CurrentChange = (input.bytes[6]<<8 | input.bytes[7]);
			data.IlluminanceChange = (input.bytes[8]<<8 | input.bytes[9]);
		}
		
		break;	

	default:
      return {
        errors: ['unknown FPort'],
      };
	  
    }
          
	 return {
		data: data,
	};
 }
  
function netvoxEncodeDownlink(input) {
  var ret = [];
  var devid;
  var getCmdID;
	  
  getCmdID = getCmdToID(input.data.Cmd);
  devid = getDeviceID(input.data.Device);

  if (input.data.Cmd == "ConfigReportReq")
  {
	  var mint = input.data.MinTime;
	  var maxt = input.data.MaxTime;
	  var currentChg = input.data.CurrentChange;
	  var illChg = input.data.IlluminanceChange;
	  
	  ret = ret.concat(getCmdID, devid, (mint >> 8), (mint & 0xFF), (maxt >> 8), (maxt & 0xFF), (currentChg >> 8), (currentChg & 0xFF), (illChg >> 8), (illChg & 0xFF), 0x00);
  }
  else if (input.data.Cmd == "ReadConfigReportReq")
  {
	  ret = ret.concat(getCmdID, devid, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00);
  }  
  
  return {
    fPort: 7,
    bytes: ret
  };
}  
  
function netvoxDecodeDownlink(input) {
  var data = {};
  switch (input.fPort) {
    case 7:
		data.Cmd = getCfgCmd(input.bytes[0]);
		data.Device = getDeviceName(input.bytes[1]);
		if (input.bytes[0] === getCmdToID("ConfigReportReq"))
		{
			data.MinTime = (input.bytes[2]<<8 | input.bytes[3]);
			data.MaxTime = (input.bytes[4]<<8 | input.bytes[5]);
			data.CurrentChange = (input.bytes[6]<<8 | input.bytes[7]);
			data.IlluminanceChange = (input.bytes[8]<<8 | input.bytes[9]);
		}

		break;
		
    default:
      return {
        errors: ['invalid FPort'],
      };
  }
  
  return {
		data: data,
	};
}

// ---- normalization layer (authored) ----
// Supply-phase labels for the reserved channels[] entries, indexed by the
// 1-based suffix upstream puts on its per-CT fields (Current1 -> phaseA).
var R718NL3_PHASE_LABELS = ['phaseA', 'phaseB', 'phaseC'];

function round(value, decimals) { var f = Math.pow(10, decimals); return Math.round(value * f) / f; }
function setp(o, path, v) { o[path[0]] = o[path[0]] || {}; if (path.length === 2) { o[path[0]][path[1]] = v; } else { o[path[0]][path[1]] = o[path[0]][path[1]] || {}; o[path[0]][path[1]][path[2]] = v; } }
function decodeUplinkCore(input) {
  var raw = netvoxDecode(input);
  var d = (raw && raw.data) || raw || {};
  if (d.Cmd !== undefined) { return { errors: ['configuration response frame, not a measurement'] }; }
  if (d.SWver !== undefined || d.Datecode !== undefined) { return { errors: ['device information frame, not a measurement'] }; }
  var data = {};
  // One channels entry per supply phase, created on first reference so a frame
  // emits entries only for the phases it actually carries.
  var phases = [null, null, null];
  function phaseEntry(n) {
    if (n < 1 || n > 3) { return null; }
    if (phases[n - 1] === null) { phases[n - 1] = { channel: R718NL3_PHASE_LABELS[n - 1] }; }
    return phases[n - 1];
  }
  var k;
  for (k in d) {
    if (!Object.prototype.hasOwnProperty.call(d, k)) { continue; }
    var val = d[k];
    if (val === null || val === undefined) { continue; }
    var m;
    // Per-phase CT reading: mA -> power.current (A) inside that phase's entry.
    m = /^Current([0-9]+)$/.exec(k);
    if (m && typeof val === 'number') {
      var ce = phaseEntry(parseInt(m[1], 10));
      if (ce !== null) { setp(ce, ['power', 'current'], round(val / 1000, 5)); continue; }
    }
    // Per-phase CT scale factor (configuration) -> that phase's entry.
    m = /^Multiplier([0-9]+)$/.exec(k);
    if (m && typeof val === 'number') {
      var me = phaseEntry(parseInt(m[1], 10));
      if (me !== null) { me.multiplier = val; continue; }
    }
    // Per-phase threshold alarms -> that phase's entry. The optional `t` absorbs
    // the typo field name (`HighCurren2Alarm`) used by sibling Netvox decoders.
    m = /^(Low|High)Current?([0-9]+)Alarm$/.exec(k);
    if (m) {
      var ae = phaseEntry(parseInt(m[2], 10));
      if (ae !== null) { ae[(m[1] === 'Low' ? 'low' : 'high') + 'CurrentAlarm'] = val; continue; }
    }
    // Whole-device fields: one ambient light sensor, one battery rail.
    if (k === 'Illuminance') { if (typeof val === 'number') { setp(data, ['air', 'lightIntensity'], val); } continue; }
    if (k === 'Volt') { if (typeof val === 'number') { data.battery = val; } continue; }
    if (k === 'Device') { data.deviceName = val; continue; }
    // Anything else the ported decoder emits rides as a camelCase extra.
    var ck = k.charAt(0).toLowerCase() + k.slice(1);
    data[ck] = val;
  }
  var entries = [];
  var i;
  for (i = 0; i < 3; i++) {
    if (phases[i] !== null) { entries.push(phases[i]); }
  }
  if (entries.length > 0) { data.channels = entries; }
  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  // fPort 0 carries MAC commands only (LoRaWAN spec): there is no application
  // payload to decode, so this is not a decode failure. See AUTHORING.md.
  if (input && input.fPort === 0) {
    return { data: { make: "netvox", model: "r718nl3" } };
  }
  if (!input || !input.bytes || input.bytes.length === 0) {
    return { errors: ['empty payload: no application bytes to decode'] };
  }

  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "netvox";
    result.data.model = "r718nl3";
  }
  return result;
}
