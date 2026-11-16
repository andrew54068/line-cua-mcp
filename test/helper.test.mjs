// Tests for "LINE Reader.app" (helper/line-reader.c) against a fake home in a
// temp folder: no LINE data, no keychain, no permission prompts.
//   node test/helper.test.mjs
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync, chmodSync, rmSync, openSync, readSync, closeSync, constants } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const T = mkdtempSync(join(tmpdir(), "line-reader-test-"));
const APP = join(T, "LINE Reader Test.app");
const BIN = join(APP, "Contents/MacOS/line-reader");
const HOME = join(T, "home");
const DB = join(HOME, "Library/Containers/jp.naver.line.mac/Data/Library/Containers/jp.naver.line/Data/db");
const DATA = join(HOME, "Library/Group Containers/VUTU7AKEUR.jp.naver.line.mac/Real/Library/Data");
const KEY = "0123456789abcdef0123456789abcdef";
let n = 0;

try {
  execFileSync("bash", [join(ROOT, "scripts/build-helper.sh"), APP], { env: { ...process.env, LINE_READER_TEST: "1" }, stdio: "ignore" });
  mkdirSync(DB, { recursive: true });
  mkdirSync(join(DATA, "Caches/acct/chat/m/1"), { recursive: true });
  writeFileSync(join(DB, "qwbaaaa.edb"), "main-db");
  writeFileSync(join(DB, "qwbaaaa.edb-wal"), "main-wal");
  writeFileSync(join(DB, "qwb_keep_aaaa.edb"), "a much larger sibling database file");
  writeFileSync(join(DATA, "Caches/acct/chat/m/1/x.eimg"), "cached-preview");
  writeFileSync(join(T, "secret.txt"), "outside LINE");
  symlinkSync(join(T, "secret.txt"), join(DATA, "Caches/acct/escape"));

  const outDir = () => { const d = mkdtempSync(join(T, "out-")); chmodSync(d, 0o700); return d; };
  const run = (args, env = {}) => spawnSync(BIN, args, { env: { LINE_READER_TEST_HOME: HOME, ...env }, encoding: "utf8" });
  const result = (d) => JSON.parse(readFileSync(join(d, "result.json"), "utf8"));
  const check = (name, fn) => { fn(); n++; console.log(`✓ ${name}`); };

  check("snapshot copies the main DB and its -wal, skips siblings", () => {
    const d = outDir();
    assert.equal(run(["snapshot", "--out", d]).status, 0);
    const r = result(d);
    assert.equal(r.ok, true);
    assert.equal(r.source, join(DB, "qwbaaaa.edb"));
    assert.equal(readFileSync(join(d, "m.edb"), "utf8"), "main-db");
    assert.equal(readFileSync(join(d, "m.edb-wal"), "utf8"), "main-wal");
    assert.equal(existsSync(join(d, "m.edb-shm")), false);
    assert.equal(r.keySent, false);
  });

  const withFifo = (env) => {
    const d = outDir();
    const fifo = join(d, "key.fifo");
    execFileSync("mkfifo", ["-m", "600", fifo]);
    const fd = openSync(fifo, constants.O_RDONLY | constants.O_NONBLOCK);
    const p = run(["snapshot", "--out", d, "--key-fifo", fifo], env);
    const b = Buffer.alloc(64);
    let got = "";
    try { got = b.subarray(0, readSync(fd, b)).toString(); } catch { /* EAGAIN: nothing sent */ }
    closeSync(fd);
    return { p, r: result(d), got };
  };

  check("snapshot sends the key through the FIFO, not result.json", () => {
    const { p, r, got } = withFifo({ LINE_READER_TEST_KEY: KEY });
    assert.equal(p.status, 0);
    assert.equal(r.keySent, true);
    assert.equal(got, KEY + "\n");
    assert.equal(JSON.stringify(r).includes(KEY), false);
  });

  check("snapshot reports a missing key without failing", () => {
    const { r, got } = withFifo({});
    assert.equal(r.ok, true);
    assert.equal(r.keySent, false);
    assert.match(r.keyError, /not found/);
    assert.equal(got, "");
  });

  check("snapshot rejects a malformed key", () => {
    const { r, got } = withFifo({ LINE_READER_TEST_KEY: "not-a-key" });
    assert.equal(r.keySent, false);
    assert.match(r.keyError, /32-hex/);
    assert.equal(got, "");
  });

  check("--key-fifo outside --out is refused", () => {
    const d = outDir();
    const fifo = join(T, "elsewhere.fifo");
    execFileSync("mkfifo", ["-m", "600", fifo]);
    run(["snapshot", "--out", d, "--key-fifo", fifo], { LINE_READER_TEST_KEY: KEY });
    assert.match(result(d).error, /inside --out/);
  });

  check("--out must be a private folder", () => {
    const d = outDir();
    chmodSync(d, 0o755);
    const p = run(["snapshot", "--out", d]);
    assert.equal(p.status, 2);
    assert.equal(existsSync(join(d, "result.json")), false);
  });

  check("copy returns files from LINE's data folder", () => {
    const d = outDir();
    const src = join(DATA, "Caches/acct/chat/m/1/x.eimg");
    assert.equal(run(["copy", "--out", d, src]).status, 0);
    const r = result(d);
    assert.deepEqual(r.files, [{ path: src, copy: "f0", bytes: 14 }]);
    assert.equal(readFileSync(join(d, "f0"), "utf8"), "cached-preview");
  });

  for (const [name, path] of [
    ["a file outside LINE's data folder", join(T, "secret.txt")],
    ["a symlink that escapes LINE's data folder", join(DATA, "Caches/acct/escape")],
    ["a ../ path that escapes LINE's data folder", join(DATA, "../../../../../../secret.txt")],
    ["a relative path", "Caches/acct/chat/m/1/x.eimg"],
  ]) {
    check(`copy refuses ${name}`, () => {
      const d = outDir();
      assert.equal(run(["copy", "--out", d, path]).status, 1);
      assert.equal(result(d).ok, false);
      assert.equal(existsSync(join(d, "f0")), false);
    });
  }

  check("list walks a folder inside LINE's data folder only", () => {
    const d = outDir();
    run(["list", "--out", d, join(DATA, "Caches")]);
    const r = result(d);
    assert.deepEqual(r.files.map((f) => f.path).sort(), ["acct/chat/m/1/x.eimg"]);
    const e = outDir();
    run(["list", "--out", e, T]);
    assert.equal(result(e).ok, false);
  });

  check("runs through LaunchServices (open -W) and writes its result", () => {
    const d = outDir();
    spawnSync("/usr/bin/open", ["-W", "-n", "-g", "-j", "--env", `LINE_READER_TEST_HOME=${HOME}`, "-a", APP, "--args", "snapshot", "--out", d], { timeout: 60000 });
    // `open -W` returns early when the helper exits first; wait for result.json.
    for (let i = 0; i < 200 && !existsSync(join(d, "result.json")); i++) execFileSync("sleep", ["0.05"]);
    assert.equal(result(d).ok, true);
    assert.equal(readFileSync(join(d, "m.edb"), "utf8"), "main-db");
  });

  console.log(`LINE Reader helper: ${n} checks passed (fake home; no LINE data, keychain, or prompts).`);
} finally {
  rmSync(T, { recursive: true, force: true });
}
