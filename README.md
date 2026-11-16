<p align="center">
  <img src="assets/banner.svg" alt="line-cua-mcp — 讀取 LINE 本機資料庫，送訊息不移動游標" width="640">
</p>

> 語言：繁體中文（台灣）｜[English README](README.en.md)

macOS 專用的 LINE Desktop MCP server。**讀取**訊息時，直接讀 LINE 本機加密資料庫的唯讀快照；這條讀取路徑完全在背景執行，不碰 UI：不移動游標、不切換視窗焦點、不用 OCR、不捲動畫面，而且 LINE 關閉時也可以讀。**送訊息**時則必須透過 LINE UI，由 [cua-driver](https://github.com/trycua/cua) 以不移動游標的方式操作；送出前會用 OCR 讀取聊天標題，並用本機資料庫交叉比對目標聊天。

## 實驗性警告

這是一個**實驗性個人工具**，不是成熟產品，也不是可以放心給一般使用者安裝的正式產品。它會讀取你本機 LINE Desktop 的加密資料庫，並且在你明確要求時透過 LINE 介面送出訊息。請把它當成研究用／自用的原型工具：

- 只在**你自己的 Mac、你自己的 LINE 帳號、你自己的資料**上使用。
- 首次設定需要擷取本機 LINE 資料庫金鑰；這通常會啟動一個重新簽章的 LINE 副本並要求你登入，可能會讓原本的 LINE Desktop 被登出。
- 送訊息雖然有 OCR 和本機資料庫交叉比對來降低風險，但仍不應視為零風險；預設會先留下草稿（`auto: false`），建議確認後再送出。
- LINE 更新、macOS 權限、OCR 結果、資料庫格式或 `cua-driver` 行為改變，都可能讓它失效。
- 你必須自行確認使用方式符合 LINE 服務條款與所在地法律。本專案與 LINE／NAVER 無關，也不代表 LINE／NAVER 認可或支持。

## 兩條資料路徑

- **讀取是資料庫路徑。** macOS 版 LINE Desktop 是 **Qt6/QML** app，訊息文字由 GPU 繪製，accessibility tree 裡拿不到；但歷史訊息存在本機 **wxSQLite3 / QtCipherSqlitePlugin AES-128-CBC** 加密 SQLite DB（`…/Data/db/qwb*.edb`）。`read_history` / `list_chats` 會用 macOS keychain 裡的帳號金鑰解開唯讀快照，回傳**本機 DB 內現有的**歷史紀錄（每一則本機已存的訊息，含 sender、timestamp、direction），並附上涵蓋範圍（本機則數、最舊／最新時間）。本機 DB 只存有 LINE Desktop 已同步到這台 Mac 的訊息；從未載入到本機的較舊訊息不在其中（可用 `sync_older_messages` 回補）。這條路徑完全背景執行，不碰 UI。舊版曾用 OCR 讀螢幕，只能看到目前畫面；那條路徑已移除。
- **送訊息是 UI 路徑，但不移動游標。** 不能靠改 DB 送訊息，所以 `send_message` 會透過 cua-driver 操作 LINE UI：CGEvent 會送到指定座標／按鍵，但不 warp 可見游標；LINE 可能短暫跳到前景開啟目標聊天，完成後會把原本的前景 app 切回來。

## 附件下載（須明確啟用）

`get_attachment({"messageId":"…"})` 預設只讀取本機快取。加入 `"download":true` 後，若沒有完整快取，工具才會嘗試透過 LINE Desktop 官方介面下載。這個流程會連線至 LINE 伺服器、將 LINE 切到前景，且 **LINE 可能使用預設應用程式開啟下載的文件**。目前只支援一般檔案訊息（ct14），副檔名限 `.pdf`、`.txt`、`.csv`、`.docx`、`.xlsx`、`.pptx`。不支援指令稿、執行檔、舊版 Office 檔案及含巨集的 Office 檔案；符合副檔名也不代表內容安全。

工具會確認本機資料庫中的檔名唯一（包含文字訊息提到的檔名）、聊天室名稱不重複、聊天室標題符合目標，搜尋結果中只有一筆名稱完全相符的聊天室，並顯示「找到 1 則訊息」，對話中則必須出現完全相符且已標示的檔名。點擊座標來自 Vision 文字辨識；檔名截斷、重複、缺少標示或辨識不確定時，一律停止。目前只支援黃色／橘色搜尋標示；已過期或無法確認到期時間的附件不會下載。同一個伺服器程序會依序執行介面操作；下載期間請勿操作 LINE 或執行其他自動化程序。

只有 LINE 資料庫記錄下載路徑，且下載位元組數符合預期時，才會回傳 `downloaded.path` 與 `downloaded.bytes`。Node 不會開啟或檢查該路徑，因此無法獨立確認檔案目前仍存在。LINE 開啟文件後，文件的應用程式可能停在前景；工具只能盡力還原原本的前景應用程式。逾時或出現儲存對話框不算成功，也不會重複點擊附件。不會回傳媒體金鑰，也不會直接呼叫 LINE 伺服器 API。此下載流程尚未通過實際介面驗證；本機資料庫未同步的訊息無法檢查，也無法保證帳號不受限制。

## MCP 工具

| Tool | 功能 |
|------|------|
| `line_status` | 回報 LINE UI 是否可用，以及本機 DB／金鑰／解密狀態。DB-backed 讀取（`list_chats` / `read_history`）不需要 LINE 正在執行；只有 UI 工具需要。 |
| `list_chats` | 從本機 DB 列出最近聊天（name、chatId、最後活動時間、是否群組）。完全背景執行。 |
| `read_history` | 依名稱或 chatId 從已解密的本機 DB 讀取聊天**本機已存的**歷史紀錄：文字、direction、絕對時間戳，並附本機涵蓋範圍。不移動游標、不切前景、不用 OCR。 |
| `sync_older_messages` | **盡力而為、走 UI（非背景）：** 讓 LINE 跳到前景並把聊天往上捲，促使 LINE 把較舊訊息回補進本機 DB。不移動游標、會還原焦點，並回報前後涵蓋範圍。需要 LINE 正在執行。 |
| `select_chat` | 透過 UI 開啟指定聊天（搜尋 → pixel-click 第一筆結果）。供 `send_message` 使用。不移動游標；會還原焦點。 |
| `send_files` | 精確指定 1:1 chatId／DB name／UI alias，準備檔名、大小與 SHA-256；實際上傳使用 line-send-files 技能的原生選檔流程，再從 DB 核對送達紀錄。 |
| `send_message` | 透過 UI 對指定聊天送出或留下草稿。送出前有 anchored name、1:1-only、DB cross-check 等防護。 |

## 本機資料庫與金鑰

`src/linedb.py`（透過專案 venv 與 `apsw-sqlite3mc` 執行）負責解密，但它**不會自己打開 LINE 的資料夾**。macOS 會保護其他 App 的資料（「想要取用其他 App 的資料」），而系統提示框會顯示「是哪個程序在要求」。所以所有讀取 LINE 資料夾的動作，都交給一個有名字、有用途說明的小 App：**LINE Reader.app**（`helper/line-reader.c`，bundle ID `com.dawson.line-reader`）。

- LINE Reader 把 `qwb*.edb`、`-wal`、`-shm` 複製到呼叫端建立的私人暫存資料夾（權限 0700），再用 FIFO 把 keychain 裡的金鑰交給 `linedb.py`，金鑰不會落在一般檔案裡。`linedb.py` 只開啟那份複本，所以不會鎖住或改動 LINE 正在寫入的檔案。
- LINE Reader 只複製、不寫入 LINE 的資料、不連網、不執行腳本，也不載入使用者可改寫的程式碼（hardened runtime + library validation）。所以就算給了它權限，別的程序也無法借它執行其他程式；最多只能拿到 LINE 資料的複本。
- `linedb.py` 透過 LaunchServices（`open -W -a "LINE Reader.app"`）啟動它，所以 macOS 的提示框會顯示：**「LINE Reader」想要取用其他 App 的資料**，並附上用途說明：*Copies LINE Desktop's local chat database and attachment cache into a private temporary folder…*。如果出現的提示框名稱是 Python、node 或其他程式，那不是本專案發出的，請按「不允許」。
- macOS 對這類授權只記得單一程序，所以每次讀取都可能再問一次。想要完全不跳提示，可以在「系統設定 → 隱私權與安全性 → 完全取用磁碟」手動加入 `~/Applications/LINE Reader.app`。要不要給，由你決定；本專案不會自動授權。

在跑 LINE 的那台 Mac 上安裝（建置是 deterministic 的；內容沒變就不會覆蓋，既有授權也會保留）：

```bash
yarn helper:install   # 建置並安裝到 ~/Applications/LINE Reader.app
```

cipher 參數是：

```sql
PRAGMA cipher='aes128cbc';
PRAGMA kdf_iter=1;
PRAGMA key='<32-hex>';
```

這是 **wxSQLite3 AES-128，不是 SQLCipher**；SQLCipher 的 PRAGMA／AES-256 開不起來。

### 金鑰

32-hex 金鑰不會由本專案寫進 repo 或明文檔案。金鑰存在 macOS login keychain service `line-cua-mcp-dbkey`；LINE Reader 用 Apple 內建的 `security` 工具讀取（這個 keychain 項目本來就信任它，所以不會多跳提示），再經由 FIFO 交給 `linedb.py`。設定 `$LINE_DB_KEY` 可以覆寫 keychain：

```bash
security find-generic-password -s line-cua-mcp-dbkey -w   # 讀回金鑰
```

### 擷取金鑰（第一次設定）

在有 SIP 的 Mac 上，不能直接 attach 到 hardened、sandboxed 的 LINE app 讀記憶體。可行的一次性流程（**不需要關 SIP**）：

1. 把 `LINE.app` 複製到暫存資料夾；對副本執行 `xattr -cr`。
2. 對副本做 ad-hoc re-sign，加入 `com.apple.security.get-task-allow`（同時會移除 hardened-runtime flag），例如：`codesign -f -s - --deep --entitlements ent.plist LINEcopy.app`。
3. 啟動這個副本並登入你的帳號。這通常會讓原本的 LINE Desktop 被登出；擷取完再登入回去即可。金鑰跟帳號穩定相關，所以副本中的金鑰可解開真實 DB。
4. 用 `lldb` attach 到副本（`get-task-allow` 讓它可被 debug）；在 writable memory 裡找 `encryption_key=` / `mse` 附近的 32-hex token。
5. 用真實 DB 驗證後存進 keychain：
   ```bash
   security add-generic-password -a "$USER" -s line-cua-mcp-dbkey -w <key> -U
   ```
   然後刪掉這個 LINE 副本。

如果 LINE 之後 rotate key，`linedb.py status` 會回報 `decryptOk: false`，需要重做一次擷取。

### 快速檢查

```bash
.venv/bin/python src/linedb.py status                 # db found, key, decryptOk, counts
.venv/bin/python src/linedb.py list-chats --limit 20
.venv/bin/python src/linedb.py read "<chat name>"     # 完整歷史（JSON）
.venv/bin/python src/linedb.py export-md --name "<chat>" --thread "<Name>" --out out.md
```

## 送訊息安全機制

`send_message` 會改變外部狀態，所以加了多層防護；`send_files` 僅準備檔案，技能的原生選檔操作才會送出：

1. **重新選擇**指定聊天，不會送到「目前剛好打開的聊天室」。
2. **Anchored name match**（不是 substring）：OCR 讀到的聊天標題正規化後必須等於目標名稱，只容許尾端多一個非英數字元（LINE header icon 造成的 OCR 雜訊）。例如短目標 `明` 不會通過 `小明子` / `陳明婷`；`Alice` 不會通過 `Alice2`。
3. **預設只允許 1:1**：如果開啟的聊天標題有 member-count badge `(N)`，視為群組，拒絕送出。需要送群組時必須明確傳 `allowGroup: true`。
4. **DB 交叉比對**（`crossCheckSendTarget`）：本機 DB 是聊天 identity 與 group status 的權威來源，不只相信 OCR。目標會先用聊天列表解析；如果目標是群組、名稱有歧義，或 OCR 標題指向不同聊天，就拒絕。
5. **真正按 Return 前會再驗一次**。
6. `auto: false` 是預設值，只會把文字放進輸入框當草稿，不會送出。

`ocr.ts`（透過 `src/ocr.swift` 使用 macOS Vision）現在**只用於送訊息前驗證聊天標題**；讀訊息已不再用 OCR。

純 matcher / 交叉比對邏輯有 unit tests（`yarn test`）。DB 交叉比對補上 header OCR 可能 fail-open 的兩類問題：

- **把群組誤當 1:1**：即使 `(N)` badge 被裁掉或 OCR 錯讀，仍會用 DB 的 `isGroup` 拒絕。`isGroup` 是 fail-closed：只要不是 `u` 開頭的 1:1 聯絡人（例如群組、多人聊天室、LINE Square community、未知未來類型），都視為 group。
- **送錯對象**，包含兩個方向：*extension* — OCR 標題解析成另一個已知聊天（例如目標 `小明`，實際開到 `小明華`）；*truncation* — 標題是另一個已知聊天名稱的嚴格前綴（可能是 OCR 把長名字裁短）。兩者都拒絕；目標名稱有歧義也拒絕。

**殘餘限制與取捨：** 交叉比對需要本機 DB（金鑰在 keychain）；如果 DB 不可用，會降級成只靠 OCR 的保護機制並寫 log。若某個 1:1 名稱剛好是另一個聊天名稱的嚴格前綴，會被 truncation guard 拒絕；請改用完整名稱或精確 chatId。因為目前沒有獨立訊號能知道畫面上實際是哪個 chat，以下狀況無法只靠名稱完全解掉：兩個聊天顯示名稱完全相同（其中一個是群組）；或某個新聊天還沒寫進本機 DB，而它的較長標題剛好被 OCR 裁短成目標名稱。預設仍是 `auto: false`，送出前請先檢查草稿。

## 需求

- macOS，已安裝並登入 **LINE** desktop app。
- **Python venv**，包含 `apsw-sqlite3mc`（DB 讀取路徑）：
  ```bash
  python3 -m venv .venv && .venv/bin/pip install apsw-sqlite3mc
  ```
- **Xcode Command Line Tools**（`/usr/bin/swiftc`）：`yarn build` 會把 `src/ocr.swift` 編譯成 `dist/ocr`，供 UI 路徑的 OCR 使用。讀取路徑不需要。
- DB 金鑰已放進 keychain service `line-cua-mcp-dbkey`（見上方）。
- 安裝 **cua-driver**，並授權 Accessibility / Screen Recording（`select_chat` / `send_message` 需要）：
  ```bash
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/trycua/cua/main/libs/cua-driver/scripts/install.sh)"
  ```
- Node 18+。

## 建置與執行

```bash
yarn install
yarn build            # tsc + 編譯 dist/ocr + 複製 linedb.py 到 dist/
node dist/server.js   # MCP stdio server
```

Register with Claude Code:

```bash
claude mcp add --transport stdio line-cua -- node /absolute/path/to/line-cua-mcp/dist/server.js
```

## 調整參數

DB 路徑與 cipher 參數在 `src/linedb.py`。送訊息用的 OCR crop 區域與 composer click point 是 window-fraction 常數：`src/ocr.ts` 的 `HEADER`，以及 `src/line.ts` 的 composer `0.72, 0.89`。如果 LINE 改 UI layout，要調這些值。

## 法律與免責

這是用來存取**你自己的** LINE 帳號與資料、並且只在**你自己的**機器上使用的個人工具。使用前請理解：

- 你必須自行遵守 LINE 服務條款與所在地法律。讀本機資料庫、操作 desktop client，可能違反 LINE 的 ToS；金鑰擷取流程修改的是 app 的**副本**，不是你安裝的 `LINE.app`。只在自己的帳號／資料上使用。
- 本軟體以 **AS IS** 提供，沒有任何保證，作者不負任何責任；見 [`LICENSE`](LICENSE)。
- 這不是法律意見。如果你不確定某種使用方式是否合法，請尋求所在地法律意見。

**商標：**「LINE」是 LINE Corporation／NAVER 的商標。本專案是獨立專案，與 LINE／NAVER 無關，也不代表 LINE／NAVER 認可或支持。

隱私與金鑰處理說明請見 [`SECURITY.md`](SECURITY.md)。

## 檔案傳送

`send_files` 需要 `chatId`、`name`、絕對路徑 `paths`，可另給經過畫面確認的 `uiName`。`auto:false` 只準備檔名、bytes、SHA-256，不碰 UI。檔案 URL 貼上在目前 LINE 版本實測無效，因此 `auto:true` 明確拒絕，不會嘗試上傳。

已驗證的傳送流程在 bullpen 的 `comm/line-send-files/SKILL.md`：先確認 Mac 已解鎖及一對一收件人，透過 native cua_repl 的 Open 選檔視窗選取精確檔案，再按 Open。2026-09-30 實際傳送四份 PDF 成功。每份須在 pinned chat 出現新的 outgoing file message，且檔名、FILE_SIZE、status=2、errorCode=0 相符，保存訊息 ID 後才可回報成功。
