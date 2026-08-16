// Entry point. Subcommands are wired up in later phases; anything not yet
// implemented fails loudly rather than pretending to succeed.

export const USAGE = `veritas-gate - your agent doesn't get to say "done" without proof.

Usage:
  veritas init      Detect the project and write .veritas.yml
  veritas verify    Run the configured checks now
  veritas status    Show recent runs from the evidence ledger
  veritas hook      Stop-hook handler (reads hook JSON on stdin)

Options:
  -h, --help        Show this help
  -v, --version     Show the version
`;

export const VERSION = "0.1.0";

export async function main(argv: readonly string[]): Promise<number> {
  const command = argv[0];

  if (command === undefined || command === "-h" || command === "--help") {
    process.stdout.write(USAGE);
    return 0;
  }

  if (command === "-v" || command === "--version") {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }

  throw new Error(`unknown command: ${command}`);
}

// Only run when executed directly, so tests can import main() without side effects.
if (process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].replaceAll("\\", "/"))) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      process.stderr.write(`veritas: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    },
  );
}
