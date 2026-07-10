// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for elv/elv-lw-oc8 (ELV-LW-OC8 Open Collector 8-fold:
// eight open-collector output channels whose on/off states are reported).
// Category: analog-interface.
//
// Original work for @intelligent-farming/lorawan-codec-normalization. Wire
// format understood with reference to the upstream Apache-2.0 ELV decoder
// (TheThingsNetwork/lorawan-devices vendor/elv/elv-lw-oc8.js, attributed in
// NOTICE). The uplink (fPort 10) is a TLV stream of typed records; upstream
// flattens each channel into ch1..ch8 (0/1) plus version/tx_reason/supply.
// This module walks the same records and authors the normalized vocabulary.
// Upstream normalization is never copied.
//
// TLV record types (fPort 10):
//   0x01 app version    : 3 bytes  -> appVersion (extra, "Vx.y.z")
//   0x02 bootloader ver : 3 bytes  -> blVersion (extra)
//   0x03 tx reason      : 1 byte   -> txReason (extra, event name)
//   0x04 supply voltage : 2 bytes  mV -> supplyVoltage (V extra; mV / 1000)
//   0x07 output states  : count(1)=1 then 1 bitfield byte
//                         bit b -> channel (b+1) state
//   0x08 interval       : 1 byte   -> interval (extra)
//   0x09 contact iface  : 1 byte   -> contactInterfaceEnabled (boolean extra)
//
// Channel-1 mapping: output channel 1 -> action.contactState ('closed' if the
// collector is on, else 'open'). Channels 2..8 -> contactState2..contactState8
// (boolean camelCase extras). An unknown record type is a hard parser error.

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

var TX_REASON = [
  'UNDEFINED_EVENT', 'TIMER_EVENT', 'USER_BUTTON_EVENT', 'INPUT_1_EVENT',
  'INPUT_2_EVENT', 'INPUT_3_EVENT', 'INPUT_4_EVENT', 'INPUT_5_EVENT',
  'INPUT_6_EVENT', 'INPUT_7_EVENT', 'INPUT_8_EVENT', 'APP_EVENT',
  'CYCLIC_EVENT', 'TIMEOUT_EVENT', 'DOWNLINK_ACK_EVENT', 'DOWNLINK_ERROR_EVENT'
];

function decodeUplinkCore(input) {
  var b = input.bytes;
  if (input.fPort !== 10) {
    return { errors: ['unsupported fPort ' + input.fPort + ' (expected 10)'] };
  }
  if (!b || b.length === 0) {
    return { errors: ['empty payload'] };
  }

  var data = {};
  var i = 0;

  while (i < b.length) {
    var type = b[i];

    if (type === 0x01) {
      data.appVersion = 'V' + b[i + 1] + '.' + b[i + 2] + '.' + b[i + 3];
      i += 4;
    } else if (type === 0x02) {
      data.blVersion = 'V' + b[i + 1] + '.' + b[i + 2] + '.' + b[i + 3];
      i += 4;
    } else if (type === 0x03) {
      var r = b[i + 1];
      data.txReason = r < TX_REASON.length ? TX_REASON[r] : 'UNKNOWN_EVENT';
      i += 2;
    } else if (type === 0x04) {
      data.supplyVoltage = round(((b[i + 1] << 8) | b[i + 2]) / 1000, 3);
      i += 3;
    } else if (type === 0x07) {
      // count byte then, if 1, a bitfield of the 8 channel states.
      var count = b[i + 1];
      if (count === 1) {
        var bits = b[i + 2];
        data.action = { contactState: (bits & 0x01) ? 'closed' : 'open' };
        var ch;
        for (ch = 1; ch < 8; ch++) {
          data['contactState' + (ch + 1)] = Boolean((bits >> ch) & 0x01);
        }
        i += 3;
      } else {
        i += 2;
      }
    } else if (type === 0x08) {
      data.interval = b[i + 1];
      i += 2;
    } else if (type === 0x09) {
      data.contactInterfaceEnabled = Boolean(b[i + 1]);
      i += 2;
    } else {
      return { errors: ['unknown ELV-LW-OC8 record type 0x' + type.toString(16)] };
    }
  }

  return { data: data };
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "elv";
    result.data.model = "elv-lw-oc8";
  }
  return result;
}
