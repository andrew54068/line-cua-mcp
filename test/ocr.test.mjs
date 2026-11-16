// dist/ocr (compiled ocr.swift): text, --crop, and --boxes on a drawn PNG.
// No LINE window or screenshot; the image is drawn here with AppKit.
//   node test/ocr.test.mjs
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const OCR = join(dirname(fileURLToPath(import.meta.url)), "../dist/ocr");
const T = mkdtempSync(join(tmpdir(), "line-ocr-test-"));
const png = join(T, "t.png");
try {
  // 1000x400 white image: "TOPLEFT 123" near the top-left, "BOTTOM 789" near the bottom-right.
  execFileSync("/usr/bin/swift", ["-e", `
import AppKit
let img = NSImage(size: NSSize(width: 1000, height: 400))
img.lockFocus()
NSColor.white.setFill(); NSRect(x: 0, y: 0, width: 1000, height: 400).fill()
let a: [NSAttributedString.Key: Any] = [.font: NSFont.systemFont(ofSize: 48), .foregroundColor: NSColor.black]
("TOPLEFT 123" as NSString).draw(at: NSPoint(x: 40, y: 300), withAttributes: a)
("BOTTOM 789" as NSString).draw(at: NSPoint(x: 600, y: 40), withAttributes: a)
img.unlockFocus()
let rep = NSBitmapImageRep(data: img.tiffRepresentation!)!
try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: CommandLine.arguments[1]))
`, png]);
  const run = (...a) => execFileSync(OCR, [png, ...a], { encoding: "utf8" });

  const all = run();
  assert.match(all, /TOPLEFT\s*123/);
  assert.match(all, /BOTTOM\s*789/);
  console.log("✓ reads the whole image");

  const top = run("--crop", "0,0,0.5,0.5");
  assert.match(top, /TOPLEFT\s*123/);
  assert.doesNotMatch(top, /BOTTOM/);
  console.log("✓ --crop keeps only the top-left quarter (top-left origin)");

  const boxes = JSON.parse(run("--boxes"));
  const b = boxes.find((x) => /^BOTTOM\s*789$/.test(x.text));
  assert.ok(b && b.x > 0.5 && b.y > 0.5, "box for bottom-right text is in the bottom-right");
  console.log("✓ --boxes reports full-image fractions");

  assert.throws(() => run("--crop", "0.5,0,0.2,1"));
  console.log("✓ an invalid --crop fails");
  console.log("ocr: 4 checks passed (drawn image; no LINE window)");
} finally {
  rmSync(T, { recursive: true, force: true });
}
