// Authoring reference only — NOT shipped in the npm tarball (see package.json
// "files": "!codecs/**/reference") and NOT executed by this module.
//
// Source: Senzemo Senstick SSM30 (HW3.0/FW1.0, Pino Tech probe) TTN payload
// decoder, file "SSM30-Decoder.txt" from https://senzemo.com/materials/
// (Senzemo, LoRaWAN Protocol Manual Senstick_SSM30-HWv3.0_FWv1.0_v1.1). Kept
// verbatim as the wire-format reference our normalized codec.js was authored
// from. Not in TheThingsNetwork/lorawan-devices (device.json ttn is null).

/*

   _____                                      _____                 __  _      __  
  / ___/___  ____  ____  ___  ____ ___  ____ / ___/___  ____  _____/ /_(_)____/ /__
  \__ \/ _ \/ __ \/_  / / _ \/ __ `__ \/ __ \\__ \/ _ \/ __ \/ ___/ __/ / ___/ //_/
 ___/ /  __/ / / / / /_/  __/ / / / / / /_/ /__/ /  __/ / / (__  ) /_/ / /__/ ,<   
/____/\___/_/ /_/ /___/\___/_/ /_/ /_/\____/____/\___/_/ /_/____/\__/_/\___/_/|_|  
                
  Senstick SSM30 HW 3.0 - FW 1.0      
  Probe: Pino Tech                    
*/


function decodeUplink(input) {
  const bytes = input.bytes;  
  const port = input.fPort; 

  // If Data Packet
  if (port == 1 || port == 2) {
    
    var Status = bytes[0];
    var Temperature = (bytes[1] << 8) + bytes[2];
    var Humidity = (bytes[3] << 8) + bytes[4];
    var AirPressure = (bytes[5] << 8) + bytes[6];
    var BatteryLevel = bytes[7];  
    var mV  = (bytes[8] << 8) + bytes[9];
      
    // Pino Tech Soil Probe
    var Vmax = 2876; // Max mV @ 100% = 2871-2882 mV
    var Vmin = 44; // Min mV @ 0% = 44 mV
    var Voltage = mV/1000;
    
    var SoilMoisture = Math.round((mV - Vmin) * 100 / (Vmax - Vmin));       
    if (SoilMoisture > 100) SoilMoisture = 100;
    if (SoilMoisture < 0) SoilMoisture = 0;
    
    // VWC equation is suitable for most mineral soils - most mineral soils will saturate around 35-50% VWC
    var VWC = (2.8432 * Voltage * Voltage * Voltage) - (9.1993 * Voltage * Voltage) + (20.2553 * Voltage) - 4.1882;
    VWC = Math.round(VWC);    
      
    return {
      data: {
        Status: Status,
        Temperature: sintToDec(Temperature),
        Humidity: Humidity / 100.0,
        AirPressure: AirPressure / 10.0,
        BatteryLevel: (BatteryLevel + 100) / 100,
        SoilMoistureRaw: mV,
        SoilMoisture: SoilMoisture,
        VWC: VWC
        
      },
        warnings: [],
        errors: []
    };
  }
  // If Config packet
  else {
    
    var Status = bytes[0];    
    var SendPeriod = bytes[1];
    var MovementThreshold = bytes[2];
    var PacketConfirm = bytes[3];
    var DataRate = bytes[4]; 
    var FamilyId = bytes[5];
    var ProductId = bytes[6];         
    var HW = bytes[7];
    var FW = bytes[8];         
    
    return {
      data: {
        Status: Status,
        SendPeriod: SendPeriod,
        MovementThreshold: MovementThreshold, 
        PacketConfirm: PacketConfirm,
        DataRate: DataRate, 
        FamilyId: FamilyId,
        ProductId: ProductId,    
        HW: HW/10,
        FW: FW/10
      },
        warnings: [],
        errors: []
    };
  }
}


function sintToDec(T){
  if (T > 32767) {
    return ((T - 65536) / 100.0);
  }
  else {
    return (T / 100.0);
  }
}