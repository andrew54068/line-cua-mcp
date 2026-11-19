# Contributing

Thanks for your interest. This is a small, macOS-only tool; contributions that
keep it focused are welcome.

## Setup

```bash
yarn install
yarn build            # tsc -> dist/, compiles ocr.swift to dist/ocr, copies linedb.py
yarn test             # synthetic unit tests, no LINE data or UI (requires a prior `yarn build`)
```

See the README for the full runtime prerequisites (Python venv with
`apsw-sqlite3mc`, the captured DB key in the keychain, and `cua-driver`).

## Layout

- `src/server.ts` — MCP stdio server, tool definitions and dispatch.
- `src/linedb.py` / `src/linedb.ts` — background DB read path (decrypt + query).
- `src/line.ts` — UI orchestration for `select_chat` / `send_message`.
- `src/driver.ts` — long-lived `cua-driver` MCP client wrapper.
- `src/ocr.ts` / `src/ocr.swift` — native Vision OCR, used **only** for send-path
  header verification.
- `test/matcher.test.mjs` — pure tests for the send-safety name matcher.

## Conventions

- `dist/` is **generated** (`yarn build`); never edit it by hand and never commit
  it — it is gitignored.
- Don't commit personal data: use clearly-fictional names in tests, comments, and
  docs (e.g. `明`, `小明子`, `Alice`).
- The send path is the only mutating operation; preserve its safety guards and
  add tests for any change to the matcher (`namesMatch` / `hasMemberCountBadge`).
