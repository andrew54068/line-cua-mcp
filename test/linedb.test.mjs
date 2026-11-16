// End-to-end: linedb.py reads an encrypted fake LINE DB only through the test
// build of LINE Reader.app (launched via LaunchServices). No real LINE data.
//   node test/linedb.test.mjs
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PY = join(ROOT, ".venv/bin/python3");
const T = mkdtempSync(join(tmpdir(), "linedb-test-"));
const APP = join(T, "LINE Reader Test.app");
const HOME = join(T, "home");
const DB = join(HOME, "Library/Containers/jp.naver.line.mac/Data/Library/Containers/jp.naver.line/Data/db");
const KEY = "00112233445566778899aabbccddeeff";

if (!existsSync(PY)) {
  console.log("skip linedb.test.mjs: no .venv with apsw-sqlite3mc");
  process.exit(0);
}
try {
  execFileSync("bash", [join(ROOT, "scripts/build-helper.sh"), APP], { env: { ...process.env, LINE_READER_TEST: "1" }, stdio: "ignore" });
  mkdirSync(DB, { recursive: true });
  // Same cipher LINE uses (wxSQLite3 AES-128-CBC, kdf_iter=1), minimal schema.
  execFileSync(PY, ["-c", `
import apsw, sys
con = apsw.Connection(sys.argv[1])
con.pragma("cipher", "aes128cbc"); con.pragma("kdf_iter", 1); con.pragma("key", sys.argv[2])
con.execute("""
CREATE TABLE _profile(_mid TEXT, _displayName TEXT);
CREATE TABLE _chat(_id TEXT, _lastUpdatedTime INTEGER, _lastMessage TEXT);
CREATE TABLE _groupChat(_chatMid TEXT, _chatName TEXT);
CREATE TABLE _contact(_mid TEXT, _displayNameOverridden TEXT, _displayName TEXT, _targetProfileDetail TEXT);
CREATE TABLE _message(_id TEXT, _chatId TEXT, _from TEXT, _createdTime INTEGER, _text TEXT, _contentType INTEGER);
INSERT INTO _profile VALUES('uMe', 'Me');
INSERT INTO _chat VALUES('u${"a".repeat(32)}', 1700000000000, 'hi');
INSERT INTO _contact VALUES('u${"a".repeat(32)}', NULL, 'Test Friend', NULL);
INSERT INTO _message VALUES('1', 'u${"a".repeat(32)}', 'uMe', 1700000000000, 'hi', 0);
""")
`, join(DB, "qwbtest.edb"), KEY]);

  const env = { ...process.env, LINE_READER_APP: APP, LINE_READER_TEST_HOME: HOME, LINE_READER_TEST_KEY: KEY };
  delete env.LINE_DB_KEY;
  const py = (...args) => {
    const p = spawnSync(PY, [join(ROOT, "src/linedb.py"), ...args], { env, encoding: "utf8", timeout: 120000 });
    return { ...p, json: p.stdout ? JSON.parse(p.stdout) : null };
  };

  const s = py("status");
  assert.equal(s.status, 0, s.stderr);
  assert.equal(s.json.dbFound, true);
  assert.equal(s.json.keyAvailable, true);
  assert.equal(s.json.decryptOk, true);
  assert.equal(s.json.messageCount, 1);
  console.log("✓ status: helper copied the DB and sent the key; decrypt ok");

  const chats = py("list-chats");
  assert.equal(chats.status, 0, chats.stderr);
  assert.equal(chats.json[0].name, "Test Friend");
  console.log("✓ list-chats reads the helper's copy");

  const nokey = spawnSync(PY, [join(ROOT, "src/linedb.py"), "list-chats"], { env: { ...env, LINE_READER_TEST_KEY: "" }, encoding: "utf8", timeout: 120000 });
  assert.notEqual(nokey.status, 0);
  assert.match(nokey.stdout + nokey.stderr, /DB key unavailable/);
  console.log("✓ a missing key fails closed with a clear error");

  const missing = spawnSync(PY, [join(ROOT, "src/linedb.py"), "status"], { env: { ...env, LINE_READER_APP: join(T, "nope.app") }, encoding: "utf8" });
  assert.match(missing.stdout, /not installed/);
  console.log("✓ a missing helper is reported, not worked around");
  console.log("linedb.py via LINE Reader: 4 checks passed (fake encrypted DB; no LINE data or prompts).");
} finally {
  rmSync(T, { recursive: true, force: true });
}
