// Field Lab DSL expression parser.

const EXPR_BINARY_PRECEDENCE = new Map([
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

export const EXPR_FUNC_TARGETS = new Map([
  ["clamp", "c.clamp"],
  ["smoothstep", "c.smoothstep"],
  ["max", "c.max"],
  ["min", "c.min"],
  ["abs", "c.abs"],
  ["hypot", "Math.hypot"],
  ["noise", "c.noise"],
  ["noise2", "c.noise2"],
  ["sin", "c.sin"],
  ["asin", "Math.asin"],
  ["cos", "c.cos"],
  ["exp", "c.exp"],
  ["sqrt", "c.sqrt"],
  ["pow", "c.pow"],
]);

export const EXPR_FUNC_ARITY = new Map([
  ["clamp", [3]],
  ["smoothstep", [3]],
  ["max", [1, 2]],
  ["min", [1, 2]],
  ["abs", [1]],
  ["hypot", [2]],
  ["noise", [1]],
  ["noise2", [2]],
  ["sin", [1]],
  ["asin", [1]],
  ["cos", [1]],
  ["exp", [1]],
  ["sqrt", [1]],
  ["pow", [2]],
]);

export const CLOCK_IDENTIFIERS = new Set(["dt", "frame"]);
export const GEO_IDENTIFIERS = new Set(["x", "y", "i", "lon", "lat", "u", "v", "px", "py", "pz", "N", "TAU", "PI"]);
export const STAMP_IDENTIFIERS = new Set(["r", ...GEO_IDENTIFIERS]);

export function tokenizeExpr(source) {
  const tokens = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }

    const number = /^(?:\d+\.\d*|\.\d+|\d+)(?:e[+-]?\d+)?/i.exec(source.slice(i));
    if (number) {
      tokens.push({ type: "number", value: number[0] });
      i += number[0].length;
      continue;
    }

    const ident = /^[A-Za-z_][A-Za-z0-9_]*/.exec(source.slice(i));
    if (ident) {
      let value = ident[0];
      if (value === "and") value = "&&";
      if (value === "or") value = "||";
      if (value === "not") value = "!";
      tokens.push(EXPR_BINARY_PRECEDENCE.has(value) || value === "!" ? { type: "op", value } : { type: "ident", value });
      i += ident[0].length;
      continue;
    }

    const op = ["===", "!==", "??", "&&", "||", ">=", "<=", "==", "!=", "+", "-", "*", "/", "%", ">", "<", "!", "?", ":", ".", "(", ")", ","]
      .find((candidate) => source.startsWith(candidate, i));
    if (op) {
      tokens.push({ type: EXPR_BINARY_PRECEDENCE.has(op) || op === "!" ? "op" : "punc", value: op });
      i += op.length;
      continue;
    }

    throw new Error(`Unexpected token in expression "${source}" at ${i}`);
  }
  tokens.push({ type: "eof", value: "" });
  return tokens;
}

export function parseExpr(tokens) {
  const parser = { tokens, index: 0 };
  const ast = parseConditional(parser);
  expect(parser, "eof");
  return ast;
}

function parseConditional(parser) {
  const test = parseBinary(parser, 0);
  if (!match(parser, "?")) return test;
  const consequent = parseConditional(parser);
  expect(parser, ":");
  const alternate = parseConditional(parser);
  return { type: "Conditional", test, consequent, alternate };
}

function parseBinary(parser, minPrec) {
  let left = parseUnary(parser);
  while (true) {
    const token = peek(parser);
    const prec = token.type === "op" ? EXPR_BINARY_PRECEDENCE.get(token.value) : undefined;
    if (prec === undefined || prec < minPrec) break;
    parser.index++;
    const right = parseBinary(parser, prec + 1);
    left = { type: "Binary", op: token.value, left, right };
  }
  return left;
}

function parseUnary(parser) {
  const token = peek(parser);
  if (token.value === "!" || token.value === "-" || token.value === "+") {
    parser.index++;
    return { type: "Unary", op: token.value, expr: parseUnary(parser) };
  }
  return parsePostfix(parser);
}

function parsePostfix(parser) {
  let expr = parsePrimary(parser);
  while (true) {
    if (match(parser, ".")) {
      const prop = expect(parser, "ident");
      expr = { type: "Member", object: expr, prop: prop.value };
      continue;
    }
    if (match(parser, "(")) {
      const args = [];
      if (!match(parser, ")")) {
        do {
          args.push(parseConditional(parser));
        } while (match(parser, ","));
        expect(parser, ")");
      }
      expr = { type: "Call", callee: expr, args };
      continue;
    }
    return expr;
  }
}

function parsePrimary(parser) {
  const token = peek(parser);
  if (token.type === "number") {
    parser.index++;
    return { type: "Number", value: token.value };
  }
  if (token.type === "ident") {
    parser.index++;
    return { type: "Identifier", name: token.value };
  }
  if (match(parser, "(")) {
    const expr = parseConditional(parser);
    expect(parser, ")");
    return expr;
  }
  throw new Error(`Expected expression, got ${token.value || token.type}`);
}

export function formatCallee(callee) {
  if (callee.type === "Identifier") return callee.name;
  if (callee.type === "Member") return `${formatCallee(callee.object)}.${callee.prop}`;
  return callee.type;
}

function peek(parser) {
  return parser.tokens[parser.index];
}

function match(parser, value) {
  if (peek(parser).value !== value) return false;
  parser.index++;
  return true;
}

function expect(parser, valueOrType) {
  const token = peek(parser);
  if (token.value === valueOrType || token.type === valueOrType) {
    parser.index++;
    return token;
  }
  throw new Error(`Expected ${valueOrType}, got ${token.value || token.type}`);
}
