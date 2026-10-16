import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const HERE = typeof import.meta !== "undefined" && typeof import.meta.url === "string" ? dirname(fileURLToPath(import.meta.url)) : typeof __dirname !== "undefined" ? __dirname : ".";
const PROMPT_ROOT = process.env.DITO_RESOURCE_DIR || join(HERE, "../..");
const NAMESPACE_DIRS = {
  personas: join(PROMPT_ROOT, "personas"),
  identities: join(PROMPT_ROOT, "identities"),
  "system-prompts": join(PROMPT_ROOT, "system-prompts")
};
const PROMPT_BUNDLE_PATH = process.env.DITO_PROMPT_BUNDLE || join(PROMPT_ROOT, "desktop", "prompts", "dito-prompts.bin");
const KEY_FRAGMENTS = [
  Buffer.from("/Hdew9hakGF8ni/gTCXZCMoev2GFD04Xh0X7Up3gk4g=", "base64"),
  Buffer.from("Ctuf6r+hSORITDeal6YUoucIX5sWHWx2kvsTRJzUwiI=", "base64"),
  Buffer.from("XioASJH7wvj0w0IzMCs1XGp33m1HnxDX4frFowFGNHg=", "base64")
];
function deriveMaterial() {
  let out = Buffer.alloc(32);
  for (const frag of KEY_FRAGMENTS) {
    for (let i = 0; i < out.length && i < frag.length; i++) out[i] ^= frag[i];
  }
  return out;
}
let cachedBundle = null;
let cachedBundlePath = "";
function getPromptKey(salt) {
  const envKey = (process.env.DITO_PROMPT_KEY || "").trim();
  if (envKey) return Buffer.from(envKey, "base64");
  const saltBuf = typeof salt === "string" ? Buffer.from(salt, "base64") : salt ?? Buffer.alloc(16, 68);
  return scryptSync(deriveMaterial(), saltBuf, 32);
}
function loadPromptBundle() {
  if (cachedBundle && cachedBundlePath === PROMPT_BUNDLE_PATH) return cachedBundle;
  if (!existsSync(PROMPT_BUNDLE_PATH)) return null;
  try {
    const raw = readFileSync(PROMPT_BUNDLE_PATH, "utf-8");
    const data = JSON.parse(raw);
    if (!data || data.version !== 1 || !data.prompts) return null;
    cachedBundle = data;
    cachedBundlePath = PROMPT_BUNDLE_PATH;
    return cachedBundle;
  } catch (err) {
    console.error(`[dito] 提示词加密包读取失败：${err.message}`);
    return null;
  }
}
function hasPromptBundle() {
  return loadPromptBundle() !== null;
}
function namespaceForDir(dir) {
  const normalized = dir.endsWith("/") ? dir.slice(0, -1) : dir;
  if (normalized === NAMESPACE_DIRS.personas) return "personas";
  if (normalized === NAMESPACE_DIRS.identities) return "identities";
  if (normalized === NAMESPACE_DIRS["system-prompts"]) return "system-prompts";
  return null;
}
function listEncryptedPromptNames(namespace, ext = ".md") {
  const bundle = loadPromptBundle();
  if (!bundle) return [];
  const prefix = `${namespace}/`;
  const names = [];
  for (const entry of Object.values(bundle.prompts)) {
    if (entry.path.startsWith(prefix) && entry.path.endsWith(ext)) {
      names.push(entry.path.slice(prefix.length, -ext.length));
    }
  }
  return names.sort((a, b) => a.localeCompare(b, "zh"));
}
function readEncryptedPrompt(namespace, fileName) {
  const bundle = loadPromptBundle();
  if (!bundle) return null;
  const keyPath = `${namespace}/${fileName}`;
  const entry = bundle.prompts[keyPath];
  if (!entry) return null;
  try {
    const key = getPromptKey(bundle.salt);
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(entry.iv, "base64"));
    decipher.setAuthTag(Buffer.from(entry.authTag, "base64"));
    const plain = Buffer.concat([decipher.update(Buffer.from(entry.ciphertext, "base64")), decipher.final()]);
    return plain.toString("utf-8").trim();
  } catch (err) {
    console.error(`[dito] 提示词解密失败（${keyPath}）：${err.message}`);
    return null;
  }
}
function encryptPromptText(plain, key) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plain, "utf-8"), cipher.final()]);
  return {
    path: "",
    name: "",
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64")
  };
}
function buildPromptBundle(outputPath = PROMPT_BUNDLE_PATH) {
  const salt = randomBytes(16);
  const key = getPromptKey(salt);
  const prompts = {};
  for (const [namespace, dir] of Object.entries(NAMESPACE_DIRS)) {
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir, { withFileTypes: true })) {
      if (!file.isFile() || !file.name.endsWith(".md")) continue;
      const path = `${namespace}/${file.name}`;
      const plain = readFileSync(join(dir, file.name), "utf-8");
      const entry = encryptPromptText(plain, key);
      entry.path = path;
      entry.name = file.name.slice(0, -3);
      prompts[path] = entry;
    }
  }
  const bundle = { version: 1, salt: salt.toString("base64"), prompts };
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, JSON.stringify(bundle, null, 2), "utf-8");
  return Object.keys(prompts).length;
}
export {
  NAMESPACE_DIRS,
  PROMPT_BUNDLE_PATH,
  PROMPT_ROOT,
  buildPromptBundle,
  getPromptKey,
  hasPromptBundle,
  listEncryptedPromptNames,
  loadPromptBundle,
  namespaceForDir,
  readEncryptedPrompt
};
