// Field Lab DSL parser.

import { parseExpr, tokenizeExpr } from "./expr-parser.mjs";

export function parseTopLevelDeclarations(source) {
  const recipe = {};
  const planet = {};
  const constants = [];
  let grid = null;
  const imports = [];
  const fields = [];
  const sources = [];
  const settings = [];
  const parameters = [];
  let i = 0;
  while (i < source.length) {
    const lineStart = i;
    const lineEnd = source.indexOf("\n", i);
    const end = lineEnd === -1 ? source.length : lineEnd;
    const rawLine = source.slice(lineStart, end);
    const trimmed = rawLine.trim();
    const contentStart = lineStart + rawLine.search(/\S|$/);

    if (!trimmed || trimmed.startsWith("//")) {
      i = end + 1;
      continue;
    }

    if (startsWithKeyword(source, contentStart, "stage")) {
      i = skipStageBlock(source, contentStart);
      continue;
    }
    if (startsWithKeyword(source, contentStart, "preset")) {
      i = skipNamedBlock(source, contentStart, "preset");
      continue;
    }
    if (startsWithKeyword(source, contentStart, "stamp")) {
      i = skipNamedBlock(source, contentStart, "stamp");
      continue;
    }

    if (startsWithKeyword(source, contentStart, "recipe")) {
      recipe.name = parseQuotedOrBareDirective(trimmed, "recipe");
    } else if (startsWithKeyword(source, contentStart, "summary")) {
      recipe.summary = parseQuotedOrBareDirective(trimmed, "summary");
    } else if (startsWithKeyword(source, contentStart, "recommendedPreset")) {
      recipe.recommendedPreset = parseQuotedOrBareDirective(trimmed, "recommendedPreset");
    } else if (startsWithKeyword(source, contentStart, "planet")) {
      const decl = parsePlanetDirective(trimmed);
      planet[decl.name] = decl.value;
    } else if (startsWithKeyword(source, contentStart, "const")) {
      constants.push(parseConstDirective(trimmed));
    } else if (startsWithKeyword(source, contentStart, "grid")) {
      grid = parseGridDirective(trimmed);
    } else if (startsWithKeyword(source, contentStart, "use")) {
      imports.push(parseUseDirective(trimmed));
    } else if (startsWithKeyword(source, contentStart, "field")) {
      fields.push(...parseFieldDirective(trimmed, "field", "field"));
    } else if (startsWithKeyword(source, contentStart, "source")) {
      sources.push(...parseFieldDirective(trimmed, "source", "source"));
    } else if (startsWithKeyword(source, contentStart, "setting")) {
      settings.push(parseControlDirective(trimmed, "setting"));
    } else if (startsWithKeyword(source, contentStart, "param")) {
      parameters.push(parseControlDirective(trimmed, "param"));
    }

    i = end + 1;
  }
  return {
    recipe,
    grid: grid ?? { kind: "geodesic", frequency: 64, tiles: 64 },
    planet,
    constants: uniqueDecls(constants),
    resolution: {},
    imports,
    sources: uniqueDecls(sources),
    fields: uniqueDecls([...fields, ...sources]),
    settings: uniqueDecls(settings),
    parameters: uniqueDecls(parameters),
  };
}

export function parsePresets(source) {
  return parseActionBlocks(source, "preset", parsePresetBody);
}

export function parseStamps(source) {
  return parseActionBlocks(source, "stamp", parsePresetBody);
}

function parseActionBlocks(source, keyword, parseBody) {
  const blocks = [];
  let i = 0;
  while (i < source.length) {
    const next = findNextKeyword(source, keyword, i);
    if (next === -1) break;
    i = next + keyword.length;
    i = skipWs(source, i);
    const id = readIdent(source, i);
    i = id.end;
    i = skipWs(source, i);
    const label = source[i] === "\"" ? readString(source, i) : { value: id.value, end: i };
    i = skipWs(source, label.end);
    if (source[i] !== "{") throw new Error(`Expected "{" after ${keyword} ${id.value}`);
    const block = readBlock(source, i);
    blocks.push({
      id: id.value,
      label: label.value,
      actions: parseBody(block.value),
    });
    i = block.end;
  }
  return blocks;
}

export function parseStages(source) {
  const stages = [];
  let i = 0;
  while (i < source.length) {
    const next = findNextKeyword(source, "stage", i);
    if (next === -1) break;
    i = next + "stage".length;
    i = skipWs(source, i);
    const id = readIdent(source, i);
    i = id.end;
    i = skipWs(source, i);
    const name = source[i] === "\"" ? readString(source, i) : { value: id.value, end: i };
    i = skipWs(source, name.end);
    if (source[i] !== "{") throw new Error(`Expected "{" after stage ${id.value}`);
    const block = readBlock(source, i);
    stages.push(parseStageBlock(id.value, name.value, block.value));
    i = block.end;
  }
  if (stages.length === 0) throw new Error("DSL contains no stages");
  return stages;
}

function skipStageBlock(source, start) {
  return skipNamedBlock(source, start, "stage");
}

function skipNamedBlock(source, start, keyword) {
  let i = start + keyword.length;
  i = skipWs(source, i);
  const id = readIdent(source, i);
  i = skipWs(source, id.end);
  if (source[i] === "\"") {
    const name = readString(source, i);
    i = skipWs(source, name.end);
  }
  if (source[i] !== "{") throw new Error(`Expected "{" after ${keyword} ${id.value}`);
  return readBlock(source, i).end;
}

function parseFieldDirective(line, keyword, kind) {
  return line
    .replace(new RegExp(`^${keyword}\\s+`), "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((name) => ({ name, kind }));
}

function parseQuotedOrBareDirective(line, key) {
  const rest = line.replace(new RegExp(`^${key}\\s+`), "").trim();
  if (!rest) throw new Error(`Invalid ${key} declaration: ${line}`);
  if (rest.startsWith("\"")) {
    const parsed = readString(rest, 0);
    return parsed.value;
  }
  return rest;
}

function parsePlanetDirective(line) {
  const match = /^planet\s+([A-Za-z_][A-Za-z0-9_]*)\s+(.+)$/.exec(line);
  if (!match) throw new Error(`Invalid planet declaration: ${line}`);
  const [, name, rawValue] = match;
  return { name, value: parseLiteralToken(rawValue.trim(), line) };
}

function parseConstDirective(line) {
  const match = /^const\s+([A-Za-z_][A-Za-z0-9_]*)\s+(.+)$/.exec(line);
  if (!match) throw new Error(`Invalid const declaration: ${line}`);
  const [, name, rawValue] = match;
  return { name, value: parseLiteralToken(rawValue.trim(), line) };
}

function parseGridDirective(line) {
  const match = /^grid\s+geodesic(?:\s+(?:frequency|tiles|tileSize)\s+|\s+)(\d+)$/.exec(line);
  if (match) {
    const frequency = Number(match[1]);
    if (!Number.isInteger(frequency) || frequency < 1 || frequency > 512) {
      throw new Error(`Geodesic grid frequency must be 1..512: ${line}`);
    }
    return { kind: "geodesic", frequency, tiles: frequency };
  }
  throw new Error(`Invalid grid declaration: ${line}`);
}

function parseUseDirective(line) {
  const match = /^use\s+([A-Za-z_][A-Za-z0-9_]*)\s+(.+)$/.exec(line);
  if (!match) throw new Error(`Invalid use declaration: ${line}`);
  const [, from, names] = match;
  return {
    from,
    names: names
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean),
  };
}

function parsePresetBody(body) {
  const lines = body
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("//"));
  const actions = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let match = /^fill\s+(\w+)\s+(.+)$/.exec(line);
    if (match) {
      actions.push({ type: "fill", field: match[1], value: parseExpr(tokenizeExpr(match[2])) });
      continue;
    }

    match = /^spot\s+(\w+)\s+lon\s+(.+?)\s+lat\s+(.+?)\s+radius\s+(.+?)\s+amount\s+(.+)$/.exec(line);
    if (match) {
      actions.push({
        type: "spot",
        field: match[1],
        lon: parseExpr(tokenizeExpr(match[2])),
        lat: parseExpr(tokenizeExpr(match[3])),
        radius: parseExpr(tokenizeExpr(match[4])),
        amount: parseExpr(tokenizeExpr(match[5])),
      });
      continue;
    }

    match = /^ellipse\s+(\w+)\s+lon\s+(.+?)\s+lat\s+(.+?)\s+rx\s+(.+?)\s+ry\s+(.+?)\s+amount\s+(.+?)(?:\s+angle\s+(.+))?$/.exec(line);
    if (match) {
      actions.push({
        type: "ellipse",
        center: "lonlat",
        field: match[1],
        lon: parseExpr(tokenizeExpr(match[2])),
        lat: parseExpr(tokenizeExpr(match[3])),
        rx: parseExpr(tokenizeExpr(match[4])),
        ry: parseExpr(tokenizeExpr(match[5])),
        amount: parseExpr(tokenizeExpr(match[6])),
        angle: parseExpr(tokenizeExpr(match[7] ?? "0")),
      });
      continue;
    }

    match = /^region\s+(\w+)\s+lon\s+(.+?)\s+lat\s+(.+?)\s+amount\s+(.+)$/.exec(line);
    if (match) {
      const lon = parseRangeExpr(match[2], line);
      const lat = parseRangeExpr(match[3], line);
      actions.push({
        type: "region",
        field: match[1],
        lonMin: lon.min,
        lonMax: lon.max,
        latMin: lat.min,
        latMax: lat.max,
        amount: parseExpr(tokenizeExpr(match[4])),
      });
      continue;
    }

    if (line === "eachCell {") {
      const block = collectNamedBlock(lines, i, "eachCell");
      actions.push({
        type: "eachCell",
        actions: parseActionLines(block.actions, "preset"),
      });
      i = block.endIndex;
      continue;
    }

    throw new Error(`Unknown preset action: ${line}`);
  }
  return actions;
}

function parseRangeExpr(source, line) {
  const parts = String(source).split(/\s*\.\.\s*/);
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(`Invalid region range in: ${line}`);
  }
  return {
    min: parseExpr(tokenizeExpr(parts[0])),
    max: parseExpr(tokenizeExpr(parts[1])),
  };
}

function parseControlDirective(line, keyword) {
  const tokens = tokenizeDirective(line);
  const [, name, kind = "slider", ...rest] = tokens;
  if (!name) throw new Error(`Invalid ${keyword} declaration: ${line}`);
  const isBoolean = kind === "boolean" || kind === "checkbox" || kind === "toggle";
  const decl = {
    name,
    kind: keyword,
    type: isBoolean ? "boolean" : "number",
  };
  if (!isBoolean) decl.control = kind === "number" ? "slider" : kind;

  for (let i = 0; i < rest.length; i++) {
    const key = rest[i];
    const value = rest[i + 1];
    if (key === "range") {
      decl.min = numberToken(value, line);
      decl.max = numberToken(rest[i + 2], line);
      i += 2;
    } else if (key === "min" || key === "max" || key === "step") {
      decl[key] = numberToken(value, line);
      i++;
    } else if (key === "default") {
      decl.default = isBoolean ? booleanToken(value, line) : numberToken(value, line);
      i++;
    } else if (key === "label") {
      decl.label = value ?? name;
      i++;
    } else if (/^-?\d+(?:\.\d+)?\.\.-?\d+(?:\.\d+)?$/.test(key)) {
      const [min, max] = key.split("..");
      decl.min = Number(min);
      decl.max = Number(max);
    }
  }
  return decl;
}

function parseLiteralToken(value, line) {
  if (value === "true") return true;
  if (value === "false") return false;
  if (value.startsWith("\"")) return readString(value, 0).value;
  const number = Number(value);
  if (Number.isFinite(number)) return number;
  throw new Error(`Invalid literal in declaration: ${line}`);
}

function tokenizeDirective(line) {
  const tokens = [];
  const re = /"((?:\\"|[^"])*)"|[^\s]+/g;
  let match;
  while ((match = re.exec(line))) {
    tokens.push(match[1] === undefined ? match[0] : match[1].replace(/\\"/g, "\""));
  }
  return tokens;
}

function numberToken(value, line) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`Invalid number in declaration: ${line}`);
  return number;
}

function booleanToken(value, line) {
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`Invalid boolean in declaration: ${line}`);
}

function uniqueDecls(decls) {
  const out = [];
  const seen = new Set();
  for (const decl of decls) {
    if (!decl?.name || seen.has(decl.name)) continue;
    seen.add(decl.name);
    out.push(decl);
  }
  return out;
}

function parseStageBlock(id, name, body) {
  const reads = parseListDirective(body, "reads");
  const writes = parseListDirective(body, "writes");
  const declares = parseListDirective(body, "declares");
  if (body.includes("code ```")) {
    throw new Error(`${id}: raw JS code blocks are not supported; use DSL primitives instead`);
  }
  const parsedBody = parseDslBody(body);
  return { id, name, reads, writes, declares, params: [], body: parsedBody };
}

function parseListDirective(body, key) {
  const re = new RegExp(`(?:^|\\n)\\s*${key}\\s+([^\\n]+)`);
  const match = body.match(re);
  if (!match) return [];
  return match[1]
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function parseDslBody(body) {
  const lines = body
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("//"))
    .filter((line) => !/^(reads|writes|declares)\s+/.test(line));
  const statements = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith("event when ")) {
      const event = collectEventBlock(lines, i);
      statements.push({
        type: "event",
        condition: parseExpr(tokenizeExpr(event.cond)),
        actions: parseActionLines(event.actions, "event"),
      });
      i = event.endIndex;
    } else if (line === "cell {") {
      const cell = collectNamedBlock(lines, i, "cell");
      statements.push({
        type: "cell",
        actions: parseActionLines(cell.actions, "cell"),
      });
      i = cell.endIndex;
    } else if (line === "each {") {
      const each = collectNamedBlock(lines, i, "each");
      statements.push({
        type: "each",
        actions: parseActionLines(each.actions, "each"),
      });
      i = each.endIndex;
    } else {
      statements.push(parsePrimitiveLine(line));
    }
  }
  return { type: "dsl", statements };
}

function collectEventBlock(lines, startIndex) {
  const first = lines[startIndex];
  const match = /^event\s+when\s+(.+)\s*\{\s*$/.exec(first);
  if (!match) throw new Error(`Malformed event block: ${first}`);
  const block = collectBlockBody(lines, startIndex);
  return { cond: match[1].trim(), actions: block.actions, endIndex: block.endIndex };
}

function collectNamedBlock(lines, startIndex, name) {
  if (lines[startIndex] !== `${name} {`) throw new Error(`Malformed ${name} block: ${lines[startIndex]}`);
  return collectBlockBody(lines, startIndex);
}

function collectBlockBody(lines, startIndex) {
  const actions = [];
  let depth = 0;
  for (let i = startIndex + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.endsWith("{")) depth++;
    if (line === "}") {
      if (depth === 0) return { actions, endIndex: i };
      depth--;
    }
    actions.push(line);
  }
  throw new Error(`Unterminated block starting at line ${startIndex}`);
}

function parseActionLines(lines, mode) {
  const actions = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let match = /^let\s+(\w+)\s*=\s*(.+)$/.exec(line);
    if (match) {
      const [, name, expr] = match;
      actions.push({ type: "let", name, expr: parseExpr(tokenizeExpr(expr)) });
      continue;
    }

    match = /^add\s+(\w+)\s*=\s*(.+)$/.exec(line);
    if (match) {
      const [, field, expr] = match;
      actions.push({ type: "add", field, expr: parseExpr(tokenizeExpr(expr)) });
      continue;
    }

    match = /^set\s+(\w+)\s*=\s*(.+)$/.exec(line);
    if (match) {
      const [, field, expr] = match;
      actions.push({ type: "set", field, expr: parseExpr(tokenizeExpr(expr)) });
      continue;
    }

    match = /^when\s+(.+)\s*\{\s*$/.exec(line);
    if (match) {
      const block = collectBlockBody(lines, i);
      actions.push({
        type: "when",
        condition: parseExpr(tokenizeExpr(match[1])),
        actions: parseActionLines(block.actions, mode),
      });
      i = block.endIndex;
      continue;
    }

    throw new Error(`Unknown ${mode} action: ${line}`);
  }
  return actions;
}

function parsePrimitiveLine(line) {
  let match = /^wind\s+(\w+)\s*->\s*(\w+)\s*,\s*(\w+)(?:\s*,\s*(\w+))?\s+strength\s+(.+)$/.exec(line);
  if (match) {
    const [, pressure, windU, windV, lift, strength] = match;
    return { type: "wind", pressure, windU, windV, lift, strength: parseExpr(tokenizeExpr(strength)) };
  }

  match = /^advect\s+(\w+)\s+by\s+(\w+)\s*,\s*(\w+)\s+dt\s+(.+)$/.exec(line);
  if (match) {
    const [, field, windU, windV, dtExpr] = match;
    return { type: "advect", field, windU, windV, dt: parseExpr(tokenizeExpr(dtExpr)) };
  }

  match = /^diffuse\s+(\w+)\s+amount\s+(.+)$/.exec(line);
  if (match) {
    const [, field, amount] = match;
    return { type: "diffuse", field, amount: parseExpr(tokenizeExpr(amount)) };
  }

  match = /^clamp\s+(\w+)\s+(.+?)\s+(.+)$/.exec(line);
  if (match) {
    const [, field, lo, hi] = match;
    return { type: "clamp", field, lo: parseExpr(tokenizeExpr(lo)), hi: parseExpr(tokenizeExpr(hi)) };
  }

  match = /^normalize\s+(\w+)\s+damping\s+(.+?)\s+when\s+(.+)$/.exec(line);
  if (match) {
    const [, field, damping, cond] = match;
    return { type: "normalize", field, damping: parseExpr(tokenizeExpr(damping)), condition: parseExpr(tokenizeExpr(cond)) };
  }

  throw new Error(`Unknown DSL primitive: ${line}`);
}

function readIdent(source, i) {
  const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(source.slice(i));
  if (!match) throw new Error(`Expected identifier at ${i}`);
  return { value: match[0], end: i + match[0].length };
}

function readString(source, i) {
  let out = "";
  let j = i + 1;
  while (j < source.length) {
    const ch = source[j];
    if (ch === "\\" && j + 1 < source.length) {
      out += source[j + 1];
      j += 2;
      continue;
    }
    if (ch === "\"") return { value: out, end: j + 1 };
    out += ch;
    j++;
  }
  throw new Error("Unterminated string literal");
}

function readBlock(source, i) {
  let depth = 0;
  let j = i;
  let inFence = false;
  while (j < source.length) {
    if (source.startsWith("```", j)) {
      inFence = !inFence;
      j += 3;
      continue;
    }
    const ch = source[j];
    if (!inFence && ch === "{") depth++;
    if (!inFence && ch === "}") {
      depth--;
      if (depth === 0) return { value: source.slice(i + 1, j), end: j + 1 };
    }
    j++;
  }
  throw new Error("Unterminated stage block");
}

function findNextKeyword(source, keyword, start = 0) {
  let i = start;
  while (i < source.length) {
    if (source.startsWith("//", i)) {
      const end = source.indexOf("\n", i + 2);
      if (end === -1) return -1;
      i = end + 1;
      continue;
    }
    if (source.startsWith("/*", i)) {
      const end = source.indexOf("*/", i + 2);
      if (end === -1) return -1;
      i = end + 2;
      continue;
    }
    if (source[i] === "\"") {
      i = readString(source, i).end;
      continue;
    }
    if (startsWithKeyword(source, i, keyword)) return i;
    i++;
  }
  return -1;
}

function skipWs(source, i) {
  while (i < source.length && /\s/.test(source[i])) i++;
  return i;
}

function isWordBoundary(source, i) {
  if (i < 0 || i >= source.length) return true;
  return !/[A-Za-z0-9_]/.test(source[i]);
}

function startsWithKeyword(source, start, keyword) {
  return source.startsWith(keyword, start)
    && isWordBoundary(source, start - 1)
    && isWordBoundary(source, start + keyword.length);
}
