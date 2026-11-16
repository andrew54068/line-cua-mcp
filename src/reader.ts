// reader.ts — run LINE Reader.app, the only process that opens LINE's own
// folders (see helper/line-reader.c). It is launched through LaunchServices,
// so macOS attributes the access, and any permission prompt, to "LINE Reader"
// with its purpose string, never to this Node process.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const execFileAsync = promisify(execFile);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const READER_APP =
  process.env.LINE_READER_APP ?? join(homedir(), "Applications", "LINE Reader.app");

/** Run one LINE Reader command (`copy` / `list`) into a fresh private folder
 *  (mode 0700). Returns the folder and its result.json; the caller removes the
 *  folder. Throws with LINE Reader's own error message on failure. */
export async function runReader<T = any>(
  args: string[],
  timeoutMs = 180_000,
): Promise<{ dir: string; result: T }> {
  if (!existsSync(READER_APP)) {
    throw new Error(
      `LINE Reader.app is not installed at ${READER_APP}. Run scripts/install-helper.sh on the Mac that runs LINE.`,
    );
  }
  const dir = await mkdtemp(join(tmpdir(), "line-reader-"));
  // Test builds of the helper read these; the installed helper ignores its environment.
  const env = Object.entries(process.env)
    .filter(([k]) => k.startsWith("LINE_READER_TEST_"))
    .flatMap(([k, v]) => ["--env", `${k}=${v}`]);
  await execFileAsync(
    "/usr/bin/open",
    ["-W", "-n", "-g", "-j", ...env, "-a", READER_APP, "--args", ...args, "--out", dir],
    { timeout: timeoutMs },
  ).catch(() => {});
  // `open -W` returns early when the helper exits first, so wait for its result.
  const resultPath = join(dir, "result.json");
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(resultPath)) {
    if (Date.now() > deadline) {
      await rm(dir, { recursive: true, force: true });
      throw new Error(
        "LINE Reader did not finish. Check the Mac that runs LINE for an unanswered LINE Reader permission prompt.",
      );
    }
    await sleep(50);
  }
  const result = JSON.parse(await readFile(resultPath, "utf8"));
  if (!result.ok) {
    await rm(dir, { recursive: true, force: true });
    throw new Error(`LINE Reader: ${result.error}`);
  }
  return { dir, result };
}
