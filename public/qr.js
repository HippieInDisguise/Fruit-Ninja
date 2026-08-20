/* qr.js — minimal QR encoder. Byte mode, error correction level M, versions 1-10.
   No dependencies, no network. QR.make(text) -> { size, modules:[[bool]] }
   Enough capacity for ~213 characters, which covers any room link we generate. */
(function (root) {
  'use strict';

  // ---- GF(256) arithmetic, primitive polynomial 0x11d ----
  var EXP = new Uint8Array(512), LOG = new Uint8Array(256);
  (function () {
    var x = 1;
    for (var i = 0; i < 255; i++) {
      EXP[i] = x; LOG[x] = i;
      x <<= 1;
      if (x & 0x100) x ^= 0x11d;
    }
    for (var j = 255; j < 512; j++) EXP[j] = EXP[j - 255];
  })();
  function gmul(a, b) { return (a === 0 || b === 0) ? 0 : EXP[LOG[a] + LOG[b]]; }

  function rsGenerator(degree) {
    var poly = [1];
    for (var d = 0; d < degree; d++) {
      var next = new Array(poly.length + 1).fill(0);
      for (var i = 0; i < poly.length; i++) {
        next[i] ^= poly[i];
        next[i + 1] ^= gmul(poly[i], EXP[d]);
      }
      poly = next;
    }
    return poly;
  }

  function rsEncode(data, ecLen) {
    var gen = rsGenerator(ecLen);
    var res = new Array(ecLen).fill(0);
    for (var i = 0; i < data.length; i++) {
      var factor = data[i] ^ res[0];
      res.shift(); res.push(0);
      if (factor !== 0) for (var j = 0; j < gen.length - 1; j++) res[j] ^= gmul(gen[j + 1], factor);
    }
    return res;
  }

  // ---- Version tables for ECC level M ----
  // [totalCodewords, ecCodewordsPerBlock, [ [blockCount, dataCodewords], ... ] ]
  var VERSIONS = {
    1:  [26,  10, [[1, 16]]],
    2:  [44,  16, [[1, 28]]],
    3:  [70,  26, [[1, 44]]],
    4:  [100, 18, [[2, 32]]],
    5:  [134, 24, [[2, 43]]],
    6:  [172, 16, [[4, 27]]],
    7:  [196, 18, [[4, 31]]],
    8:  [242, 22, [[2, 38], [2, 39]]],
    9:  [292, 22, [[3, 36], [2, 37]]],
    10: [346, 26, [[4, 43], [1, 44]]]
  };
  var ALIGN = {
    1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30],
    6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50]
  };

  function dataCodewords(version) {
    var v = VERSIONS[version], n = 0;
    v[2].forEach(function (g) { n += g[0] * g[1]; });
    return n;
  }
  function countBits(version) { return version < 10 ? 8 : 16; }

  // ---- BCH helpers for format and version information ----
  function bch(value, generator, genBits) {
    var v = value << (genBits - 1);
    var top = 1 << (genBits - 1);
    for (var i = 31; i >= genBits - 1; i--) {
      if (v & (1 << i)) v ^= generator << (i - (genBits - 1));
    }
    return v;
  }
  function formatBits(maskId) {
    // ECC level M == 0b00
    var data = (0 << 3) | maskId;
    var rem = bch(data, 0x537, 11);
    return ((data << 10) | rem) ^ 0x5412;
  }
  function versionBits(version) {
    var rem = bch(version, 0x1f25, 13);
    return (version << 12) | rem;
  }

  // ---- Bit buffer ----
  function BitBuffer() { this.bits = []; }
  BitBuffer.prototype.put = function (value, length) {
    for (var i = length - 1; i >= 0; i--) this.bits.push((value >>> i) & 1);
  };

  function encodeToCodewords(bytes, version) {
    var buf = new BitBuffer();
    buf.put(0b0100, 4);                        // byte mode
    buf.put(bytes.length, countBits(version)); // character count
    for (var i = 0; i < bytes.length; i++) buf.put(bytes[i], 8);

    var capacity = dataCodewords(version) * 8;
    var terminator = Math.min(4, capacity - buf.bits.length);
    buf.put(0, terminator);
    while (buf.bits.length % 8 !== 0) buf.bits.push(0);

    var words = [];
    for (var b = 0; b < buf.bits.length; b += 8) {
      var w = 0;
      for (var k = 0; k < 8; k++) w = (w << 1) | buf.bits[b + k];
      words.push(w);
    }
    var pad = [0xec, 0x11], p = 0;
    while (words.length < dataCodewords(version)) words.push(pad[p++ % 2]);
    return words;
  }

  function interleave(words, version) {
    var spec = VERSIONS[version], ecLen = spec[1];
    var blocks = [], offset = 0;
    spec[2].forEach(function (g) {
      for (var i = 0; i < g[0]; i++) {
        var data = words.slice(offset, offset + g[1]);
        offset += g[1];
        blocks.push({ data: data, ec: rsEncode(data, ecLen) });
      }
    });
    var out = [], maxData = 0;
    blocks.forEach(function (b) { maxData = Math.max(maxData, b.data.length); });
    for (var i = 0; i < maxData; i++)
      blocks.forEach(function (b) { if (i < b.data.length) out.push(b.data[i]); });
    for (var j = 0; j < ecLen; j++)
      blocks.forEach(function (b) { out.push(b.ec[j]); });
    return out;
  }

  // ---- Matrix construction ----
  function buildMatrix(version) {
    var size = version * 4 + 17;
    var m = [], reserved = [];
    for (var r = 0; r < size; r++) {
      m.push(new Array(size).fill(0));
      reserved.push(new Array(size).fill(false));
    }
    function set(r, c, v) { m[r][c] = v ? 1 : 0; reserved[r][c] = true; }

    function finder(row, col) {
      for (var dr = -1; dr <= 7; dr++) for (var dc = -1; dc <= 7; dc++) {
        var r = row + dr, c = col + dc;
        if (r < 0 || r >= size || c < 0 || c >= size) continue;
        var inner = dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6;
        var dark = inner && (dr === 0 || dr === 6 || dc === 0 || dc === 6 ||
          (dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4));
        set(r, c, dark);
      }
    }
    finder(0, 0); finder(0, size - 7); finder(size - 7, 0);

    for (var i = 8; i < size - 8; i++) {
      set(6, i, i % 2 === 0);
      set(i, 6, i % 2 === 0);
    }

    var centers = ALIGN[version];
    for (var a = 0; a < centers.length; a++) for (var b = 0; b < centers.length; b++) {
      var cr = centers[a], cc = centers[b];
      if ((cr === 6 && cc === 6) || (cr === 6 && cc === size - 7) || (cr === size - 7 && cc === 6)) continue;
      for (var dr2 = -2; dr2 <= 2; dr2++) for (var dc2 = -2; dc2 <= 2; dc2++) {
        var on = Math.max(Math.abs(dr2), Math.abs(dc2)) !== 1;
        set(cr + dr2, cc + dc2, on);
      }
    }

    set(size - 8, 8, true); // always-dark module

    // reserve format areas
    for (var f = 0; f < 9; f++) {
      if (!reserved[8][f]) { reserved[8][f] = true; m[8][f] = 0; }
      if (!reserved[f][8]) { reserved[f][8] = true; m[f][8] = 0; }
    }
    for (var g2 = 0; g2 < 8; g2++) {
      reserved[8][size - 1 - g2] = true;
      reserved[size - 1 - g2][8] = true;
    }
    if (version >= 7) {
      for (var vr = 0; vr < 6; vr++) for (var vc = 0; vc < 3; vc++) {
        reserved[vr][size - 11 + vc] = true;
        reserved[size - 11 + vc][vr] = true;
      }
    }
    return { modules: m, reserved: reserved, size: size };
  }

  function placeData(grid, codewords) {
    var size = grid.size, bitIndex = 0, dir = -1, row = size - 1;
    var bits = [];
    codewords.forEach(function (w) { for (var i = 7; i >= 0; i--) bits.push((w >> i) & 1); });

    for (var col = size - 1; col > 0; col -= 2) {
      if (col === 6) col--; // skip vertical timing column
      while (true) {
        for (var c = 0; c < 2; c++) {
          var cc = col - c;
          if (!grid.reserved[row][cc]) {
            grid.modules[row][cc] = bitIndex < bits.length ? bits[bitIndex++] : 0;
          }
        }
        row += dir;
        if (row < 0 || row >= size) { row -= dir; dir = -dir; break; }
      }
    }
  }

  function maskFn(id, r, c) {
    switch (id) {
      case 0: return (r + c) % 2 === 0;
      case 1: return r % 2 === 0;
      case 2: return c % 3 === 0;
      case 3: return (r + c) % 3 === 0;
      case 4: return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0;
      case 5: return (r * c) % 2 + (r * c) % 3 === 0;
      case 6: return ((r * c) % 2 + (r * c) % 3) % 2 === 0;
      default: return ((r + c) % 2 + (r * c) % 3) % 2 === 0;
    }
  }

  function applyFormat(grid, maskId) {
    var size = grid.size, bits = formatBits(maskId);
    // s(i) is bit i of the 15-bit format string, s14 being the most significant.
    function s(i) { return (bits >> i) & 1; }
    // Copy 1, wrapped around the top-left finder.
    for (var c = 0; c <= 5; c++) grid.modules[8][c] = s(14 - c);
    grid.modules[8][7] = s(8);
    grid.modules[8][8] = s(7);
    grid.modules[7][8] = s(6);
    for (var r = 0; r <= 5; r++) grid.modules[r][8] = s(r);
    // Copy 2, split between the bottom-left and top-right finders.
    for (var k = 0; k <= 6; k++) grid.modules[size - 1 - k][8] = s(14 - k);
    for (var j = 0; j <= 7; j++) grid.modules[8][size - 8 + j] = s(7 - j);
    grid.modules[size - 8][8] = 1;
  }

  function applyVersion(grid, version) {
    if (version < 7) return;
    var size = grid.size, bits = versionBits(version);
    for (var i = 0; i < 18; i++) {
      var b = (bits >> i) & 1;
      var r = Math.floor(i / 3), c = i % 3;
      grid.modules[r][size - 11 + c] = b;
      grid.modules[size - 11 + c][r] = b;
    }
  }

  function penalty(m) {
    var size = m.length, score = 0, i, j, run, dark = 0;
    // rule 1: runs of 5+
    for (i = 0; i < size; i++) {
      run = 1;
      for (j = 1; j < size; j++) {
        if (m[i][j] === m[i][j - 1]) { run++; } else { if (run >= 5) score += run - 2; run = 1; }
      }
      if (run >= 5) score += run - 2;
      run = 1;
      for (j = 1; j < size; j++) {
        if (m[j][i] === m[j - 1][i]) { run++; } else { if (run >= 5) score += run - 2; run = 1; }
      }
      if (run >= 5) score += run - 2;
    }
    // rule 2: 2x2 blocks
    for (i = 0; i < size - 1; i++) for (j = 0; j < size - 1; j++) {
      var v = m[i][j];
      if (v === m[i][j + 1] && v === m[i + 1][j] && v === m[i + 1][j + 1]) score += 3;
    }
    // rule 3: finder-like patterns
    var pat1 = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
    var pat2 = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
    function match(get, len) {
      var s = 0;
      for (var a = 0; a + 11 <= len; a++) {
        var ok1 = true, ok2 = true;
        for (var b = 0; b < 11; b++) {
          var val = get(a + b);
          if (val !== pat1[b]) ok1 = false;
          if (val !== pat2[b]) ok2 = false;
        }
        if (ok1) s += 40;
        if (ok2) s += 40;
      }
      return s;
    }
    for (i = 0; i < size; i++) {
      score += match(function (k) { return m[i][k]; }, size);
      score += match(function (k) { return m[k][i]; }, size);
    }
    // rule 4: dark module balance
    for (i = 0; i < size; i++) for (j = 0; j < size; j++) if (m[i][j]) dark++;
    var pct = dark * 100 / (size * size);
    score += Math.floor(Math.abs(pct - 50) / 5) * 10;
    return score;
  }

  function toBytes(text) {
    var out = [];
    for (var i = 0; i < text.length; i++) {
      var c = text.charCodeAt(i);
      if (c < 0x80) out.push(c);
      else if (c < 0x800) { out.push(0xc0 | (c >> 6), 0x80 | (c & 63)); }
      else { out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63)); }
    }
    return out;
  }

  function make(text) {
    var bytes = toBytes(text), version = 0;
    for (var v = 1; v <= 10; v++) {
      var needed = 4 + countBits(v) + bytes.length * 8;
      if (needed <= dataCodewords(v) * 8) { version = v; break; }
    }
    if (!version) throw new Error('Link is too long to encode as a QR code');

    var codewords = interleave(encodeToCodewords(bytes, version), version);
    var best = null;
    for (var mask = 0; mask < 8; mask++) {
      var grid = buildMatrix(version);
      placeData(grid, codewords);
      var m = grid.modules.map(function (row) { return row.slice(); });
      for (var r = 0; r < grid.size; r++) for (var c = 0; c < grid.size; c++) {
        if (!grid.reserved[r][c] && maskFn(mask, r, c)) m[r][c] ^= 1;
      }
      var out = { modules: m, reserved: grid.reserved, size: grid.size };
      applyFormat(out, mask);
      applyVersion(out, version);
      var p = penalty(out.modules);
      if (!best || p < best.penalty) best = { penalty: p, size: out.size, modules: out.modules };
    }
    return { size: best.size, modules: best.modules.map(function (r) { return r.map(Boolean); }), version: version };
  }

  /** Render into an <svg> element. */
  function toSvg(text, opts) {
    opts = opts || {};
    var q = make(text), quiet = opts.quiet == null ? 2 : opts.quiet;
    var dim = q.size + quiet * 2;
    var parts = [];
    for (var r = 0; r < q.size; r++) for (var c = 0; c < q.size; c++) {
      if (q.modules[r][c]) parts.push('M' + (c + quiet) + ' ' + (r + quiet) + 'h1v1h-1z');
    }
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + dim + ' ' + dim + '" shape-rendering="crispEdges" role="img" aria-label="Link to the phone page">' +
      '<rect width="' + dim + '" height="' + dim + '" fill="' + (opts.bg || '#ffffff') + '"/>' +
      '<path d="' + parts.join('') + '" fill="' + (opts.fg || '#000000') + '"/></svg>';
  }

  var QR = { make: make, toSvg: toSvg };
  if (typeof module !== 'undefined' && module.exports) module.exports = QR;
  else root.QR = QR;
})(typeof self !== 'undefined' ? self : this);
