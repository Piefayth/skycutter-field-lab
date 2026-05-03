// Projection from tolerant v2 CST expression nodes to the existing compiler
// expression AST shape. This is intentionally expression-only for now; statement
// and recipe projection will move over once parity coverage is broad enough.

export function expressionCstToAst(node) {
  if (!node || typeof node !== "object") throw new Error("v2 CST projection: missing expression node");
  switch (node.type) {
    case "ExprNumber":
      return { type: "Number", value: node.value };
    case "ExprIdentifier":
      return { type: "Identifier", name: node.name };
    case "ExprUnary":
      return { type: "Unary", op: node.op, expr: expressionCstToAst(node.expr) };
    case "ExprBinary":
      return {
        type: "Binary",
        op: node.op,
        left: expressionCstToAst(node.left),
        right: expressionCstToAst(node.right),
      };
    case "ExprConditional":
      return {
        type: "Conditional",
        test: expressionCstToAst(node.test),
        consequent: expressionCstToAst(node.consequent),
        alternate: expressionCstToAst(node.alternate),
      };
    case "ExprGroup":
      return expressionCstToAst(node.expr);
    case "ExprMember":
      return projectMember(node);
    case "ExprCall":
      return {
        type: "Call",
        callee: expressionCstToAst(node.callee),
        args: node.args.map(expressionCstToAst),
      };
    case "ExprCoordRead":
      return projectCoordRead(node);
    case "ExprNeighborReduce":
      return {
        type: "NeighborReduce",
        op: node.op,
        coord: node.binder,
        body: expressionCstToAst(node.body),
      };
    case "ExprMissing":
      throw new Error(`v2 CST projection: incomplete ${node.label ?? "expression"}`);
    case "ExprUnknown":
      throw new Error(`v2 CST projection: unknown expression token "${node.value}"`);
    default:
      throw new Error(`v2 CST projection: unsupported expression node ${node.type}`);
  }
}

function projectMember(node) {
  if (!node.prop) throw new Error("v2 CST projection: incomplete member access");
  const object = expressionCstToAst(node.object);
  if (object.type === "Identifier" && object.name === "brush") {
    return { type: "Identifier", name: node.prop };
  }
  return { type: "Member", object, prop: node.prop };
}

function projectCoordRead(node) {
  if (!node.field) {
    throw new Error("v2 CST projection: @ coordinate query must follow a bare field name");
  }
  if (!node.coord) {
    throw new Error("v2 CST projection: expected coordinate name after @");
  }
  if (node.coord === "prev") {
    return { type: "CoordRead", field: node.field, coord: { kind: "prev" } };
  }
  if (node.coord === "upstream") {
    if (node.args.length !== 3) {
      throw new Error(`v2 CST projection: ${node.field}@upstream takes exactly 3 args; got ${node.args.length}`);
    }
    return {
      type: "CoordRead",
      field: node.field,
      coord: {
        kind: "upstream",
        velX: expressionCstToAst(node.args[0]),
        velY: expressionCstToAst(node.args[1]),
        dt: expressionCstToAst(node.args[2]),
      },
    };
  }
  return { type: "CoordRead", field: node.field, coord: { kind: "neighbor", binding: node.coord } };
}
