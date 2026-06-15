#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageJsonPath = resolve(repoRoot, "package.json");
const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));

function fail(message) {
  console.error(message);
  process.exit(1);
}

function collectExportTargets(value, targets = []) {
  if (typeof value === "string") {
    targets.push(value);
    return targets;
  }
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) {
      collectExportTargets(child, targets);
    }
  }
  return targets;
}

if (!existsSync(resolve(repoRoot, "build/index.js"))) {
  fail("build/index.js is missing. Run npm run build before npm run pack:check.");
}

const raw = execFileSync("npm", ["pack", "--dry-run", "--json"], {
  cwd: repoRoot,
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
});

const packEntries = JSON.parse(raw);
const files = packEntries[0]?.files?.map((file) => file.path) ?? [];
const fileSet = new Set(files);

const allowedExact = new Set(["README.md", "CHANGELOG.md", "LICENSE", "package.json"]);
const disallowed = files.filter((file) =>
  file.startsWith("build/license/")
  || file === "build/cli/license-commands.js"
  || file === "build/cli/license-commands.d.ts"
  || file.includes(".test."),
);

if (disallowed.length > 0) {
  fail(`npm pack contains disallowed files:\n${disallowed.join("\n")}`);
}

const unexpected = files.filter((file) => !allowedExact.has(file) && !file.startsWith("build/"));
if (unexpected.length > 0) {
  fail(`npm pack contains unexpected top-level files:\n${unexpected.join("\n")}`);
}

const exportTargets = collectExportTargets(packageJson.exports).map((target) =>
  target.replace(/^\.\//, ""),
);
const missingExports = exportTargets.filter((target) => !fileSet.has(target));

if (missingExports.length > 0) {
  fail(`package.json exports point to files missing from npm pack:\n${missingExports.join("\n")}`);
}

process.stdout.write(`Pack check passed: ${files.length} files\n`);
