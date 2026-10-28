// Raw DEFLATE (RFC 1951), compatible with zlib / CompressionStream('deflate-raw').
import { DecodeError } from './bytes.js';

const LBASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEXT = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DBASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DEXT = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const CLORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

const FIXED_LIT = new Uint8Array(288).fill(8, 0, 144).fill(9, 144, 256).fill(7, 256, 280).fill(8, 280, 288);
const FIXED_DIST = new Uint8Array(30).fill(5);

// ---------- inflate ----------

// Canonical Huffman decode tables (puff-style): count per length + symbols sorted by code.
function huffman(lens) {
  const counts = new Uint16Array(16);
  for (const l of lens) counts[l]++;
  counts[0] = 0;
  let left = 1;
  for (let l = 1; l < 16; l++) {
    left = left * 2 - counts[l];
    if (left < 0) throw new DecodeError('link data is corrupt (bad Huffman code)');
  }
  const offs = new Uint16Array(16);
  for (let l = 1; l < 15; l++) offs[l + 1] = offs[l] + counts[l];
  const symbols = new Uint16Array(lens.length);
  for (let s = 0; s < lens.length; s++) if (lens[s]) symbols[offs[lens[s]]++] = s;
  return { counts, symbols };
}

const FIXED_LIT_H = huffman(FIXED_LIT);
const FIXED_DIST_H = huffman(FIXED_DIST);

export function inflate(data, maxSize) {
  let pos = 0;
  let bitbuf = 0;
  let bitcnt = 0;
  let out = new Uint8Array(Math.min(maxSize, Math.max(1024, data.length * 4)));
  let len = 0;

  const corrupt = (why) => new DecodeError(`link data is corrupt (${why})`);

  function bits(n) {
    while (bitcnt < n) {
      if (pos >= data.length) throw corrupt('truncated');
      bitbuf |= data[pos++] << bitcnt;
      bitcnt += 8;
    }
    const v = bitbuf & ((1 << n) - 1);
    bitbuf >>>= n;
    bitcnt -= n;
    return v;
  }

  function decode(h) {
    let code = 0, first = 0, index = 0;
    for (let l = 1; l < 16; l++) {
      code |= bits(1);
      const count = h.counts[l];
      if (code - first < count) return h.symbols[index + code - first];
      index += count;
      first = (first + count) << 1;
      code <<= 1;
    }
    throw corrupt('bad Huffman code');
  }

  function reserve(n) {
    if (len + n > maxSize) throw new DecodeError('level data is too large when decompressed');
    if (len + n <= out.length) return;
    const b = new Uint8Array(Math.min(maxSize, Math.max(out.length * 2, len + n)));
    b.set(out.subarray(0, len));
    out = b;
  }

  function codes(lit, dist) {
    for (;;) {
      let sym = decode(lit);
      if (sym < 256) {
        reserve(1);
        out[len++] = sym;
      } else if (sym === 256) {
        return;
      } else {
        sym -= 257;
        if (sym >= 29) throw corrupt('bad length');
        const n = LBASE[sym] + bits(LEXT[sym]);
        const ds = decode(dist);
        if (ds >= 30) throw corrupt('bad distance');
        const d = DBASE[ds] + bits(DEXT[ds]);
        if (d > len) throw corrupt('distance too far back');
        reserve(n);
        for (let i = 0; i < n; i++, len++) out[len] = out[len - d];
      }
    }
  }

  let final;
  do {
    final = bits(1);
    const type = bits(2);
    if (type === 0) {
      bitbuf = bitcnt = 0; // skip to byte boundary
      if (pos + 4 > data.length) throw corrupt('truncated');
      const n = data[pos] | (data[pos + 1] << 8);
      if ((n ^ 0xffff) !== (data[pos + 2] | (data[pos + 3] << 8))) throw corrupt('bad stored block');
      pos += 4;
      if (pos + n > data.length) throw corrupt('truncated');
      reserve(n);
      out.set(data.subarray(pos, pos + n), len);
      pos += n;
      len += n;
    } else if (type === 1) {
      codes(FIXED_LIT_H, FIXED_DIST_H);
    } else if (type === 2) {
      const nlen = bits(5) + 257;
      const ndist = bits(5) + 1;
      const ncode = bits(4) + 4;
      if (nlen > 286 || ndist > 30) throw corrupt('bad code counts');
      const cl = new Uint8Array(19);
      for (let i = 0; i < ncode; i++) cl[CLORDER[i]] = bits(3);
      const clh = huffman(cl);
      const lens = new Uint8Array(nlen + ndist);
      for (let i = 0; i < nlen + ndist; ) {
        const sym = decode(clh);
        if (sym < 16) {
          lens[i++] = sym;
          continue;
        }
        let v = 0, rep;
        if (sym === 16) {
          if (i === 0) throw corrupt('repeat with no previous length');
          v = lens[i - 1];
          rep = 3 + bits(2);
        } else if (sym === 17) rep = 3 + bits(3);
        else rep = 11 + bits(7);
        if (i + rep > nlen + ndist) throw corrupt('too many lengths');
        lens.fill(v, i, i + rep);
        i += rep;
      }
      if (!lens[256]) throw corrupt('no end-of-block code');
      codes(huffman(lens.subarray(0, nlen)), huffman(lens.subarray(nlen)));
    } else {
      throw corrupt('bad block type');
    }
  } while (!final);
  if (pos !== data.length) throw corrupt('trailing data');
  return out.slice(0, len);
}

// ---------- deflate ----------

// Huffman code lengths limited to `limit` bits. Over the limit: flatten frequencies and retry.
function codeLengths(freq, limit) {
  let f = Array.from(freq);
  for (;;) {
    const lens = new Uint8Array(f.length);
    let nodes = [];
    f.forEach((w, s) => { if (w) nodes.push({ w, s }); });
    if (nodes.length === 0) return lens;
    // A lone symbol still gets a complete 2-code tree, which every decoder accepts.
    if (nodes.length === 1) nodes.push({ w: 1, s: nodes[0].s === 0 ? 1 : 0 });
    while (nodes.length > 1) {
      nodes.sort((a, b) => a.w - b.w);
      const [a, b] = nodes.splice(0, 2);
      nodes.push({ w: a.w + b.w, kids: [a, b] });
    }
    let max = 0;
    const walk = (n, d) => {
      if (n.kids) n.kids.forEach((k) => walk(k, d + 1));
      else { lens[n.s] = d; max = Math.max(max, d); }
    };
    walk(nodes[0], 0);
    if (max <= limit) return lens;
    f = f.map((w) => (w ? Math.max(1, w >> 1) : 0));
  }
}

// Canonical codes, bit-reversed because DEFLATE writes Huffman codes MSB first into an LSB-first stream.
function canonical(lens) {
  const count = new Uint16Array(16);
  for (const l of lens) count[l]++;
  count[0] = 0;
  const next = new Uint16Array(16);
  for (let l = 1, code = 0; l < 16; l++) next[l] = code = (code + count[l - 1]) << 1;
  return Array.from(lens, (l) => {
    if (!l) return 0;
    let c = next[l]++, r = 0;
    for (let i = 0; i < l; i++, c >>= 1) r = (r << 1) | (c & 1);
    return r;
  });
}

// Code-length sequence -> [symbol, extra] pairs using repeat codes 16/17/18.
function rle(lens) {
  const out = [];
  for (let i = 0; i < lens.length; ) {
    const l = lens[i];
    let run = 1;
    while (i + run < lens.length && lens[i + run] === l) run++;
    if (l === 0 && run >= 3) {
      const r = Math.min(run, 138);
      out.push(r >= 11 ? [18, r - 11] : [17, r - 3]);
      i += r;
    } else if (l !== 0 && run >= 4) {
      const r = Math.min(run - 1, 6);
      out.push([l, 0], [16, r - 3]);
      i += 1 + r;
    } else {
      out.push([l, 0]);
      i++;
    }
  }
  return out;
}

const CLEXT = { 16: 2, 17: 3, 18: 7 };

const LSYM = new Uint8Array(259);
for (let s = 0; s < 29; s++) for (let l = LBASE[s]; l < (s < 28 ? LBASE[s + 1] : 259); l++) LSYM[l] = s;
const dsym = (d) => { let s = 0; while (s < 29 && DBASE[s + 1] <= d) s++; return s; };

const MAX_CHAIN = 256;

function lz77(data) {
  const n = data.length;
  const head = new Int32Array(1 << 15).fill(-1);
  const prev = new Int32Array(n);
  const hash = (i) => ((data[i] << 10) ^ (data[i + 1] << 5) ^ data[i + 2]) & 0x7fff;
  const insert = (i) => { if (i + 2 < n) { const h = hash(i); prev[i] = head[h]; head[h] = i; } };
  const find = (i) => {
    let best = 0, dist = 0;
    if (i + 2 >= n) return { len: 0, dist };
    const maxLen = Math.min(258, n - i);
    for (let p = head[hash(i)], chain = MAX_CHAIN; p >= 0 && i - p <= 32768 && chain--; p = prev[p]) {
      let l = 0;
      while (l < maxLen && data[p + l] === data[i + l]) l++;
      if (l > best) { best = l; dist = i - p; if (l === maxLen) break; }
    }
    return { len: best, dist };
  };

  const tokens = []; // literal: [byte], match: [len, dist]
  let pending = null;
  for (let i = 0; i < n; ) {
    const m = pending || find(i);
    pending = null;
    insert(i);
    // Lazy matching: a longer match at the next byte wins over this one.
    if (m.len >= 3 && m.len < 258 && i + 1 < n) {
      const next = find(i + 1);
      if (next.len > m.len) {
        tokens.push([data[i++]]);
        pending = next;
        continue;
      }
    }
    if (m.len >= 3) {
      tokens.push([m.len, m.dist]);
      for (let k = 1; k < m.len; k++) insert(i + k);
      i += m.len;
    } else {
      tokens.push([data[i++]]);
    }
  }
  return tokens;
}

// One block for the whole input, fixed or dynamic Huffman, whichever is smaller.
export function deflate(data) {
  const tokens = lz77(data);
  const lf = new Uint32Array(286);
  const df = new Uint32Array(30);
  for (const t of tokens) {
    if (t.length === 1) lf[t[0]]++;
    else { lf[257 + LSYM[t[0]]]++; df[dsym(t[1])]++; }
  }
  lf[256] = 1;

  const llens = codeLengths(lf, 15);
  const dlens = codeLengths(df, 15);
  if (!dlens.some(Boolean)) dlens[0] = 1; // zlib convention: at least one distance code
  let nlen = 286; while (nlen > 257 && !llens[nlen - 1]) nlen--;
  let ndist = 30; while (ndist > 1 && !dlens[ndist - 1]) ndist--;
  const seq = rle([...llens.subarray(0, nlen), ...dlens.subarray(0, ndist)]);
  const cf = new Uint32Array(19);
  for (const [s] of seq) cf[s]++;
  const cl = codeLengths(cf, 7);
  let ncode = 19; while (ncode > 4 && !cl[CLORDER[ncode - 1]]) ncode--;

  const cost = (ll, dl) => {
    let c = 0;
    for (let s = 0; s < 286; s++) c += lf[s] * (ll[s] + (s > 256 ? LEXT[s - 257] : 0));
    for (let s = 0; s < 30; s++) c += df[s] * (dl[s] + DEXT[s]);
    return c;
  };
  let dynCost = 14 + 3 * ncode + cost(llens, dlens);
  for (const [s] of seq) dynCost += cl[s] + (CLEXT[s] || 0);
  const dynamic = dynCost < cost(FIXED_LIT, FIXED_DIST);

  const out = [];
  let bitbuf = 0, bitcnt = 0;
  const put = (v, n) => {
    bitbuf |= v << bitcnt;
    bitcnt += n;
    while (bitcnt >= 8) { out.push(bitbuf & 255); bitbuf >>>= 8; bitcnt -= 8; }
  };

  put(1, 1); // final block
  let lit, dist, lc, dc;
  if (dynamic) {
    put(2, 2);
    put(nlen - 257, 5); put(ndist - 1, 5); put(ncode - 4, 4);
    for (let i = 0; i < ncode; i++) put(cl[CLORDER[i]], 3);
    const cc = canonical(cl);
    for (const [s, x] of seq) { put(cc[s], cl[s]); if (CLEXT[s]) put(x, CLEXT[s]); }
    [lit, dist] = [llens, dlens];
  } else {
    put(1, 2);
    [lit, dist] = [FIXED_LIT, FIXED_DIST];
  }
  lc = canonical(lit);
  dc = canonical(dist);
  for (const t of tokens) {
    if (t.length === 1) { put(lc[t[0]], lit[t[0]]); continue; }
    const [l, d] = t;
    const ls = LSYM[l], ds = dsym(d);
    put(lc[257 + ls], lit[257 + ls]); put(l - LBASE[ls], LEXT[ls]);
    put(dc[ds], dist[ds]); put(d - DBASE[ds], DEXT[ds]);
  }
  put(lc[256], lit[256]);
  if (bitcnt) out.push(bitbuf & 255);
  return new Uint8Array(out);
}
