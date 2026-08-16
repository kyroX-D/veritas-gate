#!/usr/bin/env node

// src/cli.ts
var USAGE = `veritas-gate - your agent doesn't get to say "done" without proof.

Usage:
  veritas init      Detect the project and write .veritas.yml
  veritas verify    Run the configured checks now
  veritas status    Show recent runs from the evidence ledger
  veritas hook      Stop-hook handler (reads hook JSON on stdin)

Options:
  -h, --help        Show this help
  -v, --version     Show the version
`;
var VERSION = "0.1.0";
async function main(argv) {
  const command = argv[0];
  if (command === void 0 || command === "-h" || command === "--help") {
    process.stdout.write(USAGE);
    return 0;
  }
  if (command === "-v" || command === "--version") {
    process.stdout.write(`${VERSION}
`);
    return 0;
  }
  throw new Error(`unknown command: ${command}`);
}
if (process.argv[1] !== void 0 && import.meta.url.endsWith(process.argv[1].replaceAll("\\", "/"))) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      process.stderr.write(`veritas: ${error instanceof Error ? error.message : String(error)}
`);
      process.exitCode = 1;
    }
  );
}
export {
  USAGE,
  VERSION,
  main
};
