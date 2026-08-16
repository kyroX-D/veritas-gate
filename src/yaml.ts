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

/**
 * Removes a trailing `# comment`, respecting quoted strings.
 *
 * A quote character only opens a string when it starts a scalar, meaning at the
 * beginning of the line or after whitespace. Treating every apostrophe as a
 * delimiter made `run: echo it's fine  # note` swallow the comment into the
 * command.
 */
function stripComment(raw: string): string {
  let inSingle = false;
  let inDouble = false;

  const startsScalar = (index: number): boolean => index === 0 || /\s/.test(raw[index - 1] ?? "");

  for (let i = 0; i < raw.length; i += 1) {
    const char = raw[i];

    if (char === "'" && !inDouble && (inSingle || startsScalar(i))) {
      inSingle = !inSingle;
    } else if (char === '"' && !inSingle && (inDouble || startsScalar(i))) {
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
  const withoutBom = source.charCodeAt(0) === 0xfeff ? source.slice(1) : source;

  withoutBom.split(/\r?\n/).forEach((raw, index) => {
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

/**
 * Unescapes a double-quoted YAML scalar body.
 *
 * Without this, a command such as `node -e "x"` written by `veritas init` as
 * `run: "node -e \"x\""` parses back with literal backslashes and then runs as
 * a different command than the one configured.
 */
function unescapeDoubleQuoted(body: string, line: number): string {
  let result = "";

  for (let i = 0; i < body.length; i += 1) {
    const char = body[i] as string;

    if (char !== "\\") {
      result += char;
      continue;
    }

    const next = body[i + 1];
    i += 1;

    switch (next) {
      case '"':
        result += '"';
        break;
      case "\\":
        result += "\\";
        break;
      case "/":
        result += "/";
        break;
      case "n":
        result += "\n";
        break;
      case "r":
        result += "\r";
        break;
      case "t":
        result += "\t";
        break;
      case "0":
        result += "\0";
        break;
      case "u": {
        const hex = body.slice(i + 1, i + 5);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
          throw new YamlError("invalid \\u escape in a double-quoted string", line);
        }
        result += String.fromCharCode(Number.parseInt(hex, 16));
        i += 4;
        break;
      }
      case undefined:
        throw new YamlError("a double-quoted string ends with a dangling backslash", line);
      default:
        throw new YamlError(`unsupported escape \\${next} in a double-quoted string`, line);
    }
  }

  return result;
}

/** Finds the index of the closing quote, honouring escapes. */
function closingQuote(text: string, quote: '"' | "'"): number {
  for (let i = 1; i < text.length; i += 1) {
    if (quote === '"' && text[i] === "\\") {
      i += 1;
      continue;
    }

    if (text[i] === quote) {
      // In single-quoted YAML, '' is an escaped quote rather than the end.
      if (quote === "'" && text[i + 1] === "'") {
        i += 1;
        continue;
      }
      return i;
    }
  }

  return -1;
}

function parseScalar(raw: string, line: number): YamlValue {
  const text = raw.trim();

  if (text === "") {
    return null;
  }

  if (text.startsWith('"') || text.startsWith("'")) {
    const quote = text[0] as '"' | "'";
    const end = closingQuote(text, quote);

    if (end === -1) {
      throw new YamlError("unterminated quoted string", line);
    }

    if (text.slice(end + 1).trim() !== "") {
      throw new YamlError("unexpected content after a quoted string", line);
    }

    const body = text.slice(1, end);
    return quote === '"' ? unescapeDoubleQuoted(body, line) : body.replaceAll("''", "'");
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
