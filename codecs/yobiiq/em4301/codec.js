// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for yobiiq/em4301 (YOBIIQ EM4301, 3-phase
// electricity energy meter).
//
// Wire-format decoder ported verbatim from the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/yobiiq/em4301.js, attributed in
// NOTICE), renamed yobiiqDecode; downlink encoder renamed to an inert helper.
// decodeUplinkCore sums the active-energy-import registers (Wh) into
// metering.energy.total, routes the per-phase registers into `channels[]` and
// the meter's own aggregates into top-level `power.*` (both below), and
// flattens the remaining measured/config fields (emitted upstream as
// {data,unit}) to their numeric value as camelCase extras.
//
// Frame layout (fPort 1..10 measurements, fPort 50 basic info): a stream of
// records, each `channel index byte + register type byte + fixed-length
// big-endian payload` per CONFIG_MEASUREMENT.TYPES / CONFIG_INFO.TYPES below.
// The leading channel byte is only a per-frame record index (the special pair
// channel 11 / type 0x0A carries modbusErrorCode); the register type byte is
// what names the reading.
//
// Per-phase readings ride in `channels[]`
// --------------------------------------
// The register table splits cleanly into registers that measure ONE supply
// phase and registers that describe the whole meter. Every per-phase register
// is a sub-sensor position measuring the same physical quantity, so its reading
// goes in the reserved `channels` array (see AUTHORING.md "Multi-channel
// devices") instead of the suffixed extras the normalization layer used to pass
// straight through from the ported decoder (`voltageL1N`/`L2N`/`L3N`,
// `currentL1`..`L3`, `activePowerL1`..`L3`, `reactivePowerL1`..`L3`,
// `apparentPowerL1`..`L3`, `powerFactorL1`..`L3`, `phaseAngleL1`..`L3`,
// `maximumL1CurrentDemand`..`L3`). Three positions, labelled after the phase
// the register names — `phaseA`/`phaseB`/`phaseC` for L1/L2/L3, the label
// scheme the three-phase arwin-technology/lrs2m001-4xxx, netvox/r718n3 and
// emu/emu-prof-ii meters use for this concept:
//   phaseA <- 0x0C voltageL1N             -> power.voltage (V, as decoded)
//             0x10 currentL1              -> power.current (A; mA / 1000)
//             0x14 activePowerL1          -> power.active  (W, as decoded)
//             0x1D powerFactorL1          -> powerFactor          (extra, -1..1)
//             0x17 reactivePowerL1        -> reactivePower        (extra, kvar)
//             0x1A apparentPowerL1        -> apparentPower        (extra, kVA)
//             0x20 phaseAngleL1           -> phaseAngle           (extra, degrees)
//             0x27 maximumL1CurrentDemand -> maximumCurrentDemand (extra, mA)
//   phaseB <- 0x0D / 0x11 / 0x15 / 0x1E / 0x18 / 0x1B / 0x21 / 0x28 (L2)
//   phaseC <- 0x0E / 0x12 / 0x16 / 0x1F / 0x19 / 0x1C / 0x22 / 0x29 (L3)
// No register is L1 promoted to a bare vocabulary key: the meter has no
// whole-device voltage register at all (0x0C is L1's own phase-to-neutral
// voltage, like 0x0D/0x0E), so this codec emits no top-level `power.voltage`.
// The five extras keep the ported decoder's value and unit verbatim — only the
// L1/L2/L3 infix is dropped, since the entry's `channel` label already carries
// the phase. `powerFactor` stays an extra rather than the vocabulary's
// `power.factor`: it is only being moved out of a suffixed name in this pass,
// and promoting an extra to a vocabulary key is a separate normalization
// decision (same for reactive/apparent power, whose vendor units are kvar/kVA
// rather than the vocabulary's var/VA).
//
// Whole-meter readings stay top-level (never repeated inside an entry):
//   0x13 activePowerL123 -> power.active    (W)  the meter's own 3-phase total
//   0x0F currentL123     -> power.current   (A)  the meter's own current total
//   0x23 frequency       -> power.frequency (Hz) line frequency, not per phase
//   0x04/0x05 activeEnergyImportL123T1/T2 -> metering.energy.total (Wh, summed)
// 0x13/0x0F are aggregates the METER reports (not a promoted phase and not
// something we sum), so they describe the whole device and belong to the empty
// channel label; a frame carrying both them and the per-phase registers emits
// the aggregate top-level and the phases in entries, and no single reading is
// ever emitted twice.
//
// TRIAGE — deliberately NOT channels[] entries, do not "fix" these into any:
// the tariff registers 0x06/0x07 activeEnergyExportL123T1/T2 and 0x08..0x0B
// reactiveEnergyImport/ExportL123T1/T2 (plus the import pair folded into
// metering.energy.total) are TARIFF BUCKETS of one meter-wide register — T1/T2
// is a billing rate, not a physical position, and the L123 in their name means
// "whole meter", so they stay top-level camelCase extras under their existing
// names. Also whole-device and top-level: 0x24..0x26 totalSystemActive/
// Reactive/ApparentPower, 0x2A averagePower, 0x00 index, 0x01 timestamp,
// 0x03 dataloggerTimestamp, 0x2B midYearOfCertification, 0xF0..0xF2
// manufacturedYear/firmwareVersion/hardwareVersion, the modbusErrorCode status
// byte, and every fPort-50 identity/config extra (deviceSerialNumber,
// deviceModel, deviceClass, powerEvent, primary/secondaryCurrentTransformer-
// Ratio, primary/secondaryVoltageTransformerRatio) — the CT/VT ratios describe
// the meter's wiring configuration, not one phase's reading.
//
// Lazy build: a frame carries only the registers the datalogger profile
// selected, so an entry is created only when a register for that phase appears,
// and `channels` is omitted entirely when a frame carries none — the energy /
// datalog frame emits no `channels` key, and a frame naming only L1 and L3
// emits exactly two entries (`phaseA`, `phaseC`).
//
// Sentinel policy: there is none to honour. The wire format has no absent- or
// disconnected-phase encoding — every per-phase register is a plain
// big-endian integer, signed via two's complement with no reserved code
// (unlike the sibling adeunis/tic-cbe-linky-tri, whose 0x80000000 marks a
// register absent from the bus) — and 0 A is a legitimate idle reading on an
// unloaded phase, not a sentinel. So no position is ever skipped for its value:
// a phase is missing from `channels` only when the frame carried no register
// for it. A frame the ported decoder cannot parse (fPort outside the
// measurement/info ports, unknown register type) returns its `error` string as
// a decode error instead of a partial measurement, since frame sync is lost.


// Version Control
var VERSION_CONTROL = {
    CODEC : {VERSION: "1.0.1", NAME: "codecVersion"},
    DEVICE: {MODEL : "EM4301", NAME: "genericModel"},
    PRODUCT: {CODE : "P1002011", NAME: "productCode"},
    MANUFACTURER: {COMPANY : "YOBIIQ B.V.", NAME: "manufacturer"},
}


// Configuration constants for device basic info
var CONFIG_INFO = {
    FPORT     : 50,
    CHANNEL  : parseInt("0xFF", 16),
    TYPES    : {
        "0x09" : {SIZE : 2, NAME : "hardwareVersion", DIGIT: false},
        "0x0A" : {SIZE : 2, NAME : "firmwareVersion", DIGIT: false},
        "0x16" : {SIZE : 4, NAME : "deviceSerialNumber"},
        "0x0F" : {SIZE : 1, NAME : "deviceClass",
            VALUES     : {
                "0x00" : "Class A",
                "0x01" : "Class B",
                "0x02" : "Class C",
            },
        },
        "0x0B" : {SIZE : 1, NAME : "powerEvent",
            VALUES     : {
                "0x00" : "AC Power Off",
                "0x01" : "AC Power On",
            },
        },
        "0x1E" : {SIZE : 2, NAME : "primaryCurrentTransformerRatio",},
        "0x1F" : {SIZE : 1, NAME : "secondaryCurrentTransformerRatio",},
        "0x20" : {SIZE : 4, NAME : "primaryVoltageTransformerRatio",},
        "0x21" : {SIZE : 2, NAME : "secondaryVoltageTransformerRatio",},
        "0x28" : {SIZE : 0, NAME : "deviceModel",},
    },
    WARNING_NAME   : "warning",
    ERROR_NAME     : "error",
    INFO_NAME      : "info"
}

// Configuration constants for measurement registers
 var CONFIG_MEASUREMENT = {
    FPORT_MIN : 1,
    FPORT_MAX : 10,
    TYPES : {
        "0x00" : {SIZE : 4, NAME : "index",},
        "0x01" : {SIZE : 4, NAME : "timestamp",},
        "0x03" : {SIZE : 4, NAME : "dataloggerTimestamp",},
        "0x04" : {SIZE : 4, NAME : "activeEnergyImportL123T1", UNIT : "Wh",},
        "0x05" : {SIZE : 4, NAME : "activeEnergyImportL123T2", UNIT : "Wh",},
        "0x06" : {SIZE : 4, NAME : "activeEnergyExportL123T1", UNIT : "Wh",},
        "0x07" : {SIZE : 4, NAME : "activeEnergyExportL123T2", UNIT : "Wh",},
        "0x08" : {SIZE : 4, NAME : "reactiveEnergyImportL123T1", UNIT : "varh",},
        "0x09" : {SIZE : 4, NAME : "reactiveEnergyImportL123T2", UNIT : "varh",},
        "0x0A" : {SIZE : 4, NAME : "reactiveEnergyExportL123T1", UNIT : "varh",},
        "0x0B" : {SIZE : 4, NAME : "reactiveEnergyExportL123T2", UNIT : "varh",},
        "0x0C" : {SIZE : 4, NAME : "voltageL1N", UNIT : "V", RESOLUTION : 0.1, SIGNED : true,},
        "0x0D" : {SIZE : 4, NAME : "voltageL2N", UNIT : "V", RESOLUTION : 0.1, SIGNED : true,},
        "0x0E" : {SIZE : 4, NAME : "voltageL3N", UNIT : "V", RESOLUTION : 0.1, SIGNED : true,},
        "0x0F" : {SIZE : 4, NAME : "currentL123", UNIT : "mA", SIGNED : true,},
        "0x10" : {SIZE : 4, NAME : "currentL1", UNIT : "mA", SIGNED : true,},
        "0x11" : {SIZE : 4, NAME : "currentL2", UNIT : "mA", SIGNED : true,},
        "0x12" : {SIZE : 4, NAME : "currentL3", UNIT : "mA", SIGNED : true,},
        "0x13" : {SIZE : 4, NAME : "activePowerL123", UNIT : "W", SIGNED : true,},
        "0x14" : {SIZE : 4, NAME : "activePowerL1", UNIT : "W", SIGNED : true,},
        "0x15" : {SIZE : 4, NAME : "activePowerL2", UNIT : "W", SIGNED : true,},
        "0x16" : {SIZE : 4, NAME : "activePowerL3", UNIT : "W", SIGNED : true,},
        "0x17" : {SIZE : 4, NAME : "reactivePowerL1", UNIT : "kvar", RESOLUTION : 0.001, SIGNED : true,},
        "0x18" : {SIZE : 4, NAME : "reactivePowerL2", UNIT : "kvar", RESOLUTION : 0.001, SIGNED : true,},
        "0x19" : {SIZE : 4, NAME : "reactivePowerL3", UNIT : "kvar", RESOLUTION : 0.001, SIGNED : true,},
        "0x1A" : {SIZE : 4, NAME : "apparentPowerL1", UNIT : "kVA", RESOLUTION : 0.001, SIGNED : true,},
        "0x1B" : {SIZE : 4, NAME : "apparentPowerL2", UNIT : "kVA", RESOLUTION : 0.001, SIGNED : true,},
        "0x1C" : {SIZE : 4, NAME : "apparentPowerL3", UNIT : "kVA", RESOLUTION : 0.001, SIGNED : true,},
        "0x1D" : {SIZE : 1, NAME : "powerFactorL1", RESOLUTION : 0.01, SIGNED : true,},
        "0x1E" : {SIZE : 1, NAME : "powerFactorL2", RESOLUTION : 0.01, SIGNED : true,},
        "0x1F" : {SIZE : 1, NAME : "powerFactorL3", RESOLUTION : 0.01, SIGNED : true,},
        "0x20" : {SIZE : 2, NAME : "phaseAngleL1", UNIT : "degree", RESOLUTION : 0.01, SIGNED : true,},
        "0x21" : {SIZE : 2, NAME : "phaseAngleL2", UNIT : "degree", RESOLUTION : 0.01, SIGNED : true,},
        "0x22" : {SIZE : 2, NAME : "phaseAngleL3", UNIT : "degree", RESOLUTION : 0.01, SIGNED : true,},
        "0x23" : {SIZE : 2, NAME : "frequency", UNIT : "Hz", RESOLUTION : 0.01, SIGNED : true,},
        "0x24" : {SIZE : 4, NAME : "totalSystemActivePower", UNIT : "kW",},
        "0x25" : {SIZE : 4, NAME : "totalSystemReactivePower", UNIT : "kvar", RESOLUTION : 0.001,},
        "0x26" : {SIZE : 4, NAME : "totalSystemApparentPower", UNIT : "kVA", RESOLUTION : 0.001,},
        "0x27" : {SIZE : 4, NAME : "maximumL1CurrentDemand", UNIT : "mA", SIGNED : true,},
        "0x28" : {SIZE : 4, NAME : "maximumL2CurrentDemand", UNIT : "mA", SIGNED : true,},
        "0x29" : {SIZE : 4, NAME : "maximumL3CurrentDemand", UNIT : "mA", SIGNED : true,},
        "0x2A" : {SIZE : 4, NAME : "averagePower", UNIT : "W", SIGNED : true,},
        "0x2B" : {SIZE : 4, NAME : "midYearOfCertification",},
        "0xF0" : {SIZE : 2, NAME : "manufacturedYear", DIGIT: true,},
        "0xF1" : {SIZE : 2, NAME : "firmwareVersion", DIGIT: false,},
        "0xF2" : {SIZE : 2, NAME : "hardwareVersion", DIGIT: false,},
    },
    WARNING_NAME   : "warning",
    ERROR_NAME     : "error",
    INFO_NAME      : "info"
}

function decodeBasicInformation(bytes)
{
    var LENGTH = bytes.length;
    var decoded = {};
    var index = 0;
    var channel = 0;
    var type = "";
    var size = 0;
    if(LENGTH == 1)
    {
        if(bytes[0] == 0)
        {
            decoded[CONFIG_INFO.INFO_NAME] = "Downlink command succeeded";

        } else if(bytes[0] == 1)
        {
            decoded[CONFIG_INFO.WARNING_NAME] = "Downlink command failed";
        }
        return decoded;
    }
    try
    {
        while(index < LENGTH)
        {
            channel = bytes[index];
            index = index + 1;
            if(channel == CONFIG_INFO.CHANNEL)
            {
                // Type of basic information
                type = "0x" + toEvenHEX(bytes[index].toString(16).toUpperCase());
                index = index + 1;
                var info = CONFIG_INFO.TYPES[type];
                size = info.SIZE;
                // Decoding
                var value = 0;
                if(size != 0)
                {
                    if(info.DIGIT || info.DIGIT == false)
                    {
                        if(info.DIGIT == false)
                        {
                            // Decode into "V" + DIGIT STRING + "." DIGIT STRING format
                            value = getDigitStringArrayNoFormat(bytes, index, size);
                            value = "V" + value[0] + "." + value[1];
                        }else
                        {
                            // Decode into DIGIT STRING format
                            value = getDigitStringArrayEvenFormat(bytes, index, size);
                            value = value.toString();
                        }
                    }else
                    {
                        if(info.VALUES)
                        {
                            // Decode into STRING (VALUES specified in CONFIG_INFO)
                            value = "0x" + toEvenHEX(bytes[index].toString(16).toUpperCase());
                            value = info.VALUES[value];
                        }else
                        {
                            // Decode into DECIMAL format
                            value = getValueFromBytesBigEndianFormat(bytes, index, size);
                        }
                    }
                    decoded[info.NAME] = value;
                    index = index + size;
                }else
                {
                    // Device Model (End of decoding)
                    size = getSizeBasedOnChannel(bytes, index, channel);
                    decoded[info.NAME] = getStringFromBytesBigEndianFormat(bytes, index, size);
                    index = index + size;
                }
            }
        }
    }catch(error)
    {
        decoded[CONFIG_INFO.ERROR_NAME] = error.message;
    }

    return decoded;
}

function decodeDeviceData(bytes)
{
    var LENGTH = bytes.length;
    var decoded = {};
    var index = 0;
    var channel = 0;
    var type = "";
    var size = 0;
    if(LENGTH == 1)
    {
        if(bytes[0] == 0)
        {
            decoded[CONFIG_MEASUREMENT.INFO_NAME] = "Downlink command succeeded";

        } else if(bytes[0] == 1)
        {
            decoded[CONFIG_MEASUREMENT.WARNING_NAME] = "Downlink command failed";
        }
        return decoded;
    }
    try
    {
        while(index < LENGTH)
        {
            channel = bytes[index];
            index = index + 1;
            // Type of device measurement
            type = "0x" + toEvenHEX(bytes[index].toString(16).toUpperCase());
            index = index + 1;

            // channel checking
            if(channel == 11 && type == "0x0A")
            {
                // Modbus error code decoding
                decoded.modbusErrorCode = bytes[index];
                index = index + 1;
                continue; // next channel
            }

            var measurement = CONFIG_MEASUREMENT.TYPES[type];
            size = measurement.SIZE;
            // Decoding
            var value = 0;
            if(measurement.DIGIT || measurement.DIGIT == false)
            {
                if(measurement.DIGIT == false)
                {
                    // Decode into "V" + DIGIT STRING + "." DIGIT STRING format
                    value = getDigitStringArrayNoFormat(bytes, index, size);
                    value = "V" + value[0] + "." + value[1];
                }else
                {
                    // Decode into DIGIT NUMBER format
                    value = getDigitStringArrayEvenFormat(bytes, index, size);
                    value = parseInt(value.join(""));
                }
            }else
            {
                // Decode into DECIMAL format
                value = getValueFromBytesBigEndianFormat(bytes, index, size);
            }
            if(measurement.SIGNED)
            {
                value = getSignedIntegerFromInteger(value, size);
            }
            if(measurement.RESOLUTION)
            {
                value = value * measurement.RESOLUTION;
                value = parseFloat(value.toFixed(2));
            }
            if(measurement.UNIT)
            {
                decoded[measurement.NAME] = {};
                decoded[measurement.NAME]["data"] = value;
                decoded[measurement.NAME]["unit"] = measurement.UNIT;
                // decoded[measurement.NAME] = value;
            }else
            {
                decoded[measurement.NAME] = value;
            }
            index = index + size;

        }
    }catch(error)
    {
        decoded[CONFIG_MEASUREMENT.ERROR_NAME] = error.message;
    }
    return decoded;
}

function getStringFromBytesBigEndianFormat(bytes, index, size)
{
    var value = "";
    for(var i=0; i<size; i=i+1)
    {
        value = value + String.fromCharCode(bytes[index+i]);
    }
    return value;
}

function getStringFromBytesLittleEndianFormat(bytes, index, size)
{
    var value = "";
    for(var i=(size - 1); i>=0; i=i-1)
    {
        value = value + String.fromCharCode(bytes[index+i]);
    }
    return value;
}

function getValueFromBytesBigEndianFormat(bytes, index, size)
{
    var value = 0;
    for(var i=0; i<(size-1); i=i+1)
    {
        value = (value | bytes[index+i]) << 8; 
    }
    value = value | bytes[index+size-1]
    return (value >>> 0); // to unsigned
}

function getValueFromBytesLittleEndianFormat(bytes, index, size)
{
    var value = 0;
    for(var i=(size-1); i>0; i=i-1)
    {
        value = (value | bytes[index+i]) << 8; 
    }
    value = value | bytes[index]
    return (value >>> 0); // to unsigned
}

function getDigitStringArrayNoFormat(bytes, index, size)
{
  var hexString = []
  for(var i=0; i<size; i=i+1)
  {
    hexString.push(bytes[index+i].toString(16));
  }
  return hexString
}

function getDigitStringArrayEvenFormat(bytes, index, size)
{
  var hexString = []
  for(var i=0; i<size; i=i+1)
  {
    hexString.push(bytes[index+i].toString(16));
  }
  return hexString.map(toEvenHEX)
}

function toEvenHEX(hex)
{
  if(hex.length == 1)
  {
    return "0"+hex;
  }
  return hex;
}

function getSizeBasedOnChannel(bytes, index, channel)
{
    var size = 0;
    while(index + size < bytes.length && bytes[index + size] != channel)
    {
        size = size + 1;
    }
    return size;
}

function getSignedIntegerFromInteger(integer, size) 
{
	var signMask = 1 << (size * 8 - 1);
	var dataMask = (1 << (size * 8 - 1)) - 1;
	if(integer & signMask) 
    {
	    return -(~integer & dataMask) - 1;
	}else 
    {
	    return integer & dataMask;
	}
}

/************************************************************************************************************/

// Decode decodes an array of bytes into an object. (ChirpStack v3)
//  - fPort contains the LoRaWAN fPort number
//  - bytes is an array of bytes, e.g. [225, 230, 255, 0]
//  - variables contains the device variables e.g. {"calibration": "3.5"} (both the key / value are of type string)
// The function must return an object, e.g. {"temperature": 22.5}
function Decode(fPort, bytes, variables) 
{
    var decoded = {};
    if(fPort == 0)
    {
        decoded = {mac: "MAC command received", fPort: fPort};
    }
    else if(fPort == CONFIG_INFO.FPORT)
    {
        decoded = decodeBasicInformation(bytes);
    }else if(fPort >= CONFIG_MEASUREMENT.FPORT_MIN && fPort <= CONFIG_MEASUREMENT.FPORT_MAX)
    {
        decoded = decodeDeviceData(bytes);
    }else
    {
        decoded = {error: "Incorrect fPort", fPort : fPort};
    }
    decoded[VERSION_CONTROL.CODEC.NAME] = VERSION_CONTROL.CODEC.VERSION;
    decoded[VERSION_CONTROL.DEVICE.NAME] = VERSION_CONTROL.DEVICE.MODEL;
    decoded[VERSION_CONTROL.PRODUCT.NAME] = VERSION_CONTROL.PRODUCT.CODE;
    decoded[VERSION_CONTROL.MANUFACTURER.NAME] = VERSION_CONTROL.MANUFACTURER.COMPANY;
    return decoded;
}

// Decode uplink function. (ChirpStack v4 , TTN)
//
// Input is an object with the following fields:
// - bytes = Byte array containing the uplink payload, e.g. [255, 230, 255, 0]
// - fPort = Uplink fPort.
// - variables = Object containing the configured device variables.
//
// Output must be an object with the following fields:
// - data = Object representing the decoded payload.
function yobiiqDecode(input) {
    return {
        data: Decode(input.fPort, input.bytes, input.variables)
    };
}

/************************************************************************************************************/

// Encode encodes the given object into an array of bytes. (ChirpStack v3)
//  - fPort contains the LoRaWAN fPort number
//  - obj is an object, e.g. {"temperature": 22.5}
//  - variables contains the device variables e.g. {"calibration": "3.5"} (both the key / value are of type string)
// The function must return an array of bytes, e.g. [225, 230, 255, 0]
function Encode(fPort, obj, variables) {
    try
    {
        if(obj[CONFIG_DOWNLINK.TYPE] == CONFIG_DOWNLINK.CONFIG)
        {
            return encodeDeviceConfiguration(obj[CONFIG_DOWNLINK.CONFIG], variables);
        }else if(obj[CONFIG_DOWNLINK.TYPE] == CONFIG_DOWNLINK.MEASURE)
        {
            return encodePeriodicPackage(obj[[CONFIG_DOWNLINK.MEASURE]], variables);
        }
    }catch(error)
    {

    }
    return [];
}

// Encode downlink function. (ChirpStack v4 , TTN)
//
// Input is an object with the following fields:
// - data = Object representing the payload that must be encoded.
// - variables = Object containing the configured device variables.
//
// Output must be an object with the following fields:
// - bytes = Byte array containing the downlink payload.
function yobiiqEncodeDownlink(input) {
    return {
        bytes: Encode(null, input.data, input.variables)
    };
}

/************************************************************************************************************/

// Constants for device configuration 
var CONFIG_DEVICE = {
    FPORT : 50,
    CHANNEL : parseInt("0xFF", 16),
    TYPES : {
        "restart" : {TYPE : parseInt("0x0B", 16), SIZE : 1, MIN : 1, MAX : 1,},
        "primaryCurrentTransformerRatio" : {TYPE : parseInt("0x1E", 16), SIZE : 2, MIN : 0, MAX : 9999,},
        "secondaryCurrentTransformerRatio" : {TYPE : parseInt("0x1F", 16), SIZE : 1, MIN : 0, MAX : 5,},
        "primaryVoltageTransformerRatio" : {TYPE : parseInt("0x20", 16), SIZE : 4, MIN : 30, MAX : 500000,},
        "secondaryVoltageTransformerRatio" : {TYPE : parseInt("0x21", 16), SIZE : 2, MIN : 30, MAX : 500,},
    }
}

// Constants for device periodic package 
var CONFIG_PERIODIC = {
    CHANNEL : parseInt("0xFF", 16),
    TYPES : {
        "Interval" : {TYPE : parseInt("0x14", 16), SIZE : 1, MIN : 1, MAX : 255,},
        "Mode" : {TYPE : parseInt("0x15", 16), SIZE : 1, MIN : 0, MAX : 1,},
        "Status" : {TYPE : parseInt("0x16", 16), SIZE : 1, MIN : 0, MAX : 1,},
        "Measurement" : {TYPE : parseInt("0x17", 16), SIZE : 1, MIN : 0, MAX : 10,},
    },
    MEASUREMENTS : {
        index : "0x00",
        timestamp : "0x01",
        dataloggerTimestamp : "0x03",
        activeEnergyImportL123T1 : "0x04",
        activeEnergyImportL123T2 : "0x05",
        activeEnergyExportL123T1 : "0x06",
        activeEnergyExportL123T2 : "0x07",
        reactiveEnergyImportL123T1 : "0x08",
        reactiveEnergyImportL123T2 : "0x09",
        reactiveEnergyExportL123T1 : "0x0A",
        reactiveEnergyExportL123T2 : "0x0B",
        voltageL1N : "0x0C",
        voltageL2N : "0x0D",
        voltageL3N : "0x0E",
        currentL123 : "0x0F",
        currentL1 : "0x10",
        currentL2 : "0x11",
        currentL3 : "0x12",
        activePowerL123 : "0x13",
        activePowerL1 : "0x14",
        activePowerL2 : "0x15",
        activePowerL3 : "0x16",
        reactivePowerL1 : "0x17",
        reactivePowerL2 : "0x18",
        reactivePowerL3 : "0x19",
        apparentPowerL1 : "0x1A",
        apparentPowerL2 : "0x1B",
        apparentPowerL3 : "0x1C",
        powerFactorL1 : "0x1D",
        powerFactorL2 : "0x1E",
        powerFactorL3 : "0x1F",
        phaseAngleL1 : "0x20",
        phaseAngleL2 : "0x21",
        phaseAngleL3 : "0x22",
        frequency : "0x23",
        totalSystemActivePower : "0x24",
        totalSystemReactivePower : "0x25",
        totalSystemApparentPower : "0x26",
        maximumL1CurrentDemand : "0x27",
        maximumL2CurrentDemand : "0x28",
        maximumL3CurrentDemand : "0x29",
        averagePower : "0x2A",
        midYearOfCertification : "0x2B",
        manufacturedYear : "0xF0",
        firmwareVersion : "0xF1",
        hardwareVersion : "0xF2",
    }
}

// Constants for downlink type (Config or Measure)
var CONFIG_DOWNLINK = {
    TYPE    : "Type",
    CONFIG  : "Config",
    MEASURE : "Measure",
}

function encodeDeviceConfiguration(obj, variables)
{
    var encoded = []
    var index = 0;
    var field = ["Param", "Value"];
    try
    {
        var config = CONFIG_DEVICE.TYPES[obj[field[0]]];
        var value = obj[field[1]];
        if(obj[field[1]] >= config.MIN && obj[field[1]] <= config.MAX)
        {
            encoded[index] = CONFIG_DEVICE.CHANNEL;
            index = index + 1;
            encoded[index] = config.TYPE;
            index = index + 1;
            for(var i=1; i<=config.SIZE; i=i+1)
            {
                encoded[index] = (value >> 8*(config.SIZE - i)) % 256;
                index = index + 1;
            }
        }else
        {
            // Error
            return [];
        }
    }catch(error)
    {
        // Error
        return [];
    }
    return encoded;
}

function encodePeriodicPackage(obj, variables)
{
    var encoded = []
    var index = 0;
    var field = ["Interval", "Mode", "Status", "Measurement"];
    try 
    {
        // Encode Interval, Mode, Status
        for(var i=0; i<3; i=i+1)
        {
            if(field[i] in obj)
            {
                var config = CONFIG_PERIODIC.TYPES[field[i]];
                if(obj[field[i]] >= config.MIN && obj[field[i]] <= config.MAX)
                {
                    encoded[index] = CONFIG_PERIODIC.CHANNEL;
                    index = index + 1;
                    encoded[index] = config.TYPE;
                    index = index + 1;
                    encoded[index] = obj[field[i]];
                    index = index + 1;
                }else
                {
                    // Error
                    return [];
                }
            }
        }

        // Encode Measurement
		if(field[3] in obj)
		{
			var measurements = obj[field[3]];
			var LENGTH = measurements.length;
			var config = CONFIG_PERIODIC.TYPES[field[3]];
			if(LENGTH > config.MAX)
			{
				// Error
				return [];
			}
			var measurement = "";
			if(LENGTH > 0)
			{
				encoded[index] = CONFIG_PERIODIC.CHANNEL;
				index = index + 1;
				encoded[index] = config.TYPE;
				index = index + 1;
			}
			for(var i=0; i<LENGTH; i=i+1)
			{
				measurement = measurements[i];
				if(measurement in CONFIG_PERIODIC.MEASUREMENTS)
				{
					encoded[index] = parseInt(CONFIG_PERIODIC.MEASUREMENTS[measurement], 16);
					index = index + 1;
				}else
				{
					// Error
					return [];
				}
			}
		}

    }catch(error)
    {
        // Error
        return [];
    }

    return encoded;
}




// ---- normalization layer (authored) ----

function yobiiqRound(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

// The ported decoder already applied each register's RESOLUTION, so the only
// unit change left is mA -> A (div 1000). div === 1 passes the value through
// untouched, so nothing else can drift.
function yobiiqScale(value, div) {
  if (div === 1) { return value; }
  return yobiiqRound(value / div, 3);
}

// Reserved channels[] positions, in emitted order: the meter's three supply
// phases. Slot index is the conductor's position in the register table above
// (L1, L2, L3).
var YOBIIQ_PHASE_LABELS = ['phaseA', 'phaseB', 'phaseC'];

// Per-phase registers whose reading is a `power.*` vocabulary key inside that
// phase's entry: upstream register name -> [slot, key, divisor].
var YOBIIQ_PHASE_POWER = {
  voltageL1N:    [0, 'voltage', 1],
  voltageL2N:    [1, 'voltage', 1],
  voltageL3N:    [2, 'voltage', 1],
  currentL1:     [0, 'current', 1000],
  currentL2:     [1, 'current', 1000],
  currentL3:     [2, 'current', 1000],
  activePowerL1: [0, 'active', 1],
  activePowerL2: [1, 'active', 1],
  activePowerL3: [2, 'active', 1]
};

// Per-phase registers that stay camelCase extras inside that phase's entry:
// upstream register name -> [slot, key]. The vendor's value and unit are
// unchanged (powerFactor -1..1, reactivePower kvar, apparentPower kVA,
// phaseAngle degrees, maximumCurrentDemand mA); only the L1/L2/L3 infix is
// dropped, because the entry's `channel` label already carries the phase.
var YOBIIQ_PHASE_EXTRA = {
  powerFactorL1:          [0, 'powerFactor'],
  powerFactorL2:          [1, 'powerFactor'],
  powerFactorL3:          [2, 'powerFactor'],
  reactivePowerL1:        [0, 'reactivePower'],
  reactivePowerL2:        [1, 'reactivePower'],
  reactivePowerL3:        [2, 'reactivePower'],
  apparentPowerL1:        [0, 'apparentPower'],
  apparentPowerL2:        [1, 'apparentPower'],
  apparentPowerL3:        [2, 'apparentPower'],
  phaseAngleL1:           [0, 'phaseAngle'],
  phaseAngleL2:           [1, 'phaseAngle'],
  phaseAngleL3:           [2, 'phaseAngle'],
  maximumL1CurrentDemand: [0, 'maximumCurrentDemand'],
  maximumL2CurrentDemand: [1, 'maximumCurrentDemand'],
  maximumL3CurrentDemand: [2, 'maximumCurrentDemand']
};

// Whole-meter registers the METER itself aggregates over the whole device ->
// top-level `power.*`: upstream register name -> [key, divisor]. Never summed
// by us and never repeated inside an entry.
var YOBIIQ_AGGREGATE_POWER = {
  activePowerL123: ['active', 1],
  currentL123:     ['current', 1000],
  frequency:       ['frequency', 1]
};

// Lazily create (and return) the channels entry for one supply phase.
function yobiiqPhase(slots, idx) {
  if (slots[idx] === null) {
    slots[idx] = { channel: YOBIIQ_PHASE_LABELS[idx] };
  }
  return slots[idx];
}

function decodeUplinkCore(input) {
  var raw = yobiiqDecode(input);
  var d = (raw && raw.data) || raw || {};
  var data = {};
  var energyImport = null;
  // channels[] entries per supply phase (L1, L2, L3), created only when the
  // frame actually carries a register for that phase.
  var slots = [null, null, null];
  var k;
  for (k in d) {
    if (!Object.prototype.hasOwnProperty.call(d, k)) { continue; }
    var val = d[k];
    if (val === null || val === undefined) { continue; }
    // The ported decoder reports a wire-format fault as an `error` string: an
    // fPort outside the measurement/info ports ("Incorrect fPort"), or a
    // register type / length its table does not cover (the thrown message).
    // Either way frame sync is lost, so the frame is a decode error rather
    // than telemetry with an `error` field attached.
    if (k === 'error') { return { errors: [String(val)] }; }
    if (/^activeEnergyImport/.test(k) && val && typeof val.data === 'number') { energyImport = (energyImport || 0) + val.data; continue; }
    var num = (val && typeof val === 'object' && typeof val.data !== 'undefined' && !Array.isArray(val)) ? val.data : val;
    var phasePower = YOBIIQ_PHASE_POWER[k];
    if (phasePower) {
      var entry = yobiiqPhase(slots, phasePower[0]);
      if (!entry.power) { entry.power = {}; }
      entry.power[phasePower[1]] = yobiiqScale(num, phasePower[2]);
      continue;
    }
    var phaseExtra = YOBIIQ_PHASE_EXTRA[k];
    if (phaseExtra) {
      yobiiqPhase(slots, phaseExtra[0])[phaseExtra[1]] = num;
      continue;
    }
    var aggregate = YOBIIQ_AGGREGATE_POWER[k];
    if (aggregate) {
      if (!data.power) { data.power = {}; }
      data.power[aggregate[0]] = yobiiqScale(num, aggregate[1]);
      continue;
    }
    data[k] = num;
  }
  if (energyImport !== null) { data.metering = data.metering || {}; data.metering.energy = { total: energyImport }; }
  // Emit the phase entries in fixed order (L1, L2, L3), skipping phases this
  // frame said nothing about; a frame with no per-phase register at all carries
  // no `channels` key.
  var entries = [];
  var slot;
  for (slot = 0; slot < slots.length; slot++) {
    if (slots[slot] !== null) {
      entries.push(slots[slot]);
    }
  }
  if (entries.length > 0) { data.channels = entries; }
  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  // fPort 0 carries MAC commands only (LoRaWAN spec): there is no application
  // payload to decode, so this is not a decode failure. See AUTHORING.md.
  if (input && input.fPort === 0) {
    return { data: { make: "yobiiq", model: "em4301" } };
  }
  if (!input || !input.bytes || input.bytes.length === 0) {
    return { errors: ['empty payload: no application bytes to decode'] };
  }

  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "yobiiq";
    result.data.model = "em4301";
  }
  return result;
}
