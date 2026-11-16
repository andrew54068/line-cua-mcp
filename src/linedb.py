#!/usr/bin/env python3
# linedb.py — read LINE Desktop's encrypted local message DB fully offline.
#
# LINE Desktop (macOS, Qt6) stores all history in a wxSQLite3 / QtCipherSqlitePlugin
# AES-128-CBC encrypted SQLite file (NOT SQLCipher). Given the account's 32-hex
# key, the entire history is readable with zero UI: no cursor, no foreground, no
# OCR, no scrolling. This is the data path the OCR approach could never match.
#
# LINE's folders are protected by macOS ("access data from other apps"), so this
# script never opens them. LINE Reader.app (helper/line-reader.c), a small named
# app with a purpose string, copies the DB (+ -wal/-shm) into a private temp
# folder and hands over the key from the keychain service "line-cua-mcp-dbkey"
# through a FIFO. $LINE_DB_KEY overrides the keychain. We open that copy
# read-only, so we never lock or perturb the file LINE is actively writing.
#
# Decryption: apsw-sqlite3mc with PRAGMA cipher='aes128cbc', kdf_iter=1.
#
# CLI:  linedb.py status
#       linedb.py list-chats [--limit N]
#       linedb.py read <chat-name-or-id> [--limit N]
#       linedb.py search <text> [--limit N]
#       linedb.py attachments <chat-name-or-id> [--kind image|video|audio|file|sticker] [--limit N]
#       linedb.py attachment-sources <message-id>   (internal; includes the media key)
import sys, os, re, json, time, shutil, hashlib, tempfile, datetime, subprocess, argparse, atexit
from zoneinfo import ZoneInfo

try:
    import apsw
except Exception as e:  # pragma: no cover
    print(json.dumps({"error": f"apsw-sqlite3mc not installed: {e}"})); sys.exit(2)

HELPER_APP = os.environ.get("LINE_READER_APP") or os.path.expanduser("~/Applications/LINE Reader.app")


def run_helper(args, out, timeout=180):
    """Run LINE Reader.app through LaunchServices so macOS attributes access to
    LINE's folders (and any permission prompt) to that named app, never to this
    Python process. Returns its result.json; raises SystemExit on failure."""
    if not os.path.isdir(HELPER_APP):
        raise SystemExit(json.dumps({"error": f"LINE Reader.app is not installed at {HELPER_APP}",
                                     "hint": "run scripts/install-helper.sh on the Mac that runs LINE"}))
    cmd = ["/usr/bin/open", "-W", "-n", "-g", "-j"]
    # Test builds of the helper read these; the installed helper ignores its environment.
    cmd += [x for k, v in os.environ.items() if k.startswith("LINE_READER_TEST_") for x in ("--env", f"{k}={v}")]
    subprocess.run(cmd + ["-a", HELPER_APP, "--args", *args, "--out", out],
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=timeout)
    # `open -W` returns early when the helper exits first, so wait for its result.
    result = os.path.join(out, "result.json")
    deadline = time.monotonic() + timeout
    while not os.path.exists(result):
        if time.monotonic() > deadline:
            raise SystemExit(json.dumps({"error": "LINE Reader did not finish",
                "hint": "check the Mac that runs LINE for an unanswered LINE Reader permission prompt"}))
        time.sleep(0.05)
    with open(result, encoding="utf-8") as f:
        res = json.load(f)
    if not res.get("ok"):
        raise SystemExit(json.dumps({"error": f"LINE Reader: {res.get('error')}"}, ensure_ascii=False))
    return res


def snapshot(want_key=True):
    """Copy LINE's message DB into a private temp folder via LINE Reader.
    Returns (folder, helper result, key or None)."""
    tmp = tempfile.mkdtemp(prefix="linedb-")  # mode 0700
    atexit.register(lambda: shutil.rmtree(tmp, ignore_errors=True))
    key = os.environ.get("LINE_DB_KEY", "").strip() or None
    fifo = rfd = None
    if want_key and not key:
        # The key travels through a FIFO, so it never lands in a regular file.
        fifo = os.path.join(tmp, "key.fifo")
        os.mkfifo(fifo, 0o600)
        rfd = os.open(fifo, os.O_RDONLY | os.O_NONBLOCK)
    try:
        res = run_helper(["snapshot"] + (["--key-fifo", fifo] if fifo else []), tmp)
        if rfd is not None:
            try:
                key = os.read(rfd, 64).decode().strip() or None
            except BlockingIOError:
                key = None
    finally:
        if rfd is not None:
            os.close(rfd)
    return tmp, res, key


def open_snapshot(folder, key):
    con = apsw.Connection(os.path.join(folder, "m.edb"), flags=apsw.SQLITE_OPEN_READONLY)
    con.pragma("cipher", "aes128cbc")
    con.pragma("kdf_iter", 1)
    con.pragma("key", key)
    try:
        con.execute("SELECT count(*) FROM sqlite_master").fetchone()
    except apsw.NotADBError:
        raise SystemExit(json.dumps({"error": "decryption failed — wrong key or cipher params"}))
    return con


def open_db():
    folder, res, key = snapshot()
    if not key:
        raise SystemExit(json.dumps({"error": "DB key unavailable", "hint":
            res.get("keyError") or "set $LINE_DB_KEY or keychain service 'line-cua-mcp-dbkey'"}))
    return open_snapshot(folder, key)


def my_mid(con):
    r = con.execute("SELECT _mid FROM _profile LIMIT 1").fetchone()
    return r[0] if r else None


def chat_name(con, chat_id):
    """Resolve a chatId to a display name across 1:1 / group / community / unsaved."""
    g = con.execute("SELECT _chatName FROM _groupChat WHERE _chatMid=?", (chat_id,)).fetchone()
    if g and g[0]:
        return g[0]
    try:
        sq = con.execute("SELECT _name FROM _square WHERE _mid=?", (chat_id,)).fetchone()
        if sq and sq[0]:
            return sq[0]
    except apsw.SQLError:
        pass
    ct = con.execute(
        "SELECT _displayNameOverridden,_displayName,_targetProfileDetail FROM _contact WHERE _mid=?",
        (chat_id,),
    ).fetchone()
    if ct:
        if ct[0]:
            return ct[0]
        if ct[1]:
            return ct[1]
        if ct[2]:
            try:
                pn = json.loads(ct[2]).get("profileName")
                if pn:
                    return pn
            except Exception:
                pass
    return None


def list_chats(con, limit=50):
    out = []
    for cid, lut, last in con.execute(
        "SELECT _id,_lastUpdatedTime,_lastMessage FROM _chat ORDER BY _lastUpdatedTime DESC LIMIT ?",
        (limit,),
    ):
        out.append({
            "chatId": cid,
            "name": chat_name(con, cid),
            "lastUpdated": iso(lut),
            # 1:1 contacts are "u"-prefixed; treat everything else (groups "c",
            # rooms "m", LINE Square "t", and any future/unknown prefix) as a
            # group so the send guard fails CLOSED on unknown chat types.
            "isGroup": cid[:1] != "u",
        })
    return out


def resolve_chat(con, name):
    """name -> chatId. Accepts a raw chatId, exact name, or unambiguous substring."""
    # raw id passthrough
    if con.execute("SELECT 1 FROM _chat WHERE _id=? LIMIT 1", (name,)).fetchone():
        return name
    chats = list_chats(con, 2000)
    exact = [c for c in chats if c["name"] == name]
    if len(exact) == 1:
        return exact[0]["chatId"]
    if len(exact) > 1:
        raise SystemExit(json.dumps({"error": "ambiguous exact name",
            "matches": [c["name"] for c in exact]}, ensure_ascii=False))
    fuzzy = [c for c in chats if c["name"] and name in c["name"]]
    if len(fuzzy) == 1:
        return fuzzy[0]["chatId"]
    if len(fuzzy) > 1:
        raise SystemExit(json.dumps({"error": "ambiguous name",
            "matches": [c["name"] for c in fuzzy[:20]]}, ensure_ascii=False))
    raise SystemExit(json.dumps({"error": f"no chat named '{name}'"}, ensure_ascii=False))


# LINE message _contentType -> label for non-text messages
CT = {0: None, 1: "[image]", 2: "[video]", 3: "[audio]", 7: "[sticker]",
      6: "[call]", 13: "[contact]", 14: "[file]", 16: "[album]"}
# contentTypes whose message carries one attachment (album/16 is a set of posts)
KIND = {1: "image", 2: "video", 3: "audio", 7: "sticker", 14: "file"}

# LINE's shared data folder (Caches, Sticker). Only LINE Reader.app opens it;
# this script only builds path strings from LINE's own records.
LINE_DATA = os.path.expanduser(
    "~/Library/Group Containers/VUTU7AKEUR.jp.naver.line.mac/Real/Library/Data")
# LINE saves downloads into its container's Downloads, a symlink to ~/Downloads.
LINE_DOWNLOADS = os.path.expanduser("~/Library/Containers/jp.naver.line.mac/Data/Downloads/")


def iso(ms):
    return datetime.datetime.fromtimestamp(ms / 1000).isoformat(timespec="seconds") if ms else None


def _json(s):
    try:
        v = json.loads(s) if s else {}
        return v if isinstance(v, dict) else {}
    except (ValueError, TypeError):
        return {}


def _int(v):
    try:
        return int(v)
    except (TypeError, ValueError):
        return None


def _size(n):
    if n is None:
        return "? B"
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024 or unit == "GB":
            return f"{n:.0f} {unit}" if unit == "B" else f"{n:.1f} {unit}"
        n /= 1024


def _user_path(p):
    """Map LINE's container Downloads path to the real ~/Downloads path."""
    if p and p.startswith(LINE_DOWNLOADS):
        return os.path.expanduser("~/Downloads/") + p[len(LINE_DOWNLOADS):]
    return p


def attachment_meta(ct, text, md, ci):
    """Facts about a message's attachment from LINE's DB records only (no file
    access, no key material). None for messages without one attachment."""
    kind = KIND.get(ct)
    if not kind:
        return None
    m, c = _json(md), _json(ci)
    mci = _json(m.get("MEDIA_CONTENT_INFO"))
    a = {"kind": kind}
    name = (text if ct == 14 else None) or c.get("fileName") or m.get("FILE_NAME")
    if name:
        a["fileName"] = name
    size = _int(m.get("FILE_SIZE")) or _int(mci.get("fileSize"))
    if size:
        a["fileSize"] = size
    if mci.get("width") and mci.get("height"):
        a["width"], a["height"] = mci["width"], mci["height"]
    if mci.get("extension"):
        a["extension"] = mci["extension"]
    dur = _int(m.get("DURATION")) or _int(m.get("AUDLEN")) or _int(c.get("duration"))
    if dur and kind in ("video", "audio"):
        a["durationMs"] = dur
    exp = _int(m.get("FILE_EXPIRE_TIMESTAMP"))
    if exp:
        a["expiresAt"] = iso(exp)
        a["expired"] = exp < datetime.datetime.now().timestamp() * 1000
    if kind == "sticker":
        a.update(stickerId=m.get("STKID"), packageId=m.get("STKPKGID"))
        if m.get("STKTXT"):
            a["alt"] = m["STKTXT"]
    # Where LINE recorded a copy. Paths outside LINE's cache are reported as
    # LINE recorded them; the file may have been moved since.
    if c.get("downloadedPath"):
        a["savedCopy"] = _user_path(c["downloadedPath"])
    if c.get("originalPath") or c.get("path"):
        a["sentFrom"] = c.get("originalPath") or c.get("path")
    a["cachedPreview"] = bool(c.get("thumbPath"))
    return a


def attachment_label(a):
    k = a["kind"]
    if k == "file":
        return f"[file] {a.get('fileName', '?')} ({_size(a.get('fileSize'))})"
    if k == "sticker":
        return f"[sticker {a['alt']}]" if a.get("alt") else "[sticker]"
    extra = []
    if a.get("width"):
        extra.append(f"{a['width']}×{a['height']}")
    if a.get("durationMs"):
        s = a["durationMs"] // 1000
        extra.append(f"{s // 60}:{s % 60:02d}")
    name = {"image": "image", "video": "video", "audio": "voice"}[k]
    return f"[{name}{' ' + ' '.join(extra) if extra else ''}]"


def read_history(con, chat_id, limit=0):
    me = my_mid(con)
    rows = con.execute(
        "SELECT _createdTime,_from,_text,_contentType,_id,_contentMetadata,_contentInfo FROM _message "
        "WHERE _chatId=? ORDER BY _createdTime", (chat_id,)
    ).fetchall()
    if limit and limit > 0:
        rows = rows[-limit:]
    msgs = []
    for t, frm, text, ct, mid, md, ci in rows:
        att = attachment_meta(ct, text, md, ci)
        body = attachment_label(att) if att else (text if text else CT.get(ct, f"[type={ct}]"))
        msg = {
            "id": mid, "time": iso(t), "ts": t,
            "direction": "out" if frm == me else "in",
            "sender": "me" if frm == me else (chat_name(con, frm) or frm),
            "text": body,
        }
        if att:
            msg["attachment"] = att
        msgs.append(msg)
    return msgs


def list_attachments(con, chat_id, kind=None, limit=50):
    """A chat's attachments, newest first (DB records only)."""
    me = my_mid(con)
    cts = [ct for ct, k in KIND.items() if kind in (None, k)]
    rows = con.execute(
        "SELECT _id,_createdTime,_from,_text,_contentType,_contentMetadata,_contentInfo FROM _message "
        f"WHERE _chatId=? AND _contentType IN ({','.join('?' * len(cts))}) "
        "ORDER BY _createdTime DESC LIMIT ?", (chat_id, *cts, limit)).fetchall()
    out = []
    for mid, t, frm, text, ct, md, ci in rows:
        a = attachment_meta(ct, text, md, ci)
        out.append({"id": mid, "time": iso(t), "direction": "out" if frm == me else "in",
                    "sender": "me" if frm == me else (chat_name(con, frm) or frm), **a})
    return out


def attachment_sources(con, message_id):
    """Everything get_attachment needs for one message, including the media
    key. Internal: the TS side never returns keyMaterial to MCP clients."""
    row = con.execute(
        "SELECT _id,_chatId,_createdTime,_from,_text,_contentType,_contentMetadata,_contentInfo "
        "FROM _message WHERE _id=?", (str(message_id),)).fetchone()
    if not row:
        raise SystemExit(json.dumps({"error": f"no message with id {message_id}"}))
    mid, cid, t, frm, text, ct, md, ci = row
    a = attachment_meta(ct, text, md, ci)
    if not a:
        raise SystemExit(json.dumps({"error": f"message {message_id} has no attachment",
                                     "contentType": ct}))
    me = my_mid(con)
    m, c = _json(md), _json(ci)
    src = {"keyMaterial": c.get("keyMaterial"), "thumbPath": c.get("thumbPath"),
           "downloadedPath": _user_path(c.get("downloadedPath")),
           "downloadedFileSize": _int(c.get("downloadedFileSize"))}
    res = (_json(c.get("fileTransInfo")) if isinstance(c.get("fileTransInfo"), str)
           else c.get("fileTransInfo") or {}).get("resourceList") or []
    if res and res[0].get("path"):
        src["uploadBlob"] = res[0]["path"]
    # The chat's cache folder is <account folder>/sha1(chatId); take the
    # account folder from any thumbnail path LINE recorded.
    hit = con.execute("SELECT _contentInfo FROM _message WHERE _contentInfo LIKE '%thumbPath%' "
                      "ORDER BY _createdTime DESC LIMIT 1").fetchone()
    acct = re.match(r"^(.*/Caches/[0-9a-f]{40})/", _json(hit[0]).get("thumbPath", "")) if hit else None
    if acct:
        src["chatCacheDir"] = f"{acct.group(1)}/{hashlib.sha1(cid.encode()).hexdigest()}"
    if ct == 7 and m.get("STKPKGID") and m.get("STKID"):
        src["stickerDir"] = f"{LINE_DATA}/Sticker/{m['STKPKGID']}"
    # Count every local message that can match this filename search, not a
    # limited attachment list. Text mentions also make UI targeting ambiguous.
    if ct == 14 and a.get("fileName"):
        needle = a["fileName"].casefold()
        # ponytail: full local scan; index filename search if large histories make this slow.
        matches = 0
        for tx, kind, meta, content in con.execute(
                "SELECT _text,_contentType,_contentMetadata,_contentInfo FROM _message"):
            att = attachment_meta(kind, tx, meta, content)
            if needle in (tx or "").casefold() or (att and needle in att.get("fileName", "").casefold()):
                matches += 1
        src["downloadNameMatches"] = matches
    return {"id": mid, "chatId": cid, "chat": chat_name(con, cid), "time": iso(t),
            "direction": "out" if frm == me else "in",
            "sender": "me" if frm == me else (chat_name(con, frm) or frm),
            "attachment": a, "sources": src}


def chat_coverage(con, chat_id):
    """Local-DB coverage for a chat: how much of the history is actually stored
    on THIS Mac. The DB only holds what LINE Desktop has synced locally; older
    messages that were never loaded are absent. Cheap (single aggregate query),
    so the UI sync path can poll it between scroll rounds."""
    row = con.execute(
        "SELECT COUNT(*), MIN(_createdTime), MAX(_createdTime) "
        "FROM _message WHERE _chatId=?", (chat_id,)
    ).fetchone()
    total = row[0] if row else 0
    oldest = row[1] if row and row[1] is not None else None
    newest = row[2] if row and row[2] is not None else None
    return {
        "source": "local-line-desktop-db",
        "localMessageCount": total,
        "oldestLocalMessage": iso(oldest),
        "oldestLocalMessageTs": oldest,
        "newestLocalMessage": iso(newest),
        "newestLocalMessageTs": newest,
        "mayExcludeRemoteUnsyncedHistory": True,
    }


TZ = ZoneInfo("Asia/Taipei")


def _tdt(ms):
    return datetime.datetime.fromtimestamp(ms / 1000, TZ)


def owner_labels(con, override=None):
    """Return (full, short) self labels, e.g. ('Alex (alias)', 'Alex')."""
    if override:
        return override, override.split(" (")[0].strip()
    r = con.execute("SELECT _displayName FROM _profile LIMIT 1").fetchone()
    full = r[0] if r and r[0] else "Me"
    return full, full.split(" (")[0].strip()


def _render_body(text):
    """Render a message body for the archive: humanize call records, collapse
    multi-line into ' / ' (dropping blank lines), non-text -> [圖片 / 附件]."""
    if not text:
        return "[圖片 / 附件]"
    m = re.match(r"Call History : (\d+) millisecs, Result: (\d+)", text)
    if m:
        ms = int(m.group(1))
        if ms <= 0:
            return "[通話 未接/取消]"
        s = ms // 1000
        return f"[通話 {s // 60}:{s % 60:02d}]"
    segs = [s.strip() for s in text.split("\n") if s.strip()]
    return " / ".join(segs) if segs else "[圖片 / 附件]"


def export_md(con, chat_id, thread, out_path, owner=None):
    """Write a chat's FULL history as the regulated 'living archive' markdown
    (matches conversations/line-*.md). Regenerated from the DB each run — the DB
    is the source of truth, so this is always complete and self-correcting."""
    me = my_mid(con)
    full, short = owner_labels(con, owner)
    is_one = chat_id[:1] == "u"
    rows = [r for r in con.execute(
        "SELECT _createdTime,_from,_text,_contentType FROM _message WHERE _chatId=? "
        "ORDER BY _createdTime", (chat_id,)).fetchall() if r[0]]
    if not rows:
        raise SystemExit(json.dumps({"error": "no messages for chat", "chatId": chat_id}))

    def label(frm):
        if frm == me:
            return full
        if is_one:
            return thread
        return chat_name(con, frm) or frm

    others = sorted({label(f) for _, f, _, _ in rows if f != me})
    first, last = _tdt(rows[0][0]), _tdt(rows[-1][0])
    now = datetime.datetime.now(TZ)
    L = ["---", "platform: line", f"thread: {thread}", f"source: line://chat/{thread}",
         f"participants: [{', '.join([short] + others)}]", "timezone: Asia/Taipei",
         f"range: {first:%Y-%m-%dT%H:%M} → {last:%Y-%m-%dT%H:%M}",
         f"last_synced: {now:%Y-%m-%dT%H:%M}", f"messages: {len(rows)}", "---",
         f"# LINE conversation — {thread}", "",
         "> Living archive. Times are Asia/Taipei. Non-text items shown as "
         "[圖片 / 附件]. Multi-line messages joined with \" / \".", ""]
    cur = None
    for t, frm, text, ct in rows:
        dt = _tdt(t)
        day = dt.strftime("%Y-%m-%d (%a)")
        if day != cur:
            if cur is not None:
                L.append("")
            L += [f"## {day}", ""]
            cur = day
        body = _render_body(text)
        L.append(f"[{dt:%Y-%m-%d %H:%M}] {label(frm)}: {body}")
    L.append("")
    os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        f.write("\n".join(L))
    return {"file": out_path, "messages": len(rows), "thread": thread,
            "participants": [short] + others,
            "range": f"{first:%Y-%m-%dT%H:%M} → {last:%Y-%m-%dT%H:%M}"}


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("status")
    p = sub.add_parser("list-chats"); p.add_argument("--limit", type=int, default=50)
    p = sub.add_parser("read"); p.add_argument("name"); p.add_argument("--limit", type=int, default=0)
    p = sub.add_parser("coverage"); p.add_argument("name")
    p = sub.add_parser("files"); p.add_argument("chat_id"); p.add_argument("--since", type=int, default=0)
    p = sub.add_parser("attachments"); p.add_argument("name"); p.add_argument("--limit", type=int, default=50)
    p.add_argument("--kind", choices=sorted(set(KIND.values())))
    p = sub.add_parser("attachment-sources"); p.add_argument("message_id")
    p = sub.add_parser("search"); p.add_argument("text"); p.add_argument("--limit", type=int, default=50)
    p = sub.add_parser("export-md")
    p.add_argument("--name"); p.add_argument("--chat-id", dest="chat_id")
    p.add_argument("--out", required=True)
    p.add_argument("--thread", help="clean thread name for frontmatter/title (default: resolved chat name)")
    p.add_argument("--owner", help="self label override (default: LINE profile display name)")
    a = ap.parse_args()

    if a.cmd == "status":
        out = {"helper": HELPER_APP, "helperInstalled": os.path.isdir(HELPER_APP),
               "db": None, "dbFound": False, "keyAvailable": False}
        try:
            folder, res, key = snapshot()
            out.update(db=res.get("source"), dbFound=True, keyAvailable=bool(key))
            if not key:
                out["detail"] = res.get("keyError")
            else:
                con = open_snapshot(folder, key)
                out["decryptOk"] = True
                out["messageCount"] = con.execute("SELECT count(*) FROM _message").fetchone()[0]
                out["chatCount"] = con.execute("SELECT count(*) FROM _chat").fetchone()[0]
        except SystemExit as e:
            if out["dbFound"]:
                out["decryptOk"] = False
            out["detail"] = str(e)
        print(json.dumps(out, ensure_ascii=False, indent=2)); return

    con = open_db()
    if a.cmd == "list-chats":
        print(json.dumps(list_chats(con, a.limit), ensure_ascii=False, indent=2))
    elif a.cmd == "read":
        cid = resolve_chat(con, a.name)
        msgs = read_history(con, cid, a.limit)
        cov = chat_coverage(con, cid)
        cov["returnedMessageCount"] = len(msgs)
        cov["limitApplied"] = bool(a.limit and a.limit > 0)
        print(json.dumps({"chatId": cid, "name": chat_name(con, cid),
                          "messages": msgs, "coverage": cov},
                         ensure_ascii=False, indent=2))
    elif a.cmd == "attachments":
        cid = resolve_chat(con, a.name)
        print(json.dumps({"chatId": cid, "name": chat_name(con, cid),
                          "attachments": list_attachments(con, cid, a.kind, a.limit)},
                         ensure_ascii=False, indent=2))
    elif a.cmd == "attachment-sources":
        print(json.dumps(attachment_sources(con, a.message_id), ensure_ascii=False, indent=2))
    elif a.cmd == "files":
        cid = resolve_chat(con, a.chat_id)
        me = my_mid(con)
        rows = con.execute("SELECT _id,_createdTime,_contentMetadata,_status,_errorCode,_text "
                           "FROM _message WHERE _chatId=? AND _from=? AND _contentType=14 "
                           "AND _createdTime>=? ORDER BY _createdTime", (cid, me, a.since)).fetchall()
        out = []
        for mid, ts, metadata, status, error, text in rows:
            try:
                metadata = json.loads(metadata) if metadata else {}
            except (ValueError, TypeError):
                metadata = {}
            out.append({"id": mid, "ts": ts, "metadata": metadata, "status": status,
                        "errorCode": error, "text": text})
        print(json.dumps(out, ensure_ascii=False, indent=2))
    elif a.cmd == "coverage":
        cid = resolve_chat(con, a.name)
        print(json.dumps({"chatId": cid, "name": chat_name(con, cid),
                          **chat_coverage(con, cid)},
                         ensure_ascii=False, indent=2))
    elif a.cmd == "search":
        me = my_mid(con)
        rows = con.execute(
            "SELECT _chatId,_createdTime,_from,_text FROM _message "
            "WHERE _text LIKE ? ORDER BY _createdTime DESC LIMIT ?",
            (f"%{a.text}%", a.limit)).fetchall()
        res = [{"chatId": c, "chat": chat_name(con, c), "time": iso(t),
                "direction": "out" if f == me else "in", "text": tx}
               for c, t, f, tx in rows]
        print(json.dumps(res, ensure_ascii=False, indent=2))
    elif a.cmd == "export-md":
        if not (a.name or a.chat_id):
            raise SystemExit(json.dumps({"error": "export-md needs --name or --chat-id"}))
        cid = a.chat_id if a.chat_id else resolve_chat(con, a.name)
        thread = a.thread or chat_name(con, cid) or cid
        print(json.dumps(export_md(con, cid, thread, os.path.expanduser(a.out), a.owner),
                         ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
