# Security & Privacy

`line-cua-mcp` reads your **entire** LINE Desktop chat history (by decrypting a
local snapshot of LINE's database) and can send messages on your behalf. Treat
it accordingly.

## Data handling

- **All processing is local.** The MCP server makes no outbound network calls of
  its own: reads are plain SQLite queries against a temp copy of LINE's local
  database, and sends are local macOS UI automation. It does not phone home.
- **Third-party telemetry is out of our control.** LINE Desktop itself ships a
  crash/telemetry SDK (you may see a `.sentry-native/` directory appear if you
  run the re-signed LINE copy from the key-capture step), and `cua-driver` is a
  separate third-party binary. Those are not part of this project.

## The decryption key

- The 32-hex database key is stored in the **macOS login keychain** under the
  service `line-cua-mcp-dbkey` (or supplied via the `LINE_DB_KEY` env var). It is
  never written to the repo or to a plaintext file by this code.
- **Anyone who obtains this key plus a copy of your `qwb*.edb` can read your full
  LINE history.** Protect the keychain item as you would a password.
- Remove it when you uninstall:
  ```bash
  security delete-generic-password -s line-cua-mcp-dbkey
  ```

## Key-capture caveats

The one-time key capture (see the README) **re-signs a copy of `LINE.app`** with
`com.apple.security.get-task-allow`, which strips the hardened-runtime flag **on
that scratch copy only**, and logging into the copy generally **logs your main
LINE session out** (log back in afterward). Delete the scratch copy when done.
The procedure does not disable SIP and does not modify your real `LINE.app`.

## Reporting a vulnerability

Open a private security advisory on the repository, or contact the maintainer
directly rather than filing a public issue.
