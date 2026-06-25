// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for mclimate/16aspm (smart power meter / relay).
//
// Wire-format decoder ported verbatim from the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/mclimate/16aspm.js, attributed in
// NOTICE), renamed upstreamDecode. decodeUplinkCore maps the
// measurement fields to the vocabulary; other fields -> camelCase extras.

function upstreamDecode(input) {
    try {
        var bytes = input.bytes;
        var data = {};

        function handleKeepalive(bytes, data) {
            data.internalTemperature = bytes[1];

        // Energy data
        var energy = (bytes[2] << 24) | (bytes[3] << 16) | (bytes[4] << 8) | bytes[5];
        data.energy_kWh = energy / 1000;

        // Power data
        var power = (bytes[6] << 8) | bytes[7];
        data.power_W = power;

        // AC voltage
        data.acVoltage_V = bytes[8];

        // AC current data
        var acCurrent = (bytes[9] << 8) | bytes[10];
        data.acCurrent_mA = acCurrent;
        
        // Relay state
        data.relayState = bytes[11] === 0x01 ? "ON" : "OFF";
            return data;
        }

        function handleResponse(bytes, data){
            var commands = bytes.map(function(byte){
                return ("0" + byte.toString(16)).substr(-2); 
            });
            commands = commands.slice(0,-12);
            var command_len = 0;
        
            commands.map(function (command, i) {
                switch (command) {
                    case '04':
                        {
                            command_len = 2;
                            var hardwareVersion = commands[i + 1];
                            var softwareVersion = commands[i + 2];
                            data.deviceVersions = { hardware: Number(hardwareVersion), software: Number(softwareVersion) };
                        }
                    break;
                    case '12':
                        {
                            command_len = 1;
                            data.keepAliveTime = parseInt(commands[i + 1], 16);
                        }
                    break;
                    case '19':
                        {
                            command_len = 1;
                            var commandResponse = parseInt(commands[i + 1], 16);
                            var periodInMinutes = commandResponse * 5 / 60;
                            data.joinRetryPeriod =  periodInMinutes;
                        }
                    break;
                    case '1b':
                        {
                            command_len = 1;
                            data.uplinkType = parseInt(commands[i + 1], 16) ;
                        }
                    break;
                    case '1d':
                        {
                            command_len = 2;
                            var wdpC = commands[i + 1] == '00' ? false : parseInt(commands[i + 1], 16);
                            var wdpUc = commands[i + 2] == '00' ? false : parseInt(commands[i + 2], 16);
                            data.watchDogParams= { wdpC: wdpC, wdpUc: wdpUc } ;
                        }
                    break;
                    case '1f':
                        {
                            command_len = 1;
                            data.overheatingThreshold = parseInt(commands[i + 1], 16);
                        }
                    break;
                    case '21':
                        {
                            command_len = 2;
                            data.overvoltageThreshold = (parseInt(commands[i + 1], 16) << 8) | parseInt(commands[i + 2], 16) ;
                        }
                    break;
                    case '23':
                        {
                            command_len = 1;
                            data.overcurrentThreshold = parseInt(commands[i + 1], 16) ;
                        }
                    break;
                    case '25':
                        {
                            command_len = 2;
                            data.overpowerThreshold = (parseInt(commands[i + 1], 16) << 8) | parseInt(commands[i + 2], 16) ;
                        }
                    break;
                    case '5a':
                        {
                            command_len = 1;
                            data.afterOverheatingProtectionRecovery = parseInt(commands[i + 1], 16)
                        }
                    break;
                    case '5c':
                        {
                            command_len = 1;
                            data.ledIndicationMode = parseInt(commands[i + 1], 16)
                        }
                    break;
                    case '5d':
                        {
                            command_len = 1;
                            data.manualChangeRelayState = parseInt(commands[i + 1], 16) === 0x01
                        }
                    break;
                    case '5f':
                        {
                            command_len = 1;
                            data.relayRecoveryState = parseInt(commands[i + 1], 16) ;
                        }
                    break;
                    case '60':
                        {
                            command_len = 2;
                            data.overheatingEvents = { events: parseInt(commands[i + 1], 16), temperature: parseInt(commands[i + 2], 16) } ;
                        }
                    break;
                    case '61':
                        {
                            command_len = 3;
                            data.overvoltageEvents = { events: parseInt(commands[i + 1], 16), voltage: (parseInt(commands[i + 2], 16) << 8) | parseInt(commands[i + 3], 16) };
                        }
                    break;
                    case '62':
                        {
                            command_len = 3;
                            data.overcurrentEvents = { events: parseInt(commands[i + 1], 16), current: (parseInt(commands[i + 2], 16) << 8) | parseInt(commands[i + 3], 16) }
                        }
                    break;
                    case '63':
                        {
                            command_len = 3;
                            data.overpowerEvents = { events: parseInt(commands[i + 1], 16), power: (parseInt(commands[i + 2], 16) << 8) | parseInt(commands[i + 3], 16) };
                        }
                    break;
                    case '70':
                        {
                            command_len = 2;
                            data.overheatingRecoveryTime = (parseInt(commands[i + 1], 16) << 8) | parseInt(commands[i + 2], 16) ;
                        }
                    break;
                    case '71':
                        {
                            command_len = 2;
                            data.overvoltageRecoveryTime = (parseInt(commands[i + 1], 16) << 8) | parseInt(commands[i + 2], 16);
                        }
                    break;
                    case '72':
                        {
                            command_len = 1;
                            data.overcurrentRecoveryTemp = parseInt(commands[i + 1], 16);
                        }
                    break;
                    case '73':
                        {
                            command_len = 1;
                            data.overpowerRecoveryTemp = parseInt(commands[i + 1], 16);
                        }
                    break;
                    case 'b1':
                        {
                            command_len = 1;
                            data.relayState = parseInt(commands[i + 1], 16) === 0x01
                        }
                    break;
                    case 'a0':
                        {
                            command_len = 4;
                            let fuota_address = parseInt(`${commands[i + 1]}${commands[i + 2]}${commands[i + 3]}${commands[i + 4]}`, 16)
                            let fuota_address_raw = `${commands[i + 1]}${commands[i + 2]}${commands[i + 3]}${commands[i + 4]}`
                            data.fuota = { fuota_address, fuota_address_raw };
                        }
                    break;
                    default:
                        break;
                }
                commands.splice(i,command_len);
            });
            return data;
            }

        if (bytes[0] == 1) {
            data = handleKeepalive(bytes, data);
        } else {
            data = handleResponse(bytes, data);
            // Handle the remaining keepalive data if required after response
            bytes = bytes.slice(-12);
            data = handleKeepalive(bytes, data);
        }
        return { data: data };
    } catch (e) {
        // console.log(e);
        throw new Error('Unhandled data');
    }
}
// ---- normalization layer (authored) ----
function round(value,decimals){var f=Math.pow(10,decimals);return Math.round(value*f)/f;}
function decodeUplinkCore(input){
  var raw=upstreamDecode(input); var d=(raw&&raw.data)||raw||{};
  var data={};
  var k;
  for(k in d){ if(!Object.prototype.hasOwnProperty.call(d,k))continue; var val=d[k]; if(val===null||val===undefined)continue; if(k==="model"){data.deviceModel=val;continue;} if(k==="make"){data.deviceMake=val;continue;} if(k==="energy_kWh"&&typeof val==="number"){data.metering=data.metering||{};data.metering.energy={total:round(val*1000,3)};continue;} if(k==="power_W"&&typeof val==="number"){data.power=data.power||{};data.power.active=val;continue;} if(k==="acVoltage_V"&&typeof val==="number"){data.power=data.power||{};data.power.voltage=val;continue;} if(k==="acCurrent_mA"&&typeof val==="number"){data.power=data.power||{};data.power.current=round(val/1000,5);continue;}
    if(val&&typeof val==="object"&&typeof val.value!=="undefined"&&!Array.isArray(val)){ data[("",k).replace(/_([a-zA-Z])/g,function(m,c){return c.toUpperCase();})]=val.value; continue; }
    data[k.replace(/_([a-zA-Z])/g,function(m,c){return c.toUpperCase();})]=val;
  }
  return {data:data};
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "mclimate";
    result.data.model = "16aspm";
  }
  return result;
}
