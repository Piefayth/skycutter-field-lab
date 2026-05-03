// Symbol-table projections for v1-shape validators.
//
// Originally a full expression parser (parseExpr / tokenizeExpr +
// recursive-descent precedence machinery), but v2 owns the parsing
// path now via cst-v2.mjs + cst-to-ast-v2.mjs. The only remaining
// consumer (dsl/validate.mjs) imports just the symbol-table maps
// and `formatCallee`, so the parser proper has been removed and
// this file is now ~50 lines instead of 255.
//
// Filename kept to minimize import churn — `import {...} from
// "./expr-parser.mjs"` still works. Worth renaming to something
// like `validator-symbols.mjs` in a follow-up cleanup pass; the
// file is no longer a parser.

import {
  MATH_FUNCTIONS,
  CLOCK_BUILTINS,
  GEO_BUILTINS,
  GEO_CONSTANTS,
  STAMP_EXTRAS,
} from "./dsl-spec.mjs";

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

// Render a Member or Identifier callee back to dotted-form for error
// messages.
export function formatCallee(callee) {
  if (callee.type === "Identifier") return callee.name;
  if (callee.type === "Member") return `${formatCallee(callee.object)}.${callee.prop}`;
  return callee.type;
}
