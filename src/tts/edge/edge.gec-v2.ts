/** Sec-MS-GEC v2 wire algorithm; constants documented by edge-tts ba61d944 (2026-10-13).
 * Implemented with explicit unsigned words rather than floating-point 64-bit products.
 * SHA-256 rounds follow FIPS 180-4; this protocol supplies its own initial partial block.
 */
const INITIAL = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
const CHECKPOINT = [0xfd9fbea2, 0x91243ce7, 0xbe499094, 0xcd2e1e0a, 0x6c006f49, 0x04bd35ab, 0xfeb0a7e4, 0x03effbd2];
const K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];
const SCHEDULE = [
  0xeb24bf9e, 0x1558691f, 0xa0c09ee2, 0x0cfa32ba, 0xa622ee8c, 0xd1dd9491, 0xc0dd25a0, 0xf9e70ab6,
  0xf0c31573, 0x7058ce4e, 0x7188e606, 0x00e5ab33, 0xd258b060, 0x72766564,
];
const COEFFICIENTS = [
  [0xe82e91b1, 0xb32700d0], [0x44de24c6, 0x88dff51d], [0x3beb65bc, 0x29514038], [0xc89c5933, 0xb328cbdf],
  [0x8d1ec211, 0xd405b4d5], [0x314ef5d5, 0x26e55f3c], [0xe92491b1, 0x607801c6], [0xf0a5b9d5, 0x82b2c1fb],
  [0x06064cf3, 0xfa51a3da], [0xda79fa60, 0x207cc464], [0xbed20560, 0x3c3c74f3], [0x89f9c9f8, 0xd2d14b61],
  [0x35fa38c6, 0xbb04a2c1], [0xcb49e3c6, 0xc5626167],
];
const rotate = (word: number, bits: number) => ((word >>> bits) | (word << (32 - bits))) >>> 0;
const swap = (word: number) => rotate(word, 16);
const sigma0 = (word: number) => (rotate(word, 7) ^ rotate(word, 18) ^ (word >>> 3)) >>> 0;
const sigma1 = (word: number) => (rotate(word, 17) ^ rotate(word, 19) ^ (word >>> 10)) >>> 0;
const multiply = (a: number, b: number) => Math.imul(a, b) >>> 0;

function expand(words: number[], start = 16): void {
  for (let i = start; i < 64; i++) {
    words[i] = (sigma1(words[i - 2]) + words[i - 7] + sigma0(words[i - 15]) + words[i - 16]) >>> 0;
  }
}
function compress(state: readonly number[], words: number[], start = 0): number[] {
  let [a, b, c, d, e, f, g, h] = state;
  for (let i = start; i < 64; i++) {
    const constant = start === 14 && i === 14 ? 0xc9dc06a7 : K[i];
    const first = (h + (rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25)) + ((e & f) ^ (~e & g)) + constant + words[i]) >>> 0;
    const second = ((rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
    [a, b, c, d, e, f, g, h] = [(first + second) >>> 0, a, b, c, (d + first) >>> 0, e, f, g];
  }
  return [a, b, c, d, e, f, g, h];
}
function digest(data: Buffer): Buffer {
  const words = Array<number>(14).fill(0);
  words.push(data.readUIntBE(0, 3), data.readUInt32BE(3));
  for (let i = 16; i < 30; i++) {
    let value = SCHEDULE[i - 16];
    if (i - 2 >= 14) value += i === 16 ? (sigma1(words[i - 2]) ^ 0x000b92c0) >>> 0 : sigma1(words[i - 2]);
    if (i - 7 >= 14) value += words[i - 7];
    if (i - 15 >= 14) value += i === 29 ? (sigma0(words[i - 15]) ^ 0x059c0b80) >>> 0 : sigma0(words[i - 15]);
    words.push(value >>> 0);
  }
  words.push((sigma1(words[28]) + words[23] + sigma0(words[15]) + words[14] + 0xc9dc06a7 - K[14]) >>> 0);
  expand(words, 31);
  let state = compress(CHECKPOINT, words, 14).map((word, i) => (word + INITIAL[i]) >>> 0);
  const length = 57 + data.length;
  const padding = Buffer.alloc(((55 - length) % 64 + 64) % 64);
  const tail = Buffer.alloc(8);
  tail.writeBigUInt64BE(BigInt(length) * 8n);
  const blocks = Buffer.concat([data.subarray(7), Buffer.from([0x80]), padding, tail]);
  for (let offset = 0; offset < blocks.length; offset += 64) {
    const block = Array.from({ length: 16 }, (_, i) => blocks.readUInt32BE(offset + i * 4));
    expand(block);
    state = compress(state, block).map((word, i) => (word + state[i]) >>> 0);
  }
  const result = Buffer.alloc(32);
  state.forEach((word, i) => result.writeUInt32BE(word, i * 4));
  return result;
}
function checksum(data: Buffer, hash: Buffer): Buffer {
  const keys = [(hash.readUInt32LE(0) | 1) >>> 0, (hash.readUInt32LE(4) | 1) >>> 0];
  const factors = keys.map(key => multiply(key, 0x82893933));
  const terms = COEFFICIENTS.map(([coefficient], i) => multiply(coefficient, factors[i % 2]));
  const offsets = COEFFICIENTS.map(([, offset]) => offset);
  const bytes = Buffer.alloc(Math.ceil((data.length + 1) / 8) * 8);
  data.copy(bytes, 1);
  for (let i = 0; i < bytes.length / 4; i++) {
    const word = bytes.readUInt32LE(i * 4);
    let term = multiply(word, keys[i % 2]);
    let offset = multiply(swap(word), i % 2 === 0 ? 0xef0569fb : 0xc31713db);
    if (i === 0) {
      term = (term + multiply(0xf2f90b1a, factors[0])) >>> 0;
      offset = (offset + 0x0b1a0000) >>> 0;
    }
    terms.push(term); offsets.push(offset);
  }
  let swapSum = 0, last = 0, state = 0, sum = 0;
  for (let i = 0; i < terms.length; i += 2) {
    const x = terms[i], y = terms[i + 1];
    const q = multiply(swap((offsets[i] + x) >>> 0), 0x76f50f34);
    swapSum = (swapSum + multiply(swap(q), 0xc3efea97) + q) >>> 0;
    const r = multiply(swap((offsets[i + 1] + y) >>> 0), 0x1881ce3c);
    last = (multiply(swap(r), 0x35bd1ec9) + r) >>> 0;
    swapSum = (swapSum + last) >>> 0;
    state = (multiply(state, keys[0]) + x) >>> 0;
    for (const factor of [0xcf98b111, 0x87085b9f, 0x12ceb96d, 0x257e1d83]) state = multiply(swap(state), factor);
    sum = (sum + state) >>> 0;
    state = (multiply(state, keys[1]) + y) >>> 0;
    for (const factor of [0xa27416f5, 0xd38396ff, 0x7c932b89, 0xbfa49f69]) state = multiply(swap(state), factor);
    sum = (sum + state) >>> 0;
  }
  const result = Buffer.alloc(8);
  result.writeUInt32LE((last ^ state) >>> 0, 0);
  result.writeUInt32LE((swapSum ^ sum) >>> 0, 4);
  return result;
}

export function hashEdgeGecV2(data: Buffer): string {
  if (data.length < 7) throw new RangeError("Edge GEC input is too short");
  const hash = digest(data);
  return `${checksum(data, hash).toString("hex")}-${hash.toString("hex")}`.toUpperCase();
}
