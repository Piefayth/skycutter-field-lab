// Tolerant concrete syntax tree for Field Lab DSL v2.
//
// This is the canonical editor-facing syntax front-end. It preserves source
// ranges, survives incomplete code, and records line-level statement shells
// without trying to duplicate the compiler parser's semantic AST. Compiler
// migration can happen incrementally by projecting this CST into the existing
// parse-v2 shape once this front-end has enough coverage.

const BLOCK_KEYWORDS = new Set([
  "views", "stamps", "scenarios",
  "palette", "view", "stamp", "scenario",
  "step", "stage", "cell", "when",
]);

const NAME_DECL_KEYWORDS = new Set([
  "field", "source", "param", "const",
  "stage", "scenario", "stamp", "metric", "palette", "view",
]);

const NAME_BUCKET = {
  field: "fields",
  source: "sources",
  param: "parameters",
  const: "constants",
  stage: "stages",
  scenario: "scenarios",
  stamp: "stamps",
  metric: "metrics",
  palette: "palettes",
  view: "views",
};

export function parseDslCst(source) {
  source = String(source ?? "");
  const sanitized = sanitizeDsl(source);
  const root = makeRoot(source);
  const { blocks, errors } = scanBlocks(source, sanitized, root);
  const statements = scanStatements(source, sanitized, root, blocks);
  const symbols = scanSymbols(statements);
  const names = namesFromSymbols(symbols);
  root.children = blocks.filter((block) => block.parent === root);
  root.statements = statements.filter((stmt) => stmt.block === root);
  return {
    type: "RecipeCst",
    source,
    sanitized,
    root,
    blocks,
    statements,
    symbols,
    names,
    errors,
  };
}

export function blockStackAt(cst, pos, { knownOnly = true } = {}) {
  const blocks = cst?.blocks ?? [];
  return blocks
    .filter((block) => {
      if (knownOnly && !BLOCK_KEYWORDS.has(block.keyword)) return false;
      return block.openBrace < pos && block.closeBrace >= pos;
    })
    .sort((a, b) => a.openBrace - b.openBrace);
}

export function statementAt(cst, pos) {
  return (cst?.statements ?? []).find((stmt) => stmt.from <= pos && pos <= stmt.to) ?? null;
}

export function cursorContextAt(cst, pos) {
  const stack = blockStackAt(cst, pos);
  const statement = statementAt(cst, pos);
  return {
    type: "CursorContext",
    pos,
    stack,
    mode: classifyMode(stack),
    statement,
    symbols: visibleSymbolsAt(cst, pos),
  };
}

export function sanitizeDsl(source) {
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

function makeRoot(source) {
  return {
    type: "Root",
    keyword: "root",
    id: null,
    from: 0,
    to: source.length,
    openBrace: -1,
    closeBrace: source.length,
    bodyFrom: 0,
    bodyTo: source.length,
    parent: null,
    children: [],
    statements: [],
    closed: true,
  };
}

function scanBlocks(source, sanitized, root) {
  const blocks = [];
  const errors = [];
  const stack = [root];
  for (let i = 0; i < sanitized.length; i++) {
    const ch = sanitized[i];
    if (ch === "{") {
      const header = readBlockHeader(sanitized, i);
      const parent = stack[stack.length - 1] ?? root;
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
        headerFrom: header.from,
        headerTo: i,
        parent,
        children: [],
        statements: [],
        closed: false,
      };
      parent.children.push(block);
      blocks.push(block);
      stack.push(block);
      continue;
    }
    if (ch === "}") {
      if (stack.length <= 1) {
        errors.push({
          type: "UnexpectedClosingBrace",
          from: i,
          to: i + 1,
          message: "unexpected closing brace",
        });
        continue;
      }
      const block = stack.pop();
      block.closeBrace = i;
      block.bodyTo = i;
      block.to = i + 1;
      block.closed = true;
    }
  }
  while (stack.length > 1) {
    const block = stack.pop();
    errors.push({
      type: "UnclosedBlock",
      from: block.openBrace,
      to: block.openBrace + 1,
      message: `unclosed ${block.keyword} block`,
      block,
    });
  }
  return { blocks, errors };
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

function scanStatements(source, sanitized, root, blocks) {
  const statements = [];
  const lineRanges = computeLineRanges(source);
  for (const line of lineRanges) {
    const text = source.slice(line.from, line.to);
    const clean = sanitized.slice(line.from, line.to);
    const words = [...clean.matchAll(/\b[A-Za-z_][A-Za-z0-9_]*\b/g)];
    if (words.length === 0) continue;
    const keyword = words[0][0];
    const nameMatch = words[1] ?? null;
    const name = nameMatch?.[0] ?? null;
    const block = innermostBlockForLine(root, blocks, line.from);
    const stmt = {
      type: "Statement",
      keyword,
      name,
      nameFrom: nameMatch ? line.from + nameMatch.index : null,
      nameTo: nameMatch ? line.from + nameMatch.index + name.length : null,
      from: line.from,
      to: line.to,
      line: line.number,
      text,
      cleanText: clean,
      block,
      blockKeyword: block.keyword,
      role: classifyStatement(keyword, block.keyword),
    };
    statements.push(stmt);
    block.statements.push(stmt);
  }
  return statements;
}

function computeLineRanges(source) {
  const ranges = [];
  let from = 0;
  let number = 1;
  for (let i = 0; i <= source.length; i++) {
    if (i === source.length || source[i] === "\n") {
      ranges.push({ from, to: i, number });
      from = i + 1;
      number++;
    }
  }
  return ranges;
}

function innermostBlockForLine(root, blocks, lineStart) {
  let best = root;
  for (const block of blocks) {
    if (block.openBrace < lineStart && block.closeBrace >= lineStart) {
      if (block.openBrace > best.openBrace) best = block;
    }
  }
  return best;
}

function classifyStatement(keyword, blockKeyword) {
  if (NAME_DECL_KEYWORDS.has(keyword)) return "declaration";
  if (keyword === "reads" || keyword === "writes") return "stageIo";
  if (keyword === "set" || keyword === "add" || keyword === "let") return "cellAction";
  if (keyword === "spot" || keyword === "ellipse" || keyword === "region") return "initAction";
  if (keyword === "color" || keyword === "stop" || keyword === "overlay") return "render";
  if (keyword === "for" || keyword === "when") return "control";
  if (blockKeyword === "root") return "topLevel";
  return "statement";
}

function scanSymbols(statements) {
  const symbols = [];
  for (const stmt of statements) {
    if (!NAME_DECL_KEYWORDS.has(stmt.keyword)) continue;
    const bucket = NAME_BUCKET[stmt.keyword];
    if (!bucket || !stmt.name) continue;
    symbols.push({
      type: "Symbol",
      kind: stmt.keyword,
      bucket,
      name: stmt.name,
      from: stmt.nameFrom,
      to: stmt.nameTo,
      statement: stmt,
      block: stmt.block,
    });
  }
  return symbols;
}

function namesFromSymbols(symbols) {
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
  for (const symbol of symbols) {
    names[symbol.bucket]?.push(symbol.name);
  }
  names.immutables = unique([...names.parameters, ...names.constants, ...names.planet]);
  for (const key of Object.keys(names)) names[key] = unique(names[key]);
  return names;
}

function visibleSymbolsAt(cst, pos) {
  // First cut: recipe-scope declarations plus prior let-locals in the
  // current block. Reduction binders need expression CST coverage and are
  // intentionally left for the next parser slice.
  const symbols = [...(cst?.symbols ?? [])].filter((symbol) => symbol.from <= pos);
  const currentBlock = blockStackAt(cst, pos, { knownOnly: false }).at(-1) ?? cst?.root;
  for (const stmt of currentBlock?.statements ?? []) {
    if (stmt.from >= pos) continue;
    if (stmt.keyword !== "let" || !stmt.name) continue;
    symbols.push({
      type: "Symbol",
      kind: "local",
      bucket: "locals",
      name: stmt.name,
      from: stmt.nameFrom,
      to: stmt.nameTo,
      statement: stmt,
      block: currentBlock,
    });
  }
  return symbols;
}

function classifyMode(stack) {
  for (let i = stack.length - 1; i >= 0; i--) {
    const keyword = stack[i].keyword;
    if (keyword === "?" || keyword === "when") continue;
    if (keyword === "cell") return "cellBody";
    if (keyword === "view") return "viewBody";
    if (keyword === "palette") return "paletteBody";
    if (keyword === "stage") return "stageBody";
    if (keyword === "step") return "stepBody";
    if (keyword === "views") return "viewsSection";
    if (keyword === "stamps") return "stampsSection";
    if (keyword === "scenarios") return "scenariosSection";
    if (keyword === "scenario" || keyword === "stamp") return "presetBody";
  }
  return "topLevel";
}

function unique(values) {
  return [...new Set(values.map((v) => String(v ?? "").trim()).filter(Boolean))];
}
