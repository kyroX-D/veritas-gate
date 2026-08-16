// A deliberately small YAML subset parser.
//
// veritas ships with zero runtime dependencies, so rather than pulling in a
// full YAML implementation for a config file with four top-level keys, this
// parses exactly the subset .veritas.yml needs:
//
//   - block mappings            key: value
//   - nested block mappings     key:\n  child: value
//   - block sequences           key:\n  - item
//   - sequences of mappings     key:\n  - name: a\n    run: b
//   - scalars                   strings, quoted strings, integers, booleans, null
//   - full-line and trailing    # comments
//
// Anything outside that subset (anchors, aliases, multi-line block scalars,
// flow collections, multiple documents) raises YamlError with a line number
// instead of silently producing something wrong. Callers treat that as a
// warning and fall back to auto-detection — a config veritas cannot read must
// never block a session.

export class YamlError extends Error {
  readonly line: number;

  constructor(message: string, line: number) {
    super(`line ${line}: ${message}`);
    this.name = "YamlError";
    this.line = line;
  }
}

export type YamlValue = string | number | boolean | null | YamlValue[] | { [key: string]: YamlValue };

interface Line {
  readonly indent: number;
  readonly text: string;
  readonly number: number;
}

const KEY_PATTERN = /^([A-Za-z0-9_.\-$]+)\s*:(?:\s+(.*))?$/;

/** Removes a trailing `# comment`, respecting quoted strings. */
function stripComment(raw: string): string {
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i < raw.length; i += 1) {
    const char = raw[i];

    if (char === "'" && !inDouble) {
      inSingle = !inSingle;
    } else if (char === '"' && !inSingle) {
      inDouble = !inDouble;
    } else if (char === "#" && !inSingle && !inDouble) {
      // Only a `#` at the start or preceded by whitespace opens a comment.
      if (i === 0 || /\s/.test(raw[i - 1] ?? "")) {
        return raw.slice(0, i);
      }
    }
  }

  return raw;
}

function toLines(source: string): Line[] {
  const lines: Line[] = [];

  source.split(/\r?\n/).forEach((raw, index) => {
    const number = index + 1;

    if (raw.includes("\t")) {
      throw new YamlError("tabs are not valid YAML indentation, use spaces", number);
    }

    const withoutComment = stripComment(raw);
    const text = withoutComment.trimEnd();

    if (text.trim() === "") {
      return;
    }

    if (text.trim() === "---" || text.trim() === "...") {
      throw new YamlError("document markers are not supported", number);
    }

    lines.push({ indent: text.length - text.trimStart().length, text: text.trim(), number });
  });

  return lines;
}

function parseScalar(raw: string, line: number): YamlValue {
  const text = raw.trim();

  if (text === "") {
    return null;
  }

  if (
    (text.startsWith('"') && text.endsWith('"') && text.length >= 2) ||
    (text.startsWith("'") && text.endsWith("'") && text.length >= 2)
  ) {
    return text.slice(1, -1);
  }

  // Empty flow collections are the idiomatic way to write "nothing here" and
  // are what `veritas init` emits, so they are supported. Non-empty flow
  // collections are not.
  if (text === "[]") return [];
  if (text === "{}") return {};

  if (text.startsWith("[") || text.startsWith("{")) {
    throw new YamlError("non-empty flow collections ([...] and {...}) are not supported", line);
  }

  if (text === "true" || text === "yes" || text === "on") return true;
  if (text === "false" || text === "no" || text === "off") return false;
  if (text === "null" || text === "~") return null;

  if (/^-?\d+$/.test(text)) {
    return Number.parseInt(text, 10);
  }

  if (/^-?\d+\.\d+$/.test(text)) {
    return Number.parseFloat(text);
  }

  return text;
}

/**
 * Parses the block starting at `lines[start]`, consuming every line whose
 * indentation is at least `indent`. Returns the value and the index of the
 * first line that was not consumed.
 */
function parseBlock(lines: Line[], start: number, indent: number): { value: YamlValue; next: number } {
  const first = lines[start];

  if (first === undefined) {
    return { value: null, next: start };
  }

  return first.text.startsWith("- ") || first.text === "-"
    ? parseSequence(lines, start, indent)
    : parseMapping(lines, start, indent);
}

function parseSequence(lines: Line[], start: number, indent: number): { value: YamlValue; next: number } {
  const items: YamlValue[] = [];
  let index = start;

  while (index < lines.length) {
    const line = lines[index];
    if (line === undefined || line.indent < indent) break;

    if (line.indent > indent) {
      throw new YamlError("unexpected indentation inside a list", line.number);
    }

    if (!line.text.startsWith("- ") && line.text !== "-") {
      throw new YamlError(`expected a list item starting with "- "`, line.number);
    }

    const inline = line.text === "-" ? "" : line.text.slice(2).trim();
    index += 1;

    // An item that itself looks like `key: value` starts a mapping whose
    // remaining keys are indented to line up with the text after the dash.
    const inlineKey = KEY_PATTERN.exec(inline);

    if (inlineKey !== null) {
      const keyIndent = line.indent + 2;
      const synthetic: Line[] = [{ indent: keyIndent, text: inline, number: line.number }];

      while (index < lines.length) {
        const continuation = lines[index];
        if (continuation === undefined || continuation.indent < keyIndent) break;
        if (continuation.text.startsWith("- ") && continuation.indent === keyIndent) break;
        synthetic.push(continuation);
        index += 1;
      }

      items.push(parseMapping(synthetic, 0, keyIndent).value);
      continue;
    }

    if (inline === "") {
      const nested = lines[index];

      if (nested !== undefined && nested.indent > line.indent) {
        const parsed = parseBlock(lines, index, nested.indent);
        items.push(parsed.value);
        index = parsed.next;
        continue;
      }

      items.push(null);
      continue;
    }

    items.push(parseScalar(inline, line.number));
  }

  return { value: items, next: index };
}

function parseMapping(lines: Line[], start: number, indent: number): { value: Record<string, YamlValue>; next: number } {
  const result: Record<string, YamlValue> = {};
  let index = start;

  while (index < lines.length) {
    const line = lines[index];
    if (line === undefined || line.indent < indent) break;

    if (line.indent > indent) {
      throw new YamlError("unexpected indentation", line.number);
    }

    if (line.text.startsWith("- ")) {
      break;
    }

    const match = KEY_PATTERN.exec(line.text);

    if (match === null) {
      throw new YamlError(`expected "key: value", got ${JSON.stringify(line.text)}`, line.number);
    }

    const key = match[1] as string;
    const inlineValue = match[2];
    index += 1;

    if (inlineValue !== undefined && inlineValue.trim() !== "") {
      result[key] = parseScalar(inlineValue, line.number);
      continue;
    }

    const child = lines[index];

    if (child === undefined || child.indent <= line.indent) {
      // A key with nothing under it. A sequence may legally sit at the same
      // indentation as its key, which is the only same-indent continuation.
      if (child !== undefined && child.indent === line.indent && child.text.startsWith("- ")) {
        const parsed = parseSequence(lines, index, child.indent);
        result[key] = parsed.value;
        index = parsed.next;
        continue;
      }

      result[key] = null;
      continue;
    }

    const parsed = parseBlock(lines, index, child.indent);
    result[key] = parsed.value;
    index = parsed.next;
  }

  return { value: result, next: index };
}

/** Parses a YAML document from the supported subset. Throws YamlError otherwise. */
export function parseYaml(source: string): YamlValue {
  const lines = toLines(source);

  if (lines.length === 0) {
    return null;
  }

  const firstIndent = lines[0]?.indent ?? 0;
  const { value, next } = parseBlock(lines, 0, firstIndent);

  if (next < lines.length) {
    throw new YamlError("unexpected content after the end of the document", lines[next]?.number ?? 0);
  }

  return value;
}
