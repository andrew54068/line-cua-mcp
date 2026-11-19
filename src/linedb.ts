// linedb.ts — read LINE's encrypted local message DB via the Python helper
// (linedb.py + apsw-sqlite3mc). This is the fully-background, cursor-free,
// full-history data path: no UI, no OCR, no foreground, no scrolling. The
// helper decrypts a read-only copy of LINE's wxSQLite3 AES-128 DB. The copy and
// the account key (keychain service "line-cua-mcp-dbkey") come from LINE
// Reader.app, the only process that touches LINE's folders (see linedb.py).

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));

/** Resolve the project's venv python (has apsw-sqlite3mc). Falls back to py3. */
function pythonPath(): string {
  const candidates = [
    join(__dirname, "..", ".venv", "bin", "python3"), // dist/ or src/ -> repo/.venv
    join(__dirname, "..", "..", ".venv", "bin", "python3"),
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  return "python3";
}

const SCRIPT = join(__dirname, "linedb.py");

export interface LineMessage {
  id: string;
  time: string | null;
  ts: number | null;
  direction: "in" | "out";
  sender: string;
  text: string;
  attachment?: AttachmentMeta;
}
/** Attachment facts from LINE's DB records only. `savedCopy` / `sentFrom` are
 *  paths LINE recorded outside its cache; the file may have moved since. */
export interface AttachmentMeta {
  kind: "image" | "video" | "audio" | "file" | "sticker";
  fileName?: string;
  fileSize?: number;
  width?: number;
  height?: number;
  extension?: string;
  durationMs?: number;
  expiresAt?: string;
  expired?: boolean;
  stickerId?: string;
  packageId?: string;
  alt?: string;
  savedCopy?: string;
  sentFrom?: string;
  cachedPreview: boolean;
}
export interface AttachmentListItem extends AttachmentMeta {
  id: string; time: string | null; direction: "in" | "out"; sender: string;
}
/** Internal: includes the message's media key. Never return it to MCP clients. */
export interface AttachmentSources {
  id: string; chatId: string; chat: string | null; time: string | null;
  direction: "in" | "out"; sender: string;
  attachment: AttachmentMeta;
  sources: {
    keyMaterial?: string; thumbPath?: string; uploadBlob?: string;
    downloadedPath?: string; downloadedFileSize?: number; downloadNameMatches?: number;
    chatCacheDir?: string; stickerDir?: string;
  };
}
export interface ChatHistory { chatId: string; name: string | null; messages: LineMessage[]; coverage?: ChatCoverage; }
export interface ChatSummary { chatId: string; name: string | null; lastUpdated: string | null; isGroup: boolean; }
/** How much of a chat's history is actually stored in THIS Mac's local LINE DB.
 *  The DB only holds what LINE Desktop has synced locally — older messages that
 *  were never loaded are absent, hence `mayExcludeRemoteUnsyncedHistory`. */
export interface ChatCoverage {
  source: string;
  localMessageCount: number;
  returnedMessageCount?: number;
  limitApplied?: boolean;
  oldestLocalMessage: string | null;
  oldestLocalMessageTs?: number | null;
  newestLocalMessage: string | null;
  newestLocalMessageTs?: number | null;
  mayExcludeRemoteUnsyncedHistory: boolean;
}
export interface ChatCoverageResult extends ChatCoverage { chatId: string; name: string | null; }
export interface DbStatus {
  helper?: string; helperInstalled?: boolean;
  db: string | null; dbFound: boolean; keyAvailable: boolean;
  decryptOk?: boolean; messageCount?: number; chatCount?: number; detail?: string;
}

/** Run linedb.py <args> and parse its JSON stdout. linedb.py emits a JSON error
 *  object and exits non-zero on failure; we surface that as a thrown Error. */
async function run<T>(args: string[]): Promise<T> {
  try {
    const { stdout } = await execFileAsync(pythonPath(), [SCRIPT, ...args], {
      maxBuffer: 64 * 1024 * 1024,
    });
    return JSON.parse(stdout) as T;
  } catch (err: any) {
    const out = (err?.stdout ?? "").toString().trim();
    if (out) {
      try {
        const j = JSON.parse(out);
        throw new Error(j.error ? `linedb: ${j.error}${j.matches ? " — " + JSON.stringify(j.matches) : ""}` : out);
      } catch (e: any) {
        if (e instanceof Error && e.message.startsWith("linedb:")) throw e;
        throw new Error(out);
      }
    }
    throw new Error(err?.message ?? String(err));
  }
}

export interface OutgoingFileMessage { id: string; ts: number; metadata: Record<string, unknown>; status: number | null; errorCode: number | null; text: string | null; }
export const outgoingFiles = (chatId: string, since = 0) => run<OutgoingFileMessage[]>(["files", chatId, "--since", String(since)]);

export const dbStatus = () => run<DbStatus>(["status"]);
export const listChats = (limit = 50) => run<ChatSummary[]>(["list-chats", "--limit", String(limit)]);
/** Every chat in the local DB (no practical limit). Ground truth for the send
 *  guard's DB cross-check (identity + group status), independent of header OCR. */
export const allChats = () => run<ChatSummary[]>(["list-chats", "--limit", "1000000"]);
export const readChat = (name: string, limit = 0) =>
  run<ChatHistory>(["read", name, ...(limit ? ["--limit", String(limit)] : [])]);
/** Cheap local-DB coverage for one chat (count + oldest/newest), without
 *  pulling the messages. Used by the UI sync path to poll progress. */
export const chatCoverage = (name: string) => run<ChatCoverageResult>(["coverage", name]);
export const searchMessages = (text: string, limit = 50) =>
  run<any[]>(["search", text, "--limit", String(limit)]);
export const listAttachments = (name: string, kind?: string, limit = 50) =>
  run<{ chatId: string; name: string | null; attachments: AttachmentListItem[] }>(
    ["attachments", name, "--limit", String(limit), ...(kind ? ["--kind", kind] : [])]);
export const attachmentSources = (messageId: string) =>
  run<AttachmentSources>(["attachment-sources", messageId]);

/** Format a chat history as a readable transcript, with a footer that is honest
 *  about what the local DB does and does not contain. */
export function formatHistory(h: ChatHistory): string {
  const head = `${h.name ?? h.chatId} — ${h.messages.length} message(s)`;
  const lines = h.messages.map((m) => {
    const t = m.time ? m.time.replace("T", " ") : "?";
    const who = m.direction === "out" ? "me" : (m.sender || "them");
    const body = (m.text ?? "").replace(/\n/g, "\n      ");
    return `${t}  ${who}: ${body}${m.attachment ? `  (id ${m.id})` : ""}`;
  });
  const out = [head, ...lines];
  const c = h.coverage;
  if (c) {
    const fmt = (s: string | null) => (s ? s.replace("T", " ") : "?");
    out.push(
      "",
      `— local DB: ${c.localMessageCount} message(s) stored` +
        (c.limitApplied ? `, ${c.returnedMessageCount} returned (limit applied)` : "") +
        `; oldest ${fmt(c.oldestLocalMessage)}, newest ${fmt(c.newestLocalMessage)}.`,
      `  This is the complete history PRESENT IN LINE Desktop's local DB. Messages` +
        ` that were never synced to this Mac are not included. To backfill older` +
        ` history from LINE's servers, run sync_older_messages and read again.`,
    );
  }
  return out.join("\n");
}
