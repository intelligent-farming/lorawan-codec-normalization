// Authoring reference only — NOT shipped in the npm tarball.
//
// Ellenex PDT2-L (Version 6 firmware) sends a CBOR map on fPort 15 with
// calibrated SI values. CBOR keys and units from Ellenex's published V6 decoder
// (github.com/ellenex/lorawan-payload-decoders, "Version 6 Sensors"; no license
// on the repo, so the decoder is NOT copied — only the documented key/unit facts
// are used). CBOR wire format matches ellenex/pls2-l-v6 (Apache-2.0 TTN reference).
// Not separately in TheThingsNetwork/lorawan-devices (device.json ttn null).
//
// SENSOR_MAP (key -> quantity, unit):
//   v -> battery (mV)
//   DP -> pressure.differential (Pa)
//   T -> air.temperature (C)
