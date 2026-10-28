// Little-endian byte I/O. Varints are unsigned LEB128 (max 32 bits); signed varints use zigzag.

export class DecodeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DecodeError';
  }
}

function check(v, lo, hi) {
  if (!Number.isInteger(v) || v < lo || v > hi) throw new RangeError(`value ${v} out of range ${lo}..${hi}`);
}

export class ByteWriter {
  constructor() {
    this.buf = new Uint8Array(256);
    this.len = 0;
  }

  u8(v) {
    check(v, 0, 255);
    if (this.len === this.buf.length) {
      const b = new Uint8Array(this.buf.length * 2);
      b.set(this.buf);
      this.buf = b;
    }
    this.buf[this.len++] = v;
  }

  u16(v) {
    check(v, 0, 0xffff);
    this.u8(v & 255);
    this.u8(v >> 8);
  }

  varint(v) {
    check(v, 0, 0xffffffff);
    while (v >= 128) {
      this.u8((v % 128) | 128);
      v = Math.floor(v / 128);
    }
    this.u8(v);
  }

  svarint(v) {
    check(v, -0x80000000, 0x7fffffff);
    this.varint(v < 0 ? -2 * v - 1 : 2 * v);
  }

  bytes(arr) {
    for (const v of arr) this.u8(v);
  }

  // UTF-8, length-prefixed.
  string(s) {
    const b = new TextEncoder().encode(s);
    this.varint(b.length);
    this.bytes(b);
  }

  finish() {
    return this.buf.slice(0, this.len);
  }
}

const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

export class ByteReader {
  constructor(bytes) {
    this.b = bytes;
    this.pos = 0;
  }

  get remaining() {
    return this.b.length - this.pos;
  }

  u8() {
    if (this.pos >= this.b.length) throw new DecodeError('unexpected end of data');
    return this.b[this.pos++];
  }

  u16() {
    return this.u8() | (this.u8() << 8);
  }

  varint() {
    let v = 0;
    let mul = 1;
    for (let i = 0; i < 5; i++) {
      const b = this.u8();
      v += (b & 127) * mul;
      if (!(b & 128)) {
        // Reject padded encodings so every value has exactly one byte form.
        if (i > 0 && b === 0) throw new DecodeError('non-canonical varint');
        if (v > 0xffffffff) throw new DecodeError('varint overflow');
        return v;
      }
      mul *= 128;
    }
    throw new DecodeError('varint too long');
  }

  svarint() {
    const v = this.varint();
    return v % 2 ? -(v + 1) / 2 : v / 2;
  }

  bytes(n) {
    if (n > this.remaining) throw new DecodeError('unexpected end of data');
    const out = Array.from(this.b.subarray(this.pos, this.pos + n));
    this.pos += n;
    return out;
  }

  string(maxBytes) {
    const n = this.varint();
    if (n > maxBytes) throw new DecodeError(`string too long (${n} > ${maxBytes} bytes)`);
    if (n > this.remaining) throw new DecodeError('unexpected end of data');
    const sub = this.b.subarray(this.pos, this.pos + n);
    this.pos += n;
    try {
      return utf8.decode(sub);
    } catch {
      throw new DecodeError('invalid UTF-8 in string');
    }
  }
}
