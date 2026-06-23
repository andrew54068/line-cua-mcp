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
} from "./line.js";
import { checkPermissions } from "./driver.js";
import { dbStatus, listChats, readChat, formatHistory } from "./linedb.js";

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
      "Read a chat's message history from LINE's local encrypted database — FULLY in the background: no cursor, no window focus change, no OCR, no scrolling. Returns the COMPLETE history (every message, not just the visible viewport), with sender direction and timestamps. Decrypts a read-only snapshot of LINE's wxSQLite3 DB using the account key in the macOS keychain. Identify the chat by name (1:1, group, or community); pass limit to cap to the most recent N messages.",
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
