/**
 * Dito 提示词加密模块。
 *
 * 把人设（personas/）、用户身份（identities/）、系统专属提示词（system-prompts/）
 * 加密到 desktop/prompts/dito-prompts.bin。Dito 运行时透明解密读取；
 * 打包桌面版时可以不携带任何明文提示词，普通用户看不到提示词内容。
 *
 * 加密算法：AES-256-GCM。每份提示词使用独立随机 IV 与 authTag。
 * 密钥来源：优先 DITO_PROMPT_KEY（可选的运行环境注入），
 *           否则使用内置混淆碎片派生的密钥（用于开发/构建，可防普通翻看，不防专业逆向）。
 */
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** 包根目录（extensions/ 的上一级） */
export const PROMPT_ROOT = join(__dirname, "..");

export type PromptNamespace = "personas" | "identities" | "system-prompts";

export const NAMESPACE_DIRS: Record<PromptNamespace, string> = {
  personas: join(PROMPT_ROOT, "personas"),
  identities: join(PROMPT_ROOT, "identities"),
  "system-prompts": join(PROMPT_ROOT, "system-prompts"),
};

/** 加密提示词包路径（可用环境变量覆盖，方便桌面版/测试） */
export const PROMPT_BUNDLE_PATH =
  process.env.DITO_PROMPT_BUNDLE || join(PROMPT_ROOT, "desktop", "prompts", "dito-prompts.bin");

// ── 内置密钥碎片（仅用于开发/构建；桌面版建议注入 DITO_PROMPT_KEY） ──
const KEY_FRAGMENTS = [
  Buffer.from("/Hdew9hakGF8ni/gTCXZCMoev2GFD04Xh0X7Up3gk4g=", "base64"),
  Buffer.from("Ctuf6r+hSORITDeal6YUoucIX5sWHWx2kvsTRJzUwiI=", "base64"),
  Buffer.from("XioASJH7wvj0w0IzMCs1XGp33m1HnxDX4frFowFGNHg=", "base64"),
];

function deriveMaterial(): Buffer {
  let out = Buffer.alloc(32);
  for (const frag of KEY_FRAGMENTS) {
    for (let i = 0; i < out.length && i < frag.length; i++) out[i] ^= frag[i];
  }
  return out;
}

export interface EncryptedPromptEntry {
  /** 相对包根的提示词文件路径，如 personas/dito.md */
  path: string;
  /** 文件名（不含扩展名），如 dito */
  name: string;
  /** AES-256-GCM 密文（base64） */
  ciphertext: string;
  /** IV（base64） */
  iv: string;
  /** GCM 认证标签（base64） */
  authTag: string;
}

interface PromptBundle {
  version: number;
  /** scrypt 盐（base64） */
  salt: string;
  prompts: Record<string, EncryptedPromptEntry>;
}

let cachedBundle: PromptBundle | null = null;
let cachedBundlePath = "";

/** 当前实际使用的密钥：优先环境变量注入，其次内置碎片派生。 */
export function getPromptKey(salt?: Buffer | string): Buffer {
  const envKey = (process.env.DITO_PROMPT_KEY || "").trim();
  if (envKey) return Buffer.from(envKey, "base64");
  const saltBuf = typeof salt === "string" ? Buffer.from(salt, "base64") : salt ?? Buffer.alloc(16, 0x44);
  return scryptSync(deriveMaterial(), saltBuf, 32);
}

export function loadPromptBundle(): PromptBundle | null {
  if (cachedBundle && cachedBundlePath === PROMPT_BUNDLE_PATH) return cachedBundle;
  if (!existsSync(PROMPT_BUNDLE_PATH)) return null;
  try {
    const raw = readFileSync(PROMPT_BUNDLE_PATH, "utf-8");
    const data = JSON.parse(raw) as PromptBundle;
    if (!data || data.version !== 1 || !data.prompts) return null;
    cachedBundle = data;
    cachedBundlePath = PROMPT_BUNDLE_PATH;
    return cachedBundle;
  } catch (err) {
    console.error(`[dito] 提示词加密包读取失败：${(err as Error).message}`);
    return null;
  }
}

export function hasPromptBundle(): boolean {
  return loadPromptBundle() !== null;
}

/** 把文件所在目录映射为提示词命名空间；非提示词目录返回 null。 */
export function namespaceForDir(dir: string): PromptNamespace | null {
  const normalized = dir.endsWith("/") ? dir.slice(0, -1) : dir;
  if (normalized === NAMESPACE_DIRS.personas) return "personas";
  if (normalized === NAMESPACE_DIRS.identities) return "identities";
  if (normalized === NAMESPACE_DIRS["system-prompts"]) return "system-prompts";
  return null;
}

/** 列出加密包内某个命名空间下的提示词名称（不含扩展名） */
export function listEncryptedPromptNames(namespace: PromptNamespace, ext = ".md"): string[] {
  const bundle = loadPromptBundle();
  if (!bundle) return [];
  const prefix = `${namespace}/`;
  const names: string[] = [];
  for (const entry of Object.values(bundle.prompts)) {
    if (entry.path.startsWith(prefix) && entry.path.endsWith(ext)) {
      names.push(entry.path.slice(prefix.length, -ext.length));
    }
  }
  return names.sort((a, b) => a.localeCompare(b, "zh"));
}

/** 读取并解密包内某份提示词。未命中返回 null。 */
export function readEncryptedPrompt(namespace: PromptNamespace, fileName: string): string | null {
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
    console.error(`[dito] 提示词解密失败（${keyPath}）：${(err as Error).message}`);
    return null;
  }
}

// ── 构建加密包 ──────────────────────────────────────────────────

function encryptPromptText(plain: string, key: Buffer): EncryptedPromptEntry {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plain, "utf-8"), cipher.final()]);
  return {
    path: "",
    name: "",
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
  };
}

/**
 * 扫描 personas/identities/system-prompts 下的 .md 文件，加密写入
 * desktop/prompts/dito-prompts.bin。返回写入的条目数。
 */
export function buildPromptBundle(outputPath = PROMPT_BUNDLE_PATH): number {
  const salt = randomBytes(16);
  const key = getPromptKey(salt);
  const prompts: Record<string, EncryptedPromptEntry> = {};

  for (const [namespace, dir] of Object.entries(NAMESPACE_DIRS) as [PromptNamespace, string][]) {
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

  const bundle: PromptBundle = { version: 1, salt: salt.toString("base64"), prompts };
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, JSON.stringify(bundle, null, 2), "utf-8");
  return Object.keys(prompts).length;
}
