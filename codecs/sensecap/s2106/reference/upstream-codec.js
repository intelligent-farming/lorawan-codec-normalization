// Authoring reference only — NOT shipped in the npm tarball (see package.json
// "files": "!codecs/**/reference") and NOT executed by this module.
//
// The Seeed SenseCAP S2106 LoRaWAN pH sensor uses the documented SenseCAP S210X
// uplink format (SenseCAP API docs, "List of Measurement IDs",
// sensecap-docs.seeed.cc/measurement_list.html; product page
// seeedstudio.com/SenseCAP-S2106-p-5647.html). The wire format below is
// reproduced as original work — no upstream decoder is copied — and was
// cross-checked against an independent community decoder. device.json ttn is null.
//
// Payload = one or more 7-byte telemetry frames followed by a 2-byte CRC
// (transmitted but not validated here). Each frame: b0 channel; b1..2
// measurement ID (uint16, little-endian); b3..6 value (int32, little-endian,
// scaled /1000). Measurement ID 4106 = Water pH (0-14). Special IDs <= 4096
// (version 0, sensor EUI 2/3, battery+interval 7, ...) are control frames;
// ID 7 carries battery percent. The S2106 reports measurement ID 4106.
function i32le(b, k) {
  var v = (b[k] & 0xff) | ((b[k + 1] & 0xff) << 8) | ((b[k + 2] & 0xff) << 16) | ((b[k + 3] & 0xff) << 24);
  return v;
}
function reference(bytes) {
  var out = {};
  var n = bytes.length - 2; // drop trailing CRC
  for (var k = 0; k + 7 <= n; k += 7) {
    var id = (bytes[k + 1] & 0xff) | ((bytes[k + 2] & 0xff) << 8);
    if (id > 4096) { out['m' + id] = i32le(bytes, k + 3) / 1000; }
    else if (id === 7) { out.batteryPercent = (bytes[k + 4] << 8) | bytes[k + 3]; }
  }
  return out;
}
