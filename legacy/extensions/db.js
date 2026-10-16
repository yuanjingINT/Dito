import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
const require2 = typeof import.meta !== "undefined" && typeof import.meta.url === "string" ? createRequire(import.meta.url) : createRequire(__filename);
function createBunDB(path) {
  const { Database } = require2("bun:sqlite");
  const db = new Database(path);
  return {
    close() {
      db.close();
    },
    exec(sql) {
      db.exec(sql);
    },
    run(sql, ...params) {
      db.run(sql, ...params);
    },
    get(sql, ...params) {
      return db.query(sql).get(...params);
    },
    all(sql, ...params) {
      return db.query(sql).all(...params);
    }
  };
}
function createNodeDB(path) {
  const { DatabaseSync } = require2("node:sqlite");
  const db = new DatabaseSync(path);
  return {
    close() {
      db.close();
    },
    exec(sql) {
      db.exec(sql);
    },
    run(sql, ...params) {
      db.prepare(sql).run(...params);
    },
    get(sql, ...params) {
      return db.prepare(sql).get(...params);
    },
    all(sql, ...params) {
      return db.prepare(sql).all(...params);
    }
  };
}
function openDatabase(path) {
  mkdirSync(dirname(path), { recursive: true });
  try {
    return createBunDB(path);
  } catch {
    return createNodeDB(path);
  }
}
export {
  openDatabase
};
