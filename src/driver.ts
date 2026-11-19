// driver.ts — persistent MCP client to `cua-driver mcp`.
//
// CRITICAL: cua-driver's element_index cache is per-connection. A one-shot
// `cua-driver <tool>` CLI invocation runs in-process with a fresh cache, so an
// index returned by one call is gone by the next — indexed click/type_text
// cannot span CLI calls. We therefore hold ONE long-lived MCP client; the
// cache persists across get_window_state -> click -> type_text on it.
//
// cua-driver actions here are AX queries plus CGEvent posts (coordinate clicks
// and synthesized key events). They do not warp the visible cursor and do not
// steal focus, and they work on backgrounded windows. The cursor-free property
// of the coordinate click lives inside cua-driver itself; verify-cua.ts measures
// it empirically (cursor delta before/after each op).

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

function resolveCuaDriver(): string {
  const fromEnv = process.env.CUA_DRIVER_PATH;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  const candidates = [
    join(homedir(), ".local", "bin", "cua-driver"),
    "/usr/local/bin/cua-driver",
    "/opt/homebrew/bin/cua-driver",
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  return "cua-driver";
}

const CUA_DRIVER = resolveCuaDriver();

export class DriverError extends Error {
  constructor(message: string, readonly tool: string) {
    super(message);
    this.name = "DriverError";
  }
}

let clientPromise: Promise<Client> | null = null;

async function getClient(): Promise<Client> {
  if (!clientPromise) {
    clientPromise = (async () => {
      const transport = new StdioClientTransport({
        command: CUA_DRIVER,
        // Proxy to the CuaDriver daemon (CuaDriver.app) so macOS attributes
        // Accessibility / Screen Recording use to "CuaDriver", which already
        // holds those grants. In-process mode (--no-daemon-relaunch) would make
        // macOS attribute them to whatever app hosts this MCP server.
        args: ["mcp"],
        env: {
          ...process.env,
          PATH: `${join(homedir(), ".local", "bin")}:${process.env.PATH ?? ""}`,
        } as Record<string, string>,
      });
      const client = new Client(
        { name: "line-cua-mcp", version: "0.1.0" },
        { capabilities: {} },
      );
      await client.connect(transport);
      return client;
    })();
  }
  return clientPromise;
}

/** Call a cua-driver tool over the persistent connection. Returns the parsed
 *  JSON from the first text content block, or the raw text if not JSON. */
export async function cua<T = any>(
  tool: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  const client = await getClient();
  const res = await client.callTool({ name: tool, arguments: args });
  if ((res as any).isError) {
    const text = (res.content as any[])?.find((c) => c.type === "text")?.text ?? "unknown error";
    throw new DriverError(`cua-driver ${tool}: ${text}`, tool);
  }
  // Prefer structuredContent when present.
  if ((res as any).structuredContent) return (res as any).structuredContent as T;
  const text = (res.content as any[])?.find((c) => c.type === "text")?.text ?? "";
  const trimmed = String(text).trim();
  if (!trimmed) return undefined as unknown as T;
  // Strip a leading "✅ " summary marker if the whole thing isn't JSON.
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    return trimmed as unknown as T;
  }
}

export async function closeDriver(): Promise<void> {
  if (clientPromise) {
    const c = await clientPromise.catch(() => null);
    await c?.close().catch(() => {});
    clientPromise = null;
  }
}

// ---- Typed helpers ----

export interface CuaWindow {
  window_id: number;
  pid: number;
  app_name: string;
  title: string;
  bounds: { x: number; y: number; width: number; height: number };
  z_index: number;
  is_on_screen: boolean;
  on_current_space: boolean | null;
}

export async function listWindows(pid?: number): Promise<CuaWindow[]> {
  const res = await cua<{ windows: CuaWindow[] }>("list_windows", pid ? { pid } : {});
  return res?.windows ?? [];
}

export interface WindowState {
  pid: number;
  window_id: number;
  element_count: number;
  tree_markdown: string;
  screenshot_width?: number;
  screenshot_height?: number;
}

export async function getWindowState(
  pid: number,
  windowId: number,
  opts: { capture_mode?: "som" | "vision" | "ax"; query?: string } = {},
): Promise<WindowState> {
  return cua<WindowState>("get_window_state", {
    pid,
    window_id: windowId,
    capture_mode: opts.capture_mode ?? "ax",
    ...(opts.query ? { query: opts.query } : {}),
  });
}

/** Window screenshot pixel dimensions (cua-driver's click/right_click coordinate
 *  space). Differs from the logical window bounds by the display scale factor. */
export async function getShotSize(pid: number, windowId: number): Promise<{ width: number; height: number }> {
  const s = await getWindowState(pid, windowId, { capture_mode: "vision" });
  return { width: s.screenshot_width ?? 0, height: s.screenshot_height ?? 0 };
}

/** Pixel left-click in window-local screenshot coordinates (CGEvent path). */
export async function clickPixel(pid: number, windowId: number, x: number, y: number): Promise<void> {
  await cua("click", { pid, window_id: windowId, x: Math.round(x), y: Math.round(y) });
}

export async function clickElement(
  pid: number,
  windowId: number,
  elementIndex: number,
  action: "press" | "show_menu" | "pick" | "confirm" | "cancel" | "open" = "press",
): Promise<void> {
  await cua("click", { pid, window_id: windowId, element_index: elementIndex, action });
}

export async function typeText(
  pid: number,
  text: string,
  opts: { windowId?: number; elementIndex?: number } = {},
): Promise<void> {
  await cua("type_text", {
    pid,
    text,
    ...(opts.elementIndex != null && opts.windowId != null
      ? { element_index: opts.elementIndex, window_id: opts.windowId }
      : {}),
  });
}

// Tracks (pid:windowId) for which we've populated cua-driver's element-index
// cache this connection (value = element_count seen), so press_key can use the
// auth-message path.
const snapshotted = new Map<string, number>();

/** Ensure cua-driver has a current element-index cache for this window and
 *  return how many elements it has. Takes at most one AX snapshot per window per
 *  connection. */
async function ensureSnapshot(pid: number, windowId: number): Promise<number> {
  const key = `${pid}:${windowId}`;
  const cached = snapshotted.get(key);
  if (cached != null) return cached;
  const state = await getWindowState(pid, windowId, { capture_mode: "ax" });
  const count = state.element_count ?? 0;
  snapshotted.set(key, count);
  return count;
}

/**
 * Press a key, delivered via cua-driver's AUTH-MESSAGE path (element_index set)
 * — NOT the NSMenu path. This is critical: press_key with only `window_id`
 * briefly activates LINE WindowServer-frontmost (SLPSSetFrontProcessWithOptions),
 * STEALING FOCUS. Passing an element_index routes through the auth path, which
 * does not activate. We default to element_index 0 (the AXWindow, always
 * present), ensuring a snapshot has populated the cache first.
 */
export async function pressKey(
  pid: number,
  key: string,
  opts: { modifiers?: string[]; windowId?: number; elementIndex?: number } = {},
): Promise<void> {
  const windowId = opts.windowId;
  let elementIndex = opts.elementIndex;
  if (windowId != null) {
    // Force the auth-message (no-activation) path with a valid element index.
    if (elementIndex == null) elementIndex = 0;
    const count = await ensureSnapshot(pid, windowId);
    if (count <= elementIndex) {
      // The element index we'd use doesn't exist — taking the window_id-only
      // path would silently STEAL FOCUS. Fail closed instead.
      throw new DriverError(
        `press_key("${key}") cannot use the focus-safe path: window ${windowId} has ${count} elements, index ${elementIndex} unavailable. Refusing to fall back to the focus-stealing path.`,
        "press_key",
      );
    }
  }
  await cua("press_key", {
    pid,
    key,
    ...(opts.modifiers ? { modifiers: opts.modifiers } : {}),
    ...(windowId != null ? { window_id: windowId } : {}),
    ...(elementIndex != null ? { element_index: elementIndex } : {}),
  });
}

/** Invalidate the snapshot cache (call when the window's element tree may have
 *  been rebuilt). press_key normally uses index 0 (the window), so this is
 *  rarely needed. */
export function invalidateSnapshot(pid: number, windowId: number): void {
  snapshotted.delete(`${pid}:${windowId}`);
}

export async function checkPermissions(): Promise<any> {
  return cua("check_permissions", {});
}

/**
 * Scroll the target pid's focused region. cua-driver implements this with
 * synthesized keys: by:"page" → PageUp/PageDown × amount, by:"line" → arrow
 * keys × amount. Pre-focuses element_index first when given with windowId.
 * NOTE: this drives the UI by keystroke — it is NOT part of the background DB
 * read path.
 */
export async function scroll(
  pid: number,
  direction: "up" | "down" | "left" | "right",
  opts: { by?: "page" | "line"; amount?: number; windowId?: number; elementIndex?: number } = {},
): Promise<void> {
  await cua("scroll", {
    pid,
    direction,
    ...(opts.by ? { by: opts.by } : {}),
    ...(opts.amount != null ? { amount: opts.amount } : {}),
    ...(opts.windowId != null ? { window_id: opts.windowId } : {}),
    ...(opts.elementIndex != null ? { element_index: opts.elementIndex } : {}),
  });
}
