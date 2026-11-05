import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// The VS Code launcher can resolve relative paths from a different directory.
const extensionPath = fileURLToPath(new URL("../", import.meta.url));
const result = spawnSync(
  "code",
  ["--new-window", `--extensionDevelopmentPath=${extensionPath}`],
  { stdio: "inherit" }
);

if (result.error) {
  throw new Error("Could not launch VS Code. Check that the code command is available.", {
    cause: result.error,
  });
}

process.exitCode = result.status ?? 1;
