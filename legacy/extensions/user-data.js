import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
function userDataDir(legacyDir) {
  return process.env.DITO_USER_DIR ? resolve(process.env.DITO_USER_DIR) : join(legacyDir, "user");
}
function channelDataDir(legacyDir, channel) {
  return join(userDataDir(legacyDir), channel);
}
function writePrivateJson(path, value) {
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(value, null, 2) + "\n", { mode: 384 });
  renameSync(temp, path);
}
const migrated = /* @__PURE__ */ new Set();
function migrateChannelData(legacyDir) {
  const root = userDataDir(legacyDir);
  const key = `${resolve(legacyDir)}\0${root}`;
  if (migrated.has(key)) return;
  const names = existsSync(legacyDir) ? readdirSync(legacyDir) : [];
  for (const channel of ["qq", "matrix"]) {
    const dir = channelDataDir(legacyDir, channel);
    mkdirSync(dir, { recursive: true, mode: 448 });
    const selected = names.filter((name) => name.startsWith(`${channel}-`) || name.startsWith(`memory-${channel}-`) || name.startsWith(`kb-${channel}-`) || channel === "qq" && (name === "affinity.json" || name === "memes"));
    selected.sort((a, b) => Number(a === `${channel}-chats.json`) - Number(b === `${channel}-chats.json`));
    for (const name of selected) {
      const source = join(legacyDir, name);
      const target = join(dir, name);
      if (existsSync(target)) continue;
      if (name === `${channel}-chats.json`) {
        const index = JSON.parse(readFileSync(source, "utf-8"));
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
export {
  channelDataDir,
  migrateChannelData,
  userDataDir,
  writePrivateJson
};
