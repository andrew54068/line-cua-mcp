// Unit tests for LINE media decryption (attachments.ts). No LINE data.
//   node test/attachments.test.mjs
import assert from "node:assert/strict";
import { createCipheriv, createHmac, hkdfSync, randomBytes } from "node:crypto";
import { decryptLineMedia, sniffMime } from "../dist/attachments.js";

// Encrypt the way LINE does, so decryption is checked against an independent writer.
function encrypt(plain, keyMaterial) {
  const d = Buffer.from(hkdfSync("sha256", Buffer.from(keyMaterial, "base64"), Buffer.alloc(0), "FileEncryption", 76));
  const c = createCipheriv("aes-256-ctr", d.subarray(0, 32), Buffer.concat([d.subarray(64, 76), Buffer.alloc(4)]));
  const body = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([body, createHmac("sha256", d.subarray(32, 64)).update(body).digest()]);
}

const key = randomBytes(32).toString("base64");
const jpeg = Buffer.concat([Buffer.from("ffd8ffe000104a464946", "hex"), randomBytes(70000)]);
const blob = encrypt(jpeg, key);

assert.equal(blob.length, jpeg.length + 32);
assert.deepEqual(decryptLineMedia(blob, key), jpeg);
console.log("✓ decrypts LINE media (AES-256-CTR + HMAC-SHA256, size = plain + 32)");

assert.throws(() => decryptLineMedia(blob, randomBytes(32).toString("base64")), /HMAC mismatch/);
console.log("✓ a wrong key fails the HMAC check");

const tampered = Buffer.from(blob);
tampered[100] ^= 1;
assert.throws(() => decryptLineMedia(tampered, key), /HMAC mismatch/);
console.log("✓ a changed byte fails the HMAC check");

assert.equal(sniffMime(jpeg), "image/jpeg");
assert.equal(sniffMime(Buffer.from("%PDF-1.7\n")), "application/pdf");
assert.equal(sniffMime(Buffer.from("0000001c667479704d344120", "hex")), "audio/mp4");
assert.equal(sniffMime(Buffer.from("504b030414000600", "hex")), "application/zip");
console.log("✓ sniffs JPEG, PDF, M4A, and ZIP (docx/xlsx) headers");
console.log("attachments: 4 checks passed");

// Synthetic metadata only: no LINE reads and no UI operations.
const { assertDownloadTarget, verifiedFilenameBox, verifiedResultRow, verifiedDownload, getAttachment, downloadSkipReason } = await import('../dist/attachments.js');
const target = {
  id: 'm1', chatId: 'u1', chat: 'Alice', time: null, direction: 'in', sender: 'Alice',
  attachment: { kind: 'file', fileName: 'report.pdf', fileSize: 1234, expiresAt: '2099-01-01T00:00:00Z', cachedPreview: false },
  sources: { downloadNameMatches: 1 },
};
assertDownloadTarget(target);
for (const change of [
  { attachment: { ...target.attachment, kind: 'image' } },
  { attachment: { ...target.attachment, expired: true } },
  { attachment: { ...target.attachment, expiresAt: '2000-01-01T00:00:00Z' } },
  { attachment: { ...target.attachment, expiresAt: 'invalid' } },
  { attachment: { ...target.attachment, fileSize: 0 } },
  { attachment: { ...target.attachment, fileName: 'bad\nname.pdf' } },
  { sources: { downloadNameMatches: 2 } }, { sources: {} }, { chat: null },
]) assert.throws(() => assertDownloadTarget({ ...target, ...change }));
for (const name of ['a.sh', 'a.command', 'a.app', 'a.webloc', 'a.docm', 'a.xls', 'a.pdf.command']) {
  assert.throws(() => assertDownloadTarget({ ...target, attachment: { ...target.attachment, fileName: name } }), /Only pdf/);
}
assert.equal(downloadSkipReason(target), null);
assert.match(downloadSkipReason({ ...target, attachment: { ...target.attachment, kind: 'image' } }), /only file/);
assert.match(downloadSkipReason({ ...target, attachment: { ...target.attachment, fileName: 'a.sh' } }), /pdf\/txt/);
assert.match(downloadSkipReason({ ...target, attachment: { ...target.attachment, expired: true } }), /expired/);
assert.equal(downloadSkipReason({ ...target, sources: { downloadNameMatches: 2 } }), null);
assert.throws(() => assertDownloadTarget({ ...target, sources: { downloadNameMatches: 2 } }), /ambiguous/);
for (const value of ['true', 'false', 1, 0, null, {}]) {
  await assert.rejects(getAttachment('unused', value), /download must be a boolean/);
}
const box = { text: 'report.pdf', confidence: 0.99, highlighted: true, x: 0.5, y: 0.4, width: 0.2, height: 0.02 };
assert.equal(verifiedFilenameBox([box], 'report.pdf'), box);
assert.throws(() => verifiedFilenameBox([box, box], 'report.pdf'));
assert.equal(verifiedFilenameBox([{ ...box, text: 'my report.pdf' }], 'myreport.pdf').text, 'my report.pdf');
assert.throws(() => verifiedFilenameBox([{ ...box, text: 'my report2.pdf' }], 'my report.pdf'));
for (const change of [{ highlighted: false }, { confidence: 0.2 }, { text: 'report.pdf…' }, { y: 0.9 }, { x: 0.1 }, { width: -1 }, { height: 0 }, { confidence: NaN }]) {
  assert.throws(() => verifiedFilenameBox([{ ...box, ...change }], 'report.pdf'));
}
const title = { ...box, text: 'Alice', x: 0.17, y: 0.2, width: 0.1, confidence: 0.5 };
const count = { ...title, text: '找到 1 則訊息', y: 0.23, width: 0.15 };
assert.equal(verifiedResultRow([title, count], 'Alice'), title);
const ai = { ...title, text: 'Al思辨派對' }, aiCount = { ...count, text: '找到1 則訊息' };
assert.equal(verifiedResultRow([ai, aiCount], 'AI思辨派對'), ai); // MBA Vision reads "AI" as "Al"
assert.throws(() => verifiedResultRow([{ ...ai, text: 'A1思辨派對' }, aiCount], 'AI思辨派對'));
for (const rows of [[title], [title, { ...count, text: '找到 2 則訊息' }], [title, count, title], [title, { ...count, y: 0.6 }]]) {
  assert.throws(() => verifiedResultRow(rows, 'Alice'));
}
assert.throws(() => assertDownloadTarget({ ...target, attachment: { ...target.attachment, expiresAt: undefined } }));
assert.equal(verifiedDownload(target, target), undefined);
assert.equal(verifiedDownload({ ...target, sources: { downloadedPath: '/synthetic/report.pdf', downloadedFileSize: 1233 } }, target), undefined);
assert.equal(verifiedDownload({ ...target, sources: { downloadedPath: 'relative', downloadedFileSize: 1234 } }, target), undefined);
assert.deepEqual(verifiedDownload({ ...target, sources: { downloadedPath: '/synthetic/report.pdf', downloadedFileSize: 1234 } }, target), {
  path: '/synthetic/report.pdf', bytes: 1234, source: 'line-ui', verifiedBy: 'line-db',
});
assert.throws(() => verifiedDownload({ ...target, id: 'm2' }, target), /identity changed/);
assert.throws(() => verifiedDownload({ ...target, chatId: 'u2' }, target), /identity changed/);
console.log('download safety: validation, document allowlist, OCR ambiguity/highlight/pane, exact DB size and identity passed');
