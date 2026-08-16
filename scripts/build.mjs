// Bundles the CLI into a single dependency-free ESM file that is committed to
// the repository, so the plugin runs without an install step.
import { build } from "esbuild";
import { chmod } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outfile = join(root, "dist", "veritas.mjs");

await build({
  entryPoints: [join(root, "src", "cli.ts")],
  outfile,
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  minify: false,
  sourcemap: false,
  legalComments: "none",
  banner: { js: "#!/usr/bin/env node" },
});

// Ignored on Windows; matters when the repo is cloned on macOS/Linux.
await chmod(outfile, 0o755).catch(() => {});

console.log(`built ${outfile}`);
