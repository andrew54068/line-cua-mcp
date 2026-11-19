// ocr.ts — OCR the LINE conversation HEADER via a cua-driver window screenshot.
// Used ONLY to verify which chat is open before a send (anchored name match +
// 1:1-only group guard). Message history is NOT read by OCR — that comes from
// LINE's local encrypted DB (see linedb.ts).
//
// Pipeline: cua-driver captures the (possibly backgrounded) window -> crop to
// the header strip -> native Vision OCR (dist/ocr, compiled from ocr.swift).

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { cua, type LineHandleLike } from "./driver_types.js";

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));

/** Window-image crop rectangle as fractions (0..1) of width/height. */
interface PaneRect { left: number; top: number; right: number; bottom: number; }

/** Capture the LINE window via cua-driver (no cursor move, no raise). Returns
 *  the PNG path and its pixel dimensions. Cleans up its own temp dir if the
 *  capture call fails (the caller's finally only covers the returned path). */
async function captureWindow(h: LineHandleLike): Promise<{ path: string; width: number; height: number }> {
  const dir = await mkdtemp(join(tmpdir(), "line-ocr-"));
  const out = join(dir, "shot.png");
  try {
    const res = await cua<any>("get_window_state", {
      pid: h.pid,
      window_id: h.windowId,
      capture_mode: "vision",
      screenshot_out_file: out,
    });
    const width = res?.screenshot_width ?? 0;
    const height = res?.screenshot_height ?? 0;
    return { path: out, width, height };
  } catch (e) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    throw e;
  }
}

/** OCR an image with the native Vision framework. dist/ocr is compiled from
 *  ocr.swift by `yarn build` with the system swiftc; Vision is a system
 *  framework, so no toolchain is needed at run time. */
async function runOcr(args: string[]): Promise<string> {
  const bin = join(__dirname, "ocr");
  if (!existsSync(bin)) throw new Error(`OCR helper missing at ${bin}. Run yarn build.`);
  const { stdout } = await execFileAsync(bin, args, { maxBuffer: 8 * 1024 * 1024 });
  return stdout;
}

/** OCR one pane of a window screenshot. */
const ocrPane = (src: string, p: PaneRect) =>
  runOcr([src, "--crop", [p.left, p.top, p.right, p.bottom].join(",")]);

// The chat-header strip: the open conversation's name sits at the top of the
// right pane. Used to verify send targets the intended chat.
const HEADER: PaneRect = { left: 0.38, top: 0.07, right: 0.7, bottom: 0.13 };

/** OCR just the conversation-header strip and return its first non-empty line
 *  (the open chat's display name), or "" if none. */
export async function ocrOpenChatName(h: LineHandleLike, right = HEADER.right): Promise<string> {
  const shot = await captureWindow(h);
  const dir = dirname(shot.path);
  try {
    if (!shot.width || !shot.height) return "";
    const text = await ocrPane(shot.path, { ...HEADER, right });
    const first = text.split("\n").map((l) => l.trim()).filter(Boolean)[0] ?? "";
    return first;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Fail closed if the composer contains a draft instead of its placeholder. */
export async function assertComposerEmpty(h: LineHandleLike): Promise<void> {
  const shot = await captureWindow(h);
  try {
    if (!shot.width || !shot.height) throw new Error("Cannot verify the LINE composer.");
    const text = (await ocrPane(shot.path, {left: 0.42, top: 0.85, right: 0.95, bottom: 0.945})).trim();
    if (!/^(輸入訊息|Type a message(?:\.{3})?|Input a message)$/i.test(text)) {
      throw new Error(`LINE composer is not confirmed empty (draft or OCR uncertainty). Refusing to paste files.`);
    }
  } finally { await rm(dirname(shot.path), {recursive: true, force: true}).catch(() => {}); }
}

/** Vision rectangles in full-window, top-left-origin fractions. */
export interface OcrBox {
  text: string; confidence: number; x: number; y: number;
  width: number; height: number; highlighted: boolean;
}

/** No crop: coordinates map directly to the captured window's pixels. */
export async function ocrWindowBoxes(h: LineHandleLike): Promise<{ boxes: OcrBox[]; width: number; height: number }> {
  const shot = await captureWindow(h);
  try {
    if (!(shot.width > 0 && shot.height > 0)) throw new Error("Cannot capture LINE window dimensions.");
    return { boxes: JSON.parse(await runOcr([shot.path, "--boxes"])), width: shot.width, height: shot.height };
  } finally { await rm(dirname(shot.path), { recursive: true, force: true }).catch(() => {}); }
}
