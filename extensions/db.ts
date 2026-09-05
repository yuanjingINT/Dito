/**
 * Dito 共享数据库工具：运行环境无关的 SQLite 封装。
 *
 * - pi 二进制运行在 Bun 上 → 用 `bun:sqlite`
 * - SDK/REPL 运行在 Node 上 → 用 `node:sqlite`
 *
 * 统一成 { exec, run, get, all } 四个方法，两个后端行为一致。
 */
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

// ESM 下没有全局 require，用 createRequire 恢复 CommonJS 风格加载，
// 以便按运行时选择 bun:sqlite / node:sqlite。
const require = createRequire(import.meta.url);

type Row = Record<string, unknown>;

export interface DitoDB {
  exec(sql: string): void;
  run(sql: string, ...params: unknown[]): void;
  get(sql: string, ...params: unknown[]): Row | undefined;
  all(sql: string, ...params: unknown[]): Row[];
}

function createBunDB(path: string): DitoDB {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { Database } = require("bun:sqlite") as { Database: new (p: string) => any };
  const db = new Database(path);
  return {
    exec(sql: string) {
      db.exec(sql);
    },
    run(sql: string, ...params: unknown[]) {
      db.run(sql, ...params);
    },
    get(sql: string, ...params: unknown[]) {
      return db.query(sql).get(...params) as Row | undefined;
    },
    all(sql: string, ...params: unknown[]) {
      return db.query(sql).all(...params) as Row[];
    },
  };
}

function createNodeDB(path: string): DitoDB {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { DatabaseSync } = require("node:sqlite") as { DatabaseSync: new (p: string) => any };
  const db = new DatabaseSync(path);
  return {
    exec(sql: string) {
      db.exec(sql);
    },
    run(sql: string, ...params: unknown[]) {
      db.prepare(sql).run(...params);
    },
    get(sql: string, ...params: unknown[]) {
      return db.prepare(sql).get(...params) as Row | undefined;
    },
    all(sql: string, ...params: unknown[]) {
      return db.prepare(sql).all(...params) as Row[];
    },
  };
}

export function openDatabase(path: string): DitoDB {
  mkdirSync(dirname(path), { recursive: true });
  try {
    return createBunDB(path);
  } catch {
    return createNodeDB(path);
  }
}
