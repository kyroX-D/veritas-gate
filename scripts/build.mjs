// Bundles the CLI into a single dependency-free ESM file that is committed to
// the repository, so the plugin runs without an install step.
import { build } from "esbuild";
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

// The bundle is deliberately NOT chmod +x here.
//
// git tracks the executable bit, so chmodding on POSIX turned the committed
// 100644 into 100755 and made `git diff --exit-code -- dist/` report a change
// every time. That is the check guarding the bundle against going stale, and it
// failed on Linux and macOS while passing on Windows, where chmod is a no-op.
//
// Nothing needs the bit: the plugin hook runs `node <path>`, and `npm install`
// sets permissions on bin entries itself.

console.log(`built ${outfile}`);
