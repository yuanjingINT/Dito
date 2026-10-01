/**
 * 图片格式工具：魔数识别 + GIF 首帧转 PNG（纯 JS，零依赖）。
 *
 * 视觉识别发图前统一格式：
 * - QQ 图片 URL 的 content-type 常不可靠（缺失 / application/octet-stream），按文件魔数判断；
 * - 不少视觉模型（如智谱 GLM-4V）不接受 image/gif，动图统一取首帧转 PNG 再送模型。
 */
import { deflateSync } from "node:zlib";

/** 单张图解码的像素上限（约 20MP，防超大画布 GIF 撑爆内存） */
const MAX_PIXELS = 20_000_000;

/** 按文件魔数识别图片类型；识别不出返回 null。不信任 URL content-type。 */
export function detectImageMime(buf: Buffer): string | null {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image/png";
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  const head6 = buf.length >= 6 ? buf.toString("latin1", 0, 6) : "";
  if (head6 === "GIF87a" || head6 === "GIF89a") return "image/gif";
  if (buf.length >= 12 && buf.toString("latin1", 0, 4) === "RIFF" && buf.toString("latin1", 8, 12) === "WEBP") return "image/webp";
  if (buf.length >= 2 && buf[0] === 0x42 && buf[1] === 0x4d) return "image/bmp";
  return null;
}

/**
 * 把图片规范成视觉模型友好格式：
 * - 魔数优先于传入 mime（URL 头不可信）；识别不出时若 mime 是 image/* 则沿用，否则按 PNG。
 * - GIF → 首帧 PNG（转码失败则退回原格式，交给模型自己判断）。
 */
export function toVisionImage(buf: Buffer, mime: string): { buf: Buffer; mime: string } {
  const detected = detectImageMime(buf);
  const headerMime = mime.split(";")[0].trim();
  const actual = detected ?? (headerMime.startsWith("image/") ? headerMime : "image/png");
  if (actual === "image/gif") {
    const png = gifToPng(buf);
    if (png) return { buf: png, mime: "image/png" };
  }
  return { buf, mime: actual };
}

/** GIF 首帧解码为 PNG；解析失败返回 null（动图只取第一帧，视觉识别足够） */
export function gifToPng(buf: Buffer): Buffer | null {
  if (detectImageMime(buf) !== "image/gif") return null;
  try {
    let p = 6;
    const screenW = buf.readUInt16LE(p);
    p += 2;
    const screenH = buf.readUInt16LE(p);
    p += 2;
    if (screenW <= 0 || screenH <= 0 || screenW * screenH > MAX_PIXELS) return null;
    const packed = buf[p++];
    p += 2; // 背景色索引 + 像素宽高比
    const gct = readColorTable(buf, p, packed);
    if (gct) p += gct.size * 3;
    let transparent = -1;

    while (p < buf.length) {
      const block = buf[p++];
      if (block === 0x3b) return null; // 文件结束：没有图像数据
      if (block === 0x21) {
        // 扩展块：Graphic Control Extension 记录透明色（其它扩展块不改变透明色状态）
        const label = buf[p++];
        if (label === 0xf9 && p + 4 < buf.length) {
          const flags = buf[p + 1];
          transparent = flags & 0x01 ? buf[p + 4] : -1;
        }
        p = readSubBlocks(buf, p).next;
        continue;
      }
      if (block !== 0x2c) return null; // 未知块

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
      return composePng(screenW, screenH, left, top, fw, fh, (fpacked & 0x40) !== 0, indices, table, transparent);
    }
    return null;
  } catch {
    return null;
  }
}

interface ColorTable {
  data: Buffer;
  size: number;
}

/** packed 低 3 位 = 色表大小指数（2^(n+1) 项，每项 3 字节） */
function readColorTable(buf: Buffer, offset: number, packed: number): ColorTable | null {
  if (!(packed & 0x80)) return null;
  const size = 1 << ((packed & 0x07) + 1);
  if (offset + size * 3 > buf.length) return null;
  return { data: buf.subarray(offset, offset + size * 3), size };
}

/** 读取 size 前缀的子块序列，返回拼接数据和下一个块的位置 */
function readSubBlocks(buf: Buffer, start: number): { data: Buffer; next: number } {
  const parts: Buffer[] = [];
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

/** GIF 交错存储的行号 → 实际行号（4 趟扫描：步长 8/8/4/2） */
function interlaceRow(row: number, height: number): number {
  const p1 = Math.ceil(height / 8);
  const p2 = Math.ceil((height - 4) / 8);
  const p3 = Math.ceil((height - 2) / 4);
  if (row < p1) return row * 8;
  if (row - p1 < p2) return 4 + (row - p1) * 8;
  if (row - p1 - p2 < p3) return 2 + (row - p1 - p2) * 4;
  return 1 + (row - p1 - p2 - p3) * 2;
}

/** GIF 变体 LZW 解码（LSB 优先，码长随字典增长 9→12） */
function lzwDecode(data: Buffer, minCodeSize: number, pixelCount: number): Uint8Array | null {
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
      code |= ((data[(bitPos + i) >> 3] >> ((bitPos + i) & 7)) & 1) << i;
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
      // KwKwK：当前码还没进字典，序列 = 上一段 + 上一段首字节
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

/** 首帧画到逻辑屏幕画布上（保留透明），再编码 PNG */
function composePng(
  screenW: number,
  screenH: number,
  left: number,
  top: number,
  fw: number,
  fh: number,
  interlaced: boolean,
  indices: Uint8Array,
  table: Buffer,
  transparent: number,
): Buffer | null {
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

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** 极简 PNG 编码（8bit RGBA，无滤波，zlib 压缩） */
function encodePng(width: number, height: number, rgba: Buffer): Buffer {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  return Buffer.concat([PNG_SIGNATURE, pngChunk("IHDR", ihdr), pngChunk("IDAT", deflateSync(raw)), pngChunk("IEND", Buffer.alloc(0))]);
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  chunk.write(type, 4, "latin1");
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, 8 + data.length)), 8 + data.length);
  return chunk;
}
