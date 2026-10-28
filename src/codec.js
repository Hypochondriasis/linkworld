// Bytes <-> link text. Payload = flag byte + body; flag 0 = raw, 1 = deflate-raw.
// Built-in deflate instead of CompressionStream so old browsers work and links are identical everywhere.
import { DecodeError } from './bytes.js';
import { deflate, inflate } from './deflate.js';

const RAW = 0;
const DEFLATE = 1;
export const MAX_UNPACKED = 256 * 1024;
const MAX_CHARS = 1024 * 1024;

export async function pack(bytes) {
  const z = deflate(bytes);
  const useZ = z.length < bytes.length;
  const body = useZ ? z : bytes;
  const out = new Uint8Array(1 + body.length);
  out[0] = useZ ? DEFLATE : RAW;
  out.set(body, 1);
  return toBase64url(out);
}

export async function unpack(text, maxSize = MAX_UNPACKED) {
  const data = fromBase64url(text);
  if (data.length === 0) throw new DecodeError('link is empty');
  const body = data.subarray(1);
  if (data[0] === RAW) {
    if (body.length > maxSize) throw new DecodeError('level data is too large');
    return body;
  }
  if (data[0] === DEFLATE) return inflate(body, maxSize);
  throw new DecodeError(`unknown compression flag ${data[0]}`);
}

function toBase64url(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64url(text) {
  if (text.length > MAX_CHARS) throw new DecodeError('link is too long');
  if (!/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) throw new DecodeError('link contains invalid characters');
  const bin = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
