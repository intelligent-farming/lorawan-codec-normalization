// Authoring reference only — NOT shipped in the npm tarball.
//
// Ellenex CDO2-L (Version 6 firmware) sends a CBOR map on fPort 15 with
// calibrated SI values. CBOR keys and units from Ellenex's published V6 decoder
// (github.com/ellenex/lorawan-payload-decoders, "Version 6 Sensors"; the repo
// carries no license, so the decoder is NOT copied — only the documented key/unit
// facts are used). The CBOR wire format matches ellenex/pls2-l-v6 (Apache-2.0 TTN
// reference). This V6 variant is not separately in TheThingsNetwork/lorawan-devices
// (device.json ttn null).
//
// SENSOR_MAP (key -> quantity, unit):
//   v -> battery (mV)
//   T -> water.temperature.current (C)
//   DO2 -> water.dissolvedOxygen (mg/L)
//   DO1 (%Sat)/DO3 (ppm) -> extras
