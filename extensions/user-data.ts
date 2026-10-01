/** QQ / Matrix 私有文件：集中存储，并兼容旧目录的会话索引。 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";

export type UserChannel = "qq" | "matrix";

export function userDataDir(legacyDir: string): string {
  return process.env.DITO_USER_DIR ? resolve(process.env.DITO_USER_DIR) : join(legacyDir, "user");
}

export function channelDataDir(legacyDir: string, channel: UserChannel): string {
  return join(userDataDir(legacyDir), channel);
}

/** 私有 JSON 使用原子替换；仅当前用户可读写。 */
export function writePrivateJson(path: string, value: unknown): void {
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  renameSync(temp, path);
}

const migrated = new Set<string>();

/**
 * 复制旧文件保留备份；只补齐尚不存在的目标，绝不覆盖已有用户数据。
 * 迁移后重写会话映射的绝对路径，继续使用原会话和 Matrix 加密密钥。
 */
export function migrateChannelData(legacyDir: string): void {
  const root = userDataDir(legacyDir);
  const key = `${resolve(legacyDir)}\0${root}`;
  if (migrated.has(key)) return;
  const names = existsSync(legacyDir) ? readdirSync(legacyDir) : [];
  for (const channel of ["qq", "matrix"] as const) {
    const dir = channelDataDir(legacyDir, channel);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const selected = names.filter((name) => name.startsWith(`${channel}-`)
      || name.startsWith(`memory-${channel}-`) || name.startsWith(`kb-${channel}-`)
      || (channel === "qq" && (name === "affinity.json" || name === "memes")));
    // 先复制会话文件，再发布指向新位置的索引。
    selected.sort((a, b) => Number(a === `${channel}-chats.json`) - Number(b === `${channel}-chats.json`));
    for (const name of selected) {
      const source = join(legacyDir, name);
      const target = join(dir, name);
      if (existsSync(target)) continue;
      if (name === `${channel}-chats.json`) {
        const index = JSON.parse(readFileSync(source, "utf-8")) as Record<string, string>;
        const oldSessions = join(legacyDir, `${channel}-sessions`) + sep;
        for (const [chat, file] of Object.entries(index)) {
          if (typeof file === "string" && file.startsWith(oldSessions)) {
            const next = join(dir, `${channel}-sessions`, file.slice(oldSessions.length));
            if (existsSync(next)) index[chat] = next;
          }
        }
        writePrivateJson(target, index);
      } else {
        cpSync(source, target, { recursive: true, errorOnExist: true, force: false });
      }
    }
  }
  migrated.add(key);
}
