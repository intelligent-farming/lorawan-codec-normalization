// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Normalized payload codec for acrios/acr-cv-101l-m-eac
// (ACRIOS ACR-CV-101L-M-EAC, externally-powered M-Bus to LoRaWAN converter).
//
// Ported from the upstream Apache-2.0 decoder
// (TheThingsNetwork/lorawan-devices vendor/acrios/acr-cv-101l-m-x.js, attributed
// in NOTICE). The upstream wraps the tmbus library (Taras Greben, Apache-2.0)
// to decode the framed M-Bus telegram carried over LoRaWAN. The tmbus decode
// (frame validation, fixed CI=0x73 / variable CI=0x72|0x76 record parsing,
// DIF/VIF unit resolution) is reproduced here faithfully as console-safe ES5;
// the front-end de-fragmentation guard (frame index / batch-frame count in the
// first two bytes) is preserved. We author the normalization ourselves; we do
// NOT copy the upstream output as our measurement.
//
// This converter retrofits ANY M-Bus meter, but the EAC variant is fielded on
// water meters. Normalization maps the meter's CURRENT cumulative VOLUME reading
// (the storage-0 / actual record) to metering.water.total in LITRES:
//   m3 x 1000, l x 1, ml / 1000.
// Decode-only telemetry from the telegram (M-Bus secondary address, device type,
// access number, application status) is carried as camelCase extras. If the
// attached meter is not a volume meter, no vocabulary key is produced and an
// error is returned.

function decodeUplinkCore(input) {
  var bytes = input.bytes;
  if (!bytes || bytes.length < 2) {
    return { errors: ['payload too short'] };
  }

  function round(value, decimals) {
    var f = Math.pow(10, decimals);
    return Math.round(value * f) / f;
  }

  // ---- de-fragmentation guard (upstream front-end) -------------------------
  // First byte = frame index, second byte = batch-frame count. Only a single
  // unfragmented frame (1, 1) is decodable on-device.
  var frameIndex = bytes[0];
  var batchFrames = bytes[1];
  if (frameIndex !== 1 || batchFrames !== 1) {
    return { errors: ['fragmented frame not supported (frameIndex ' + frameIndex + ', batchFrames ' + batchFrames + ')'] };
  }

  // ---------------------------------------------------------------------------
  // tmbus decode (ported). Operates on the M-Bus telegram following the 2-byte
  // fragmentation header. Returns a record object or throws a string on a
  // malformed frame.
  // ---------------------------------------------------------------------------
  var frame = bytes.slice(2);

  function ln(t) { return t ? t.length || 0 : 0; }
  function sNc(c, i) { return i > 0 ? Array(i + 1).join(c) : ''; }
  function sIn(s, i, n) { return i ? s.slice(0, i) + n + s.slice(i) : n + s; }

  function p10(n, e) {
    if (!e) { return n; }
    var s = ln(n);
    if (!s) {
      var iv = parseInt(n, 10);
      if (n !== iv) { return isNaN(iv) ? n : n * Math.pow(10, e); }
    }
    var t = '' + n, b = (s ? t[0] === '-' : n < 0) ? 1 : 0, l = ln(t);
    if (e > 0) { t += sNc('0', e); }
    else {
      e += l - b;
      if (e < 0) { t = sIn(t, b, sNc('0', -e)); }
      t = sIn(t, e <= 0 ? b : e + b, '.');
    }
    return s ? t : Number(t);
  }

  function ba2i(a) {
    var i = ln(a);
    if (!i || i > 4) { return i ? a : 0; }
    var r = a[--i], m = i === 3 ? 0 : r & 128 ? (r &= 127, -(1 << (i * 8 + 7))) : 0;
    while (i) { r = (r << 8) + a[--i]; }
    return r + m;
  }

  function ba2b(a) {
    var i = ln(a), r = 0;
    while (i) { r = (r << 8) + a[--i]; }
    return r;
  }

  function ba2bcd(a, x) {
    var r = 0, i = ln(a), v, h, l, s = '', e = 0, m = 0;
    function p(c) {
      if (m) { c = -c; }
      if (c < 10) { s += c; }
      else { e = 1; s += 'A-C EF'.charAt(c - 10); }
    }
    while (i) {
      v = a[--i]; h = (v & 0xF0) >> 4; l = v & 0xF;
      if (m) { h = -h; l = -l; }
      r = r * 100 + h * 10 + l;
      p(h);
      if (ln(s) === 1) {
        e = 0;
        if (h === 13) { e = 1; }
        else if (h > 13) {
          m = 1; l = -l; r = l;
          if (h === 14) { r -= 10; }
        }
      }
      p(l);
    }
    if (!x && e) { throw s; }
    return e ? s : r;
  }

  function ba2f(a) {
    var l = ln(a) - 1, s = 7;
    if (l === 7) { s = 4; }
    else if (l !== 3) { return NaN; }
    var b = l - 1, m = (1 << s) - 1, f = (a[b] & m) << (b * 8), h = 1 << (b * 8 + s), y = 1 << (14 - s),
      e = (a[b] >> s) + ((a[l] & 0x7F) << (8 - s)) + 1 - y, g = a[l] >> 7 ? -1 : 1, i;
    for (i = 0; i < b; ++i) { f += a[i] << (i * 8); }
    if (e === y) { return g * (f ? NaN : Number.POSITIVE_INFINITY); }
    if (f) { f = e === 1 - y ? f / (h >> 1) : (f | h) / h; }
    return g * f * Math.pow(2, e);
  }

  function ha2si(a) {
    var l = ln(a = a.slice()), d = [], r = a[l - 1], m = r & 128, i, f;
    if (m) {
      for (i = f = 0; i < l; ++i) {
        if (a[i] || f) { a[i] = 256 - a[i] - f; f = 1; }
      }
    }
    for (i = l, f = 0; i;) { if (a[--i]) { f = 1; } }
    if (!f) { return 0; }
    do {
      r = f = 0; i = l;
      while (i) {
        var n = r * 256 + a[--i];
        r = n % 10;
        if (a[i] = (n - r) / 10) { f = 1; }
      }
      d.push(r);
    } while (f);
    for (i = ln(d); !d[--i];) { /* trim */ }
    return (m ? '-' : '') + d.slice(0, ++i).reverse().join('');
  }

  function sum(a, b, e) {
    var r = 0, i = b || 0;
    while (i < (e || ln(a))) { r += a[i++]; }
    return r & 0xFF;
  }

  function i2c(i) { return String.fromCharCode(i); }
  function ba2s(a) {
    var r = [], i = ln(a);
    while (i) { r.push(i2c(a[--i])); }
    return r.join('');
  }

  // ---- frame parse ---------------------------------------------------------
  var a = frame.slice(), isA = Array.isArray, O = [0], R = 'Reserved';
  while (ln(a)) { if (a[0] !== 255) { break; } else { a.splice(0, 1); } }
  var l = ln(a), eEnd = l - 2, r = { len: l }, idCounter = 0, n = 0, c, w;
  if (!l) { return { errors: ['empty M-Bus frame'] }; }

  var parseError = null;
  function er(s) { throw (s || 'Wrong frame length') + ', pos ' + n; }
  function rdi() { if (n === l) { er(); } return (c = a[n++]); }
  function sl(t, s) {
    var p = n, rr = s + n;
    if (rr > eEnd) { er('Premature end of data when reading ' + t + ' (need ' + s + ', available ' + (eEnd - n) + ')'); }
    n = rr;
    return a.slice(p, n);
  }
  function ii(t, b, s) {
    var rr = sl(t, s || 4);
    return b ? ba2i(b === 2 ? rr.reverse() : rr) : ba2bcd(rr, 1);
  }
  function aSum(b) { if (sum(a, b, eEnd) !== a[eEnd]) { er('Check sum failed'); } }

  // M-Bus device-type table (used for identity reporting).
  var M = ' meter', S = ['Heat' + M, 'Cooling' + M, ' (Volume measured at ', 'return temperature: outlet)', 'flow temperature: inlet)', 'Customer unit', 'Radio converter ', 'Access Code '];
  var D = ['Other', 'Oil' + M, 'Electricity' + M, 'Gas' + M, S[0], 'Steam' + M, 'Hot water' + M, 'Water' + M, 'Heat Cost Allocator', R,
    S[0] + S[2] + S[3], 'Compressed air', S[1] + S[2] + S[3], S[1] + S[2] + S[4], S[0] + S[2] + S[4], 'Combined Heat / ' + S[1], 'Bus / System component', 'Unknown device type', 'Cold water' + M, 'Dual water' + M,
    'Pressure' + M + ' / pressure device', 'A/D Converter', 'Warm water' + M, 'Calorific value', 'Smoke detector / smoke alarm device', 'Room sensor', 'Gas detector', 'Consumption' + M, 'Sensor', 'Breaker (electricity)',
    'Valve (gas or water)', 'Switching device', S[5] + ' (display device)', S[5], 'Waste water' + M, 'Garbage', 'Carbon dioxide', 'Environmental' + M, 'System device', 'Communication controller',
    'Unidirectional repeater', 'Bidirectional repeater', S[6] + '(system side)', S[6] + '(meter side)', 'Wired Adapter'];
  var fD = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 3, 4, 5, 6, 7, 8, 9];
  var vD = [0, 1, 2, 3, 10, 5, 22, 7, 8, 11, 12, 13, 14, 15, 16, 17,
    27, 27, 27, 27, 23, 6, 18, 19, 20, 21, 24, 25, 26, 28, 28, 28,
    29, 30, 31, 31, 31, 32, 33, 33, 34, 35, 36, 37, 37, 37, 37, 37,
    38, 39, 40, 41, 38, 38, 42, 43, 44];
  var vFunc = ['Instantaneous', 'Maximum', 'Minimum', 'During error state'];

  function i2fu(iv) {
    var U = ['Wh', 'kWh', 'MWh', 'kJ', 'MJ', 'GJ', 'W', 'kW', 'MW', 'kJ/h', 'MJ/h', 'GJ/h', 'ml', 'l', 'm\xB3', 'ml/h', 'l/h', 'm\xB3/h'];
    return iv < 2 ? [['h,m,s', 'D,M,Y'][iv], 0]
      : iv < 0x38 ? [U[Math.floor((iv - 2) / 3)], (iv - 2) % 3]
        : iv < 0x39 ? ['\xB0C', -3]
          : iv < 0x3A ? ['Units for H.C.A.', 0]
            : [R, 0];
  }

  function m2c(iv) { return i2c((iv & 0x1F) + 64); }
  function deManIdi(nn) { return m2c(nn >> 10) + m2c(nn >> 5) + m2c(nn); }
  function deManId() { return deManIdi(ii('ManID', 1, 2)); }
  function deD(iv) { return D[iv > 0x3F ? 9 : iv > 0x38 ? 38 : vD[iv]]; }

  function deS(rr) {
    var s = rr.status;
    if (rr.fixed) { rr.cStored = s & 2 ? 'At fixed date' : 'Actual'; }
    else {
      if ((s & 3) !== 3) {
        if (s & 1) { w.push('Application Busy'); }
        if (s & 2) { w.push('Application Error'); }
      }
    }
    if (s & 4) { w.push('Power Low'); }
    if (s & 8) { w.push('Permanent Error'); }
    if (s & 16) { w.push('Temporary Error'); }
    return s & 1;
  }

  function nv() {
    if (!r.data) { r.data = []; }
    var v = { id: idCounter++ };
    r.data.push(v);
    return v;
  }
  function sD(d, m2) { r.deviceCode = d; r.deviceType = m2; }

  // ---- fixed-data (CI=0x73) record parse -----------------------------------
  function pF() {
    r.accessN = rdi();
    r.status = rdi();
    var s = deS(r), u1 = rdi(), u2 = rdi(), m = (u1 >> 6) | (u2 >> 4 & 0xC);
    sD(m, D[fD[m]]);
    if (m > 9 && m < 15 && s) { s = 2; }
    var x = nv(), y = nv(), ux = i2fu(u1 & 0x3f), vy = u2 & 0x3f, uy, v = 1;
    x.storage = 0;
    x.func = vFunc[0];
    x.value = p10(ii('Counter 1', s), ux[1]);
    x.unit = ux[0];
    if (vy === 0x3e) { uy = ux; }
    else {
      v = 0;
      if (vy !== 0x3f) { uy = i2fu(vy); }
    }
    y.storage = v;
    y.func = vFunc[0];
    v = ii('Counter 2', s);
    y.value = uy ? p10(v, uy[1]) : v;
    y.unit = uy ? uy[0] : '';
  }

  // ---- variable-data (CI=0x72/0x76) record parse ---------------------------
  var T = ['Reserved', 'Energy', 'Volume', 'Mass', 'On Time', 'Operating Time', 'Power', 'Volume Flow', 'Volume Flow ext.', 'Mass flow',
    'Flow Temperature', 'Return Temperature', 'Temperature Difference', 'External Temperature', 'Pressure', 'Time Point', 'Units for H.C.A.', 'Averaging Duration', 'Actuality Duration', 'Credit',
    'Debit', 'Access Number', 'Medium', 'Manufacturer', 'Parameter set id', 'Model/Version', 'Hardware version #', 'Firmware version #', 'Software version #', 'Customer location',
    'Customer', S[7] + 'User', S[7] + 'Operator', S[7] + 'System Operator', S[7] + 'Developer', 'Password', 'Error flags', 'Error mask', 'Digital Output', 'Digital Input',
    'Baudrate', 'Response delay time', 'Retry', 'First cyclic storage #', 'Last cyclic storate #', 'Storage block size', 'Storage interval', 'Duration since last readout', 'Start of tariff', 'Duration of tariff',
    'Period of tariff', 'Voltage', 'Current', 'Dimensionless', 'Reset counter', 'Cumulation counter', 'Control signal', 'Day of week', 'Week number', 'Time point of day change',
    'State of parameter activation', 'Special supplier information', 'Duration since last cumulation', 'Operating time battery', 'Battery change', 'Cold/Warm Temperature Limit', 'Cumul. count max power'];
  var UU = ['seconds', 'minutes', 'hours', 'days', 'months', 'years', 'Wh', 'J', 'm\xB3', 'kg',
    'W', 'J/h', 'm\xB3/h', 'm\xB3/min', 'm\xB3/s', 'kg/h', '\xB0C', 'K', 'bar', 'currency unit',
    'binary', 'baud', 'bittimes', 'V', 'A', 'MWh', 'GJ', 't', 'feet\xB3', 'american gallon',
    'american gallon/min', 'american gallon/h', 'MW', 'GJ/h', '\xB0F', 'revolution / measurement', 'liter', 'kWh', 'kW', 'K*l'];

  function deV(v, b, nn) {
    v.type = T[b[0]];
    var e = b[1];
    if (ln(b) > 1) {
      if (e === 5) { e = 9; nn += 2; }
      if (e === 9) { v.unit = UU[nn]; }
      else if (e === 8) {
        v.type += ' (' + (nn ? 'time & ' : '') + 'date)';
        v.isDate = 1;
      } else if (e > 5) { v.fkind = e === 7 ? 'deD' : 'deManIdi'; }
      else {
        v.unit = UU[b[2]];
        v.e = nn + b[1];
      }
    }
  }

  function deVif(v, d) {
    var t = d >> 3 & 0xF, nn = d & 7, m = [
      [1, -3, 6], [1, 1, 7], [2, -6, 8], [3, -3, 9], [[4, 9], [5, 9]],
      [6, -3, 10], [6, 1, 11], [7, -6, 12], [8, -7, 13], [8, -9, 14],
      [9, -3, 15], [[10, -3, 16], [11, -3, 16]], [[12, -3, 17], [13, -3, 16]],
      [[14, -3, 18], [[15, 8], [[16], O]]], [[17, 9], [18, 9]]];
    if (t === 0xF) {
      if (nn < 3) { v.type = ['Fabrication No', '(Enhanced)', 'Bus Address'][nn]; }
    } else {
      var b = m[t], i = 2;
      for (; isA(b[0]); nn &= 0xF ^ (1 << i), b = b[d >> i-- & 1]) { /* descend */ }
      deV(v, b, nn);
    }
  }

  function deVifD(v, d) {
    var t = d >> 2 & 0xF, nn = d & 3, m = [
      [19, -3, 19], [20, -3, 19], [[21], [22, 7], [23, 6], [24]],
      [[25], [26], [27], [28]], [[29], [30], [31], [32]], [[33], [34], [35], [36, 0, 20]],
      [[37], O, [38, 0, 20], [39, 0, 20]], [[40, 0, 21], [41, 0, 22], [42], O],
      [[43], [44], [45], O], [46, 9], [[46, 0, 4], [46, 0, 5], O, O], [47, 9],
      [[48, 8], [49, 0, 1], [49, 0, 2], [49, 0, 3]], [50, 9],
      [[50, 0, 4], [50, 0, 5], [53], O], O, [[54], [55], [56], [57]],
      [[58], [59], [60], [61]], [62, 5], [63, 5], [[64, 8]]];
    if (d & 0x40) { t = (t & 7) + 16; }
    var b = d > 0x70 ? O : m[t];
    if ((d & 0x60) === 0x40) {
      t = d & 16; nn = d & 0xF;
      b = t ? [52, -12, 24] : [51, -9, 23];
    } else {
      if (isA(b[0])) { b = b[nn]; nn = 0; }
    }
    deV(v, b, nn);
  }

  function deVifB(v, d) {
    var t = d >> 3 & 0xF, nn = d & 7, m = [
      [[[1, -1, 25]]], [[[1, -1, 26]]], [[[2, 2, 8]]], [[[3, 2, 27]]],
      [[[O, [2, -1, 28]], [[2, -1, 29], [2, 0, 29]]], [[[7, -3, 30], [7, 0, 30]], [[7, 0, 31], O]]],
      [[[6, -1, 32]]], [[[6, -1, 33]]], O, O, O, O,
      [[10, -3, 34], [11, -3, 34]], [[12, -3, 34], [13, -3, 34]], O,
      [[65, -3, 34], [65, -3, 16]], [66, -3, 10]];
    var b = m[t], i = 2;
    for (; isA(b[0]); nn &= 0xF ^ (1 << i), b = d >> i-- & 1 ? (ln(b) < 2 ? O : b[1]) : b[0]) { /* descend */ }
    deV(v, b, nn);
  }

  function rif(arr) {
    var v = ln(arr);
    v = v ? arr[v - 1] : 128;
    while (n < eEnd && v >> 7) {
      v = a[n++];
      arr.push(v);
    }
    return arr;
  }

  function deVifs(v) {
    var y = v.vif, l2 = ln(y), i = 0, t = y[i], m = 0x7F, d = t & m, b;
    if (t === 0xFD || t === 0xFB) {
      d = y[++i] & m;
      (t === 0xFD ? deVifD : deVifB)(v, d);
    } else if (d < 0x7C) { deVif(v, d); }
    else if (d === 0x7C) {
      b = a[(n -= l2 - 2) - 1];
      v.type = ba2s(sl('VIF type', b));
      y = v.vif = rif([t]);
      l2 = ln(y);
    }
    if (d === m) { v.type = 'Manufacturer specific'; }
    if (!(y[i] >> 7)) { return; }
    if (d !== m) { ++i; }
    // Walk the VIFE chain for stream alignment. Only exponent-correction VIFEs
    // (0x70..0x77 multiplicative, 0x7D additive 1e3) affect the decoded value;
    // upstream's descriptive VIFE text is not needed for normalization.
    b = 0;
    while (i < l2 && i < 11) {
      t = y[i++]; d = t & m;
      if (!b) {
        if (d >= 0x70 && d < 0x78) { v.e = (v.e || 0) + (d & 7) - 6; }
        else if (d === 0x7D) { v.e = (v.e || 0) + 3; }
        b = d === m;
      }
      if (!(t & 0x80)) { break; }
    }
  }

  function rv(v) {
    deVifs(v);
    var y = v.dif, l2 = ln(y) - 1, p, i, d = y[0], f = d >> 4 & 3, t = d & 0xF, m, b = d & 7, s;
    if (t === 0xD) {
      p = b = a[n++];
      if (b < 0xC0) { m = 'ba2s'; }
      else {
        b &= 0xF;
        if (p > 0xEF) { if (p < 0xFB) { m = 'ba2f'; } }
        else {
          m = p > 0xDF ? 'ba2i' : 'ba2bcd';
          s = (p & 0xF0) === 0xD0;
        }
      }
    } else {
      if (b === 5) { --b; m = 'ba2f'; }
      else {
        if (b === 7) { ++b; }
        m = t & 8 ? 'ba2bcd' : 'ba2i';
      }
    }
    i = t = sl('Record #' + v.id, b);
    if (m) {
      try {
        if (m === 'ba2s') { t = ba2s(t); }
        else if (m === 'ba2f') { t = ba2f(t); }
        else if (m === 'ba2i') { t = ba2i(t); }
        else { t = ba2bcd(t); }
      } catch (e) { v.error = true; t = e; }
    }
    if (!v.error) {
      m = isA(t);
      if (m) { t = ha2si(t); }
      if (s) { t = m ? (t[0] === '-' ? t.slice(1) : ('-' + t)) : -t; }
      if (v.e) { t = p10(t, v.e); }
      if (v.isDate) { t = ba2b(isA(i) ? i : [i]); }
      else if (v.fkind === 'deD') { t = deD(typeof t === 'number' ? t : 0); }
      else if (v.fkind === 'deManIdi') { t = deManIdi(typeof t === 'number' ? t : 0); }
    }
    v.value = t;
    v.func = vFunc[f];
    d >>= 6; f = d & 1;
    if (d & 2) {
      for (i = 0; i < l2; ++i) {
        d = y[i + 1];
        f += (d & 0xF) << (i * 4 + 1);
      }
    }
    v.storage = f;
    delete v.isDate;
    delete v.fkind;
    delete v.e;
    delete v.dif;
    delete v.vif;
  }

  function pV() {
    r.manId = deManId();
    r.version = rdi(); rdi();
    sD(c, deD(c));
    r.accessN = rdi();
    r.status = rdi();
    deS(r);
    n += 2;
    var guard = 0;
    while (n < eEnd - 1 && guard < 64) {
      guard++;
      var t = a[n];
      if (t === 0x2F) { ++n; continue; }
      var v = nv();
      if ((t & 0xF) === 0xF) {
        t = t >> 4 & 7; ++n;
        if (t < 2) {
          if (t) { v.request = 'Readout again'; }
          v.type = 'Manufacturer specific';
          v.value = sl(v.type, eEnd - n);
        } else if (t > 6) { v.request = 'Global readout'; }
      } else {
        v.dif = rif([]);
        v.vif = rif([]);
        rv(v);
      }
    }
  }

  // ---- run the frame state machine -----------------------------------------
  try {
    w = r.errors = [];
    rdi();
    if (l === 1) {
      if (c === 0xe5) { r.type = 'OK'; }
      else { er('Invalid char'); }
    } else {
      if (l < 5) { er(); }
      if (a[l - 1] !== 0x16) { er('No Stop'); }
      if (c === 0x10) {
        r.type = 'Short';
        aSum(1);
        r.c = rdi();
        r.a = rdi();
      } else {
        if (c !== 0x68) { er('No Start'); }
        r.type = 'Data';
        r.l = rdi();
        if (a[2] !== c) { er('Invalid length'); }
        if (a[0] !== a[3]) { er('Invalid format'); }
        if (c !== l - 6) { er('Wrong length'); }
        aSum(n = 4);
        r.c = rdi();
        r.a = rdi();
        r.ci = rdi();
        if ((c & 0xFA) === 0x72) {
          r.fixed = (c & 1) === 1;
          r.id = ii('ID');
          if (r.fixed) { pF(); } else { pV(); }
        } else {
          r.type = 'Error';
          er('Unsupported CI field 0x' + c.toString(16));
        }
      }
    }
  } catch (e) {
    parseError = String(e);
  }

  if (parseError) {
    return { errors: ['M-Bus decode failed: ' + parseError] };
  }

  // ---------------------------------------------------------------------------
  // Normalization (authored): map the current cumulative VOLUME to litres.
  // ---------------------------------------------------------------------------
  var records = r.data || [];

  // Volume units the meter can report and their litre conversion factor.
  function litreFactor(unit) {
    if (unit === 'm\xB3') { return 1000; }
    if (unit === 'l' || unit === 'liter') { return 1; }
    if (unit === 'ml') { return 0.001; }
    return null;
  }

  // The current cumulative reading is the storage-0 Instantaneous record.
  // Fixed frames carry no record "type" (the device type alone identifies a
  // water meter); variable frames tag the record type explicitly as "Volume".
  var litres = null;
  var i;
  for (i = 0; i < records.length; i++) {
    var rec = records[i];
    if (rec.storage !== 0 || rec.func !== 'Instantaneous') { continue; }
    if (typeof rec.value !== 'number') { continue; }
    var factor = litreFactor(rec.unit);
    var isVolume = rec.type === 'Volume' || (rec.type === undefined && factor !== null);
    if (isVolume && factor !== null) {
      litres = round(rec.value * factor, 3);
      break;
    }
  }

  if (litres === null) {
    return { errors: ['no cumulative volume reading in M-Bus telegram (device type "' + (r.deviceType || 'unknown') + '")'] };
  }

  var data = {};
  data['metering.water.total'] = litres;
  if (r.id !== undefined) { data.meterId = r.id; }
  if (r.manId !== undefined) { data.manufacturerId = r.manId; }
  if (r.deviceType !== undefined) { data.deviceType = r.deviceType; }
  if (r.accessN !== undefined) { data.accessNumber = r.accessN; }
  if (r.status !== undefined) { data.statusByte = r.status; }

  var result = { data: data };
  if (w && w.length) { result.warnings = w.slice(); }
  return result;
}

// Device identity (make/model), emitted on every successful decode. See AUTHORING.md.
function decodeUplink(input) {
  var result = decodeUplinkCore(input);
  if (result && result.data) {
    result.data.make = "acrios";
    result.data.model = "acr-cv-101l-m-eac";
  }
  return result;
}
