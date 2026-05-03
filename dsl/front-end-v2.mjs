// Canonical v2 syntax front-end.
//
// Every layer should enter here over time:
//   source -> tolerant CST + optional strict compiler AST + parse errors
//
// The compiler consumes the CST-projected version of the v2 AST shape. The
// tolerant CST is always produced; strict callers additionally ask the
// projection layer to reject incomplete or misplaced syntax.

import { parseDslCst } from "./cst-v2.mjs";
import { recipeCstToAst } from "./cst-to-ast-v2.mjs";

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
    if (errors.length === 0) {
      try {
        ast = recipeCstToAst(cst, { strict: true });
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
    } else if (!tolerant) {
      const first = errors[0];
      const wrapped = new Error(first.message ?? "v2 CST parse: syntax error");
      wrapped.cst = cst;
      wrapped.errors = errors;
      throw wrapped;
    } else if (!errors.some((error) => error.type === "StrictParseError")) {
      errors.push({
        type: "StrictParseError",
        message: errors[0]?.message ?? "v2 CST parse: syntax error",
      });
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
