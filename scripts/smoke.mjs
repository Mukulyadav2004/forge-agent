import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { once } from "node:events";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const extensionPath = fileURLToPath(new URL("../", import.meta.url));
const testPath = fileURLToPath(new URL("../out-test/smoke.js", import.meta.url));
const resultPath = fileURLToPath(new URL("../out-test/smoke-result.json", import.meta.url));
const errorPath = fileURLToPath(new URL("../out-test/smoke-error.txt", import.meta.url));
const profilePath = mkdtempSync(join(tmpdir(), "forge-agent-smoke-"));
const workspacePath = join(profilePath, "workspace");
mkdirSync(workspacePath);
writeFileSync(join(workspacePath, "example.txt"), "original text\n");
mkdirSync(join(workspacePath, 'src'));
writeFileSync(join(workspacePath, 'main.py'), 'from src.service import Service\n\nservice = Service()\n');
writeFileSync(join(workspacePath, 'src', 'service.py'), 'from .store import Store\n\nclass Service:\n    def run(self):\n        return Store().read()\n');
writeFileSync(join(workspacePath, 'src', 'store.py'), 'class Store:\n    def read(self):\n        return []\n');
let passed = false;
const portServer = createServer();
portServer.listen({ host: "127.0.0.1", port: 0 });
await once(portServer, "listening");
const address = portServer.address();
if (address === null || typeof address === "string") {
  throw new Error("Could not reserve a port for the sidebar smoke check.");
}
const debugPort = address.port;
await new Promise((resolve, reject) => {
  portServer.close((error) => (error ? reject(error) : resolve()));
});

try {
  const mcpResultPath = join(extensionPath, "out-test", "mcp-result.json");
  const liveResultPath = join(extensionPath, "out-test", "live-editor-result.json");
  rmSync(liveResultPath, { force: true });
  rmSync(mcpResultPath, { force: true });
  rmSync(resultPath, { force: true });
  rmSync(errorPath, { force: true });
  const result = spawnSync(
    "code",
    [
      "--new-window",
      workspacePath,
      "--disable-workspace-trust",
      "--wait",
      "--disable-extensions",
      "--skip-welcome",
      "--skip-release-notes",
      `--extensionDevelopmentPath=${extensionPath}`,
      `--extensionTestsPath=${testPath}`,
      `--user-data-dir=${profilePath}`,
      `--remote-debugging-port=${debugPort}`,
    ],
    {
      stdio: "inherit",
      timeout: 60_000,
      env: { ...process.env, FORGE_SMOKE_CDP_PORT: String(debugPort), FORGE_SMOKE_LIVE_REGISTRY: process.argv.includes("--live-server") ? "true" : "false" },
    }
  );

  if (result.error) {
    throw new Error("Could not complete the VS Code smoke check.", { cause: result.error });
  }

  if (result.status !== 0) {
    throw new Error(`VS Code smoke check exited with status ${result.status}.`);
  }

  if (existsSync(errorPath)) {
    throw new Error(`Sidebar smoke check failed:\n${readFileSync(errorPath, "utf8")}`);
  }
  if (!existsSync(resultPath)) {
    throw new Error("VS Code closed before the sidebar smoke check produced a result.");
  }
  const report = JSON.parse(readFileSync(resultPath, "utf8"));
  if (
    report.command_registered !== true ||
    report.command_executed !== true ||
    report.message_roundtrip !== true ||
    report.draft_restored !== true ||
    report.literal_rendering !== true ||
    report.empty_message_blocked !== true
  ) {
    throw new Error("The VS Code smoke check did not confirm the complete sidebar flow.");
  }

  if (!existsSync(mcpResultPath)) throw new Error("MCP smoke checks did not complete.");
  if (process.argv.includes("--live-server") && !existsSync(liveResultPath)) throw new Error("Live TrueForge editor discovery did not complete.");
  console.log(`Smoke check passed: ${report.extension_id} opens the sidebar, exchanges messages, and restores drafts.`);
  passed = true;
} finally {
  if (passed) {
    rmSync(profilePath, { recursive: true, force: true });
  } else {
    console.error(`Smoke check logs retained at ${profilePath}`);
  }
}
