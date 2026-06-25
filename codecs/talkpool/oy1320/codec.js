// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for talkpool/oy1320 (ultrasonic water meter).
//
// Wire-format decoder ported verbatim from the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/talkpool/oy1320.js, attributed in
// NOTICE), renamed upstreamDecode. decodeUplinkCore maps the
// measurement fields to the vocabulary; other fields -> camelCase extras.

function toHexString(byteArray) {
    return Array.prototype.map.call(byteArray, function (byte) {
        return ('0' + (byte & 0xFF).toString(16)).slice(-2);
    }).join('');
}

function DecodeOy1320Payload(bytes, port) {
    dst    = toHexString(bytes);
    first = dst.substring(4,dst.length);

    if(bytes.length % 6 === 0){
        var OY1320Data = {};
        OY1320Data.MeterReading = parseInt(first.substring(4,8),16);
        OY1320Data.Status       = "0";
        return OY1320Data;
    }
    else if(bytes.length % 9 === 0) {
        var OY1320Data = {};
        OY1320Data.MeterReading = parseInt(first.substring(4,8),16);
        OY1320Data.Status       = dst.substring(8,9);
        return OY1320Data;
    }

    return null
}


function upstreamDecode(input) {
    return {
        "data": DecodeOy1320Payload(input.bytes, input.fPort)
    }
}


// ---- normalization layer (authored) ----
function round(value,decimals){var f=Math.pow(10,decimals);return Math.round(value*f)/f;}
function decodeUplinkCore(input){
  var raw=upstreamDecode(input); var d=(raw&&raw.data)||raw||{};
  var data={};
  var k;
  for(k in d){ if(!Object.prototype.hasOwnProperty.call(d,k))continue; var val=d[k]; if(val===null||val===undefined)continue; if(k==="model"){data.deviceModel=val;continue;} if(k==="make"){data.deviceMake=val;continue;} if(k==="MeterReading"&&typeof val==="number"){data.metering=data.metering||{};data.metering.water={total:val};continue;}
    if(val&&typeof val==="object"&&typeof val.value!=="undefined"&&!Array.isArray(val)){ data[("",k).replace(/_([a-zA-Z])/g,function(m,c){return c.toUpperCase();})]=val.value; continue; }
    data[k.replace(/_([a-zA-Z])/g,function(m,c){return c.toUpperCase();})]=val;
  }
  return {data:data};
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "talkpool";
    result.data.model = "oy1320";
  }
  return result;
}
