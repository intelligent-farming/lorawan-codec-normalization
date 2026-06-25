// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for netvox/r718n3 (3-channel AC current meter).
//
// Netvox payload decoder ported verbatim from the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/netvox/r718n3.js, attributed in
// NOTICE), renamed netvoxDecode; the upstream downlink encoder/decoder are
// renamed to inert helpers. decodeUplinkCore maps measurement fields to the
// vocabulary (Vol/Voltage->power.voltage, Current/Current_n/Channel_x mA->
// power.current, Power->power.active, Energy->metering.energy.total, Angle*->
// tilt.*, Illuminance->air.lightIntensity, Temp->air.temperature, Volt->battery)
// and errors on device-info / configuration-response frames.

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
	74: "R718N3"
  };
  return deviceName[dev];
}

function getDeviceID(devName){
  if (devName == "R718N3")
	  return 74;
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
		var map = new Map([
			[0,1],[1,5],[2,10],[3,100]
		]);
		
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
		}
		else if (input.bytes[2] === 0x03)
		{	
			data.Current1 = (input.bytes[4]<<8 | input.bytes[5]);
			data.Current2 = (input.bytes[6]<<8 | input.bytes[7]);
			data.Current3 = (input.bytes[8]<<8 | input.bytes[9]);
			data.Multiplier1 = map.get(input.bytes[10] & 3);
			data.Multiplier2 = map.get(input.bytes[10]>>2 & 3);
			data.Multiplier3 = map.get(input.bytes[10]>>4 & 3);
		}
		else if (input.bytes[2] === 0x04)
		{	
			data.LowCurrent1Alarm = input.bytes[4] & 1;
			data.HighCurrent1Alarm = input.bytes[4]>>1 & 1;
			data.LowCurrent2Alarm = input.bytes[4] >>2 & 1;
			data.HighCurren2Alarm = input.bytes[4]>>3 & 1;
			data.LowCurrent3Alarm = input.bytes[4]>>4 & 1;
			data.HighCurrent3Alarm = input.bytes[4]>>5 & 1;
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
	  
	  ret = ret.concat(getCmdID, devid, (mint >> 8), (mint & 0xFF), (maxt >> 8), (maxt & 0xFF), (currentChg >> 8), (currentChg & 0xFF), 0x00, 0x00, 0x00);
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
function round(value, decimals) { var f = Math.pow(10, decimals); return Math.round(value * f) / f; }
function setp(o, path, v) { o[path[0]] = o[path[0]] || {}; if (path.length === 2) { o[path[0]][path[1]] = v; } else { o[path[0]][path[1]] = o[path[0]][path[1]] || {}; o[path[0]][path[1]][path[2]] = v; } }
function decodeUplinkCore(input) {
  var raw = netvoxDecode(input);
  var d = (raw && raw.data) || raw || {};
  if (d.Cmd !== undefined) { return { errors: ['configuration response frame, not a measurement'] }; }
  if (d.SWver !== undefined || d.Datecode !== undefined) { return { errors: ['device information frame, not a measurement'] }; }
  var data = {};
  var k;
  for (k in d) {
    if (!Object.prototype.hasOwnProperty.call(d, k)) { continue; }
    var val = d[k];
    if (val === null || val === undefined) { continue; }
    if (k === 'Vol' || k === 'Voltage') { if (typeof val === 'number') { setp(data, ['power', 'voltage'], val); } continue; }
    if (k === 'Current') { if (typeof val === 'number') { setp(data, ['power', 'current'], round(val / 1000, 5)); } continue; }
    if (k === 'Power') { if (typeof val === 'number') { setp(data, ['power', 'active'], val); } continue; }
    if (k === 'Energy') { if (typeof val === 'number') { setp(data, ['metering', 'energy', 'total'], val); } continue; }
    if (k === 'Volt') { if (typeof val === 'number') { data.battery = val; } continue; }
    if (k === 'AngleX') { if (typeof val === 'number') { setp(data, ['tilt', 'x'], val); } continue; }
    if (k === 'AngleY') { if (typeof val === 'number') { setp(data, ['tilt', 'y'], val); } continue; }
    if (k === 'AngleZ') { if (typeof val === 'number') { setp(data, ['tilt', 'z'], val); } continue; }
    if (k === 'AngleOfInclination') { if (typeof val === 'number') { setp(data, ['tilt', 'angle'], val); } continue; }
    if (k === 'Illuminance') { if (typeof val === 'number') { setp(data, ['air', 'lightIntensity'], val); } continue; }
    if (k === 'Temp' || k === 'Temperature') { if (typeof val === 'number') { setp(data, ['air', 'temperature'], val); } continue; }
    if (/^Current[0-9]+$/.test(k) && typeof val === 'number') { if (!(data.power && data.power.current !== undefined)) { setp(data, ['power', 'current'], round(val / 1000, 5)); } else { data[k.charAt(0).toLowerCase()+k.slice(1)] = round(val/1000,5); } continue; }
    if (/^Channel_[A-Z]$/.test(k) && typeof val === 'number') { if (!(data.power && data.power.current !== undefined)) { setp(data, ['power', 'current'], round(val / 1000, 5)); } else { data['channel'+k.slice(8)] = round(val/1000,5); } continue; }
    if (k === 'Device') { data.deviceName = val; continue; }
    var ck = k.charAt(0).toLowerCase() + k.slice(1);
    data[ck] = val;
  }
  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "netvox";
    result.data.model = "r718n3";
  }
  return result;
}
