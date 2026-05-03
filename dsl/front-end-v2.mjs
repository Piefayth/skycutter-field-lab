// Canonical v2 syntax front-end.
//
// Every layer should enter here over time:
//   source -> tolerant CST + optional strict compiler AST + parse errors
//
// The compiler still consumes parse-v2's existing AST shape. The editor
// consumes the CST. Keeping both under one facade lets us migrate callers
// without forcing a risky all-at-once parser rewrite.

import { parseDslCst } from "./cst-v2.mjs";
import { parseV2 } from "./parse-v2.mjs";

export function parseRecipeSource(source, options = {}) {
  const {
    tolerant = false,
    includeAst = true,
  } = options;
  source = String(source ?? "");
  const cst = parseDslCst(source);
  const errors = [...cst.errors];
  let ast = null;

  if (includeAst) {
    try {
      ast = parseV2(source);
    } catch (error) {
      const parseError = {
        type: "StrictParseError",
        message: error?.message ?? String(error),
        error,
      };
      errors.push(parseError);
      if (!tolerant) {
        const wrapped = new Error(parseError.message);
        wrapped.cause = error;
        wrapped.cst = cst;
        wrapped.errors = errors;
        throw wrapped;
      }
    }
  }

  return {
    type: "RecipeParseResult",
    source,
    cst,
    ast,
    errors,
    ok: errors.length === 0,
  };
}
