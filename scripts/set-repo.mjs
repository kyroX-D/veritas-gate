// Replaces the YOUR-USERNAME placeholder everywhere it appears.
//
//   node scripts/set-repo.mjs <github-username> [--dry-run]
//
// Badges, the clone URL, the plugin manifest and the issue templates all carry
// the placeholder. Missing one leaves a broken badge on the page people judge
// the project by, so this does all of them or none.

import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const PLACEHOLDER = "YOUR-USERNAME";
const SKIP_DIRECTORIES = new Set([".git", "node_modules", "dist", ".veritas"]);

const self = fileURLToPath(import.meta.url);
const root = join(dirname(self), "..");
const [username, ...flags] = process.argv.slice(2);
const dryRun = flags.includes("--dry-run");

if (username === undefined || username.startsWith("-")) {
  process.stderr.write("usage: node scripts/set-repo.mjs <github-username> [--dry-run]\n");
  process.exit(1);
}

if (!/^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/.test(username)) {
  process.stderr.write(`"${username}" is not a valid GitHub username.\n`);
  process.exit(1);
}

function* walk(directory) {
  for (const entry of readdirSync(directory)) {
    if (SKIP_DIRECTORIES.has(entry)) continue;

    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      yield* walk(path);
    } else {
      yield path;
    }
  }
}

let changedFiles = 0;
let changedOccurrences = 0;

for (const path of walk(root)) {
  // This file documents the placeholder in its own usage text. Rewriting it
  // would destroy the instructions for anyone who runs it next.
  if (path === self) continue;

  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    continue;
  }

  if (!text.includes(PLACEHOLDER)) continue;

  const count = text.split(PLACEHOLDER).length - 1;
  changedFiles += 1;
  changedOccurrences += count;

  process.stdout.write(`${dryRun ? "would update" : "updated"} ${relative(root, path)} (${count})\n`);

  if (!dryRun) {
    writeFileSync(path, text.split(PLACEHOLDER).join(username));
  }
}

if (changedFiles === 0) {
  process.stdout.write("No placeholder left to replace.\n");
  process.exit(0);
}

process.stdout.write(`\n${changedOccurrences} occurrence(s) in ${changedFiles} file(s)\n`);

if (!dryRun) {
  process.stdout.write("\nNow run: npm run build\n");
  process.stdout.write("The committed bundle carries the usage text, so it has to be rebuilt.\n");
}
