// Authoring reference only — NOT shipped in the npm tarball (see package.json
// "files": "!codecs/**/reference") and NOT executed by this module.
//
// Source: official RAKwireless/RadioBridge MIT-licensed payload decoder,
// @radiobridge/packet-decoder (github.com/RadioBridge/Packet-Decoder,
// src/decoders/HBVibrationSensor.ts; MIT, (c) Radio Bridge Inc.). The RBS306-VSHB
// (high-bandwidth vibration sensor) is NOT handled by the shared
// radio_bridge_packet_decoder.js used by the other RadioBridge devices, so this
// dedicated decoder is the wire-format reference. Doc example (DecoderDocs/
// HBVibrationSensor.md): 1f1c001c2c1ba8 -> axis Channel 1, Periodic Report,
// velocity 0.28 in/s, g-force 11 g, temp 27 C, bias 1.68 V.
//
// Frame: b0 protocol(high nibble)+counter; b1 type/axis (0x1C-0x1F = Channel
// 1-4); b2 event (low nibble); b3 low-freq peak velocity (/100 inches/sec);
// b4 high-freq peak g-force (/4 g); b5 accelerometer temperature (signed C);
// b6 bias voltage (/100 V).
function s8(b) { return (b & 0x80) ? b - 0x100 : b; }
function decodeUplink(input) {
  var b = input.bytes;
  var d = { axis: b[1] - 27, event: b[2] & 0x0f,
    vibration_velocity: (b[3] > 0 ? b[3] / 100 : 0),
    vibration_gforce: b[4] / 4,
    accelerator_temp: s8(b[5]),
    bias_voltage: b[6] / 100 };
  return { data: d };
}
