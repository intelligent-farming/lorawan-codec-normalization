// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for arwin-technology/lrs20310 (LRS20310 Water Leak Sensor).
//
// Ported from the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/arwin-technology/lrs20310.js,
// attributed in NOTICE). Wire format preserved; output normalized to the
// shared vocabulary. Upstream normalizeUplink was NOT copied.
//
// Wire format:
//   fPort 10, bytes[0]==5: sensor data
//     bytes[1] = event bitmask (bit0 heartbeat, bit1 reserved,
//                bit2 water_leak_alert, bit3 cable_break_alert)
//     bytes[2] = battery percentage (0..100)
//     bytes[3] = water leak level (0..100)
//   fPort 8: firmware version (major . minor . patch16)
//   fPort 12, bytes[0]==5: device settings
//   fPort 13, bytes[0]==5: threshold settings

var LRS20310_EVENTS = ['heartbeat', 'rsvd', 'water_leak_alert', 'cable_break_alert'];

function hex2dec(hex) {
  var dec = hex & 0xffff;
  if (dec & 0x8000) {
    dec = -(0x10000 - dec);
  }
  return dec;
}

function decodeUplinkCore(input) {
  var bytes = input.bytes;
  switch (input.fPort) {
    case 10: // sensor data
      switch (bytes[0]) {
        case 5:
          var evt = '';
          var leak = false;
          var cableBreak = false;
          var i;
          for (i = 0; i < 8; i++) {
            if ((0x01 << i) & bytes[1]) {
              var name = LRS20310_EVENTS[i];
              if (evt === '') {
                evt = name;
              } else {
                evt = evt + ',' + name;
              }
              if (name === 'water_leak_alert') {
                leak = true;
              }
              if (name === 'cable_break_alert') {
                cableBreak = true;
              }
            }
          }
          return {
            data: {
              water: {
                leak: leak
              },
              waterLeakLevel: bytes[3],
              batteryPercent: bytes[2],
              event: evt,
              cableBreak: cableBreak
            }
          };
        default:
          return { errors: ['unknown sensor type'] };
      }
    case 8: // firmware version
      var ver = bytes[0] + '.' + ('00' + bytes[1]).slice(-2) + '.' + ('000' + (bytes[2] << 8 | bytes[3])).slice(-3);
      return {
        data: {
          firmwareVersion: ver
        }
      };
    case 12: // device settings
      switch (bytes[0]) {
        case 5:
          return {
            data: {
              dataUploadInterval: hex2dec(bytes[1] << 8 | bytes[2]),
              numAdditionalUploads: bytes[4],
              additionalUploadsInterval: bytes[5]
            }
          };
        default:
          return { errors: ['unknown sensor type'] };
      }
    case 13: // threshold settings
      switch (bytes[0]) {
        case 5:
          return {
            data: {
              waterLeakAlertThreshold: bytes[1]
            }
          };
        default:
          return { errors: ['unknown sensor type'] };
      }
    default:
      return { errors: ['unknown FPort'] };
  }
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "arwin-technology";
    result.data.model = "lrs20310";
  }
  return result;
}
