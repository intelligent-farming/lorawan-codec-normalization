// Authoring reference only — NOT shipped in the npm tarball (see package.json
// "files": "!codecs/**/reference") and NOT executed by this module.
//
// The Netvox RA0708 wireless pH sensor is not in TheThingsNetwork/lorawan-devices.
// Its wire format follows the documented "Netvox LoRaWAN Application Command"
// ReportDataCmd layout (product manual: netvox.com.tw RA0708; datasheet
// netvox.com.tw/um/RA0708). It is reproduced here as original work — no upstream
// decoder is copied. Scaling was additionally cross-checked against an
// independent community decoder. device.json ttn is null.
//
// fPort 6 ReportDataCmd, 11 bytes: b0 version (0x01); b1 device type (0x05,
// RA07 series); b2 report/sensor type (0x08 = pH sensor); b3 battery in 0.1 V
// (high bit = low-battery flag); b4..5 pH x100 (0xFFFF = absent); b6..7 water
// temperature x100 signed (0xFFFF = absent); b8..9 ORP in mV (0xFFFF = absent);
// b10 reserved. Report type 0x00 is a version frame (no measurement).
function s16(hi, lo) { var v = ((hi & 0xff) << 8) | (lo & 0xff); return (v & 0x8000) ? v - 0x10000 : v; }
function u16(hi, lo) { return ((hi & 0xff) << 8) | (lo & 0xff); }
function absent(hi, lo) { return (hi & 0xff) === 0xff && (lo & 0xff) === 0xff; }

function decodeReport(bytes) {
  var d = {};
  d.battery = (bytes[3] & 0x7f) / 10;
  if (bytes[3] & 0x80) { d.lowBattery = true; }
  if (!absent(bytes[4], bytes[5])) { d.ph = u16(bytes[4], bytes[5]) / 100; }
  if (!absent(bytes[6], bytes[7])) { d.temperature = s16(bytes[6], bytes[7]) / 100; }
  if (!absent(bytes[8], bytes[9])) { d.orp = u16(bytes[8], bytes[9]); }
  return d;
}
