// Lightweight Field Lab DSL structure scanner.
//
// This is intentionally tolerant: it does not replace parse-v2's compiler
// parser. Editor features need structure while the user is mid-edit, when the
// compiler parser may reject the document. The scanner ignores comments and
// strings, records braced blocks, and extracts declaration names from line
// starts.

const BLOCK_KEYWORDS = new Set([
  "views", "stamps", "scenarios",
  "palette", "view", "stamp", "scenario",
  "step", "stage", "cell", "when",
]);

const NAME_DECL_KEYWORDS = new Set([
  "field", "source", "param", "const",
  "stage", "scenario", "stamp", "metric", "palette", "view",
]);

export function parseDslAst(source) {
  source = String(source ?? "");
  const sanitized = sanitizeDsl(source);
  const blocks = scanBlocks(source, sanitized);
  const names = scanNames(source);
  return { source, blocks, names };
}

export function blockStackAt(ast, pos) {
  const blocks = ast?.blocks ?? [];
  return blocks
    .filter((block) => block.openBrace < pos && block.closeBrace >= pos)
    .sort((a, b) => a.openBrace - b.openBrace);
}

export function innermostBlockAt(ast, pos) {
  const stack = blockStackAt(ast, pos);
  return stack[stack.length - 1] ?? null;
}

export function foldRangeForLine(ast, lineStart, lineEnd) {
  const candidates = (ast?.blocks ?? [])
    .filter((block) => block.openBrace >= lineStart && block.openBrace < lineEnd && block.closeBrace > block.openBrace)
    .sort((a, b) => a.openBrace - b.openBrace);
  const block = candidates[0];
  if (!block) return null;
  return { from: block.openBrace + 1, to: block.closeBrace };
}

export function defaultFoldRanges(ast, sectionNames = ["views", "stamps", "scenarios"]) {
  const wanted = new Set(sectionNames);
  return (ast?.blocks ?? [])
    .filter((block) => wanted.has(block.keyword) && block.closeBrace > block.openBrace)
    .map((block) => ({ from: block.openBrace + 1, to: block.closeBrace }));
}

export function blockDepthAt(ast, pos) {
  return blockStackAt(ast, pos).length;
}

export function lineIndentDepth(ast, source, lineStart) {
  source = String(source ?? "");
  let depth = blockDepthAt(ast, lineStart);
  const rest = source.slice(lineStart);
  const first = /^[ \t]*(.)/.exec(rest)?.[1] ?? "";
  if (first === "}") depth--;
  return Math.max(0, depth);
}

function sanitizeDsl(source) {
  let out = "";
  let quote = null;
  let lineComment = false;
  let blockComment = false;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    const next = source[i + 1];

    if (lineComment) {
      if (ch === "\n") {
        lineComment = false;
        out += "\n";
      } else {
        out += " ";
      }
      continue;
    }
    if (blockComment) {
      if (ch === "*" && next === "/") {
        blockComment = false;
        out += "  ";
        i++;
      } else {
        out += ch === "\n" ? "\n" : " ";
      }
      continue;
    }
    if (quote) {
      if (ch === "\\") {
        out += " ";
        if (i + 1 < source.length) {
          out += source[i + 1] === "\n" ? "\n" : " ";
          i++;
        }
      } else if (ch === quote) {
        quote = null;
        out += " ";
      } else {
        out += ch === "\n" ? "\n" : " ";
      }
      continue;
    }

    if (ch === "/" && next === "/") {
      lineComment = true;
      out += "  ";
      i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      blockComment = true;
      out += "  ";
      i++;
      continue;
    }
    if (ch === "\"" || ch === "'") {
      quote = ch;
      out += " ";
      continue;
    }
    out += ch;
  }
  return out;
}

function scanBlocks(source, sanitized) {
  const blocks = [];
  const stack = [];
  for (let i = 0; i < sanitized.length; i++) {
    const ch = sanitized[i];
    if (ch === "{") {
      const header = readBlockHeader(sanitized, i);
      const parent = stack[stack.length - 1] ?? null;
      const block = {
        type: "Block",
        keyword: header.keyword,
        id: header.id,
        from: header.from,
        to: source.length,
        openBrace: i,
        closeBrace: source.length,
        bodyFrom: i + 1,
        bodyTo: source.length,
        parent,
        children: [],
      };
      if (parent) parent.children.push(block);
      if (BLOCK_KEYWORDS.has(block.keyword)) blocks.push(block);
      stack.push(block);
      continue;
    }
    if (ch === "}") {
      const block = stack.pop();
      if (block) {
        block.closeBrace = i;
        block.bodyTo = i;
        block.to = i + 1;
      }
    }
  }
  return blocks;
}

function readBlockHeader(sanitized, openBrace) {
  const lineStart = sanitized.lastIndexOf("\n", openBrace - 1) + 1;
  const header = sanitized.slice(lineStart, openBrace);
  const matches = [...header.matchAll(/\b[A-Za-z_][A-Za-z0-9_]*\b/g)];
  let keyword = "?";
  let id = null;
  let from = lineStart;
  for (let i = matches.length - 1; i >= 0; i--) {
    const word = matches[i][0];
    if (BLOCK_KEYWORDS.has(word)) {
      keyword = word;
      from = lineStart + matches[i].index;
      const next = matches[i + 1]?.[0] ?? null;
      id = next && !BLOCK_KEYWORDS.has(next) ? next : null;
      break;
    }
  }
  return { keyword, id, from };
}

function scanNames(source) {
  const names = {
    fields: [],
    sources: [],
    parameters: [],
    constants: [],
    planet: [],
    stages: [],
    scenarios: [],
    stamps: [],
    metrics: [],
    palettes: [],
    views: [],
    immutables: [],
  };
  const lines = source.split("\n");
  for (const rawLine of lines) {
    const line = rawLine.replace(/\/\/.*$/, "");
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s+([A-Za-z_][A-Za-z0-9_]*)\b/.exec(line);
    if (!match) continue;
    const [, kw, name] = match;
    if (!NAME_DECL_KEYWORDS.has(kw)) continue;
    if (kw === "field") names.fields.push(name);
    else if (kw === "source") names.sources.push(name);
    else if (kw === "param") names.parameters.push(name);
    else if (kw === "const") names.constants.push(name);
    else if (kw === "stage") names.stages.push(name);
    else if (kw === "scenario") names.scenarios.push(name);
    else if (kw === "stamp") names.stamps.push(name);
    else if (kw === "metric") names.metrics.push(name);
    else if (kw === "palette") names.palettes.push(name);
    else if (kw === "view") names.views.push(name);
  }
  names.immutables = unique([...names.parameters, ...names.constants, ...names.planet]);
  for (const key of Object.keys(names)) names[key] = unique(names[key]);
  return names;
}

function unique(values) {
  return [...new Set(values.map((v) => String(v ?? "").trim()).filter(Boolean))];
}
