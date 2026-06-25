// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for dragino/lsnpk01 (soil NPK sensor).
//
// Wire-format decoder ported verbatim from the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/dragino/lsnpk01.js, attributed in
// NOTICE). decodeUplinkCore maps N_SOIL/P_SOIL/K_SOIL->soil.n/p/k (ppm), TempC_DS18B20->soil.temperature, Bat->battery; other fields -> camelCase extras.

function upstreamDecode(input) {
  var port = input.fPort;
  var bytes = input.bytes;
  var value = ((bytes[0] << 8) | bytes[1]) & 0x3fff;
  var batV = value / 1000;
  var data = {};
  switch (input.fPort) {
    case 2:
      data.Bat = batV;
      value = (bytes[2] << 8) | bytes[3];
      if (bytes[2] & 0x80) {
        value |= 0xffff0000;
      }

      data.TempC_DS18B20 = (value / 10).toFixed(2); //DS18B20,temperature

      value = (bytes[4] << 8) | bytes[5];
      data.N_SOIL = value; //Unit:mg/kg

      value = (bytes[6] << 8) | bytes[7];
      data.P_SOIL = value; //Unit:mg/kg

      value = (bytes[8] << 8) | bytes[9];
      data.K_SOIL = value; //Unit:mg/kg

      data.Message_type = bytes[10] >> 4;
      data.Interrupt_flag = bytes[10] & 0x0f;

      return {
        data: data,
      };
    default:
      return {
        errors: ['unknown FPort'],
      };
  }
}

// ---- normalization layer (authored) ----
function decodeUplinkCore(input){
  var raw=upstreamDecode(input); var d=(raw&&raw.data)||raw||{};
  if(d.error&&typeof d.error==="string"&&!Object.keys(d).some(function(k){return k!=="error"&&k!=="raw"&&k!=="port";})){return {errors:[d.error]};}
  var data={};
  var k;
  for(k in d){ if(!Object.prototype.hasOwnProperty.call(d,k))continue; var val=d[k]; if(val===null||val===undefined||val==="")continue; if(k==="N_SOIL"&&typeof val==="number"){data.soil=data.soil||{};data.soil.n=val;continue;} if(k==="P_SOIL"&&typeof val==="number"){data.soil=data.soil||{};data.soil.p=val;continue;} if(k==="K_SOIL"&&typeof val==="number"){data.soil=data.soil||{};data.soil.k=val;continue;} if(k==="TempC_DS18B20"){var t=parseFloat(val);if(!isNaN(t)){data.soil=data.soil||{};data.soil.temperature=t;}continue;} if(k==="Bat"||k==="BatV"){if(typeof val==="number")data.battery=val;continue;}
    data[({},k.charAt(0).toLowerCase()+k.slice(1)).replace(/_([a-zA-Z])/g,function(m,c){return c.toUpperCase();})]=val;
  }
  return {data:data};
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "dragino";
    result.data.model = "lsnpk01";
  }
  return result;
}
