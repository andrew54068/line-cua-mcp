// attachments.ts — return a LINE message's attachment from what is already on
// this Mac (method 1: no network, nothing LINE's servers can see).
//
// Sources, best first:
//   1. LINE's encrypted upload copy (files sent from this Mac)  -> full file
//   2. LINE's voice cache (.m4a, plain)                         -> full file
//   3. LINE's sticker cache (.png)                              -> full image
//   4. LINE's encrypted preview (.eimg, ~534 px wide)           -> preview only
// Cache files are copied by LINE Reader.app (see reader.ts) and decrypted here
// with the message's media key. Copies LINE recorded in your own folders
// (savedCopy / sentFrom) are reported as paths and not opened: reading them
// from this process could make macOS show a prompt naming the host terminal.

import { createDecipheriv, createHmac, hkdfSync, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { allChats, attachmentSources, type AttachmentMeta, type AttachmentSources } from "./linedb.js";
import { runReader } from "./reader.js";
import { activateLine, assertChatOpen, locateLine, normalizeName, preservingFocus, selectChatImpl, setSearchValue } from "./line.js";
import { clickPixel } from "./driver.js";
import { ocrWindowBoxes, type OcrBox } from "./ocr.js";
import { setTimeout as sleep } from "node:timers/promises";

/** Decrypt a LINE end-to-end-encrypted media blob. HKDF-SHA256 of the
 *  message's keyMaterial (empty salt, info "FileEncryption", 76 bytes) gives an
 *  AES-256-CTR key, an HMAC-SHA256 key, and a 12-byte nonce. The blob is
 *  ciphertext || HMAC(ciphertext); the counter starts at nonce || 00000000. */
export function decryptLineMedia(blob: Buffer, keyMaterial: string): Buffer {
  if (blob.length < 32) throw new Error("encrypted media is too short");
  const d = Buffer.from(hkdfSync("sha256", Buffer.from(keyMaterial, "base64"), Buffer.alloc(0), "FileEncryption", 76));
  const body = blob.subarray(0, blob.length - 32);
  const tag = blob.subarray(blob.length - 32);
  const mac = createHmac("sha256", d.subarray(32, 64)).update(body).digest();
  if (!timingSafeEqual(mac, tag)) throw new Error("media HMAC mismatch (wrong key or damaged file)");
  const decipher = createDecipheriv("aes-256-ctr", d.subarray(0, 32), Buffer.concat([d.subarray(64, 76), Buffer.alloc(4)]));
  return Buffer.concat([decipher.update(body), decipher.final()]);
}

/** MIME type from magic bytes, for the formats LINE sends as media. */
export function sniffMime(b: Buffer): string | null {
  const hex = b.subarray(0, 12).toString("hex");
  if (hex.startsWith("ffd8ff")) return "image/jpeg";
  if (hex.startsWith("89504e47")) return "image/png";
  if (hex.startsWith("47494638")) return "image/gif";
  if (hex.startsWith("52494646") && b.subarray(8, 12).toString() === "WEBP") return "image/webp";
  if (hex.startsWith("25504446")) return "application/pdf";
  if (b.subarray(4, 8).toString() === "ftyp") {
    const brand = b.subarray(8, 12).toString();
    return /^(M4A |M4B )/.test(brand) ? "audio/mp4" : /^(heic|heix|mif1)/.test(brand) ? "image/heic" : "video/mp4";
  }
  if (hex.startsWith("504b0304")) return "application/zip";
  return null;
}

export interface SavedFile {
  path: string;
  bytes: number;
  mimeType: string | null;
  source: "upload-cache" | "voice-cache" | "sticker-cache" | "preview-cache";
}

export interface AttachmentResult {
  id: string;
  chat: string | null;
  time: string | null;
  direction: "in" | "out";
  sender: string;
  attachment: AttachmentMeta;
  /** The full original, decrypted into a private folder. */
  file?: SavedFile;
  /** A small preview when the full original is not cached on this Mac. */
  preview?: SavedFile;
  /** LINE's saved path and exact recorded byte count; never opened by Node. */
  downloaded?: { path: string; bytes: number; source: "line-ui"; verifiedBy: "line-db" };
  notes: string[];
}

const safeName = (name: string) =>
  basename(name).replace(/[\u0000-\u001f/:]/g, "_").slice(0, 200) || "attachment";

/** Private output folder for one message (os.tmpdir() is per-user on macOS). */
async function outDir(id: string): Promise<string> {
  const dir = join(tmpdir(), "line-cua-mcp", "attachments", id.replace(/[^0-9A-Za-z_-]/g, "_"));
  await mkdir(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/** Copy one file out of LINE's folders through LINE Reader. */
async function copyFromLine(path: string): Promise<Buffer> {
  const { dir } = await runReader(["copy", path]);
  try {
    return await readFile(join(dir, "f0"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function listInLine(folder: string): Promise<{ root: string; files: { path: string; bytes: number }[] }> {
  const { dir, result } = await runReader(["list", folder]);
  await rm(dir, { recursive: true, force: true });
  return result;
}

async function save(dir: string, name: string, data: Buffer, source: SavedFile["source"]): Promise<SavedFile> {
  const path = join(dir, name);
  await writeFile(path, data, { mode: 0o600 });
  return { path, bytes: data.length, mimeType: sniffMime(data), source };
}

/** Full original from LINE's cache, or null when this Mac has none. */
async function fullFromCache(info: AttachmentSources, dir: string, notes: string[]): Promise<SavedFile | null> {
  const { attachment: a, sources: s } = info;
  if (s.uploadBlob && s.keyMaterial) {
    try {
      const data = decryptLineMedia(await copyFromLine(s.uploadBlob), s.keyMaterial);
      if (a.fileSize && data.length !== a.fileSize) throw new Error(`size ${data.length} ≠ ${a.fileSize}`);
      return save(dir, safeName(a.fileName ?? `${a.kind}-${info.id}`), data, "upload-cache");
    } catch (e) {
      notes.push(`Upload cache not usable: ${(e as Error).message}`);
    }
  }
  if (a.kind === "audio" && s.chatCacheDir && a.fileSize) {
    // LINE caches voice messages as plain .m4a files named by a hash, usually
    // under the chat's folder but not always. Match the exact byte count LINE
    // recorded: the chat's folder first, then the whole account cache.
    const size = a.fileSize;
    for (const folder of [s.chatCacheDir, s.chatCacheDir.replace(/\/[0-9a-f]{40}$/, "")]) {
      const listing = await listInLine(folder).catch(() => null);
      const hits = listing?.files.filter((f) => f.path.endsWith(".m4a") && f.bytes === size) ?? [];
      if (hits.length === 1) {
        return save(dir, `voice-${info.id}.m4a`, await copyFromLine(`${listing!.root}/${hits[0].path}`), "voice-cache");
      }
      if (hits.length > 1) {
        notes.push("Several cached voice files have this exact size; not guessing which one.");
        break;
      }
    }
  }
  if (a.kind === "sticker" && s.stickerDir && a.stickerId) {
    const listing = await listInLine(s.stickerDir).catch(() => null);
    const names = [`${a.stickerId}@2x.png`, `${a.stickerId}.png`];
    for (const n of names) {
      const hit = listing?.files.find((f) => basename(f.path) === n);
      if (hit) return save(dir, `sticker-${a.stickerId}.png`, await copyFromLine(`${listing!.root}/${hit.path}`), "sticker-cache");
    }
  }
  return null;
}

async function previewFromCache(info: AttachmentSources, dir: string, notes: string[]): Promise<SavedFile | null> {
  const s = info.sources;
  if (!s.thumbPath) return null;
  try {
    const raw = await copyFromLine(s.thumbPath);
    // Previews of end-to-end-encrypted messages use the message's media key.
    // Other previews are encrypted with a LINE app key this tool does not have.
    if (!s.keyMaterial && !sniffMime(raw)) {
      throw new Error("this message is not end-to-end encrypted, and LINE encrypts its preview with an app key this tool does not have");
    }
    const data = s.keyMaterial ? decryptLineMedia(raw, s.keyMaterial) : raw;
    if (!sniffMime(data)) throw new Error("not a recognizable image");
    return save(dir, `preview-${info.id}.jpg`, data, "preview-cache");
  } catch (e) {
    notes.push(`Preview not usable: ${(e as Error).message}`);
    return null;
  }
}

/** Local cache by default; opt-in official UI download when no full copy exists. */
export async function getAttachment(messageId: string, download: boolean = false): Promise<AttachmentResult> {
  if (typeof download !== "boolean") throw new Error("download must be a boolean.");
  const info = await attachmentSources(messageId);
  const { attachment: a } = info;
  const dir = await outDir(info.id);
  const notes: string[] = [];
  const res: AttachmentResult = {
    id: info.id, chat: info.chat, time: info.time, direction: info.direction,
    sender: info.sender, attachment: a, notes,
  };
  const file = await fullFromCache(info, dir, notes);
  if (file) res.file = file;
  else {
    const preview = a.kind === "image" || a.kind === "video" ? await previewFromCache(info, dir, notes) : null;
    if (preview) res.preview = preview;
    if (a.savedCopy || a.sentFrom) {
      notes.push(
        `LINE recorded a copy at ${a.savedCopy ?? a.sentFrom}. Not opened by this tool; the file may have moved since.`,
      );
    } else {
      notes.push(
        a.expired
          ? `The full ${a.kind} is not on this Mac, and LINE's copy expired at ${a.expiresAt}.`
          : `The full ${a.kind} is not on this Mac. LINE Desktop can download it while LINE still stores it` +
              (a.expiresAt ? ` (until ${a.expiresAt}).` : "."),
      );
    }
  }
  if (download && !res.file) {
    res.downloaded = await downloadViaLine(info);
    notes.push("LINE recorded the saved path and exact expected byte count. This tool did not open or stat that file; its current existence is not independently verified.");
  }
  return res;
}

/** Fail closed before any UI action. Only ordinary ct14 files are supported. */
export function assertDownloadTarget(info: AttachmentSources, now = Date.now()): void {
  const a = info.attachment;
  if (a.kind !== "file") throw new Error("download:true currently supports file attachments only (ct14).");
  if (!info.chat || !a.fileName || /[\u0000-\u001f/\\]/.test(a.fileName)) throw new Error("Download requires an exact chat name and a single-line filename.");
  if (!/\.(pdf|txt|csv|docx|xlsx|pptx)$/i.test(a.fileName)) throw new Error("LINE may open the downloaded file in its default app. Only pdf/txt/csv/docx/xlsx/pptx are supported; scripts, executables, legacy and macro-enabled Office files are refused.");
  if (!Number.isSafeInteger(a.fileSize) || a.fileSize! <= 0) throw new Error("Download requires a known positive exact file size.");
  if (a.expired || !a.expiresAt || !Number.isFinite(Date.parse(a.expiresAt)) || Date.parse(a.expiresAt) <= now) throw new Error("Attachment expired, or its expiry cannot be verified; download refused.");
  if (info.sources.downloadNameMatches !== 1) throw new Error("Filename is missing or ambiguous in the local DB (including text mentions); download refused.");
}

/** Vision's confidence is coarse: on macOS 15 it rated correct CJK lines 0.3
 *  or 0.5. Safety comes from the exact text, uniqueness, pane, and highlight
 *  checks; this only drops Vision's lowest-quality guesses. */
const MIN_OCR_CONFIDENCE = 0.3;

/** Vision drops or adds spaces ("A 1" read as "A1") and confuses capital I
 *  with lowercase l ("AI" read as "Al" on macOS 15). Ignore spaces and fold
 *  I/l/| together; every other character must match exactly. */
const foldOcr = (t: string) => t.replace(/\s+/g, "").replace(/[Il|]/g, "l");
const sameText = (ocr: string, want: string) => foldOcr(ocr) === foldOcr(want);

/** Message search lists the chat name and "1 message found", not the
 *  filename. Require exactly one such row in the left pane before clicking. */
export function verifiedResultRow(boxes: OcrBox[], chat: string): OcrBox {
  const left = boxes.filter(b => [b.x, b.y, b.width, b.height, b.confidence].every(Number.isFinite)
    && b.x >= 0 && b.x + b.width <= 0.35 && b.y >= 0.15 && b.y + b.height <= 0.8
    && b.width > 0 && b.height > 0 && b.confidence >= MIN_OCR_CONFIDENCE);
  const titles = left.filter(b => sameText(b.text, chat));
  const counts = left.filter(b => /^(?:找到\s*1\s*則訊息|(?:Found\s+)?1\s+message(?:\s+found)?)$/i.test(b.text));
  if (titles.length !== 1 || counts.length !== 1) throw new Error("Search must show exactly one chat result with one message; refusing to click.");
  const title = titles[0], count = counts[0];
  if (count.y < title.y + title.height || count.y - title.y - title.height > 0.05
      || Math.abs(count.x - title.x) > 0.03) {
    throw new Error("Search chat and message count do not form one row; refusing to click.");
  }
  return title;
}

/** One exact, highlighted filename inside the conversation, below its search
 *  bar and above its composer. Wrapped/truncated filenames fail closed. */
export function verifiedFilenameBox(boxes: OcrBox[], filename: string): OcrBox {
  const hits = boxes.filter(b => sameText(b.text, filename) && b.x >= 0.38 && b.x + b.width <= 1 && b.y >= 0.2 && b.y + b.height <= 0.8);
  if (hits.length !== 1) throw new Error("Exact filename is missing or duplicated in the conversation; refusing to click.");
  const b = hits[0];
  if (![b.x, b.y, b.width, b.height, b.confidence].every(Number.isFinite) || b.width <= 0 || b.height <= 0 || b.confidence < MIN_OCR_CONFIDENCE || b.highlighted !== true) {
    throw new Error("Filename OCR or search highlight is not certain; refusing to click.");
  }
  return b;
}

/** DB evidence only: never stat or open a user-folder path from this process. */
export function verifiedDownload(info: AttachmentSources, expected: AttachmentSources): AttachmentResult["downloaded"] | undefined {
  const s = info.sources;
  if (info.id !== expected.id || info.chatId !== expected.chatId || info.attachment.fileName !== expected.attachment.fileName || info.attachment.fileSize !== expected.attachment.fileSize) throw new Error("Attachment identity changed while waiting for download.");
  if (s.downloadedPath?.startsWith("/") && s.downloadedFileSize === expected.attachment.fileSize) {
    return { path: s.downloadedPath, bytes: s.downloadedFileSize!, source: "line-ui", verifiedBy: "line-db" };
  }
  return undefined;
}

async function downloadViaLine(expected: AttachmentSources): Promise<NonNullable<AttachmentResult["downloaded"]>> {
  return preservingFocus(async () => {
    const info = await attachmentSources(expected.id);
    assertDownloadTarget(info);
    // Never click an already-downloaded file: LINE might open its content.
    const existing = verifiedDownload(info, expected);
    if (existing) return existing;
    if (info.sources.downloadedPath || info.attachment.savedCopy || info.attachment.sentFrom) throw new Error("LINE already recorded a local copy without an exact verified size; refusing to open or re-download it.");
    const chats = await allChats();
    const sameName = chats.filter(c => normalizeName(c.name ?? "") === normalizeName(info.chat!));
    if (sameName.length !== 1 || sameName[0].chatId !== info.chatId) throw new Error("Chat name is ambiguous in the local DB; download refused.");
    const h = await locateLine();
    await selectChatImpl(h, info.chat!);
    await assertChatOpen(h, info.chat!, { allowGroup: true, knownChats: chats });
    await activateLine();
    await setSearchValue(h, info.attachment.fileName!);
    await sleep(1200);
    const result = await ocrWindowBoxes(h);
    const row = verifiedResultRow(result.boxes, info.chat!);
    await clickPixel(h.pid, h.windowId, (row.x + row.width / 2) * result.width, (row.y + row.height / 2) * result.height);
    await sleep(900);
    await assertChatOpen(h, info.chat!, { allowGroup: true, knownChats: chats });
    const shot = await ocrWindowBoxes(h);
    const bubble = verifiedFilenameBox(shot.boxes, info.attachment.fileName!);
    // Recheck DB just before the only attachment click (no double-click/retry).
    const latest = await attachmentSources(info.id);
    assertDownloadTarget(latest);
    const completed = verifiedDownload(latest, expected);
    if (completed) return completed;
    if (latest.sources.downloadedPath) throw new Error("Attachment acquired a saved path; refusing to open it.");
    await clickPixel(h.pid, h.windowId, (bubble.x + bubble.width / 2) * shot.width, (bubble.y + bubble.height / 2) * shot.height);
    const deadline = Date.now() + 30_000;
    do {
      await sleep(1000);
      const downloaded = verifiedDownload(await attachmentSources(info.id), expected);
      if (downloaded) return downloaded;
    } while (Date.now() < deadline);
    throw new Error("LINE did not record a downloaded path with the exact expected size within 30 seconds. No success claimed; check LINE for a dialog. No download retry was made.");
  });
}
