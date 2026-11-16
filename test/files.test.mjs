import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileTarget, fileManifest, fileReceiptMatches } from "../dist/files.js";
const id = "u" + "a".repeat(32);
const opts = { chatId: id, name: "Cached", uiName: "Visible", paths: [] };
const chat = { chatId: id, name: "Cached", isGroup: false, lastUpdated: null };
assert.equal(fileTarget(opts, [chat])[0].name, "Visible");
for (const chats of [[], [{...chat,isGroup:true}], [{...chat,name:"Changed"}], [chat,{...chat,chatId:"u"+"b".repeat(32),name:"Visible"}], [chat,{...chat,chatId:"c"+"b".repeat(32),name:"Visible"}]]) {
  assert.throws(() => fileTarget(opts, chats));
}
assert.throws(() => fileTarget({...opts,chatId:"c"+"a".repeat(32)}, [chat]));
const dir = await mkdtemp(join(tmpdir(), "line-files-test-"));
try {
  const path = join(dir,"test.pdf"); await writeFile(path,"pdf");
  const [file] = await fileManifest([path]);
  assert.equal(file.size,3); assert.match(file.sha256,/^[a-f0-9]{64}$/);
  await assert.rejects(fileManifest([path,path]));
  await assert.rejects(fileManifest(["relative.pdf"]));
  await assert.rejects(fileManifest([dir]));
  const receipt = {id:"message",ts:1,text:"test.pdf",status:2,errorCode:0,metadata:{FILE_SIZE:"3"}};
  assert.equal(fileReceiptMatches(receipt,file),true);
  for (const changed of [{status:1},{errorCode:1},{text:"other.pdf"},{metadata:{FILE_SIZE:"4"}}]) assert.equal(fileReceiptMatches({...receipt,...changed},file),false);
} finally {await rm(dir,{recursive:true});}
console.log("File-send safeguards passed (no UI actions or external sends).");
