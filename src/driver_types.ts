// driver_types.ts — shared types + a re-export of the low-level `cua` call,
// so helper modules (ocr.ts) can talk to the driver without importing the
// full line.ts orchestration layer (avoids a circular import).

export type { } from "./driver.js";
export { cua } from "./driver.js";

/** Minimal window handle shape the helpers need. */
export interface LineHandleLike {
  pid: number;
  windowId: number;
}
