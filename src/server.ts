#!/usr/bin/env node
// server.ts — MCP stdio server exposing cursor-free LINE tools.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  locateLine,
  selectChat,
  sendMessage,
  syncOlderMessages,
} from "./line.js";
import { sendFiles, type SendFilesOptions } from "./files.js";
import { checkPermissions } from "./driver.js";
import { dbStatus, listChats, readChat, formatHistory, listAttachments } from "./linedb.js";
import { getAttachment } from "./attachments.js";
import { readFile } from "node:fs/promises";

const server = new Server(
  { name: "line-cua-mcp", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

const TOOLS = [
  {
    name: "line_status",
    description:
      "Report LINE UI availability plus local DB/key/decryption status. LINE does not need to be running for DB-backed reads (`list_chats` / `read_history`); only UI tools (`select_chat` / `send_message`) require a running LINE app. Does not move the cursor or change focus.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "select_chat",
    description:
      "Open a LINE chat by name (cursor-free, no focus steal). Types the name into LINE's search box and opens the top matching result with a coordinate (pixel) click — a CGEvent posted at the target point that does not warp the cursor.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Exact chat / friend / group name as shown in LINE." },
      },
      required: ["name"],
      additionalProperties: false,
    },
  },
  {
    name: "read_history",
    description:
      "Read a chat's message history from LINE's local encrypted database — FULLY in the background: no cursor, no window focus change, no OCR, no scrolling. Returns the complete history PRESENT IN THE LOCAL DB (every locally-stored message, not just the visible viewport), with sender direction and timestamps, plus a `coverage` footer (local count, oldest/newest stored). Messages that were never synced to this Mac are NOT included — use sync_older_messages to backfill older history first. Decrypts a read-only snapshot of LINE's wxSQLite3 DB using the account key in the macOS keychain. Identify the chat by name (1:1, group, or community); pass limit to cap to the most recent N messages.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Chat name (friend / group / community) or raw chatId." },
        limit: {
          type: "integer",
          description: "Max number of most-recent messages to return. Default 0 = entire history.",
          minimum: 0,
        },
      },
      required: ["name"],
      additionalProperties: false,
    },
  },
  {
    name: "list_chats",
    description:
      "List recent chats (most-recently-active first) from LINE's local database — fully background, no UI. Use to discover exact chat names/ids for read_history. Returns name, chatId, last-activity time, and whether it's a group.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "integer", description: "Max chats to return. Default 50.", minimum: 1 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "list_attachments",
    description:
      "List a chat's attachments (images, videos, voice messages, files such as PDF/Word/Excel, stickers), newest first, from LINE's local database — fully background, no UI, no network. Each item has the message id for get_attachment, plus file name, size, image size or duration, the date LINE's server copy expires, and where LINE recorded a local copy (savedCopy / sentFrom).",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Chat name (friend / group / community) or raw chatId." },
        kind: { type: "string", enum: ["image", "video", "audio", "file", "sticker"], description: "Only this kind." },
        limit: { type: "integer", description: "Max items. Default 50.", minimum: 1 },
      },
      required: ["name"],
      additionalProperties: false,
    },
  },
  {
    name: "get_attachment",
    description:
      "Get one message's attachment. Default download:false reads local cache only, with no network. Opt-in download:true may foreground LINE and download a unique unexpired file (ct14) through its official UI (may open the document in its default app; pdf/txt/csv/docx/xlsx/pptx only); returns a DB-recorded saved path and exact byte count without opening that file. Unsupported/ambiguous targets or uncertain OCR are refused; focus restoration is best-effort if LINE opens another app. Returns the full original when LINE's cache has it (files sent from this Mac, voice messages, stickers), else a small preview for images/videos (~534 px wide). Files are decrypted into a private temp folder and returned as paths; images are also shown inline. Copies LINE recorded in your own folders (savedCopy / sentFrom) are returned as paths and not opened. LINE's folders are read only by LINE Reader.app. Get message ids from list_attachments or read_history.",
    inputSchema: {
      type: "object",
      properties: {
        messageId: { type: "string", description: "Message id from list_attachments or read_history." },
        download: { type: "boolean", default: false, description: "Opt in to official LINE UI download if no full cache copy exists. File attachments only; may fail closed on OCR/layout uncertainty. No direct server requests." },
      },
      required: ["messageId"],
      additionalProperties: false,
    },
  },
  {
    name: "sync_older_messages",
    description:
      "Best-effort: backfill OLDER history into the local DB for one chat by driving the LINE UI. UNLIKE read_history / list_chats this is NOT background — it foregrounds LINE, opens the chat, and scrolls the conversation upward so LINE Desktop fetches older messages from its servers and persists them to the local encrypted DB; focus is restored afterward and the cursor never moves. Requires LINE to be running. Reliability depends on LINE's UI/network; returns before/after local coverage (count + oldest stored, newOlderMessages, oldestMovedBack) so you can see what backfilled. After it runs, call read_history again to get the expanded history.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Exact chat name (or chatId) to backfill." },
        maxRounds: {
          type: "integer",
          description: "Max scroll-up rounds before stopping. Default 8. Stops early after 2 rounds with no new older messages.",
          minimum: 1,
        },
        pagesPerRound: {
          type: "integer",
          description: "PageUp presses per round. Default 5.",
          minimum: 1,
        },
      },
      required: ["name"],
      additionalProperties: false,
    },
  },
  {
    name: "send_files",
    description: "Prepare local files for the line-send-files skill native chooser workflow. Pins exact DB chatId/name and rejects groups. auto=false validates names, sizes and hashes without upload. auto=true is refused because file-URL paste failed in this LINE version. The skill uses native UI and verifies outgoing delivered file receipts afterward.",
    inputSchema: {
      type: "object",
      properties: {
        chatId: { type: "string", description: "Exact u-prefixed 1:1 chatId from list_chats." },
        name: { type: "string", description: "Exact cached DB name paired with chatId." },
        uiName: { type: "string", description: "Exact separately verified LINE UI name if different from the cached DB name." },
        paths: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 20 },
        auto: { type: "boolean", description: "Default false = prepare only. True is currently refused; use the skill native picker workflow." },
      },
      required: ["chatId", "name", "paths"],
      additionalProperties: false,
    },
  },
  {
    name: "send_message",
    description:
      "Send a message to a LINE chat (cursor-free; LINE may briefly come forward when opening a chat, then focus is restored). SAFETY: re-selects the named chat, verifies the open chat via OCR anchored-name matching, and cross-checks against the local DB's chat identity + group status. By default refuses groups (anything not a 1:1 contact) and re-verifies before pressing Return. With auto=true sends; auto=false (default) leaves the draft for review.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Exact chat name to send to." },
        text: { type: "string", description: "Message body. Supports @mentions when mentions=true." },
        auto: {
          type: "boolean",
          description: "If true, press Return to actually send. If false (default), leave the draft in the composer unsent.",
        },
        mentions: {
          type: "boolean",
          description: "If true, treat '@name ' tokens as LINE mentions and accept the mention popup. Default false.",
        },
        allowGroup: {
          type: "boolean",
          description: "If true, permit sending to a group/multi-person chat. Default false — groups are refused as a safety measure (only 1:1 chats allowed).",
        },
      },
      required: ["name", "text"],
      additionalProperties: false,
    },
  },
] as const;

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS as any }));

function ok(text: string) {
  return { content: [{ type: "text" as const, text }] };
}
function fail(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true };
}

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;
  try {
    switch (name) {
      case "line_status": {
        const h = await locateLine().catch((e) => ({
          running: false,
          error: e?.message ?? String(e),
        }));
        const perms = await checkPermissions().catch(() => null);
        const db = await dbStatus().catch((e) => ({ error: e?.message ?? String(e) }));
        return ok(
          JSON.stringify(
            {
              line: h,
              accessibility: perms?.accessibility ?? "unknown",
              screen_recording: perms?.screen_recording ?? "unknown",
              database: db,
            },
            null,
            2,
          ),
        );
      }
      case "select_chat": {
        const h = await locateLine();
        await selectChat(h, String((args as any).name));
        return ok(`Opened chat "${(args as any).name}".`);
      }
      case "read_history": {
        const hist = await readChat(String((args as any).name), (args as any).limit ?? 0);
        return ok(formatHistory(hist));
      }
      case "list_chats": {
        const chats = await listChats((args as any).limit ?? 50);
        return ok(JSON.stringify(chats, null, 2));
      }
      case "list_attachments": {
        const res = await listAttachments(String((args as any).name), (args as any).kind, (args as any).limit ?? 50);
        return ok(JSON.stringify(res, null, 2));
      }
      case "get_attachment": {
        const download = (args as any).download;
        if (download !== undefined && typeof download !== "boolean") throw new Error("download must be a boolean.");
        const res = await getAttachment(String((args as any).messageId), download ?? false);
        const content: any[] = [{ type: "text", text: JSON.stringify(res, null, 2) }];
        const shown = [res.file, res.preview].find(
          (f) => f && f.mimeType && /^image\/(jpeg|png|gif|webp)$/.test(f.mimeType) && f.bytes <= 4 * 1024 * 1024,
        );
        if (shown) content.push({ type: "image", data: (await readFile(shown.path)).toString("base64"), mimeType: shown.mimeType });
        return { content };
      }
      case "sync_older_messages": {
        const h = await locateLine();
        const res = await syncOlderMessages(h, String((args as any).name), {
          maxRounds: (args as any).maxRounds,
          pagesPerRound: (args as any).pagesPerRound,
        });
        return ok(JSON.stringify(res, null, 2));
      }
      case "send_files": {
        return ok(JSON.stringify(await sendFiles(args as unknown as SendFilesOptions), null, 2));
      }
      case "send_message": {
        const h = await locateLine();
        const auto = (args as any).auto ?? false;
        await sendMessage(h, {
          name: String((args as any).name),
          text: String((args as any).text),
          auto,
          mentions: (args as any).mentions ?? false,
          allowGroup: (args as any).allowGroup ?? false,
        });
        return ok(
          auto
            ? `Sent message to "${(args as any).name}".`
            : `Draft placed in "${(args as any).name}" composer (unsent — auto=false).`,
        );
      }
      default:
        return fail(`Unknown tool: ${name}`);
    }
  } catch (err: any) {
    return fail(err?.message ?? String(err));
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("line-cua-mcp server running on stdio");
