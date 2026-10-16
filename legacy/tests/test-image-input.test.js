import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { assertImageSupport, imageAttachment, MAX_IMAGE_BYTES, parseMessageArgs, readImageAttachment } from "../bin/image-input.js";
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jX1sAAAAASUVORK5CYII=", "base64");
test("CLI parses images in every message form, fresh sessions and literal option text", () => {
  for (const prefix of [[], ["-m"], ["--message"]]) {
    assert.deepEqual(parseMessageArgs([...prefix, "看看这两张图", "--image", "照片 1.png", "-i", "二.jpg", "--fresh"]), {
      text: "看看这两张图",
      imagePaths: ["照片 1.png", "二.jpg"],
      fresh: true
    });
  }
  assert.deepEqual(parseMessageArgs(["--image=a.png"]), { text: "", imagePaths: ["a.png"], fresh: false });
  assert.deepEqual(parseMessageArgs(["--", "--image", "a.png", "--fresh"]), { text: "--image a.png --fresh", imagePaths: [], fresh: false });
  assert.throws(() => parseMessageArgs(["--image"]), /图片路径/);
  assert.throws(() => parseMessageArgs(["--image", "--fresh"]), /图片路径/);
  assert.throws(() => parseMessageArgs(Array.from({ length: 9 }, () => "--image=a.png")), /最多附加 8/);
});
test("files use magic bytes, accept quoted/escaped paths and reject non-images", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dito-image-test-"));
  try {
    const file = join(dir, "图片 sample.txt");
    await writeFile(file, png);
    for (const path of [file, `"${file}"`, `'${file}'`, file.replace(/ /g, "\\ ")]) {
      const image = await readImageAttachment(path);
      assert.equal(image.name, "图片 sample.txt");
      assert.deepEqual(image.content, { type: "image", mimeType: "image/png", data: png.toString("base64") });
    }
    await writeFile(file, "not an image");
    await assert.rejects(readImageAttachment(file), /仅支持/);
    await assert.rejects(readImageAttachment(dir), /图片文件/);
    await assert.rejects(readImageAttachment(join(dir, "missing.png")), /ENOENT/);
    await assert.rejects(readImageAttachment(""), /用法/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("attachments bound size, normalize GIFs and refuse text-only models", () => {
  assert.throws(() => imageAttachment(Buffer.alloc(0), "empty"), /20 MiB/);
  assert.throws(() => imageAttachment(Buffer.alloc(MAX_IMAGE_BYTES + 1), "large"), /20 MiB/);
  const gif = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");
  assert.equal(imageAttachment(gif, "animated.gif").content.mimeType, "image/png");
  assert.throws(() => assertImageSupport({ model: { input: ["text"] } }, 1), /不支持图片/);
  assert.doesNotThrow(() => assertImageSupport({ model: { input: ["text", "image"] } }, 1));
  assert.doesNotThrow(() => assertImageSupport({ model: { input: ["text"] } }, 0));
});
test("real CLI delivers image bytes, image-only prompts and piped text without model requests", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dito-cli-images-"));
  const root = fileURLToPath(new URL("../", import.meta.url));
  const capture = join(dir, "capture.json");
  const preload = join(dir, "preload.mjs"), session = join(dir, "session.mjs"), plugins = join(dir, "plugins.mjs");
  try {
    await writeFile(join(dir, "sample.png"), png);
    await writeFile(session, `import { writeFileSync } from 'node:fs';
      export function listSessions() { return []; }
      export async function createSession(options) { return { session: {
        model: { input: ['text', 'image'] }, subscribe() {}, dispose() {},
        async prompt(text, promptOptions) { writeFileSync(process.env.DITO_TEST_CAPTURE, JSON.stringify({ text, options, promptOptions })); }
      } }; }`);
    await writeFile(plugins, "export async function ensurePluginInstallation() {}");
    await writeFile(preload, `import { registerHooks } from 'node:module';
      registerHooks({ resolve(specifier, context, next) {
        if (context.parentURL?.endsWith('/bin/dito.js')) {
          if (specifier === './session.js') return { shortCircuit: true, url: ${JSON.stringify(pathToFileURL(session).href)} };
          if (specifier === './plugin-manager.js') return { shortCircuit: true, url: ${JSON.stringify(pathToFileURL(plugins).href)} };
        }
        return next(specifier, context);
      } });`);
    const run = promisify(execFile);
    const env = { ...process.env, DITO_TEST_CAPTURE: capture, DITO_INVOKE_CWD: dir };
    const entry = ["--import", join(root, "register-loader.mjs"), "--import", preload, join(root, "bin/dito.js")];
    await run(process.execPath, [...entry, "send", "describe", "--fresh", "--image", "sample.png"], { cwd: root, env, timeout: 2e4 });
    const result = JSON.parse(await readFile(capture, "utf8"));
    assert.equal(result.text, "describe");
    assert.equal(result.options.fresh, true);
    assert.deepEqual(result.promptOptions.images, [{ type: "image", mimeType: "image/png", data: png.toString("base64") }]);
    for (const args of [["--image", join(dir, "sample.png")], ["-m", "caption", "-i", join(dir, "sample.png")]]) {
      await run(process.execPath, [...entry, ...args], { cwd: root, env, timeout: 2e4 });
      const sent = JSON.parse(await readFile(capture, "utf8"));
      assert.equal(sent.text, args[0] === "-m" ? "caption" : "");
      assert.equal(sent.promptOptions.images[0].data, png.toString("base64"));
    }
    await new Promise((resolve, reject) => {
      const child = execFile(process.execPath, [...entry, "send", "--image", "sample.png"], { cwd: root, env, timeout: 2e4 }, (error) => error ? reject(error) : resolve());
      child.stdin?.end("来自管道的说明");
    });
    const piped = JSON.parse(await readFile(capture, "utf8"));
    assert.equal(piped.text, "来自管道的说明");
    assert.equal(piped.promptOptions.images[0].data, png.toString("base64"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
