// probe.ts — non-mutating sanity check. Locates LINE, snapshots its AX tree,
// and reports which key elements (search field, chat cells) were found —
// WITHOUT selecting a chat or sending anything.
//
// Run: yarn probe

import { locateLine } from "./line.js";
import { getWindowState } from "./driver.js";
import { parseTree, findSearchField, findChatCells } from "./line.js";

const h = await locateLine();
console.log("LINE handle:", h);

const state = await getWindowState(h.pid, h.windowId, { capture_mode: "ax" });
const els = parseTree(state.tree_markdown);
console.log(`Parsed ${els.length} elements (driver reported ${state.element_count}).`);

const search = findSearchField(els);
const cells = findChatCells(els);

console.log("search field:", search ? `[${search.index}] ${search.role}` : "NOT FOUND");
console.log("chat cells:", cells.length, cells.length ? `(first index ${cells[0].index})` : "");

console.log("\nNon-cell structure (first 15):");
for (const e of els.filter((x) => x.role !== "AXCell").slice(0, 15)) {
  console.log(`  [${e.index}] ${e.role}${e.label ? ` "${e.label}"` : ""} actions=[${e.actions.join(",")}]`);
}
