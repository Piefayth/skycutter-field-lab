// Field Lab DSL expression parser.
//
// Symbol metadata (math fns, builtins, geo constants) is owned by
// `dsl-spec.mjs`. The Map / Set exports below are derived projections
// for the parser's hot path — adding a math function or a builtin only
// requires editing dsl-spec.mjs.

import {
  MATH_FUNCTIONS,
  CLOCK_BUILTINS,
  GEO_BUILTINS,
  GEO_CONSTANTS,
  STAMP_EXTRAS,
} from "./dsl-spec.mjs";

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

// Math fn → compile-time callee. Derived from MATH_FUNCTIONS in dsl-spec.
export const EXPR_FUNC_TARGETS = new Map(
  MATH_FUNCTIONS.map((m) => [m.name, m.target]),
);

// Math fn → allowed argument counts. Derived from MATH_FUNCTIONS.
export const EXPR_FUNC_ARITY = new Map(
  MATH_FUNCTIONS.map((m) => [m.name, m.arity]),
);

export const CLOCK_IDENTIFIERS = new Set(CLOCK_BUILTINS.map((b) => b.name));
export const GEO_IDENTIFIERS = new Set(
  [...GEO_BUILTINS, ...GEO_CONSTANTS].map((b) => b.name),
);
export const STAMP_IDENTIFIERS = new Set([
  ...STAMP_EXTRAS.map((s) => s.name),
  ...GEO_IDENTIFIERS,
]);

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

    const op = ["===", "!==", "??", "&&", "||", ">=", "<=", "==", "!=", "+", "-", "*", "/", "%", ">", "<", "!", "?", ":", ".", "(", ")", ",", "{", "}"]
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
    // Neighbor reduction: `neighbor MOD BIND in FIELD { EXPR }`. Disambiguated
    // by lookahead — only fires when followed by a recognized modifier; an
    // identifier named `neighbor` used in any other position falls through
    // to the regular Identifier branch (ill-advised but not parser-broken).
    if (token.value === "neighbor") {
      const nrAst = tryParseNeighborReduce(parser);
      if (nrAst) return nrAst;
    }
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

const NEIGHBOR_REDUCTION_OPS = new Set(["sum", "max", "min", "mean"]);

// Parse `neighbor MOD BIND in FIELD { EXPR }`, returning a NeighborReduce
// AST node with `bindings` always a length-1 array (the IR is
// future-proofed for multi-binding; the syntax is single-binding for now).
// If the lookahead doesn't match (the token after `neighbor` isn't one of
// the known modifiers), returns null and the caller falls back to the
// plain identifier path.
function tryParseNeighborReduce(parser) {
  const start = parser.index;
  const headTok = peek(parser);
  if (headTok.type !== "ident" || headTok.value !== "neighbor") return null;
  const modTok = parser.tokens[parser.index + 1];
  if (!modTok || modTok.type !== "ident" || !NEIGHBOR_REDUCTION_OPS.has(modTok.value)) return null;

  // Commit: consume `neighbor MOD`.
  parser.index += 2;
  const op = modTok.value;

  // Bind name.
  const bindTok = expect(parser, "ident");

  // `in` keyword. Tokenized as a regular ident; we accept it contextually.
  const inTok = peek(parser);
  if (inTok.type !== "ident" || inTok.value !== "in") {
    throw new Error(`neighbor ${op}: expected 'in', got '${inTok.value || inTok.type}'`);
  }
  parser.index++;

  // Field name.
  const fieldTok = expect(parser, "ident");

  // `{ body }`.
  if (!match(parser, "{")) {
    throw new Error(`neighbor ${op} ${bindTok.value} in ${fieldTok.value}: expected '{' before reduction body`);
  }
  const body = parseConditional(parser);
  if (!match(parser, "}")) {
    throw new Error(`neighbor ${op} ${bindTok.value} in ${fieldTok.value}: expected '}' after reduction body`);
  }

  return {
    type: "NeighborReduce",
    op,
    bindings: [{ name: bindTok.value, field: fieldTok.value }],
    body,
  };
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
