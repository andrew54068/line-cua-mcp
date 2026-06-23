#!/usr/bin/env python3
# linedb.py — read LINE Desktop's encrypted local message DB fully offline.
#
# LINE Desktop (macOS, Qt6) stores all history in a wxSQLite3 / QtCipherSqlitePlugin
# AES-128-CBC encrypted SQLite file (NOT SQLCipher). Given the account's 32-hex
# key, the entire history is readable with zero UI: no cursor, no foreground, no
# OCR, no scrolling. This is the data path the OCR approach could never match.
#
# Key source (in order): $LINE_DB_KEY, else macOS keychain service
# "line-cua-mcp-dbkey". The key is account-stable, captured once.
#
# Decryption: apsw-sqlite3mc with PRAGMA cipher='aes128cbc', kdf_iter=1.
# We snapshot the DB (+ -wal/-shm) to a temp dir and open read-only, so we never
# lock or perturb the file LINE is actively writing.
#
# CLI:  linedb.py status
#       linedb.py list-chats [--limit N]
#       linedb.py read <chat-name-or-id> [--limit N]
#       linedb.py search <text> [--limit N]
import sys, os, re, json, glob, shutil, tempfile, datetime, subprocess, argparse, atexit
from zoneinfo import ZoneInfo

try:
    import apsw
except Exception as e:  # pragma: no cover
    print(json.dumps({"error": f"apsw-sqlite3mc not installed: {e}"})); sys.exit(2)

DB_DIR = os.path.expanduser(
    "~/Library/Containers/jp.naver.line.mac/Data/Library/Containers/jp.naver.line/Data/db"
)
KEYCHAIN_SERVICE = "line-cua-mcp-dbkey"


def find_db():
    """The main message DB is qwb<hex>.edb (exclude keep_/album_/chatStats_ siblings)."""
    cands = []
    for f in sorted(glob.glob(os.path.join(DB_DIR, "qwb*.edb"))):
        b = os.path.basename(f)
        if b.startswith("qwb") and "_" not in b:
            cands.append(f)
    # fall back to the largest qwb* if naming differs
    if not cands:
        all_qwb = [f for f in glob.glob(os.path.join(DB_DIR, "qwb*.edb"))]
        if all_qwb:
            cands = [max(all_qwb, key=lambda p: os.path.getsize(p))]
    return cands[0] if cands else None


def get_key():
    k = os.environ.get("LINE_DB_KEY")
    if k:
        return k.strip()
    try:
        return subprocess.check_output(
            ["security", "find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"],
            stderr=subprocess.DEVNULL,
        ).decode().strip()
    except Exception:
        return None


def open_db():
    src = find_db()
    if not src:
        raise SystemExit(json.dumps({"error": "LINE message DB not found", "dir": DB_DIR}))
    key = get_key()
    if not key:
        raise SystemExit(json.dumps({"error": "DB key unavailable", "hint":
            f"set $LINE_DB_KEY or keychain service '{KEYCHAIN_SERVICE}'"}))
    tmp = tempfile.mkdtemp(prefix="linedb-")
    atexit.register(lambda: shutil.rmtree(tmp, ignore_errors=True))
    path = os.path.join(tmp, "m.edb")
    for ext in ("", "-wal", "-shm"):
        if os.path.exists(src + ext):
            shutil.copy2(src + ext, path + ext)
    con = apsw.Connection(path, flags=apsw.SQLITE_OPEN_READONLY)
    con.pragma("cipher", "aes128cbc")
    con.pragma("kdf_iter", 1)
    con.pragma("key", key)
    try:
        con.execute("SELECT count(*) FROM sqlite_master").fetchone()
    except apsw.NotADBError:
        raise SystemExit(json.dumps({"error": "decryption failed — wrong key or cipher params"}))
    return con


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


def iso(ms):
    return datetime.datetime.fromtimestamp(ms / 1000).isoformat(timespec="seconds") if ms else None


def read_history(con, chat_id, limit=0):
    me = my_mid(con)
    rows = con.execute(
        "SELECT _createdTime,_from,_text,_contentType,_id FROM _message "
        "WHERE _chatId=? ORDER BY _createdTime", (chat_id,)
    ).fetchall()
    if limit and limit > 0:
        rows = rows[-limit:]
    msgs = []
    for t, frm, text, ct, mid in rows:
        body = text if text else CT.get(ct, f"[type={ct}]")
        msgs.append({
            "id": mid, "time": iso(t), "ts": t,
            "direction": "out" if frm == me else "in",
            "sender": "me" if frm == me else (chat_name(con, frm) or frm),
            "text": body,
        })
    return msgs


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
    p = sub.add_parser("search"); p.add_argument("text"); p.add_argument("--limit", type=int, default=50)
    p = sub.add_parser("export-md")
    p.add_argument("--name"); p.add_argument("--chat-id", dest="chat_id")
    p.add_argument("--out", required=True)
    p.add_argument("--thread", help="clean thread name for frontmatter/title (default: resolved chat name)")
    p.add_argument("--owner", help="self label override (default: LINE profile display name)")
    a = ap.parse_args()

    if a.cmd == "status":
        src = find_db()
        out = {"db": src, "dbFound": bool(src), "keyAvailable": bool(get_key())}
        if src and get_key():
            try:
                con = open_db()
                out["decryptOk"] = True
                out["messageCount"] = con.execute("SELECT count(*) FROM _message").fetchone()[0]
                out["chatCount"] = con.execute("SELECT count(*) FROM _chat").fetchone()[0]
            except SystemExit as e:
                out["decryptOk"] = False; out["detail"] = str(e)
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
