// Authoring reference only — NOT shipped in the npm tarball (see package.json
// "files": "!codecs/**/reference") and NOT executed by this module.
//
// Rejeee SL711 LoRaWAN water-level sensor is not in TheThingsNetwork/lorawan-
// devices. Wire format from the SL711 User Manual section 4 ("Wireless data
// format", doc.rejeee.com): over LoRaWAN the FRMPayload (fPort 1) is TLV
// sensor-data blocks. Block 0x00 = device information (3-bit version, 5-bit
// battery level, reserve). Block 0x03 = ADC, 2 bytes unsigned big-endian, unit
// mV, where 1 mV corresponds to 0.01 mA of the 4-20 mA loop (manual example:
// 03 0190 -> 0x0190 = 400 -> 4.00 mA). The SL711 level range is 0-5 m mapped
// linearly across 4-20 mA. Reproduced as original work — no upstream decoder
// copied. device.json ttn is null.
function u16(hi, lo) { return ((hi & 0xff) << 8) | (lo & 0xff); }
