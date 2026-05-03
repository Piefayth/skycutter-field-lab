// Shared JavaScript evaluator for parsed DSL expression ASTs.
//
// Parsing and validation live elsewhere; this module only walks an
// already-validated expression and delegates identifier/function meaning
// to the caller's runtime context.

export function evalExpression(ast, {
  resolveIdentifier,
  callFunction,
  evalNeighborReduce = null,
} = {}) {
  if (ast === undefined || ast === null || ast === "") throw new Error("missing expression");
  if (typeof ast === "number") return ast;
  switch (ast.type) {
    case "Number":
      return Number(ast.value);
    case "Identifier":
      return resolveIdentifier?.(ast.name);
    case "Member": {
      const object = evalExpression(ast.object, { resolveIdentifier, callFunction, evalNeighborReduce });
      if (object == null || !Object.hasOwn(object, ast.prop)) {
        throw new Error(`unknown expression property ${ast.prop}`);
      }
      return object[ast.prop];
    }
    case "Unary":
      return evalUnary(ast.op, evalExpression(ast.expr, { resolveIdentifier, callFunction, evalNeighborReduce }));
    case "Binary":
      return evalBinary(
        ast.op,
        () => evalExpression(ast.left, { resolveIdentifier, callFunction, evalNeighborReduce }),
        () => evalExpression(ast.right, { resolveIdentifier, callFunction, evalNeighborReduce }),
      );
    case "Conditional":
      return evalExpression(ast.test, { resolveIdentifier, callFunction, evalNeighborReduce })
        ? evalExpression(ast.consequent, { resolveIdentifier, callFunction, evalNeighborReduce })
        : evalExpression(ast.alternate, { resolveIdentifier, callFunction, evalNeighborReduce });
    case "Call": {
      const name = ast.callee.type === "Identifier" ? ast.callee.name : null;
      const args = ast.args.map((arg) => evalExpression(arg, { resolveIdentifier, callFunction, evalNeighborReduce }));
      return callFunction?.(name, args, ast);
    }
    case "NeighborReduce":
      if (typeof evalNeighborReduce !== "function") {
        throw new Error("neighbor reductions are not available in this expression context");
      }
      return evalNeighborReduce(ast, { resolveIdentifier, callFunction });
    default:
      throw new Error(`unknown expression node ${ast.type}`);
  }
}

function evalUnary(op, value) {
  if (op === "-") return -value;
  if (op === "+") return +value;
  if (op === "!") return !value;
  throw new Error(`unknown unary op ${op}`);
}

function evalBinary(op, leftFn, rightFn) {
  if (op === "??") {
    const left = leftFn();
    return left ?? rightFn();
  }
  if (op === "||") return leftFn() || rightFn();
  if (op === "&&") return leftFn() && rightFn();
  const left = leftFn();
  const right = rightFn();
  // Vec2-aware arithmetic. The init runtime emits `{ __vec2: true,
  // x, y }` from vec2(x, y). Element-wise operators broadcast scalar
  // operands; vec-vec ops are component-wise. Comparisons stay
  // scalar-only (a comparison on a vec2 is almost certainly a bug).
  if (isV(left) || isV(right)) return evalVecBinary(op, left, right);
  switch (op) {
    case "===": return left === right;
    case "!==": return left !== right;
    case "==": return left == right;
    case "!=": return left != right;
    case ">": return left > right;
    case ">=": return left >= right;
    case "<": return left < right;
    case "<=": return left <= right;
    case "+": return left + right;
    case "-": return left - right;
    case "*": return left * right;
    case "/": return left / right;
    case "%": return left % right;
    default: throw new Error(`unknown binary op ${op}`);
  }
}

function isV(v) {
  return v && typeof v === "object" && v.__vec2 === true;
}

function evalVecBinary(op, left, right) {
  if (op !== "+" && op !== "-" && op !== "*" && op !== "/") {
    throw new Error(`vec2 ${op} is not supported (only +, -, *, /)`);
  }
  const lx = isV(left) ? left.x : Number(left);
  const ly = isV(left) ? left.y : Number(left);
  const rx = isV(right) ? right.x : Number(right);
  const ry = isV(right) ? right.y : Number(right);
  let x; let y;
  switch (op) {
    case "+": x = lx + rx; y = ly + ry; break;
    case "-": x = lx - rx; y = ly - ry; break;
    case "*": x = lx * rx; y = ly * ry; break;
    case "/": x = lx / rx; y = ly / ry; break;
    default: throw new Error(`vec2 ${op} is not supported`);
  }
  return { __vec2: true, x, y };
}
