// Frame packing for the HTML export: b bits per pixel, XOR against the previous
// frame (so static areas become zeros), then deflate the whole stream.

export const bitsFor = (levels) => Math.max(1, Math.ceil(Math.log2(levels)));

export function packFrame(idx, bits, out = new Uint8Array(Math.ceil((idx.length * bits) / 8))) {
  out.fill(0);
  let bit = 0;
  for (let i = 0; i < idx.length; i++) {
    const v = idx[i];
    for (let b = 0; b < bits; b++, bit++) if ((v >> b) & 1) out[bit >> 3] |= 1 << (bit & 7);
  }
  return out;
}

export function unpackFrame(src, bits, n, out = new Uint8Array(n)) {
  let bit = 0;
  for (let i = 0; i < n; i++) {
    let v = 0;
    for (let b = 0; b < bits; b++, bit++) v |= ((src[bit >> 3] >> (bit & 7)) & 1) << b;
    out[i] = v;
  }
  return out;
}

export class FramePacker {
  constructor(w, h, levels) {
    this.bits = bitsFor(levels);
    this.size = Math.ceil((w * h * this.bits) / 8);
    this.prev = new Uint8Array(this.size);
    this.chunks = [];
  }
  add(idx) {
    const cur = packFrame(idx, this.bits);
    const x = new Uint8Array(this.size);
    for (let i = 0; i < this.size; i++) x[i] = cur[i] ^ this.prev[i];
    this.prev = cur;
    this.chunks.push(x);
  }
  get count() { return this.chunks.length; }
  async compress() {
    const raw = new Blob(this.chunks).stream().pipeThrough(new CompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(raw).arrayBuffer());
  }
}

export function toBase64(u8) {
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}
