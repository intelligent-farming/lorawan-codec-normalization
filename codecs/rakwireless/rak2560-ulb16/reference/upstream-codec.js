// Authoring reference only — NOT shipped in the npm tarball (see package.json
// "files": "!codecs/**/reference") and NOT executed by this module.
//
// The RAK2560 Sensor Hub with the ULB16 water-level probe ("Water Level
// Monitoring" solution) emits the RAK Standardized Payload; the ULB16 reports
// its 4-20 mA loop current on a generic analog-input channel (LPP type 0x02).
// The 4-20 mA -> 0-5 m mapping (3.2 mA per metre; 4 mA = 0 m, e.g. 4.8 mA =
// 0.25 m) is from the RAK Water Level Monitoring Solution datasheet
// (docs.rakwireless.com .../water-level-monitoring/datasheet). The TLV walk is
// the same RAK Standardized Payload as the rak2560 codec (upstream Apache-2.0,
// attributed in NOTICE); the level conversion here is original work. This is a
// probe configuration of the RAK2560, not a distinct TTN device (ttn null).
