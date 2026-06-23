// Pure unit tests for the send-safety matching logic. No LINE app required.
//   node test/matcher.test.mjs
import { hasMemberCountBadge, normalizeName, namesMatch, resolveKnownChat, crossCheckSendTarget, NO_DB_MATCH } from "../dist/line.js";
let pass=0, fail=0;
const check=(d,got,want)=>{const ok=got===want;(ok?pass++:fail++);if(!ok)console.log(`✗ FAIL ${d} => ${got} (want ${want})`);};
const m=(target,header)=>namesMatch(normalizeName(header), normalizeName(target));
// group badge
check("media group",hasMemberCountBadge("明 (3)"),true);
check("not group",hasMemberCountBadge("明"),false);
check("fullwidth group",hasMemberCountBadge("群（5）"),true);
// legit allow
check("exact",m("明","明"),true);
check("icon bleed",m("明","明一"),true);
check("latin exact",m("YingLing","YingLing"),true);
// adversarial block (the substring attacks)
check("小明子",m("明","小明子"),false);
check("陳明婷",m("明","陳明婷"),false);
check("Alice2",m("Alice","Alice2"),false);
check("Bobby",m("Bob","Bobby"),false);
check("YingLing2",m("YingLing","YingLing2"),false);
check("empty",m("明",""),false);

// --- DB cross-check: closes the two header-OCR fail-open holes ---
const KNOWN = [
  { chatId: "u1", name: "小明",   isGroup: false },
  { chatId: "u2", name: "小明華", isGroup: false },
  { chatId: "m1", name: "TeamA",  isGroup: true  },
  { chatId: "u3", name: "Alice",  isGroup: false },
  { chatId: "u4", name: "陳明",   isGroup: false },
  { chatId: "u5", name: "陳華",   isGroup: false },
  { chatId: "u6", name: "Sam",    isGroup: false },
  { chatId: "u7", name: "Sam",    isGroup: false },
];
const cc=(header,target,opts)=>crossCheckSendTarget(header,target,KNOWN,opts||{});
// MODE A — group sent as 1:1, even with the "(N)" badge CROPPED out of the header
check("xcheck group blocked",cc("TeamA","TeamA").ok,false);
check("xcheck group ok w/ flag",cc("TeamA","TeamA",{allowGroup:true}).ok,true);
// MODE B (extension) — target 小明 but 小明華 opened (different known chat)
check("xcheck wrong person extension blocked",cc("小明華","小明").ok,false);
// MODE B (truncation) — 小明華 opened but OCR clipped the header to 小明, which is
// a strict prefix of another chat -> ambiguous -> refuse (fail closed)
check("xcheck wrong person truncation blocked",cc("小明","小明").ok,false);
// legit UNIQUE 1:1 send (name not a prefix of any other chat) still passes
check("xcheck unique 1:1 ok",cc("Alice","Alice").ok,true);
check("xcheck unique 1:1 id",cc("Alice","Alice").resolved?.chatId,"u3");
// legit send to the LONGER name (not a prefix of anything) passes
check("xcheck longer name ok",cc("小明華","小明華").ok,true);
// empty/garbage header -> fail closed (do not rely on the caller's OCR pre-check)
check("xcheck empty header blocked",cc("","Alice").ok,false);
// ambiguity -> refuse (duplicate exact names; anchored-fuzzy CJK)
check("xcheck ambiguous exact blocked",cc("Sam","Sam").ok,false);
check("xcheck ambiguous fuzzy blocked",cc("陳","陳").ok,false);
// no DB entry -> sentinel (caller falls back to OCR-only, not a hard refusal)
check("xcheck no-db-match sentinel",cc("Bob","Bob").reason,NO_DB_MATCH);
// resolver: exact wins over a longer fuzzy sibling; short CJK is ambiguous
check("resolve exact wins",resolveKnownChat("小明",KNOWN).match?.chatId,"u1");
check("resolve ambiguous",!!resolveKnownChat("陳",KNOWN).ambiguous,true);

console.log(`matcher.test: ${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
