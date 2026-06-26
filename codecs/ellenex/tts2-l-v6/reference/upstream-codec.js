// Authoring reference only — NOT shipped in the npm tarball.
//
// Ellenex TTS2-L (Version 6 firmware) sends a CBOR map on fPort 15 with
// calibrated SI values. CBOR keys/units from Ellenex's published V6 decoder
// (github.com/ellenex/lorawan-payload-decoders, "Version 6 Sensors"; no license
// on the repo, so only the documented key/unit facts are used). CBOR wire format
// matches ellenex/pls2-l-v6 (Apache-2.0 TTN reference). ttn null.
//
// SENSOR_MAP (key -> quantity, unit):
//   v -> battery (mV)
//   T -> temperature (C)
