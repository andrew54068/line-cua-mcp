// Prepare exact LINE file manifests; delivery uses the skill native picker workflow.
import { createHash } from "node:crypto";
import { basename, isAbsolute } from "node:path";
import { realpath, stat, readFile } from "node:fs/promises";
import { allChats, type ChatSummary, type OutgoingFileMessage } from "./linedb.js";
import { crossCheckSendTarget } from "./line.js";

export interface SendFilesOptions { chatId: string; name: string; uiName?: string; paths: string[]; auto?: boolean; }
export interface FileManifest { path: string; name: string; size: number; sha256: string; }
export function fileTarget(opts: SendFilesOptions, chats: ChatSummary[]): ChatSummary[] {
  if (!/^u[0-9a-f]{32}$/.test(opts.chatId)) throw new Error("send_files requires an exact 1:1 contact chatId (u + 32 hex).");
  const target = chats.find((c) => c.chatId === opts.chatId);
  if (!target || target.isGroup || target.name !== opts.name) throw new Error("Pinned chatId/name is missing, changed, or is a group. Refusing file send.");
  const uiName = opts.uiName ?? opts.name;
  if (!uiName.trim()) throw new Error("uiName must not be empty.");
  // A separately verified local UI alias may differ from the cached DB profile
  // name. Apply it only to the pinned identity, never globally or fuzzily.
  const aliased = chats.map((c) => c.chatId === opts.chatId ? { ...c, name: uiName } : c);
  const verdict = crossCheckSendTarget(uiName, uiName, aliased);
  if (!verdict.ok || verdict.resolved.chatId !== opts.chatId) throw new Error(verdict.ok ? "Identity mismatch." : verdict.reason);
  return aliased;
}

export async function fileManifest(paths: string[]): Promise<FileManifest[]> {
  if (!Array.isArray(paths) || !paths.length || paths.length > 20) throw new Error("Provide 1–20 absolute file paths.");
  const files: FileManifest[] = [];
  for (const input of paths) {
    if (typeof input !== "string" || !isAbsolute(input) || /[\r\n]/.test(input)) throw new Error("File paths must be absolute and contain no newlines.");
    const path = await realpath(input);
    const info = await stat(path);
    if (!info.isFile() || info.size < 1 || info.size > 1024 ** 3) throw new Error(`Not a nonempty file ≤1 GiB: ${input}`);
    const name = basename(path);
    if (files.some((f) => f.name === name)) throw new Error(`Duplicate filename: ${name}`);
    files.push({ path, name, size: info.size, sha256: createHash("sha256").update(await readFile(path)).digest("hex") });
  }
  return files;
}

export function fileReceiptMatches(message: OutgoingFileMessage, file: FileManifest): boolean {
  return message.text === file.name && Number(message.metadata.FILE_SIZE) === file.size && message.status === 2 && message.errorCode === 0;
}

export async function sendFiles(opts: SendFilesOptions) {
  if (opts.auto !== undefined && typeof opts.auto !== "boolean") throw new Error("auto must be a boolean.");
  const files = await fileManifest(opts.paths);
  fileTarget(opts, await allChats());
  if (opts.auto === true) throw new Error("File-URL paste did not work with this LINE version. Use auto=false to prepare, then the verified native file picker workflow in the line-send-files skill. No files sent by this call.");
  return { status: "prepared", chatId: opts.chatId, name: opts.name, uiName: opts.uiName ?? opts.name, files, sent: false, deliveryWorkflow: "line-send-files skill native picker" };
}
