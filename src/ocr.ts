// ocr.ts — OCR the LINE conversation HEADER via a cua-driver window screenshot.
// Used ONLY to verify which chat is open before a send (anchored name match +
// 1:1-only group guard). Message history is NOT read by OCR — that comes from
// LINE's local encrypted DB (see linedb.ts).
//
// Pipeline: cua-driver captures the (possibly backgrounded) window -> crop to
// the header strip -> native Vision OCR via the system swift. The crop step
// shells out to python3 with Pillow (PIL); see the README requirements.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtemp, rm } from "node:fs/promises";
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

async function cropPane(
  src: string,
  width: number,
  height: number,
  pane: PaneRect,
): Promise<string> {
  const cropW = Math.round((pane.right - pane.left) * width);
  const cropH = Math.round((pane.bottom - pane.top) * height);
  const offX = Math.round(pane.left * width);
  const offY = Math.round(pane.top * height);
  const dst = src.replace(/\.png$/, "_pane.png");
  // sips --cropToHeightWidth H W --cropOffset offsetY offsetX crops centered;
  // it lacks a direct x/y origin, so we crop to the pane size then re-crop.
  // Simpler + robust: use sips to crop to size with offset via two steps is
  // fiddly — instead crop with a small Python+PIL fallback if available, else
  // sips center-crop. We use Python/PIL which is reliably present here.
  await execFileAsync("python3", [
    "-c",
    [
      "import sys;from PIL import Image;im=Image.open(sys.argv[1]);",
      `c=im.crop((${offX},${offY},${offX + cropW},${offY + cropH}));`,
      "c.save(sys.argv[2])",
    ].join(""),
    src,
    dst,
  ]);
  return dst;
}

/** OCR an image with the native Vision framework via system swift. */
async function ocrImage(imagePath: string): Promise<string> {
  const script = join(__dirname, "ocr.swift");
  // Use the SYSTEM swift explicitly: a user-installed swiftly toolchain may be
  // broken, and Vision is a system framework anyway.
  const { stdout } = await execFileAsync("/usr/bin/swift", [script, imagePath], {
    maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, PATH: `/usr/bin:${process.env.PATH ?? ""}`, DEVELOPER_DIR: "" },
  });
  return stdout;
}

// The chat-header strip: the open conversation's name sits at the top of the
// right pane. Used to verify send targets the intended chat.
const HEADER: PaneRect = { left: 0.38, top: 0.07, right: 0.7, bottom: 0.13 };

/** OCR just the conversation-header strip and return its first non-empty line
 *  (the open chat's display name), or "" if none. */
export async function ocrOpenChatName(h: LineHandleLike): Promise<string> {
  const shot = await captureWindow(h);
  const dir = dirname(shot.path);
  try {
    if (!shot.width || !shot.height) return "";
    const cropped = await cropPane(shot.path, shot.width, shot.height, HEADER);
    const text = await ocrImage(cropped);
    const first = text.split("\n").map((l) => l.trim()).filter(Boolean)[0] ?? "";
    return first;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
