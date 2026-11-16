// line.ts — LINE-specific orchestration on top of the cua-driver wrapper.
//
// Encodes how LINE Desktop's AX tree is shaped and how to drive it without
// touching the global cursor or stealing focus:
//
//   - The main window is the on-screen "LINE"-titled window owned by the LINE
//     process. LINE spawns many tiny helper windows (1710x38 toolbars, etc.);
//     we pick the largest on-screen one.
//   - The chat list rows are not reliably in the AX tree, so we cannot pick a
//     chat by name from the tree directly. Instead we drive the search field
//     (AXTextField), set and verify its value, then open the top result with a coordinate
//     (pixel) click. The click is a CGEvent posted at the target point; it does
//     not warp the visible cursor.
//   - The message composer is an AXTextArea; we focus it with a coordinate click
//     then type via synthesized key events, because LINE's web-view input does
//     not honor AX value-setting.
//   - Message history is NOT in the AX tree (rows are empty shells) and cannot
//     be copied via cmd+c, so read_history reads it from LINE's local encrypted
//     DB (see linedb.ts) — not by OCR. OCR (ocr.ts) is used only to verify the
//     open chat's header on the send path.

import {
  listWindows,
  getWindowState,
  cua,
  getShotSize,
  clickPixel,
  typeText,
  pressKey,
  scroll,
} from "./driver.js";
import { ocrOpenChatName } from "./ocr.js";
import { allChats, chatCoverage, type ChatSummary, type ChatCoverageResult } from "./linedb.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface LineHandle {
  pid: number;
  windowId: number;
  title: string;
  bounds: { width: number; height: number };
}

/** Locate LINE's main window. Throws a clear error if LINE isn't running. */
export async function locateLine(): Promise<LineHandle> {
  const all = await listWindows();
  const lineWins = all.filter((w) => w.app_name === "LINE");
  if (lineWins.length === 0) {
    throw new Error(
      "LINE does not appear to be running, or no LINE window was found. Open the LINE desktop app and try again.",
    );
  }
  // Prefer on-screen windows; among those pick the largest by area (the main
  // window is ~850x704; helper windows are 1710x38 slivers or 0x0).
  const onScreen = lineWins.filter((w) => w.is_on_screen);
  const pool = onScreen.length ? onScreen : lineWins;
  const main = pool.reduce((best, w) => {
    const area = w.bounds.width * w.bounds.height;
    const bestArea = best.bounds.width * best.bounds.height;
    return area > bestArea ? w : best;
  });
  return {
    pid: main.pid,
    windowId: main.window_id,
    title: main.title,
    bounds: { width: main.bounds.width, height: main.bounds.height },
  };
}

interface ParsedElement {
  index: number;
  role: string;
  label: string | null;
  actions: string[];
  depth: number;
}

const LINE_RE =
  /^(\s*)- \[(\d+)\]\s+(\S+)(?:\s+"([^"]*)")?(?:\s+\[(?:[^\]]*?)actions=\[([^\]]*)\])?/;

/** Parse cua-driver's tree_markdown into structured elements. */
export function parseTree(md: string): ParsedElement[] {
  const out: ParsedElement[] = [];
  for (const line of md.split("\n")) {
    const m = LINE_RE.exec(line);
    if (!m) continue;
    const [, indent, idx, role, label, actions] = m;
    out.push({
      index: Number(idx),
      role,
      label: label ?? null,
      actions: actions ? actions.split(",").map((s) => s.trim()).filter(Boolean) : [],
      depth: indent.length,
    });
  }
  return out;
}

/** Find the search text field (top of the chat-list column). */
export function findSearchField(els: ParsedElement[]): ParsedElement | undefined {
  return els.find((e) => e.role === "AXTextField");
}


/** The chat-list / search-result rows. After a search, LINE renders matches as
 *  pressable AXCell / AXStaticText rows nested deep inside the left-rail
 *  AXTextArea container — these appear ABOVE the search field and the menu bar
 *  in document order. We therefore take pressable cell/row/text elements that
 *  occur before the AXMenuBar and are not menu items. */
export function findChatCells(els: ParsedElement[]): ParsedElement[] {
  const menuBarIdx = els.find((e) => e.role === "AXMenuBar")?.index ?? Number.MAX_SAFE_INTEGER;
  return els.filter(
    (e) =>
      e.index < menuBarIdx &&
      e.actions.includes("press") &&
      (e.role === "AXCell" || e.role === "AXRow" || e.role === "AXStaticText"),
  );
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const LINE_BUNDLE_ID = "jp.naver.line.mac";

/** Bundle ID of the frontmost app. Uses LaunchServices (`lsappinfo`), not
 *  AppleScript/System Events, so it needs no Automation permission. */
async function frontmostApp(): Promise<string> {
  try {
    const { stdout: asn } = await execFileAsync("lsappinfo", ["front"]);
    const { stdout } = await execFileAsync("lsappinfo", ["info", "-only", "bundleid", asn.trim()]);
    return stdout.match(/="([^"]+)"/)?.[1] ?? "";
  } catch {
    return "";
  }
}

/** Bring an app forward by bundle ID through LaunchServices (`open -b`). */
async function activateApp(bundleId: string): Promise<void> {
  if (!bundleId) return;
  await execFileAsync("open", ["-b", bundleId]).catch(() => {});
}

/** LINE's Qt window ignores clicks and keys while it is in the background, so
 *  UI actions bring it forward first; preservingFocus() restores the prior app. */
export async function activateLine(): Promise<void> {
  await activateApp(LINE_BUNDLE_ID);
  await sleep(500);
  if (await frontmostApp() !== LINE_BUNDLE_ID) {
    throw new Error("LINE did not become frontmost. No UI input was attempted.");
  }
}

/**
 * Run an operation and, if it foregrounded LINE when LINE wasn't already
 * frontmost, restore the prior frontmost app. Opening a LINE chat (clicking a
 * search result) activates LINE — results aren't in the AX tree, so a focus-free
 * AX press isn't possible and a pixel click is required, which activates the
 * window. We can't prevent the brief activation, but we return focus to where it
 * was. The cursor never moves throughout.
 */
// ponytail: one UI queue per server process; separate MCP processes still need
// exclusive access to the desktop during UI operations.
let uiTail: Promise<unknown> = Promise.resolve();
export function preservingFocus<T>(fn: () => Promise<T>): Promise<T> {
  const next = uiTail.then(() => preservingFocusImpl(fn));
  uiTail = next.catch(() => {});
  return next;
}

async function preservingFocusImpl<T>(fn: () => Promise<T>): Promise<T> {
  const before = await frontmostApp();
  try {
    return await fn();
  } finally {
    if (before && before !== LINE_BUNDLE_ID) {
      const after = await frontmostApp();
      if (after === LINE_BUNDLE_ID) await activateApp(before);
    }
  }
}

/** Parse the one search field in the first AXWindow only. A menu-only or
 *  ambiguous tree is not safe to edit. Values use cua-driver's JSON quoting. */
export function searchFieldState(md: string): { index: number; value: string } {
  if (!/^- \[\d+\] AXWindow "LINE"(?: |\n|$)/.test(md)) {
    throw new Error("LINE search window is unavailable (a dialog may be open).");
  }
  const window = md.match(/^- \[\d+\] AXWindow "LINE"[^\n]*\n([\s\S]*?)(?=^- \[|(?![\s\S]))/m)?.[1];
  if (!window) throw new Error("LINE search window is unavailable (a dialog may be open).");
  const fields = [...window.matchAll(/^\s*- \[(\d+)\] AXTextField(?: "(?:[^"\\]|\\.)*")?(?: = ("(?:[^"\\]|\\.)*"))?(?= |$)/gm)];
  if (fields.length !== 1) throw new Error("LINE search field is missing or ambiguous. Refusing to type.");
  return { index: Number(fields[0][1]), value: fields[0][2] ? JSON.parse(fields[0][2]) : "" };
}

/** Set the actual search field, never the focused field. No clicks or keys;
 *  read back AXValue and stop if LINE silently ignores the write. */
export async function setSearchValue(h: LineHandle, value: string): Promise<void> {
  if (typeof value !== "string" || /[\r\n\0]/.test(value)) throw new Error("Search must be a single-line string.");
  const windows = await listWindows(h.pid);
  if (windows.some((w) => w.is_on_screen && w.window_id !== h.windowId && w.bounds.width > 200 && w.bounds.height > 100)) {
    throw new Error("Another LINE window or dialog is open. Close it before searching.");
  }
  const before = searchFieldState((await getWindowState(h.pid, h.windowId)).tree_markdown);
  await cua("set_value", { pid: h.pid, window_id: h.windowId, element_index: before.index, value });
  for (let attempt = 0; attempt < 5; attempt++) {
    await sleep(200);
    const after = searchFieldState((await getWindowState(h.pid, h.windowId)).tree_markdown);
    if (after.value === value) return;
  }
  throw new Error("LINE did not confirm the search value. No typing fallback was attempted.");
}

/**
 * Select a chat by name: set and verify AXValue on the search field, then
 * pixel-click the top result. Cursor-free; LINE is foregrounded temporarily.
 *
 * Why result pixel-clicks: LINE renders search results in a web view that
 * only INTERMITTENTLY exposes result rows as AXCell elements — they are reliably
 * present visually. A pixel click on the top-result row opens the chat every
 * time; the AX-cell path silently fails when the rows aren't in the tree.
 * Verifies the opened chat via OCR afterward.
 */
export async function selectChat(h: LineHandle, name: string): Promise<void> {
  return preservingFocus(() => selectChatImpl(h, name));
}

export async function selectChatImpl(h: LineHandle, name: string, headerRight?: number): Promise<void> {
  await activateLine();
  const shot = await getShotSize(h.pid, h.windowId);
  if (!shot.width || !shot.height) {
    throw new Error("Could not determine LINE window dimensions for chat selection.");
  }

  await setSearchValue(h, name);
  await sleep(1100); // let LINE filter the result list

  // Pixel-click the top result row. The first result sits just below the search
  // box in the left rail: ~20% across, ~20.5% down the window image.
  const x = Math.round(shot.width * 0.2);
  const y = Math.round(shot.height * 0.205);
  await clickPixel(h.pid, h.windowId, x, y);
  await sleep(400);
  // A single click highlights; some builds need the open to register. Re-click
  // (idempotent — pressing an already-open chat's row is harmless).
  await clickPixel(h.pid, h.windowId, x, y);
  await sleep(900); // let the conversation load

  // Verify the chat actually opened by reading its header, using the SAME
  // anchored matcher as the send guard (no substring false-positives). Groups
  // are allowed here because selecting/reading a group is harmless — the 1:1
  // restriction is enforced separately in sendMessage's guard.
  const header = await ocrOpenChatName(h, headerRight);
  const a = normalizeName(header);
  const b = normalizeName(name);
  if (!a) {
    throw new Error(`Could not confirm chat "${name}" opened (header OCR empty).`);
  }
  if (!namesMatch(a, b)) {
    throw new Error(
      `Tried to open "${name}" but the conversation header reads "${header}". The chat may not exist under that exact name, or the result layout shifted.`,
    );
  }

  // Clear only the actual search field; never send keys to the composer.
  await setSearchValue(h, "");
}

export interface SyncOlderResult {
  chatId: string;
  name: string | null;
  before: { localMessageCount: number; oldestLocalMessage: string | null };
  after: { localMessageCount: number; oldestLocalMessage: string | null };
  newOlderMessages: number;
  oldestMovedBack: boolean;
  rounds: number;
  reachedStableTop: boolean;
  note: string;
}

/**
 * Best-effort UI sync: foreground LINE, open the chat, and scroll the message
 * list upward so LINE Desktop fetches older messages from its servers and
 * persists them into the local encrypted DB. UNLIKE read_history / list_chats
 * this is NOT a background operation — it activates LINE (focus is restored
 * afterward, cursor never moves) and depends on LINE's UI/network. Progress is
 * measured against the local DB between rounds, so the result reports honestly
 * whether anything actually backfilled.
 */
export async function syncOlderMessages(
  h: LineHandle,
  name: string,
  opts: { maxRounds?: number; pagesPerRound?: number; settleMs?: number } = {},
): Promise<SyncOlderResult> {
  return preservingFocus(() => syncOlderMessagesImpl(h, name, opts));
}

async function syncOlderMessagesImpl(
  h: LineHandle,
  name: string,
  opts: { maxRounds?: number; pagesPerRound?: number; settleMs?: number },
): Promise<SyncOlderResult> {
  const maxRounds = Math.max(1, Math.min(opts.maxRounds ?? 8, 40));
  const pagesPerRound = Math.max(1, Math.min(opts.pagesPerRound ?? 5, 50));
  const settleMs = Math.max(300, opts.settleMs ?? 1400);

  // Open + verify the chat (reuses the anchored OCR guard in selectChatImpl).
  await selectChatImpl(h, name);

  const cov0: ChatCoverageResult = await chatCoverage(name);

  // Synthesized PageUp must land on LINE's message list, so the window has to
  // be frontmost; preservingFocus() restores the prior app when we're done.
  await activateLine();

  const shot = await getShotSize(h.pid, h.windowId);
  // A point inside the message-history pane: centered horizontally, upper-middle
  // (below the header, well above the composer at y≈0.89).
  const px = Math.round(shot.width * 0.5);
  const py = Math.round(shot.height * 0.4);

  let prevCount = cov0.localMessageCount;
  let prevOldestTs = cov0.oldestLocalMessageTs ?? null;
  let stagnant = 0;
  let rounds = 0;
  let reachedStableTop = false;

  while (rounds < maxRounds) {
    rounds++;
    await clickPixel(h.pid, h.windowId, px, py); // focus the message list
    await sleep(150);
    await scroll(h.pid, "up", { by: "page", amount: pagesPerRound, windowId: h.windowId });
    await sleep(settleMs); // let LINE fetch older messages + persist to the DB

    const cov: ChatCoverageResult = await chatCoverage(name);
    const grew =
      cov.localMessageCount > prevCount ||
      (cov.oldestLocalMessageTs != null &&
        prevOldestTs != null &&
        cov.oldestLocalMessageTs < prevOldestTs);
    if (grew) {
      stagnant = 0;
    } else if (++stagnant >= 2) {
      reachedStableTop = true; // two no-progress rounds → top reached or sync stalled
      break;
    }
    prevCount = cov.localMessageCount;
    if (cov.oldestLocalMessageTs != null) prevOldestTs = cov.oldestLocalMessageTs;
  }

  const cov1: ChatCoverageResult = await chatCoverage(name);
  return {
    chatId: cov1.chatId,
    name: cov1.name,
    before: { localMessageCount: cov0.localMessageCount, oldestLocalMessage: cov0.oldestLocalMessage },
    after: { localMessageCount: cov1.localMessageCount, oldestLocalMessage: cov1.oldestLocalMessage },
    newOlderMessages: Math.max(0, cov1.localMessageCount - cov0.localMessageCount),
    oldestMovedBack:
      cov1.oldestLocalMessageTs != null &&
      cov0.oldestLocalMessageTs != null &&
      cov1.oldestLocalMessageTs < cov0.oldestLocalMessageTs,
    rounds,
    reachedStableTop,
    note:
      "Best-effort UI sync (NOT background): LINE was foregrounded and the chat scrolled up to make LINE Desktop backfill older messages into the local DB; focus was restored and the cursor never moved. If newOlderMessages is 0 and oldestMovedBack is false, the local DB likely already holds this chat's full history, or LINE did not load more.",
  };
}

/** Split a message into parts around @mentions, preserving the original
 *  package's behaviour: a "@name " token (not preceded by "/") is a mention. */
export function splitMentions(message: string): string[] {
  const parts = message.split(/((?<!\/)@\S+\s)/g);
  const out: string[] = [];
  let buf = "";
  for (const part of parts) {
    if (/^(?<!\/)@\S+\s$/.test(part)) {
      if (buf) {
        out.push(buf);
        buf = "";
      }
      out.push(part);
    } else {
      buf += part;
    }
  }
  if (buf) out.push(buf);
  return out;
}

/** A LINE group/multi-person chat shows a member-count badge "(N)" after the
 *  name. Detecting it is how we enforce "1:1 chats only". Trade-off: a 1:1
 *  contact whose display name legitimately contains "(N)" is refused as a group
 *  (fail closed — annoying but safe; the DB `isGroup` cross-check is the
 *  authoritative signal). */
export function hasMemberCountBadge(header: string): boolean {
  return /[（(]\s*\d+\s*[）)]/.test(header);
}

/** Normalize a chat name for tolerant matching against OCR'd header text.
 *  Strips whitespace and lowercases, and removes trailing OCR-noise glyphs that
 *  LINE's header icons (mute/popout) are commonly misread as. Does NOT strip a
 *  "(N)" member-count badge — that is a group signal we must NOT erase. */
export function normalizeName(s: string): string {
  return s
    .replace(/[（(]\s*\d+\s*[）)]/g, "") // drop the count for the NAME comparison only
    .replace(/[\s​]+/g, "")
    .replace(/[·•‹›<>「」『』|]+$/g, "") // common OCR misreads of header icons
    .toLowerCase();
}

/**
 * Verify, via OCR of the conversation header, that the chat currently open is
 * the intended 1:1 chat `name`. Returns the OCR'd header. Throws otherwise.
 *
 * This is the guard that prevents sending into the wrong chat. Hardened after
 * adversarial review:
 *   - GROUP REJECTION: if the header carries a "(N)" member-count badge, it's a
 *     multi-person chat — hard-fail. (The user requires 1:1-only sends.) Pass
 *     allowGroup:true only when the caller explicitly intends a group.
 *   - ANCHORED MATCH: the normalized header must EQUAL the normalized target
 *     (not merely contain it), so a short target like "明" cannot pass against a
 *     different open chat such as "小明子" / "陳明婷". A small edit-distance
 *     tolerance absorbs OCR fuzz without admitting different names.
 *   - DB CROSS-CHECK: when `knownChats` (the local DB chat list) is supplied,
 *     also verify the target against ground-truth identity + group status. This
 *     closes the cases header OCR alone fails *open* on — a group whose "(N)"
 *     badge was cropped, and a wrong person admitted by the ≤1-char tail
 *     tolerance. See crossCheckSendTarget.
 *   - FAIL CLOSED on an empty/too-short header.
 */
export async function assertChatOpen(
  h: LineHandle,
  name: string,
  opts: { allowGroup?: boolean; knownChats?: KnownChat[] | null } = {},
): Promise<string> {
  const header = await ocrOpenChatName(h);

  if (!opts.allowGroup && hasMemberCountBadge(header)) {
    throw new Error(
      `Open chat "${header}" is a GROUP (member-count badge present). Refusing to send: only 1:1 chats are allowed. ` +
        `Pass allowGroup if you really mean to message a group.`,
    );
  }

  const a = normalizeName(header);
  const b = normalizeName(name);
  if (!a || a.length < 1) {
    throw new Error(
      `Could not verify the open chat before sending (header OCR empty/too short). Aborting send to "${name}" for safety.`,
    );
  }
  if (!namesMatch(a, b)) {
    throw new Error(
      `Open chat "${header}" does not match target "${name}". Aborting send to avoid messaging the wrong chat.`,
    );
  }

  // DB cross-check: when we have the local chat list as ground truth, close the
  // header-OCR holes that namesMatch + the badge regex leave open (group-as-1:1
  // on a cropped badge; wrong-person on the lenient ≤1-char tail). If the DB has
  // no entry for the target (NO_DB_MATCH), keep the OCR-only verdict above.
  if (opts.knownChats && opts.knownChats.length) {
    const x = crossCheckSendTarget(header, name, opts.knownChats, {
      allowGroup: opts.allowGroup,
    });
    if (!x.ok && x.reason !== NO_DB_MATCH) throw new Error(x.reason);
  }
  return header;
}

/**
 * Anchored name match between a normalized OCR'd header (`a`) and a normalized
 * target (`b`). Safety-first: fail CLOSED on any ambiguity (blocking a legit
 * send is merely annoying; a wrong-chat send is harmful).
 *
 * Rules:
 *   - Exact equality matches.
 *   - Otherwise the SHORTER string must be a PREFIX of the longer one. This
 *     anchors the match at the start, so "明" never matches "小明子" / "陳明婷"
 *     (which don't start with 明).
 *   - The remaining tail may be at most ONE character, and that character must
 *     NOT be ASCII alphanumeric. This admits header-icon bleed (LINE's mute /
 *     pop-out glyphs near a short CJK name, e.g. "明" OCR'd as "明一") while
 *     rejecting a genuinely different longer name ("Alice" vs "Alice2",
 *     "Bob" vs "Bobby", "YingLing" vs "YingLin2").
 *
 * NOTE: short CJK names sit at the edge of OCR reliability; when the header is
 * misrecognized this returns false and the caller fails closed. That is the
 * intended, safe behavior.
 */
export function namesMatch(a: string, b: string): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (!long.startsWith(short)) return false;
  const remainder = long.slice(short.length);
  if (remainder.length > 1) return false;
  if (/[a-z0-9]/i.test(remainder)) return false;
  return true;
}

/** A chat as known to the local DB. Ground truth for identity and group status,
 *  independent of — and stronger than — header OCR. (Structurally a subset of
 *  linedb.ts's ChatSummary, so a ChatSummary[] can be passed directly.) */
export interface KnownChat {
  chatId: string;
  name: string | null;
  isGroup: boolean;
}

/** Sentinel reason: the DB has no entry for the target, so the caller should
 *  fall back to the OCR-only guard rather than hard-refuse the send. */
export const NO_DB_MATCH = "__NO_DB_MATCH__";

/**
 * Resolve a name against the local DB's chat list using the SAME normalized,
 * anchored semantics as the OCR matcher. An exact normalized-name match wins
 * outright (so a precise target like "小明" is not made ambiguous merely because
 * a longer "小明華" also exists); otherwise fall back to the anchored namesMatch.
 * Returns the unique match, or the candidate set when ambiguous.
 *
 * NB: intentionally stricter than linedb.py's resolve_chat (plain substring, for
 * convenience lookups) — this is the safety path, so it mirrors the OCR matcher.
 */
export function resolveKnownChat(
  name: string,
  chats: KnownChat[],
): { match?: KnownChat; ambiguous?: KnownChat[] } {
  const b = normalizeName(name);
  if (!b) return {};
  const named = chats.filter((c): c is KnownChat & { name: string } => !!c.name);
  const exact = named.filter((c) => normalizeName(c.name) === b);
  if (exact.length === 1) return { match: exact[0] };
  if (exact.length > 1) return { ambiguous: exact };
  const fuzzy = named.filter((c) => namesMatch(normalizeName(c.name), b));
  if (fuzzy.length === 1) return { match: fuzzy[0] };
  if (fuzzy.length > 1) return { ambiguous: fuzzy };
  return {};
}

/**
 * DB-backed cross-check for a send, layered ON TOP of the OCR matcher to close
 * two header-OCR failure modes that `namesMatch` alone cannot (it fails *open* on
 * a plausible-but-wrong read):
 *
 *   - GROUP-AS-1:1 — the target resolves to a group in the DB even if the "(N)"
 *     member-count badge was cropped out of / misread in the OCR'd header. The
 *     decision uses the DB's `isGroup`, not the badge, so it is OCR-independent.
 *   - WRONG-PERSON — the OCR'd header points at a different person than the
 *     target, in either direction: EXTENSION (the header resolves to a different
 *     known chat, e.g. "小明華" opened for target "小明", which the ≤1-char tail
 *     tolerance in `namesMatch` would otherwise admit) and TRUNCATION (the header
 *     is a strict prefix of another known chat, i.e. OCR may have clipped a
 *     longer name down to the target). Both are refused.
 *
 * Also fails closed on an empty/garbage header. Returns ok:true with the resolved
 * target chat, or ok:false with a reason. The reason `NO_DB_MATCH` means the DB
 * has no entry for the target — the caller should then fall back to the OCR-only
 * guard instead of refusing.
 *
 * Residual (cannot be closed by name alone — there is no independent read of
 * which chat is on screen; the OCR header is the only signal):
 *   - two chats sharing an IDENTICAL display name where one is a group; and
 *   - a chat NOT in the local DB snapshot (e.g. brand-new): if its longer header
 *     is OCR-truncated to exactly the target and the target is a prefix of
 *     nothing else in the DB, the truncation guard cannot see the collision.
 */
export function crossCheckSendTarget(
  header: string,
  target: string,
  chats: KnownChat[],
  opts: { allowGroup?: boolean } = {},
): { ok: true; resolved: KnownChat } | { ok: false; reason: string } {
  const namesOf = (cs: KnownChat[]) =>
    cs.map((c) => c.name).filter(Boolean).slice(0, 8).join(", ");

  // 0. Self-safe: an empty/garbage header means OCR couldn't read the open chat,
  //    so it cannot be verified. Fail closed. (assertChatOpen guards this too,
  //    but this function must not fail OPEN if called without that pre-check.)
  const nh = normalizeName(header);
  if (!nh) {
    return { ok: false, reason: "Open chat header OCR was empty; cannot verify the open chat. Refusing for safety." };
  }

  // 1. Resolve the TARGET — the exact caller argument, never OCR'd.
  const t = resolveKnownChat(target, chats);
  if (t.ambiguous) {
    return {
      ok: false,
      reason:
        `Target "${target}" is ambiguous in the local DB (${t.ambiguous.length} chats match: ${namesOf(t.ambiguous)}). ` +
        `Refusing to avoid a wrong-chat send — use a more specific name or the exact chatId.`,
    };
  }
  if (!t.match) return { ok: false, reason: NO_DB_MATCH };
  const targetChat = t.match;

  // 2. GROUP check from DB ground truth (immune to a cropped/misread badge).
  if (!opts.allowGroup && targetChat.isGroup) {
    return {
      ok: false,
      reason:
        `Target "${target}" is a GROUP in the local DB (chatId ${targetChat.chatId}). ` +
        `Refusing: only 1:1 chats are allowed unless allowGroup is set.`,
    };
  }

  // 3. WRONG-PERSON (extension): the OCR'd header must not resolve to a DIFFERENT
  //    known chat than the target (e.g. "小明華" opened for target "小明").
  const h = resolveKnownChat(header, chats);
  if (h.match && h.match.chatId !== targetChat.chatId) {
    return {
      ok: false,
      reason:
        `Open chat header "${header}" resolves to a DIFFERENT known chat ("${h.match.name}", ${h.match.chatId}) ` +
        `than the target "${target}" (${targetChat.chatId}). Refusing to avoid messaging the wrong chat.`,
    };
  }
  if (!opts.allowGroup && h.match?.isGroup) {
    return {
      ok: false,
      reason: `Open chat header "${header}" resolves to a GROUP in the local DB. Refusing: only 1:1 chats are allowed.`,
    };
  }

  // 4. WRONG-PERSON (truncation): OCR can CLIP a long header down to a shorter
  //    string. If the matched header is a strict prefix of a DIFFERENT known
  //    chat's name, the open chat could be that longer chat with its tail lost —
  //    indistinguishable from the header alone, so fail closed. (Cheap: only
  //    names that are a strict prefix of another chat are affected; pass the full
  //    name or exact chatId to disambiguate.)
  const truncationSource = chats.find(
    (c) =>
      !!c.name &&
      c.chatId !== targetChat.chatId &&
      normalizeName(c.name) !== nh &&
      normalizeName(c.name).startsWith(nh),
  );
  if (truncationSource) {
    return {
      ok: false,
      reason:
        `Open chat header "${header}" is a prefix of another known chat ("${truncationSource.name}", ${truncationSource.chatId}); ` +
        `OCR truncation could be hiding the real target. Refusing — use the full chat name or the exact chatId.`,
    };
  }

  return { ok: true, resolved: targetChat };
}

/**
 * Send a message to a chat. ALWAYS re-selects the named chat and VERIFIES (via
 * header OCR) that it is the chat now open before typing a single character —
 * this guard prevents the message landing in whatever chat happened to be open.
 *
 * Typing uses the CGEvent path (pixel-click to focus the composer + synthesized
 * typing): LINE's web-view composer ignores AX value-setting, so this is the
 * only path that actually delivers. No cursor movement and no window raise.
 * Mentions: types the "@name" token then Return to accept LINE's popup
 * (best-effort; LINE's mention UI varies by build).
 */
export async function sendMessage(
  h: LineHandle,
  opts: { name: string; text: string; auto?: boolean; mentions?: boolean; allowGroup?: boolean },
): Promise<void> {
  return preservingFocus(() => sendMessageImpl(h, opts));
}

async function sendMessageImpl(
  h: LineHandle,
  opts: { name: string; text: string; auto?: boolean; mentions?: boolean; allowGroup?: boolean },
): Promise<void> {
  // Ground truth from the local DB (chat identity + group status) used to harden
  // the OCR header guard below. If the DB is unavailable (no key, decrypt fail),
  // fall back to the OCR-only guard rather than blocking the send.
  let knownChats: ChatSummary[] | null = null;
  try {
    knownChats = await allChats();
  } catch (e) {
    console.error(
      `[send] DB cross-check unavailable (${(e as Error).message}); relying on OCR-only header guard.`,
    );
  }

  // 1. Select the target chat, then HARD-VERIFY it is the one open AND (unless
  //    allowGroup) that it is a 1:1 chat, not a group.
  await selectChatImpl(h, opts.name);
  await assertChatOpen(h, opts.name, { allowGroup: opts.allowGroup, knownChats });

  // 2. Focus the composer via a pixel click (CGEvent path). Prefer the AX
  //    text-area geometry; fall back to the measured window fraction (0.72,
  //    0.89) only if the AX lookup fails.
  const shot = await getShotSize(h.pid, h.windowId);
  if (!shot.width || !shot.height) {
    throw new Error("Could not determine LINE window dimensions for composer focus.");
  }
  const composer = await composerPoint(shot);
  await clickPixel(h.pid, h.windowId, composer.x, composer.y);
  await sleep(300);
  // Clear any stray draft.
  await pressKey(h.pid, "a", { modifiers: ["cmd"], windowId: h.windowId });
  await pressKey(h.pid, "delete", { windowId: h.windowId });

  // 3. Type the message (CGEvent synthesis via type_text on the focused field).
  if (opts.mentions) {
    const segments = splitMentions(opts.text);
    for (const seg of segments) {
      if (/^@\S+\s$/.test(seg)) {
        await typeText(h.pid, seg.trim());
        await sleep(400);
        // Accept the mention popup. LINE inserts the highlighted suggestion on Return.
        await pressKey(h.pid, "return", { windowId: h.windowId });
        await typeText(h.pid, " ");
      } else {
        await typeText(h.pid, seg);
      }
      await sleep(150);
    }
  } else {
    await typeText(h.pid, opts.text);
  }

  // 4. Send only if explicitly asked. RE-VERIFY the open chat IMMEDIATELY before
  //    the irreversible Return: focus could have shifted (incoming call, modal,
  //    notification) between the first guard and now.
  if (opts.auto) {
    await assertChatOpen(h, opts.name, { allowGroup: opts.allowGroup, knownChats });
    await sleep(150);
    await pressKey(h.pid, "return", { windowId: h.windowId });
  }
}

/** Resolve the composer click point: the measured window fraction (0.72,
 *  0.89), inside the composer at the bottom of the chat pane. (An earlier AX
 *  geometry lookup went through System Events, which needs an Automation
 *  grant for the host app; it was removed for that reason.) */
async function composerPoint(
  shot: { width: number; height: number },
): Promise<{ x: number; y: number }> {
  return { x: Math.round(shot.width * 0.72), y: Math.round(shot.height * 0.89) };
}
