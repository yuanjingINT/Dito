import { deflateSync } from "node:zlib";
const MAX_PIXELS = 2e7;
function detectImageMime(buf) {
  if (buf.length >= 8 && buf[0] === 137 && buf[1] === 80 && buf[2] === 78 && buf[3] === 71) return "image/png";
  if (buf.length >= 3 && buf[0] === 255 && buf[1] === 216 && buf[2] === 255) return "image/jpeg";
  const head6 = buf.length >= 6 ? buf.toString("latin1", 0, 6) : "";
  if (head6 === "GIF87a" || head6 === "GIF89a") return "image/gif";
  if (buf.length >= 12 && buf.toString("latin1", 0, 4) === "RIFF" && buf.toString("latin1", 8, 12) === "WEBP") return "image/webp";
  if (buf.length >= 2 && buf[0] === 66 && buf[1] === 77) return "image/bmp";
  return null;
}
function toVisionImage(buf, mime) {
  const detected = detectImageMime(buf);
  const headerMime = mime.split(";")[0].trim();
  const actual = detected ?? (headerMime.startsWith("image/") ? headerMime : "image/png");
  if (actual === "image/gif") {
    const png = gifToPng(buf);
    if (png) return { buf: png, mime: "image/png" };
  }
  return { buf, mime: actual };
}
function gifToPng(buf) {
  if (detectImageMime(buf) !== "image/gif") return null;
  try {
    let p = 6;
    const screenW = buf.readUInt16LE(p);
    p += 2;
    const screenH = buf.readUInt16LE(p);
    p += 2;
    if (screenW <= 0 || screenH <= 0 || screenW * screenH > MAX_PIXELS) return null;
    const packed = buf[p++];
    p += 2;
    const gct = readColorTable(buf, p, packed);
    if (gct) p += gct.size * 3;
    let transparent = -1;
    while (p < buf.length) {
      const block = buf[p++];
      if (block === 59) return null;
      if (block === 33) {
        const label = buf[p++];
        if (label === 249 && p + 4 < buf.length) {
          const flags = buf[p + 1];
          transparent = flags & 1 ? buf[p + 4] : -1;
        }
        p = readSubBlocks(buf, p).next;
        continue;
      }
      if (block !== 44) return null;
      const left = buf.readUInt16LE(p);
      p += 2;
      const top = buf.readUInt16LE(p);
      p += 2;
      const fw = buf.readUInt16LE(p);
      p += 2;
      const fh = buf.readUInt16LE(p);
      p += 2;
      const fpacked = buf[p++];
      const lct = readColorTable(buf, p, fpacked);
      if (lct) p += lct.size * 3;
      const table = lct?.data ?? gct?.data;
      if (!table || fw === 0 || fh === 0 || fw * fh > MAX_PIXELS) return null;
      const minCodeSize = buf[p++];
      const blocks = readSubBlocks(buf, p);
      const indices = lzwDecode(blocks.data, minCodeSize, fw * fh);
      if (!indices) return null;
      return composePng(screenW, screenH, left, top, fw, fh, (fpacked & 64) !== 0, indices, table, transparent);
    }
    return null;
  } catch {
    return null;
  }
}
function readColorTable(buf, offset, packed) {
  if (!(packed & 128)) return null;
  const size = 1 << (packed & 7) + 1;
  if (offset + size * 3 > buf.length) return null;
  return { data: buf.subarray(offset, offset + size * 3), size };
}
function readSubBlocks(buf, start) {
  const parts = [];
  let p = start;
  while (p < buf.length) {
    const size = buf[p++];
    if (size === 0) break;
    if (p + size > buf.length) {
      p = buf.length;
      break;
    }
    parts.push(buf.subarray(p, p + size));
    p += size;
  }
  return { data: Buffer.concat(parts), next: p };
}
function interlaceRow(row, height) {
  const p1 = Math.ceil(height / 8);
  const p2 = Math.ceil((height - 4) / 8);
  const p3 = Math.ceil((height - 2) / 4);
  if (row < p1) return row * 8;
  if (row - p1 < p2) return 4 + (row - p1) * 8;
  if (row - p1 - p2 < p3) return 2 + (row - p1 - p2) * 4;
  return 1 + (row - p1 - p2 - p3) * 2;
}
function lzwDecode(data, minCodeSize, pixelCount) {
  if (minCodeSize < 2 || minCodeSize > 12 || pixelCount <= 0) return null;
  const clear = 1 << minCodeSize;
  const end = clear + 1;
  const prefix = new Int32Array(4096).fill(-1);
  const suffix = new Uint8Array(4096);
  const first = new Uint8Array(4096);
  for (let i = 0; i < clear; i++) {
    suffix[i] = i;
    first[i] = i;
  }
  const out = new Uint8Array(pixelCount);
  const stack = new Uint8Array(4096);
  let outPos = 0;
  let next = end + 1;
  let codeSize = minCodeSize + 1;
  let prev = -1;
  let bitPos = 0;
  const totalBits = data.length * 8;
  while (outPos < pixelCount) {
    if (bitPos + codeSize > totalBits) break;
    let code = 0;
    for (let i = 0; i < codeSize; i++) {
      code |= (data[bitPos + i >> 3] >> (bitPos + i & 7) & 1) << i;
    }
    bitPos += codeSize;
    if (code === end) break;
    if (code === clear) {
      next = end + 1;
      codeSize = minCodeSize + 1;
      prev = -1;
      continue;
    }
    if (code > next) return null;
    let sp = 0;
    let cur = code;
    if (code === next) {
      if (prev < 0) return null;
      stack[sp++] = first[prev];
      cur = prev;
    }
    while (cur >= clear) {
      stack[sp++] = suffix[cur];
      cur = prefix[cur];
      if (cur < 0 || sp >= 4096) return null;
    }
    stack[sp++] = cur;
    while (sp > 0 && outPos < pixelCount) out[outPos++] = stack[--sp];
    if (prev >= 0 && next < 4096) {
      prefix[next] = prev;
      suffix[next] = code < clear ? code : code === next ? first[prev] : first[code];
      first[next] = first[prev];
      next++;
      if (next === 1 << codeSize && codeSize < 12) codeSize++;
    }
    prev = code;
  }
  return outPos === pixelCount ? out : null;
}
function composePng(screenW, screenH, left, top, fw, fh, interlaced, indices, table, transparent) {
  const width = Math.max(screenW, left + fw);
  const height = Math.max(screenH, top + fh);
  if (width * height > MAX_PIXELS) return null;
  const rgba = Buffer.alloc(width * height * 4);
  let src = 0;
  for (let row = 0; row < fh; row++) {
    const y = top + (interlaced ? interlaceRow(row, fh) : row);
    const base = y * width * 4;
    for (let x = 0; x < fw; x++) {
      const idx = indices[src++];
      if (idx === transparent) continue;
      const o = base + (left + x) * 4;
      const t = idx * 3;
      rgba[o] = table[t] ?? 0;
      rgba[o + 1] = table[t + 1] ?? 0;
      rgba[o + 2] = table[t + 2] ?? 0;
      rgba[o + 3] = 255;
    }
  }
  return encodePng(width, height, rgba);
}
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([PNG_SIGNATURE, pngChunk("IHDR", ihdr), pngChunk("IDAT", deflateSync(raw)), pngChunk("IEND", Buffer.alloc(0))]);
}
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 3988292384 ^ c >>> 1 : c >>> 1;
    table[n] = c;
  }
  return table;
})();
function crc32(buf) {
  let c = 4294967295;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 255] ^ c >>> 8;
  return (c ^ 4294967295) >>> 0;
}
function pngChunk(type, data) {
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  chunk.write(type, 4, "latin1");
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, 8 + data.length)), 8 + data.length);
  return chunk;
}
export {
  detectImageMime,
  gifToPng,
  toVisionImage
};
