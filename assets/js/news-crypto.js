/* ============================================================
 * news-crypto.js — 纯 JS 的 MD5 / SHA-1（无 WebCrypto 依赖）
 * ------------------------------------------------------------
 * 存在的唯一理由：财联社快讯接口 api3.cls.cn 的签名算法是
 *   sign = md5( sha1( 按 key 排序后的 query 串 ) )
 * 浏览器端没有内置 MD5，而 file:// 下 crypto.subtle 不可用，
 * 所以这里手写一份紧凑实现（约 130 行），让手机版也能直连
 * 财联社的签名接口，不用起后端。
 *
 * 已与 Python 的 hashlib 逐字节比对一致（见测试脚本）。
 * ============================================================ */
(function (w) {
  'use strict';

  /* ---------- UTF-8 编码 ---------- */
  function utf8Bytes(str) {
    var out = [], i, c;
    for (i = 0; i < str.length; i++) {
      c = str.charCodeAt(i);
      if (c < 0x80) {
        out.push(c);
      } else if (c < 0x800) {
        out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
      } else if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) {
        var c2 = str.charCodeAt(i + 1);
        if (c2 >= 0xdc00 && c2 <= 0xdfff) {
          var cp = 0x10000 + ((c - 0xd800) << 10) + (c2 - 0xdc00);
          out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 63),
            0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
          i++;
        } else {
          out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
        }
      } else {
        out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      }
    }
    return out;
  }

  function hex32be(v) {
    var s = (v >>> 0).toString(16);
    while (s.length < 8) s = '0' + s;
    return s;
  }

  /* MD5 的摘要字节序是 little-endian，逐字输出 */
  function hex32le(v) {
    v = v >>> 0;
    var b = [];
    for (var i = 0; i < 4; i++) b.push(('0' + ((v >>> (i * 8)) & 255).toString(16)).slice(-2));
    return b.join('');
  }

  /* ---------- SHA-1 ---------- */
  function sha1Bytes(bytes) {
    var h0 = 0x67452301, h1 = 0xEFCDAB89, h2 = 0x98BADCFE,
      h3 = 0x10325476, h4 = 0xC3D2E1F0;
    var msg = bytes.slice();
    var len = bytes.length;
    msg.push(0x80);
    while (msg.length % 64 !== 56) msg.push(0);
    var hi = Math.floor(len / 536870912), lo = (len * 8) >>> 0;
    msg.push((hi >>> 24) & 255, (hi >>> 16) & 255, (hi >>> 8) & 255, hi & 255);
    msg.push((lo >>> 24) & 255, (lo >>> 16) & 255, (lo >>> 8) & 255, lo & 255);

    var w = new Array(80), i, off;
    for (off = 0; off < msg.length; off += 64) {
      for (i = 0; i < 16; i++) {
        w[i] = (msg[off + i * 4] << 24) | (msg[off + i * 4 + 1] << 16)
          | (msg[off + i * 4 + 2] << 8) | msg[off + i * 4 + 3];
      }
      for (i = 16; i < 80; i++) {
        var t = w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16];
        w[i] = (t << 1) | (t >>> 31);
      }
      var a = h0, b = h1, c = h2, d = h3, e = h4;
      for (i = 0; i < 80; i++) {
        var f, k;
        if (i < 20) { f = (b & c) | ((~b) & d); k = 0x5A827999; }
        else if (i < 40) { f = b ^ c ^ d; k = 0x6ED9EBA1; }
        else if (i < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8F1BBCDC; }
        else { f = b ^ c ^ d; k = 0xCA62C1D6; }
        var tmp = (((a << 5) | (a >>> 27)) + f + e + k + w[i]) | 0;
        e = d; d = c; c = (b << 30) | (b >>> 2); b = a; a = tmp;
      }
      h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0;
      h3 = (h3 + d) | 0; h4 = (h4 + e) | 0;
    }
    return [h0 >>> 0, h1 >>> 0, h2 >>> 0, h3 >>> 0, h4 >>> 0];
  }

  function sha1Hex(str) {
    return sha1Bytes(utf8Bytes(str)).map(hex32be).join('');
  }

  /* ---------- MD5 ---------- */
  function md5Bytes(bytes) {
    var S = [
      7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
      5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
      4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
      6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21];
    var K = new Array(64), t;
    for (t = 0; t < 64; t++) {
      K[t] = (Math.floor(Math.abs(Math.sin(t + 1)) * 4294967296)) | 0;
    }

    var a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
    var len = bytes.length;
    var msg = bytes.slice();
    msg.push(0x80);
    while (msg.length % 64 !== 56) msg.push(0);
    var lo = (len * 8) >>> 0, hi = Math.floor(len / 536870912);
    msg.push(lo & 255, (lo >>> 8) & 255, (lo >>> 16) & 255, (lo >>> 24) & 255);
    msg.push(hi & 255, (hi >>> 8) & 255, (hi >>> 16) & 255, (hi >>> 24) & 255);

    var M = new Array(16), off, i;
    for (off = 0; off < msg.length; off += 64) {
      for (i = 0; i < 16; i++) {
        M[i] = msg[off + i * 4] | (msg[off + i * 4 + 1] << 8)
          | (msg[off + i * 4 + 2] << 16) | (msg[off + i * 4 + 3] << 24);
      }
      var A = a0, B = b0, C = c0, D = d0;
      for (i = 0; i < 64; i++) {
        var F, g;
        if (i < 16) { F = (B & C) | (~B & D); g = i; }
        else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
        else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
        else { F = C ^ (B | ~D); g = (7 * i) % 16; }
        F = (F + A + K[i] + M[g]) | 0;
        A = D; D = C; C = B;
        B = (B + ((F << S[i]) | (F >>> (32 - S[i])))) | 0;
      }
      a0 = (a0 + A) | 0; b0 = (b0 + B) | 0; c0 = (c0 + C) | 0; d0 = (d0 + D) | 0;
    }
    return [a0 >>> 0, b0 >>> 0, c0 >>> 0, d0 >>> 0];
  }

  function md5Hex(str) {
    return md5Bytes(utf8Bytes(str)).map(hex32le).join('');
  }

  w.JSCrypto = { sha1Hex: sha1Hex, md5Hex: md5Hex };
})(window);
