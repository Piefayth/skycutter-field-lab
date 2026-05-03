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
  "step", "stage", "cell", "when", "for",
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
  const references = scanReferences(statements);
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
    references,
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
  return (cst?.statements ?? [])
    .filter((stmt) => stmt.from <= pos && pos <= stmt.to)
    .sort((a, b) => (a.to - a.from) - (b.to - b.from))[0] ?? null;
}

export function expectedAt(cst, pos) {
  const zones = (cst?.statements ?? [])
    .filter((stmt) => stmt.from <= pos && pos <= stmt.to)
    .flatMap((stmt) => stmt.expectedZones ?? [])
    .filter((zone) => zone.from <= pos && pos <= zone.to)
    .sort((a, b) => (a.to - a.from) - (b.to - b.from));
  const precise = zones.filter((zone) => !zone.expected.includes("expression"));
  return (precise.length > 0 ? precise : zones)
    .flatMap((zone) => zone.expected);
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
    expected: unique(expectedAt(cst, pos)),
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
  const stack = [{ kind: "root", block: root }];
  for (let i = 0; i < sanitized.length; i++) {
    const ch = sanitized[i];
    if (ch === "{") {
      const header = readBlockHeader(sanitized, i);
      if (!BLOCK_KEYWORDS.has(header.keyword)) {
        stack.push({ kind: "brace" });
        continue;
      }
      const parent = innermostBlockFrame(stack)?.block ?? root;
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
      stack.push({ kind: "block", block });
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
      const frame = stack.pop();
      if (frame.kind !== "block") continue;
      const block = frame.block;
      block.closeBrace = i;
      block.bodyTo = i;
      block.to = i + 1;
      block.closed = true;
    }
  }
  while (stack.length > 1) {
    const frame = stack.pop();
    if (frame.kind !== "block") continue;
    const block = frame.block;
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

function innermostBlockFrame(stack) {
  for (let i = stack.length - 1; i >= 0; i--) {
    if (stack[i].kind === "block" || stack[i].kind === "root") return stack[i];
  }
  return null;
}

function readBlockHeader(sanitized, openBrace) {
  const lineStart = sanitized.lastIndexOf("\n", openBrace - 1) + 1;
  const previousOpen = sanitized.lastIndexOf("{", openBrace - 1);
  const previousClose = sanitized.lastIndexOf("}", openBrace - 1);
  const headerStart = Math.max(lineStart, previousOpen + 1, previousClose + 1);
  const header = sanitized.slice(headerStart, openBrace);
  const matches = [...header.matchAll(/\b[A-Za-z_][A-Za-z0-9_]*\b/g)];
  let keyword = "?";
  let id = null;
  let from = headerStart;
  const forEachMatches = [...header.matchAll(/\bfor\s+each\s+cell\b/g)];
  const forEach = forEachMatches[forEachMatches.length - 1];
  if (forEach) {
    return { keyword: "for", id: null, from: headerStart + forEach.index };
  }
  for (let i = matches.length - 1; i >= 0; i--) {
    const word = matches[i][0];
    if (BLOCK_KEYWORDS.has(word)) {
      keyword = word;
      from = headerStart + matches[i].index;
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
    for (const segment of statementSegmentsForLine(source, sanitized, line)) {
      const text = source.slice(segment.from, segment.to);
      const clean = sanitized.slice(segment.from, segment.to);
      const words = [...clean.matchAll(/\b[A-Za-z_][A-Za-z0-9_]*\b/g)];
      if (words.length === 0) continue;
      const keyword = words[0][0];
      const nameMatch = words[1] ?? null;
      const name = nameMatch?.[0] ?? null;
      const block = innermostBlockForLine(root, blocks, segment.from);
      const stmt = {
        type: "Statement",
        keyword,
        name,
        nameFrom: nameMatch ? segment.from + nameMatch.index : null,
        nameTo: nameMatch ? segment.from + nameMatch.index + name.length : null,
        from: segment.from,
        to: segment.to,
        line: line.number,
        text,
        cleanText: clean,
        block,
        blockKeyword: block.keyword,
        role: classifyStatement(keyword, block.keyword),
        parts: {},
        expressions: [],
        expectedZones: [],
      };
      annotateStatement(stmt);
      statements.push(stmt);
      block.statements.push(stmt);
    }
  }
  return statements;
}

function statementSegmentsForLine(source, sanitized, line) {
  const raw = sanitized.slice(line.from, line.to);
  const original = source.slice(line.from, line.to);
  const points = [0];
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === "{") {
      const header = readBlockHeader(sanitized, line.from + i);
      if (BLOCK_KEYWORDS.has(header.keyword)) points.push(i + 1);
    } else if (raw[i] === ";") {
      points.push(i + 1);
    }
  }
  const out = [];
  for (const point of points) {
    let from = point;
    while (from < raw.length && /\s/.test(raw[from])) from++;
    if (from >= raw.length || raw[from] === "}") continue;
    let to = raw.length;
    let depth = 0;
    for (let i = from; i < raw.length; i++) {
      const globalPos = line.from + i;
      if (raw[i] === "{") {
        const header = readBlockHeader(sanitized, globalPos);
        if (depth === 0 && BLOCK_KEYWORDS.has(header.keyword)) {
          to = i;
          break;
        }
        depth++;
      } else if (raw[i] === "}") {
        if (depth === 0) {
          to = i;
          break;
        }
        depth--;
      } else if (raw[i] === ";" && depth === 0) {
        to = i;
        break;
      }
    }
    const lineComment = original.indexOf("//", from);
    if (lineComment >= 0 && lineComment < to) to = lineComment;
    while (to > from && /\s/.test(raw[to - 1]) && /\s/.test(original[to - 1])) to--;
    if (to > from) out.push({ from: line.from + from, to: line.from + to });
  }
  return out;
}

function annotateStatement(stmt) {
  const line = stmt.cleanText;
  const base = stmt.from;
  const addZone = (from, to, expected, kind) => {
    if (from == null || to == null || to < from) return;
    stmt.expectedZones.push({
      type: "ExpectedZone",
      kind,
      expected: Array.isArray(expected) ? expected : [expected],
      from: base + from,
      to: base + to,
    });
  };
  const addExpr = (from, to, kind = "expression") => {
    if (from == null || to == null || to < from) return;
    const expr = {
      type: "ExpressionSpan",
      kind,
      from: base + from,
      to: base + to,
      text: stmt.text.slice(from, to),
    };
    annotateExpression(expr);
    stmt.expressions.push(expr);
    addZone(from, to, "expression", kind);
    for (const zone of expr.expectedZones ?? []) {
      stmt.expectedZones.push(zone);
    }
  };
  const firstTokenEnd = line.search(/\s/);
  const afterKeyword = firstTokenEnd < 0 ? line.length : firstTokenEnd;

  if (stmt.keyword === "reads" || stmt.keyword === "writes") {
    addZone(afterKeyword, line.length, "fieldName", "stageFieldList");
    return;
  }

  if (stmt.keyword === "set" || stmt.keyword === "add") {
    const target = /^\s*(set|add)\s+([A-Za-z_][A-Za-z0-9_]*)?/.exec(line);
    const targetFrom = line.indexOf(stmt.keyword) + stmt.keyword.length;
    const eq = line.indexOf("=");
    addZone(targetFrom, eq >= 0 ? eq : line.length, "fieldName", "assignmentTarget");
    if (target?.[2]) {
      const rel = line.indexOf(target[2], target.index + target[1].length);
      stmt.parts.target = { name: target[2], from: base + rel, to: base + rel + target[2].length };
    }
    if (eq >= 0) addExpr(eq + 1, line.length, "assignmentExpr");
    return;
  }

  if (stmt.keyword === "let") {
    const match = /^\s*let\s+([A-Za-z_][A-Za-z0-9_]*)?/.exec(line);
    if (match?.[1]) {
      const rel = line.indexOf(match[1], match.index + 3);
      stmt.parts.local = { name: match[1], from: base + rel, to: base + rel + match[1].length };
    }
    const eq = line.indexOf("=");
    if (eq >= 0) addExpr(eq + 1, line.length, "letExpr");
    return;
  }

  if (stmt.keyword === "when") {
    const start = line.indexOf("when") + "when".length;
    const brace = line.indexOf("{", start);
    addExpr(start, brace >= 0 ? brace : line.length, "condition");
    return;
  }

  if (stmt.keyword === "for") {
    const where = line.indexOf("where");
    const brace = line.indexOf("{");
    if (where >= 0) addExpr(where + "where".length, brace >= 0 ? brace : line.length, "eachCellPredicate");
    return;
  }

  if (stmt.keyword === "field" || stmt.keyword === "source") {
    const colon = line.indexOf(":");
    if (colon >= 0) addZone(colon + 1, line.length, "fieldType", "fieldType");
    return;
  }

  if (stmt.keyword === "substrate") {
    const kindMatch = /^\s*substrate\s+([A-Za-z_][A-Za-z0-9_]*)?/.exec(line);
    const kindFrom = line.indexOf("substrate") + "substrate".length;
    const kindTo = kindMatch?.[1] ? line.indexOf(kindMatch[1], kindFrom) + kindMatch[1].length : line.length;
    addZone(kindFrom, kindTo, "substrateKind", "substrateKind");
    if (kindMatch?.[1] === "geodesic") {
      addZone(kindTo, line.length, "substrateOption", "substrateOption");
    }
    return;
  }

  if (stmt.keyword === "param") {
    annotateParamStatement(stmt, line, addZone);
    return;
  }

  if (stmt.keyword === "recommendedPreset") {
    addZone(afterKeyword, line.length, "scenarioName", "recommendedPreset");
    return;
  }

  if (stmt.keyword === "spot" || stmt.keyword === "ellipse" || stmt.keyword === "region") {
    const firstModifier = firstPositive([
      line.indexOf(" at ", afterKeyword),
      line.indexOf(" where ", afterKeyword),
      line.indexOf(" amount", afterKeyword),
      line.length,
    ]);
    addZone(afterKeyword, firstModifier, "fieldName", "initTarget");
    annotateNamedArgExpressions(stmt, line, base, addExpr);
    return;
  }

  if (stmt.keyword === "metric") {
    const eq = line.indexOf("=");
    if (eq >= 0) {
      const cells = line.indexOf("cells", eq);
      const where = line.indexOf("where", eq);
      const bodyOpen = line.indexOf("{", eq);
      addZone(eq + 1, cells >= 0 ? cells : firstPositive([where, bodyOpen, line.length]), "metricReduction", "metricReduction");
      const bodyClose = line.lastIndexOf("}");
      if (bodyOpen >= 0) addExpr(bodyOpen + 1, bodyClose > bodyOpen ? bodyClose : line.length, "metricBody");
      if (where >= 0) addExpr(where + "where".length, bodyOpen >= 0 ? bodyOpen : line.length, "metricPredicate");
    }
    return;
  }

  if (stmt.keyword === "color") {
    annotateColorStatement(stmt, line, base, addZone, addExpr);
    return;
  }

  if (stmt.keyword === "stop") {
    const color = line.indexOf("color");
    if (color >= 0) addZone(color + "color".length, line.length, "colorTriple", "paletteColor");
  }
}

function annotateNamedArgExpressions(stmt, line, base, addExpr) {
  for (const match of line.matchAll(/\b(amount|radius|rx|ry|angle|lon|lat|lonMin|lonMax|latMin|latMax)\s*=/g)) {
    const start = match.index + match[0].length;
    const rest = line.slice(start);
    const next = /\s+\b(amount|radius|rx|ry|angle|lon|lat|lonMin|lonMax|latMin|latMax)\s*=/.exec(rest);
    const end = next ? start + next.index : line.length;
    addExpr(start, end, `${match[1]}Arg`);
  }
}

function annotateParamStatement(stmt, line, addZone) {
  const nameMatch = /^\s*param\s+([A-Za-z_][A-Za-z0-9_]*)?/.exec(line);
  const nameTo = nameMatch?.[1]
    ? line.indexOf(nameMatch[1], line.indexOf("param") + "param".length) + nameMatch[1].length
    : line.length;
  const widgetMatch = /\b(slider|toggle)\b/.exec(line.slice(nameTo));
  const widgetFrom = nameTo;
  const widgetTo = widgetMatch ? nameTo + widgetMatch.index + widgetMatch[1].length : line.length;
  addZone(widgetFrom, widgetTo, "paramWidget", "paramWidget");
  if (widgetMatch) {
    addZone(widgetTo, line.length, "paramModifier", "paramModifier");
  }
}

function annotateColorStatement(stmt, line, base, addZone, addExpr) {
  const color = line.indexOf("color");
  const kindMatch = /\bcolor\s+([A-Za-z_][A-Za-z0-9_]*)?/.exec(line);
  const afterColor = color >= 0 ? color + "color".length : 0;
  addZone(afterColor, kindMatch?.[1] ? line.indexOf(kindMatch[1], afterColor) + kindMatch[1].length : line.length, "colorKind", "colorKind");
  const kind = kindMatch?.[1];
  if (!kind) return;
  const afterKind = line.indexOf(kind, afterColor) + kind.length;
  if (kind === "ramp" || kind === "wheel") {
    const fieldMatch = /\bcolor\s+(ramp|wheel)\s+([A-Za-z_][A-Za-z0-9_]*)?/.exec(line);
    const fieldStart = afterKind;
    const range = line.indexOf("range", afterKind);
    const palette = line.indexOf("palette", afterKind);
    const stops = line.indexOf("stops", afterKind);
    const fieldEnd = firstPositive([range, palette, stops, line.length]);
    addZone(fieldStart, fieldEnd, "fieldName", "colorField");
    if (fieldMatch?.[2]) {
      const rel = line.indexOf(fieldMatch[2], fieldStart);
      stmt.parts.field = { name: fieldMatch[2], from: base + rel, to: base + rel + fieldMatch[2].length };
    }
    if (range >= 0) {
      const open = line.indexOf("[", range);
      const close = line.indexOf("]", range);
      if (open >= 0) {
        const innerEnd = close >= 0 ? close : line.length;
        const comma = line.indexOf(",", open);
        if (comma >= 0 && comma < innerEnd) {
          addExpr(open + 1, comma, "rangeLower");
          addExpr(comma + 1, innerEnd, "rangeUpper");
        } else {
          addExpr(open + 1, innerEnd, "rangeBound");
        }
      }
    }
    if (palette >= 0) {
      addZone(palette + "palette".length, line.length, "paletteName", "paletteRef");
    } else if (kind === "ramp" && fieldMatch?.[2]) {
      addZone(fieldEnd, line.length, "colorRampModifier", "colorRampModifier");
    } else if (kind === "wheel" && fieldMatch?.[2]) {
      addZone(fieldEnd, line.length, "colorWheelModifier", "colorWheelModifier");
    }
  } else if (kind === "expr") {
    addZone(afterKind, line.length, "exprBlock", "colorExprBlock");
  }
}

function firstPositive(values) {
  return Math.min(...values.filter((v) => Number.isFinite(v) && v >= 0));
}

function annotateExpression(expr) {
  const text = expr.text;
  const base = expr.from;
  expr.tokens = expressionTokens(text, base);
  expr.node = parseExpressionNode(expr.tokens);
  expr.identifiers = expr.tokens.filter((token) => token.kind === "identifier");
  expr.coordReads = coordReadsInExpression(text, base);
  expr.reductions = reductionsInExpression(text, base);
  expr.expectedZones = coordExpectedZonesInExpression(text, base, expr.coordReads);
}

function expressionTokens(text, base) {
  const tokens = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (/\s/.test(ch)) { i++; continue; }
    const number = /^(?:\d+\.\d*|\.\d+|\d+)(?:e[+-]?\d+)?/i.exec(text.slice(i));
    if (number) {
      tokens.push(token("number", number[0], base + i));
      i += number[0].length;
      continue;
    }
    const ident = /^[A-Za-z_][A-Za-z0-9_]*/.exec(text.slice(i));
    if (ident) {
      let value = ident[0];
      if (value === "and") value = "&&";
      if (value === "or") value = "||";
      if (value === "not") value = "!";
      const kind = BINARY_PRECEDENCE.has(value) || value === "!" ? "operator" : "identifier";
      tokens.push(token(kind, value, base + i));
      i += ident[0].length;
      continue;
    }
    const op = ["===", "!==", "??", "&&", "||", ">=", "<=", "==", "!=", "+", "-", "*", "/", "%", ">", "<", "!", "?", ":", ".", "(", ")", ",", "{", "}", "@"]
      .find((cand) => text.startsWith(cand, i));
    if (op) {
      tokens.push(token(BINARY_PRECEDENCE.has(op) || op === "!" ? "operator" : "punct", op, base + i));
      i += op.length;
      continue;
    }
    tokens.push(token("unknown", ch, base + i));
    i++;
  }
  tokens.push({ type: "Token", kind: "eof", value: "", from: base + text.length, to: base + text.length });
  return tokens;
}

function token(kind, value, from) {
  return { type: "Token", kind, value, from, to: from + value.length };
}

const BINARY_PRECEDENCE = new Map([
  ["??", 1],
  ["||", 2],
  ["&&", 3],
  ["===", 4],
  ["!==", 4],
  ["==", 4],
  ["!=", 4],
  [">", 5],
  [">=", 5],
  ["<", 5],
  ["<=", 5],
  ["+", 6],
  ["-", 6],
  ["*", 7],
  ["/", 7],
  ["%", 7],
]);

const REDUCTION_OPS = new Set(["sum", "max", "min", "mean"]);

function parseExpressionNode(tokens) {
  const parser = { tokens, index: 0 };
  const expr = parseConditionalNode(parser);
  if (!expr) return missingNode(tokens[0]?.from ?? 0, "expression");
  return expr;
}

function parseConditionalNode(parser) {
  const test = parseBinaryNode(parser, 0);
  if (peek(parser).value !== "?") return test;
  const question = next(parser);
  const consequent = parseConditionalNode(parser);
  let colon = null;
  let alternate = null;
  if (peek(parser).value === ":") {
    colon = next(parser);
    alternate = parseConditionalNode(parser);
  } else {
    alternate = missingNode(question.to, "conditionalAlternate");
  }
  return {
    type: "ExprConditional",
    test,
    consequent,
    alternate,
    from: test.from,
    to: alternate.to,
    questionFrom: question.from,
    colonFrom: colon?.from ?? null,
    missing: !colon,
  };
}

function parseBinaryNode(parser, minPrec) {
  let left = parseUnaryNode(parser);
  while (true) {
    const tok = peek(parser);
    const prec = tok.kind === "operator" ? BINARY_PRECEDENCE.get(tok.value) : undefined;
    if (prec === undefined || prec < minPrec) break;
    next(parser);
    const right = parseBinaryNode(parser, prec + 1);
    left = {
      type: "ExprBinary",
      op: tok.value,
      left,
      right,
      from: left.from,
      to: right.to,
      opFrom: tok.from,
      missing: right.type === "ExprMissing",
    };
  }
  return left;
}

function parseUnaryNode(parser) {
  const tok = peek(parser);
  if (tok.value === "!" || tok.value === "-" || tok.value === "+") {
    next(parser);
    const expr = parseUnaryNode(parser);
    return {
      type: "ExprUnary",
      op: tok.value,
      expr,
      from: tok.from,
      to: expr.to,
      opFrom: tok.from,
      missing: expr.type === "ExprMissing",
    };
  }
  return parsePostfixNode(parser);
}

function parsePostfixNode(parser) {
  let expr = parsePrimaryNode(parser);
  while (true) {
    const tok = peek(parser);
    if (tok.value === ".") {
      next(parser);
      const prop = peek(parser).kind === "identifier" ? next(parser) : null;
      expr = {
        type: "ExprMember",
        object: expr,
        prop: prop?.value ?? null,
        from: expr.from,
        to: prop?.to ?? tok.to,
        dotFrom: tok.from,
        missing: !prop,
      };
      continue;
    }
    if (tok.value === "(") {
      expr = parseCallNode(parser, expr);
      continue;
    }
    if (tok.value === "@") {
      expr = parseCoordReadNode(parser, expr);
      continue;
    }
    return expr;
  }
}

function parseCallNode(parser, callee) {
  const open = expectValue(parser, "(");
  const args = [];
  let closed = false;
  while (peek(parser).kind !== "eof") {
    if (peek(parser).value === ")") {
      closed = true;
      break;
    }
    args.push(parseConditionalNode(parser));
    if (peek(parser).value === ",") {
      next(parser);
      continue;
    }
    if (peek(parser).value === ")") {
      closed = true;
      break;
    }
    break;
  }
  const close = peek(parser).value === ")" ? next(parser) : null;
  return {
    type: "ExprCall",
    callee,
    args,
    from: callee.from,
    to: close?.to ?? (args.at(-1)?.to ?? open.to),
    openFrom: open.from,
    closeFrom: close?.from ?? null,
    missing: !closed,
  };
}

function parseCoordReadNode(parser, target) {
  const at = expectValue(parser, "@");
  const coordTok = peek(parser).kind === "identifier" ? next(parser) : null;
  let coord = coordTok?.value ?? null;
  let args = [];
  let closeFrom = null;
  let missing = !coordTok;
  if (coord === "upstream" && peek(parser).value === "(") {
    const call = parseCallNode(parser, {
      type: "ExprIdentifier",
      name: "upstream",
      from: coordTok.from,
      to: coordTok.to,
    });
    args = call.args;
    closeFrom = call.closeFrom;
    missing = missing || call.missing;
  }
  return {
    type: "ExprCoordRead",
    target,
    field: target.type === "ExprIdentifier" ? target.name : null,
    coord,
    args,
    from: target.from,
    to: closeFrom != null ? (args.at(-1)?.to ?? coordTok?.to ?? at.to) : (coordTok?.to ?? at.to),
    atFrom: at.from,
    coordFrom: coordTok?.from ?? null,
    closeFrom,
    missing,
  };
}

function parsePrimaryNode(parser) {
  const tok = peek(parser);
  if (tok.kind === "number") {
    next(parser);
    return { type: "ExprNumber", value: tok.value, from: tok.from, to: tok.to };
  }
  if (tok.kind === "identifier") {
    if (REDUCTION_OPS.has(tok.value)) {
      const reduction = tryParseReductionNode(parser);
      if (reduction) return reduction;
    }
    next(parser);
    return { type: "ExprIdentifier", name: tok.value, from: tok.from, to: tok.to };
  }
  if (tok.value === "(") {
    const open = next(parser);
    const expr = parseConditionalNode(parser);
    const close = peek(parser).value === ")" ? next(parser) : null;
    return {
      type: "ExprGroup",
      expr,
      from: open.from,
      to: close?.to ?? expr.to,
      openFrom: open.from,
      closeFrom: close?.from ?? null,
      missing: !close,
    };
  }
  if (tok.value === ")" || tok.value === "}" || tok.value === "," || tok.value === ":" || tok.kind === "eof") {
    return missingNode(tok.from, "expression");
  }
  next(parser);
  return { type: "ExprUnknown", value: tok.value, from: tok.from, to: tok.to };
}

function tryParseReductionNode(parser) {
  const start = parser.index;
  const op = peek(parser);
  const binder = parser.tokens[start + 1];
  const inTok = parser.tokens[start + 2];
  const neighbors = parser.tokens[start + 3];
  const open = parser.tokens[start + 4];
  if (binder?.kind !== "identifier") return null;
  if (inTok?.kind !== "identifier" || inTok.value !== "in") return null;
  if (neighbors?.kind !== "identifier" || neighbors.value !== "neighbors") return null;
  if (open?.value !== "{") return null;
  parser.index = start + 5;
  const body = parseConditionalNode(parser);
  const close = peek(parser).value === "}" ? next(parser) : null;
  return {
    type: "ExprNeighborReduce",
    op: op.value,
    binder: binder.value,
    body,
    from: op.from,
    to: close?.to ?? body.to,
    binderFrom: binder.from,
    bodyFrom: open.to,
    bodyTo: close?.from ?? body.to,
    missing: !close,
  };
}

function missingNode(from, label) {
  return { type: "ExprMissing", label, from, to: from, missing: true };
}

function peek(parser) {
  return parser.tokens[parser.index] ?? parser.tokens[parser.tokens.length - 1];
}

function next(parser) {
  const tok = peek(parser);
  if (parser.index < parser.tokens.length - 1) parser.index++;
  return tok;
}

function expectValue(parser, value) {
  const tok = peek(parser);
  if (tok.value === value) return next(parser);
  return { type: "Token", kind: "missing", value, from: tok.from, to: tok.from };
}

function coordReadsInExpression(text, base) {
  const reads = [];
  for (const match of text.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\s*@\s*([A-Za-z_][A-Za-z0-9_]*)\b/g)) {
    reads.push({
      type: "CoordReadSpan",
      field: match[1],
      coord: match[2],
      from: base + match.index,
      to: base + match.index + match[0].length,
      fieldFrom: base + match.index + match[0].indexOf(match[1]),
      coordFrom: base + match.index + match[0].lastIndexOf(match[2]),
    });
  }
  return reads;
}

function reductionsInExpression(text, base) {
  const out = [];
  const re = /\b(sum|mean|max|min)\s+([A-Za-z_][A-Za-z0-9_]*)\s+in\s+neighbors\s*\{/g;
  for (const match of text.matchAll(re)) {
    const bodyOpenRel = match.index + match[0].length - 1;
    const bodyCloseRel = findMatchingBraceInText(text, bodyOpenRel);
    const binderOffset = match[0].indexOf(match[2]);
    out.push({
      type: "ReductionSpan",
      op: match[1],
      binder: match[2],
      from: base + match.index,
      to: base + (bodyCloseRel >= 0 ? bodyCloseRel + 1 : text.length),
      binderFrom: base + match.index + binderOffset,
      binderTo: base + match.index + binderOffset + match[2].length,
      bodyFrom: base + bodyOpenRel + 1,
      bodyTo: base + (bodyCloseRel >= 0 ? bodyCloseRel : text.length),
    });
  }
  return out;
}

function coordExpectedZonesInExpression(text, base, coordReads) {
  const zones = [];
  for (const read of coordReads) {
    zones.push({
      type: "ExpectedZone",
      kind: "coordName",
      expected: ["coordName"],
      from: read.coordFrom,
      to: read.to,
    });
  }
  for (const match of text.matchAll(/\b[A-Za-z_][A-Za-z0-9_]*\s*@\s*([A-Za-z_][A-Za-z0-9_]*)?/g)) {
    if (match[1]) continue;
    const at = match[0].indexOf("@");
    zones.push({
      type: "ExpectedZone",
      kind: "coordName",
      expected: ["coordName"],
      from: base + match.index + at + 1,
      to: base + match.index + match[0].length,
    });
  }
  return zones;
}

function findMatchingBraceInText(text, openRel) {
  let depth = 0;
  for (let i = openRel; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
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

function scanReferences(statements) {
  const out = [];
  for (const stmt of statements) {
    for (const expr of stmt.expressions ?? []) {
      const coordFieldStarts = new Set((expr.coordReads ?? []).map((read) => read.fieldFrom));
      const coordCoordStarts = new Set((expr.coordReads ?? []).map((read) => read.coordFrom));
      const binderStarts = new Set((expr.reductions ?? []).map((reduction) => reduction.binderFrom));
      for (const ident of expr.identifiers ?? []) {
        let role = "identifier";
        if (coordFieldStarts.has(ident.from)) role = "coordField";
        else if (coordCoordStarts.has(ident.from)) role = "coord";
        else if (binderStarts.has(ident.from)) role = "binder";
        out.push({
          type: "Reference",
          role,
          name: ident.value,
          from: ident.from,
          to: ident.to,
          statement: stmt,
          expression: expr,
        });
      }
    }
  }
  return out;
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
  // Recipe-scope declarations plus prior let-locals in the current block and
  // active reduction binders inside expression bodies.
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
  for (const stmt of cst?.statements ?? []) {
    for (const expr of stmt.expressions ?? []) {
      for (const reduction of expr.reductions ?? []) {
        if (reduction.bodyFrom <= pos && pos <= reduction.bodyTo) {
          symbols.push({
            type: "Symbol",
            kind: "binder",
            bucket: "locals",
            name: reduction.binder,
            from: reduction.binderFrom,
            to: reduction.binderTo,
            statement: stmt,
            expression: expr,
            reduction,
            block: stmt.block,
          });
        }
      }
    }
  }
  return symbols;
}

function classifyMode(stack) {
  for (let i = stack.length - 1; i >= 0; i--) {
    const keyword = stack[i].keyword;
    if (keyword === "?" || keyword === "when") continue;
    if (keyword === "for") return "initCellBody";
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
