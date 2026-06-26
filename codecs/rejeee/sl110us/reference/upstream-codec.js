// Authoring reference only — NOT shipped in the npm tarball (see package.json
// "files": "!codecs/**/reference") and NOT executed by this module.
//
// Rejeee SL-series temperature/humidity nodes are not in
// TheThingsNetwork/lorawan-devices. Wire format from the documented Rejeee
// LoRaWAN sensor-data protocol (SL711 User Manual section 4, "Wireless data
// format"; doc.rejeee.com): over LoRaWAN the FRMPayload (fPort 1) is a sequence
// of TLV sensor-data blocks. Block 0x00 = device information (3-bit version,
// 5-bit battery level, 1 reserve byte). Temperature/humidity follow as further
// TLV blocks. Reproduced as original work — no upstream decoder copied — and
// cross-checked against an independent community decoder. device.json ttn null.
function s16(hi, lo) { var v = ((hi & 0xff) << 8) | (lo & 0xff); return (v & 0x8000) ? v - 0x10000 : v; }
