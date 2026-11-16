<p align="center">
  <img src="assets/banner.svg" alt="line-cua-mcp — Read LINE's local DB · send cursor-free" width="640">
</p>

> Language: English | [繁體中文（台灣）README](README.md)

macOS-only LINE Desktop MCP server. **Reads** come from a read-only snapshot of LINE's local encrypted database; the read path is fully backgrounded and does not touch the UI: no cursor movement, no window focus change, no OCR, no scrolling, and it works even if LINE is closed. **Sends** must go through the LINE UI, driven cursor-free by [cua-driver](https://github.com/trycua/cua); before sending, the tool OCRs the conversation header and cross-checks the target against the local DB.

## Experimental warning

This is an **experimental personal tool**, not a polished product and not commercial-grade software for general users. It reads your local LINE Desktop encrypted database and, when explicitly requested, can send messages through the LINE UI. Treat it as a research/self-use prototype:

- Use it only on **your own Mac, your own LINE account, and your own data**.
- First-time setup requires capturing the local LINE DB key; this normally launches a re-signed copy of LINE and asks you to log in, which may log your main LINE Desktop session out.
- Sends are guarded by OCR plus a local-DB cross-check, but they are not risk-free. The default is draft-only (`auto: false`); review before sending.
- LINE updates, macOS permissions, OCR behavior, DB schema changes, or `cua-driver` changes can break it.
- You are responsible for complying with LINE's Terms of Service and local law. This project is independent and is not affiliated with, endorsed by, or sponsored by LINE/NAVER.

## Two paths

- **Reads are database-backed.** LINE Desktop for macOS is a **Qt6/QML** app whose message text is GPU-rendered and absent from the accessibility tree. But message history lives in LINE's local **wxSQLite3 / QtCipherSqlitePlugin AES-128-CBC** encrypted SQLite DB (`…/Data/db/qwb*.edb`). `read_history` / `list_chats` decrypt a read-only snapshot using the account key in the macOS keychain and return the **history present in the local DB** — every locally-stored message, with sender, timestamp, and direction — plus a coverage footer (local count, oldest/newest stored). The DB only holds what LINE Desktop has synced to this Mac; older messages never loaded locally are absent (use `sync_older_messages` to backfill). This path is fully backgrounded and never touches the UI. Earlier versions OCR'd the screen and could only see the visible viewport; that path is gone.
- **Sends are UI-driven, but cursor-free.** You cannot send by mutating the DB, so `send_message` drives the LINE UI through cua-driver: CGEvents are posted to target coordinates / keys without warping the visible cursor. LINE may briefly come forward to open the target chat, then the previous foreground app is restored.

## Attachment downloads (opt-in)

`get_attachment({"messageId":"…"})` keeps the local-only path. Set `"download":true` to try LINE Desktop's official UI when no full cache copy exists. This can contact LINE's servers, foreground LINE, and **open the downloaded document in its default app**. Only ordinary file messages (ct14) ending in `.pdf`, `.txt`, `.csv`, `.docx`, `.xlsx`, or `.pptx` are supported. Scripts, executables, legacy Office files, and macro-enabled Office files are refused. An allowed extension does not establish that a document is safe.

The tool requires a unique filename across the local DB (including text mentions), an unambiguous chat name, verified chat headers, a single message-search result with the exact chat name and “1 message found”, and an exact highlighted filename in the conversation. Vision supplies click coordinates; uncertain, truncated, duplicate, or unhighlighted matches are refused. Only yellow/orange search highlighting is supported. Expired attachments and attachments without a verifiable expiry date are refused. UI downloads are serialized with other UI operations in this server process; do not interact with LINE or run another automation process during a download.

Success returns `downloaded.path` and `downloaded.bytes` only after LINE records a downloaded path with the exact expected byte count. Node does not open or stat that path. The DB record is not independent proof that the file still exists. LINE may leave the downloaded document’s app in front; restoring the previous app is best-effort. A timeout or Save dialog is not reported as success, and the tool does not retry the attachment click. No media key is returned, and no direct LINE server API is used. OCR/layout behavior is experimental and has not been live-verified for this download flow. The tool cannot verify messages absent from the local DB or promise zero account restriction risk.

## MCP tools

| Tool | Purpose |
|------|---------|
| `line_status` | Report LINE UI availability plus local DB/key/decryption status. LINE does **not** need to be running for DB-backed reads; only UI tools require it. |
| `list_chats` | List recent chats from the local DB: name, chatId, last-activity time, and whether it is a group. Fully backgrounded. |
| `read_history` | Read a chat's history (present in the local DB) by name or chatId from the decrypted DB: text, direction, absolute timestamps, plus a local-coverage footer. No cursor, focus change, OCR, or scrolling. |
| `sync_older_messages` | **Best-effort, UI-driven (not background):** foregrounds LINE and scrolls a chat upward so LINE backfills older messages into the local DB. Cursor-free, focus restored. Reports before/after coverage. Requires LINE running. |
| `select_chat` | Open a chat through the UI (search → pixel-click the top result). Used by `send_message`. Cursor-free; focus is restored. |
| `send_files` | Prepare exact 1:1 file manifests; use the line-send-files skill native chooser workflow for uploads and verify DB delivery receipts. File-URL paste is unsupported; auto=true is refused. |
| `send_message` | Draft or send a message through the UI. Guarded by anchored name matching, 1:1-only defaults, and a DB cross-check. |

## Local DB and key

`src/linedb.py` (run through the project venv with `apsw-sqlite3mc`) handles decryption, but it **never opens LINE's folders itself**. macOS protects other apps' data ("would like to access data from other apps"), and the prompt names the process that asks. So every read of LINE's folders goes through one small, named app with a purpose string: **LINE Reader.app** (`helper/line-reader.c`, bundle ID `com.dawson.line-reader`).

- LINE Reader copies `qwb*.edb`, `-wal`, and `-shm` into a private temp folder (mode 0700) that the caller created. It hands the keychain key to `linedb.py` through a FIFO, so the key never lands in a regular file. `linedb.py` opens only that copy, so it never locks or mutates the file LINE is writing.
- LINE Reader only copies. It does not write LINE's data, use the network, run scripts, or load user-writable code (hardened runtime + library validation). A grant to it therefore cannot be borrowed to run other code; the most a caller gets is a copy of LINE's data.
- `linedb.py` starts it through LaunchServices (`open -W -a "LINE Reader.app"`), so the macOS prompt reads **"LINE Reader" would like to access data from other apps**, followed by the purpose: *Copies LINE Desktop's local chat database and attachment cache into a private temporary folder…*. A prompt that names Python, node, or anything else does not come from this project: click "Don't Allow".
- macOS remembers this consent for one process only, so each read can ask again. For no prompts at all, add `~/Applications/LINE Reader.app` under System Settings → Privacy & Security → Full Disk Access. That is your choice; this project never grants permissions automatically.

Install it on the Mac that runs LINE (the build is deterministic; an unchanged build is not replaced, so existing grants stay valid):

```bash
yarn helper:install   # builds and installs ~/Applications/LINE Reader.app
```

Cipher parameters:

```sql
PRAGMA cipher='aes128cbc';
PRAGMA kdf_iter=1;
PRAGMA key='<32-hex>';
```

This is **wxSQLite3 AES-128, not SQLCipher**; SQLCipher PRAGMAs/AES-256 will not open it.

### Key

The 32-hex key is never written to the repo or a plaintext file by this project. It lives in the macOS login keychain service `line-cua-mcp-dbkey`. LINE Reader reads it with Apple's `security` tool (which the item already trusts, so there is no extra prompt) and passes it to `linedb.py` through a FIFO. `$LINE_DB_KEY` overrides the keychain:

```bash
security find-generic-password -s line-cua-mcp-dbkey -w   # read it back
```

### Capturing the key (first-time setup)

On a SIP-enabled Mac you cannot directly attach to the hardened, sandboxed LINE app. The workable one-time flow (without disabling SIP) is:

1. Copy `LINE.app` to a scratch directory and run `xattr -cr` on the copy.
2. Ad-hoc re-sign the copy with `com.apple.security.get-task-allow` (this also strips the hardened-runtime flag), e.g. `codesign -f -s - --deep --entitlements ent.plist LINEcopy.app`.
3. Launch the copied app and log into your account. This usually logs the main LINE Desktop session out; log back in after the capture. The key is account-stable, so the key from the copy decrypts the real DB.
4. Attach `lldb` to the copy (`get-task-allow` makes it debuggable) and scan writable memory for the 32-hex token near an `encryption_key=` / `mse` marker.
5. Validate against the real DB and store it:
   ```bash
   security add-generic-password -a "$USER" -s line-cua-mcp-dbkey -w <key> -U
   ```
   Then delete the copied LINE app.

If LINE rotates the key later, `linedb.py status` reports `decryptOk: false`; repeat the capture.

### Quick checks

```bash
.venv/bin/python src/linedb.py status                 # db found, key, decryptOk, counts
.venv/bin/python src/linedb.py list-chats --limit 20
.venv/bin/python src/linedb.py read "<chat name>"     # full history (JSON)
.venv/bin/python src/linedb.py export-md --name "<chat>" --thread "<Name>" --out out.md
```

## Send safety

`send_message` has external side effects and multiple guards. `send_files` only prepares a manifest; the skill native chooser step performs delivery:

1. **Re-selects** the named chat; it never sends into "whatever is open".
2. **Anchored name match** (not substring): the OCR'd conversation header must equal the target after normalization, tolerating only a single trailing non-alphanumeric glyph from LINE header icons. A short target like `明` does not pass against `小明子` / `陳明婷`, and `Alice` does not pass against `Alice2`.
3. **1:1 only by default**: if the open chat header shows a member-count badge `(N)`, it is treated as a group and the send is refused. Pass `allowGroup: true` to override.
4. **DB cross-check** (`crossCheckSendTarget`): the local DB — not header OCR — is the authoritative source for chat identity and group status. The target is resolved against the chat list and refused if it is a group, ambiguous, or if the OCR'd header points at a different chat than the target.
5. **Re-verifies immediately before** the irreversible Return keypress.
6. `auto: false` is the default: it only leaves a draft in the composer.

`ocr.ts` (native macOS Vision via `src/ocr.swift`) is now used **only** for this send-path header verification; message reading no longer uses OCR.

Pure matcher / cross-check logic is unit-tested (`yarn test`). The DB cross-check closes two classes of header-OCR fail-open cases:

- **Group-as-1:1**: even if the `(N)` badge is cropped out or misread, the DB's `isGroup` refuses the target. `isGroup` fails closed: anything not `u`-prefixed as a 1:1 contact — groups, rooms, LINE Square communities, unknown future types — counts as a group.
- **Wrong person**, in both directions: *extension* — the OCR'd header resolves to another known chat (e.g. target `小明` but `小明華` opened); and *truncation* — the header is a strict prefix of another known chat name (OCR may have clipped a longer name down). Both are refused; ambiguous targets are refused.

**Residual limits & trade-offs:** the cross-check needs the local DB (key in keychain); if unavailable, the guard degrades to OCR-only and logs that it did. Sending to a 1:1 whose name is a strict prefix of another chat's name is refused by the truncation guard; use the full name or exact chatId. Because there is no independent signal for which chat is actually on screen, two chats with identical display names (one a group), or a brand-new chat not yet in the DB whose longer header OCR-truncates to exactly the target, cannot be fully solved by name alone. The default remains `auto: false`; review drafts before sending.

## Requirements

- macOS with **LINE** Desktop installed and logged in.
- **Python venv** with `apsw-sqlite3mc` (for the DB read path):
  ```bash
  python3 -m venv .venv && .venv/bin/pip install apsw-sqlite3mc
  ```
- **Xcode Command Line Tools** (`/usr/bin/swiftc`): `yarn build` compiles `src/ocr.swift` to `dist/ocr` for the UI-path OCR. Not needed for reads.
- DB key stored in the keychain service `line-cua-mcp-dbkey` (see above).
- **cua-driver** installed and granted Accessibility / Screen Recording permissions (`select_chat` / `send_message` need it):
  ```bash
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/trycua/cua/main/libs/cua-driver/scripts/install.sh)"
  ```
- Node 18+.

## Build & run

```bash
yarn install
yarn build            # tsc + compile dist/ocr + copy linedb.py into dist/
node dist/server.js   # MCP stdio server
```

Register with Claude Code:

```bash
claude mcp add --transport stdio line-cua -- node /absolute/path/to/line-cua-mcp/dist/server.js
```

## Tuning

DB location and cipher params live in `src/linedb.py`. The send-path OCR crop regions and composer click point are window-fraction constants in `src/ocr.ts` (`HEADER`) and `src/line.ts` (composer `0.72, 0.89`). If LINE changes its layout, adjust these.

## Legal & disclaimer

This is a personal-use tool for accessing **your own** LINE account and data on **your own** machine. By using it you accept that:

- You are responsible for complying with LINE's Terms of Service and the laws of your jurisdiction. Reading the local database and automating the desktop client may be contrary to LINE's ToS; the key-capture step modifies a *copy* of the app, not your installed `LINE.app`. Use it only against your own account/data.
- The software is provided **"AS IS", without warranty of any kind** and with **no liability** to the authors — see [`LICENSE`](LICENSE).
- This is **not legal advice.** If you are unsure whether your use is permitted, seek advice for your jurisdiction.

**Trademark:** "LINE" is a trademark of LINE Corporation / NAVER. This project is independent and is **not affiliated with, endorsed by, or sponsored by** them.

See [`SECURITY.md`](SECURITY.md) for privacy and key-handling notes.
