import { open } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { homedir } from "node:os";
import { basename, resolve } from "node:path";
import { detectImageMime, toVisionImage } from "../extensions/image.js";
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_IMAGES = 8;
const supported = /* @__PURE__ */ new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
function imageAttachment(bytes, name) {
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) throw new Error("单张图片须为 1 字节至 20 MiB");
  const buf = Buffer.from(bytes);
  const mime = detectImageMime(buf);
  if (!mime || !supported.has(mime)) throw new Error("仅支持 PNG、JPEG、WebP、GIF 图片");
  const image = toVisionImage(buf, mime);
  if (image.buf.length > MAX_IMAGE_BYTES) throw new Error("图片转换后超过 20 MiB");
  return { name, content: { type: "image", data: image.buf.toString("base64"), mimeType: image.mime } };
}
function imagePath(raw) {
  let path = raw.trim();
  if (path.startsWith('"') && path.endsWith('"') || path.startsWith("'") && path.endsWith("'")) path = path.slice(1, -1);
  else path = path.replace(/\\([ \t'"()])/g, "$1");
  if (!path) throw new Error("用法：/image <图片路径>（含空格可加引号）");
  if (path === "~" || path.startsWith("~/") || path.startsWith("~\\")) path = homedir() + path.slice(1);
  return resolve(process.env.DITO_INVOKE_CWD || process.cwd(), path);
}
async function readImageAttachment(path) {
  const file = imagePath(path);
  const handle = await open(file, "r");
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error("请选择图片文件");
    if (stat.size > MAX_IMAGE_BYTES) throw new Error("单张图片不能超过 20 MiB");
    const bytes = Buffer.alloc(Math.min(stat.size + 1, MAX_IMAGE_BYTES + 1));
    let length = 0;
    while (length < bytes.length) {
      const read = await handle.read(bytes, length, bytes.length - length, null);
      if (!read.bytesRead) break;
      length += read.bytesRead;
    }
    return imageAttachment(bytes.subarray(0, length), basename(file));
  } finally {
    await handle.close();
  }
}
function assertImageSupport(session, count) {
  if (count && session.model && !session.model.input.includes("image")) {
    throw new Error("当前模型不支持图片，请用 /model 或 dito config 切换到支持视觉输入的模型");
  }
}
const execFileAsync = promisify(execFile);
async function clipboardCommand(command, args) {
  try {
    const { stdout } = await execFileAsync(command, args, { encoding: "buffer", timeout: 3e3, maxBuffer: MAX_IMAGE_BYTES * 2, windowsHide: true });
    return stdout.length ? stdout : void 0;
  } catch {
    return void 0;
  }
}
async function readClipboardInput() {
  const attached = (bytes) => ({ image: imageAttachment(bytes, "剪贴板图片") });
  if (process.platform === "linux") {
    const wayland = Boolean(process.env.WAYLAND_DISPLAY || process.env.XDG_SESSION_TYPE === "wayland");
    const command = wayland ? "wl-paste" : "xclip";
    const typesArgs = wayland ? ["--list-types"] : ["-selection", "clipboard", "-t", "TARGETS", "-o"];
    const types = (await clipboardCommand(command, typesArgs))?.toString().split(/\r?\n/).map((type) => type.trim()) ?? [];
    const mime = [...supported].find((type) => types.includes(type));
    if (mime) {
      const bytes = await clipboardCommand(command, wayland ? ["--type", mime] : ["-selection", "clipboard", "-t", mime, "-o"]);
      if (bytes) return attached(bytes);
    }
    if (process.env.WSL_DISTRO_NAME || process.env.WSLENV) {
      const image = await windowsClipboardImage("powershell.exe");
      if (image) return attached(image);
    }
    const text = await clipboardCommand(command, wayland ? ["--no-newline", "--type", "text"] : ["-selection", "clipboard", "-o"]);
    return { text: text?.toString("utf8") };
  }
  if (process.platform === "darwin") {
    const png = await clipboardCommand("pngpaste", ["-"]);
    if (png) return attached(png);
    const raw = (await clipboardCommand("osascript", ["-e", "get the clipboard as «class PNGf»"]))?.toString().trim();
    const hex = raw && /^«data PNGf([a-f\d]+)»$/i.exec(raw)?.[1];
    if (hex) return attached(Buffer.from(hex, "hex"));
    return { text: (await clipboardCommand("pbpaste", []))?.toString("utf8") };
  }
  if (process.platform === "win32") {
    const image = await windowsClipboardImage("powershell.exe");
    if (image) return attached(image);
    return { text: (await clipboardCommand("powershell.exe", ["-NoProfile", "-STA", "-Command", "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; Get-Clipboard -Raw"]))?.toString("utf8") };
  }
  return {};
}
async function windowsClipboardImage(command) {
  const script = "Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; $image = [System.Windows.Forms.Clipboard]::GetImage(); if ($image) { $stream = New-Object System.IO.MemoryStream; try { $image.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png); [Console]::Write([Convert]::ToBase64String($stream.ToArray())) } finally { $stream.Dispose(); $image.Dispose() } }";
  const bytes = await clipboardCommand(command, ["-NoProfile", "-STA", "-Command", script]);
  return bytes ? Buffer.from(bytes.toString().trim(), "base64") : void 0;
}
function parseMessageArgs(args) {
  const words = [], imagePaths = [];
  let fresh = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") {
      words.push(...args.slice(i + 1));
      break;
    }
    if (arg === "--fresh" || arg === "-f") fresh = true;
    else if (arg === "-m" || arg === "--message") continue;
    else if (arg === "--image" || arg === "-i" || arg.startsWith("--image=")) {
      const path = arg.startsWith("--image=") ? arg.slice(8) : args[++i];
      if (!path || path.startsWith("--")) throw new Error("用法：--image <图片路径>（可重复指定）");
      imagePaths.push(path);
      if (imagePaths.length > MAX_IMAGES) throw new Error(`每条消息最多附加 ${MAX_IMAGES} 张图片`);
    } else words.push(arg);
  }
  return { text: words.join(" ").trim(), fresh, imagePaths };
}
export {
  MAX_IMAGES,
  MAX_IMAGE_BYTES,
  assertImageSupport,
  imageAttachment,
  imagePath,
  parseMessageArgs,
  readClipboardInput,
  readImageAttachment
};
