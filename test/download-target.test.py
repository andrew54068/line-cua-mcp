"""Synthetic SQLite test only. No LINE paths, helper launches, or dependencies."""
import importlib.util
import json
from pathlib import Path
import sqlite3
import sys
import types

# attachment_sources uses only the supplied connection; APSW is not needed.
sys.modules["apsw"] = types.ModuleType("apsw")
spec = importlib.util.spec_from_file_location("linedb", Path(__file__).resolve().parents[1] / "src/linedb.py")
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
m.my_mid = lambda con: "me"
m.chat_name = lambda con, cid: cid
con = sqlite3.connect(":memory:")
con.execute("CREATE TABLE _message(_id TEXT,_chatId TEXT,_createdTime INTEGER,_from TEXT,_text TEXT,_contentType INTEGER,_contentMetadata TEXT,_contentInfo TEXT)")

def put(mid, chat, text, kind=14):
    con.execute("INSERT INTO _message VALUES(?,?,1,?,?,?,?,?)", (mid, chat, "other", text, kind, json.dumps({"FILE_SIZE": "1234"}), "{}"))

put("1", "a", "報告.pdf")
assert m.attachment_sources(con, "1")["sources"]["downloadNameMatches"] == 1
put("2", "b", "報告.pdf")
assert m.attachment_sources(con, "1")["sources"]["downloadNameMatches"] == 2
put("3", "c", "mention 報告.pdf here", 0)
assert m.attachment_sources(con, "1")["sources"]["downloadNameMatches"] == 3
put("4", "d", "irrelevant.pdf")
assert m.attachment_sources(con, "1")["sources"]["downloadNameMatches"] == 3
print("download DB: filename uniqueness, cross-chat duplicates, text mentions passed")
