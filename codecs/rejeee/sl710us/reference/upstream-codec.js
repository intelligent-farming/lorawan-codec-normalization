// Authoring reference only — NOT shipped in the npm tarball (see package.json
// "files": "!codecs/**/reference") and NOT executed by this module.
//
// Rejeee SL710 is not in TheThingsNetwork/lorawan-devices. Wire format from
// the documented Rejeee LoRaWAN sensor-data protocol (SL710 User Manual, section 4;
// doc.rejeee.com): over LoRaWAN the FRMPayload (fPort 1) is a sequence of TLV
// sensor-data blocks. Block 0x00 = device information (3-bit version, 5-bit
// battery level, reserve). Block 0x07 = Pressure, a 4-byte signed integer in Pa
// (the calibrated hydrostatic water pressure, range 0-3.5 MPa). Reproduced as original work — no upstream decoder
// is copied. device.json ttn is null.
function i32be(b, k) {
  return ((b[k] & 0xff) << 24) | ((b[k + 1] & 0xff) << 16) | ((b[k + 2] & 0xff) << 8) | (b[k + 3] & 0xff);
}
