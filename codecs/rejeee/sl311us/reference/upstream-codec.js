// Authoring reference only — NOT shipped in the npm tarball (see package.json
// "files": "!codecs/**/reference") and NOT executed by this module.
//
// Rejeee SL311 (SL300-series) LoRaWAN CO2 sensor is not in
// TheThingsNetwork/lorawan-devices. Wire format from the documented Rejeee
// SL300/SL311 User Manual section 6 ("Sensor Data Definition", doc.pieyun.com):
// over LoRaWAN the FRMPayload (fPort 1) is TLV sensor-data blocks. 0x00 device
// information (3-bit version, 5-bit battery level, reserve). 0x04 Temperature
// (2-byte signed, 0.1 C). 0x05 Humidity (1 byte, 1 %RH). 0x30 mixed-gas block
// (length byte, gas-type byte; 0x04 = CO2; 4-byte big-endian value, unit 0.01 ->
// ppm). Manual example 00 3F24 30 05 04 00010BF8 -> CO2 686.00 ppm, battery 31.
// Reproduced as original work — no upstream decoder copied. device.json ttn null.
function s16(hi, lo) { var v = ((hi & 0xff) << 8) | (lo & 0xff); return (v & 0x8000) ? v - 0x10000 : v; }
function i32be(b, k) { return ((b[k] & 0xff) << 24) | ((b[k+1] & 0xff) << 16) | ((b[k+2] & 0xff) << 8) | (b[k+3] & 0xff); }
