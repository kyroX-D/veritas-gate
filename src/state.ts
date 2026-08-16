// Escalation counters and the change cache.
//
// State lives in .veritas/state.json. It is a cache, not a source of truth:
// every read tolerates a missing, empty or corrupt file by returning fresh
// state, and every write failure is swallowed. Losing state costs one extra
// check run, which is always preferable to breaking a session.

import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { createHash } from "node:crypto";

import { ensureVeritasDir, veritasDir } from "./ledger.ts";

export const STATE_FILENAME = "state.json";

export interface SessionState {
  /** Consecutive Stop-hook blocks in this session. */
  readonly blocks: number;
  /** ISO timestamp of the last update, used to prune stale sessions. */
  readonly updated: string;
}

export interface State {
  readonly version: 1;
  readonly sessions: Record<string, SessionState>;
  /** Fingerprint of the watched files at the last fully green run. */
  readonly lastGreenFingerprint: string | null;
  readonly lastGreenAt: string | null;
}

export const EMPTY_STATE: State = {
  version: 1,
  sessions: {},
  lastGreenFingerprint: null,
  lastGreenAt: null,
};

/** Sessions older than this are dropped so state.json cannot grow forever. */
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function statePath(root: string): string {
  return join(veritasDir(root), STATE_FILENAME);
}

export function readState(root: string): State {
  let raw: string;
  try {
    raw = readFileSync(statePath(root), "utf8");
  } catch {
    return EMPTY_STATE;
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return EMPTY_STATE;

    const candidate = parsed as Partial<State>;
    const sessions =
      typeof candidate.sessions === "object" && candidate.sessions !== null ? candidate.sessions : {};

    return {
      version: 1,
      sessions,
      lastGreenFingerprint:
        typeof candidate.lastGreenFingerprint === "string" ? candidate.lastGreenFingerprint : null,
      lastGreenAt: typeof candidate.lastGreenAt === "string" ? candidate.lastGreenAt : null,
    };
  } catch {
    return EMPTY_STATE;
  }
}

/** Persists state. Returns false on failure; callers must not treat that as fatal. */
export function writeState(root: string, state: State): boolean {
  const cutoff = Date.now() - SESSION_TTL_MS;
  const sessions: Record<string, SessionState> = {};

  for (const [id, session] of Object.entries(state.sessions)) {
    const updatedAt = Date.parse(session.updated);
    if (Number.isNaN(updatedAt) || updatedAt >= cutoff) {
      sessions[id] = session;
    }
  }

  try {
    ensureVeritasDir(root);
    writeFileSync(statePath(root), `${JSON.stringify({ ...state, sessions }, null, 2)}\n`, "utf8");
    return true;
  } catch {
    return false;
  }
}

export function blocksFor(state: State, sessionId: string): number {
  return state.sessions[sessionId]?.blocks ?? 0;
}

export function withBlock(state: State, sessionId: string): State {
  return {
    ...state,
    sessions: {
      ...state.sessions,
      [sessionId]: { blocks: blocksFor(state, sessionId) + 1, updated: new Date().toISOString() },
    },
  };
}

/**
 * Keeps the block count but refreshes the timestamp.
 *
 * Used after veritas gives up: resetting the counter there would make it start
 * blocking again on the very next turn, producing an endless
 * block-block-block-allow cycle. Once veritas has given up, it stays given up
 * until the checks actually pass.
 */
export function withTouch(state: State, sessionId: string): State {
  return {
    ...state,
    sessions: {
      ...state.sessions,
      [sessionId]: { blocks: blocksFor(state, sessionId), updated: new Date().toISOString() },
    },
  };
}

export function withReset(state: State, sessionId: string, fingerprint: string | null): State {
  return {
    ...state,
    sessions: {
      ...state.sessions,
      [sessionId]: { blocks: 0, updated: new Date().toISOString() },
    },
    lastGreenFingerprint: fingerprint,
    lastGreenAt: fingerprint === null ? state.lastGreenAt : new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Glob matching
// ---------------------------------------------------------------------------

/**
 * Compiles a glob to a regex.
 *
 * Supported: `**` (any number of segments), `*` (within one segment), `?`.
 * Paths are compared with forward slashes regardless of platform.
 */
export function globToRegExp(pattern: string): RegExp {
  let source = "";
  let index = 0;

  while (index < pattern.length) {
    const char = pattern[index] as string;

    if (char === "*") {
      const isDouble = pattern[index + 1] === "*";

      if (isDouble) {
        if (pattern[index + 2] === "/") {
          // `**/` matches zero or more leading segments.
          source += "(?:[^/]*/)*";
          index += 3;
          continue;
        }
        source += ".*";
        index += 2;
        continue;
      }

      source += "[^/]*";
      index += 1;
      continue;
    }

    if (char === "?") {
      source += "[^/]";
      index += 1;
      continue;
    }

    source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    index += 1;
  }

  return new RegExp(`^${source}$`);
}

export function matchesAny(relativePath: string, patterns: readonly string[]): boolean {
  const normalized = relativePath.split(sep).join("/");
  return patterns.some((pattern) => globToRegExp(pattern).test(normalized));
}

// ---------------------------------------------------------------------------
// Change fingerprint
// ---------------------------------------------------------------------------

/** Directories never worth hashing. */
const IGNORED_DIRECTORIES = new Set([
  ".git",
  ".veritas",
  "node_modules",
  "dist",
  "build",
  "out",
  "coverage",
  "target",
  "vendor",
  ".venv",
  "venv",
  "__pycache__",
  ".mypy_cache",
  ".pytest_cache",
  ".ruff_cache",
  ".next",
  ".nuxt",
  ".cache",
  ".idea",
  ".vscode",
]);

/** Bounds the cost of fingerprinting. Beyond this, veritas stops guessing. */
const MAX_SCANNED_FILES = 20_000;

/**
 * Hashes the size and mtime of every file matching `patterns`.
 *
 * Returns null when the answer cannot be trusted — no patterns configured, or
 * the project is too large to scan. Null means "always run the checks", which
 * is the safe direction: the cache may only ever skip work it is certain about.
 */
export function fingerprint(root: string, patterns: readonly string[]): string | null {
  if (patterns.length === 0) return null;

  const hash = createHash("sha256");
  let scanned = 0;
  let matched = 0;
  let overflowed = false;

  const walk = (directory: string): void => {
    if (overflowed) return;

    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      if (overflowed) return;

      const full = join(directory, entry.name);

      if (entry.isDirectory()) {
        if (IGNORED_DIRECTORIES.has(entry.name)) continue;
        walk(full);
        continue;
      }

      if (!entry.isFile()) continue;

      scanned += 1;
      if (scanned > MAX_SCANNED_FILES) {
        overflowed = true;
        return;
      }

      const relativePath = relative(root, full);
      if (!matchesAny(relativePath, patterns)) continue;

      try {
        const stats = statSync(full);
        hash.update(`${relativePath.split(sep).join("/")}\0${stats.size}\0${Math.floor(stats.mtimeMs)}\n`);
        matched += 1;
      } catch {
        // File vanished mid-walk; ignore it.
      }
    }
  };

  walk(root);

  if (overflowed) return null;
  if (matched === 0) return null;

  return hash.digest("hex");
}
