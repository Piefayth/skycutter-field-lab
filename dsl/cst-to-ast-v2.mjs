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

export function cellActionsCstToAst(cst, cellBlock) {
  const statements = [...(cellBlock?.statements ?? [])]
    .filter((stmt) => ["let", "set", "add", "when"].includes(stmt.keyword))
    .sort((a, b) => a.from - b.from);
  return statements.map((stmt) => cellActionCstToAst(cst, stmt));
}

export function cellActionCstToAst(cst, stmt) {
  if (!stmt || stmt.type !== "Statement") throw new Error("v2 CST projection: missing cell action statement");
  if (stmt.keyword === "let") {
    if (!stmt.parts.local?.name) throw new Error("v2 CST projection: incomplete let action");
    return {
      type: "let",
      name: stmt.parts.local.name,
      expr: expressionCstToAst(firstExpression(stmt)),
    };
  }
  if (stmt.keyword === "set" || stmt.keyword === "add") {
    if (!stmt.parts.target?.name) throw new Error(`v2 CST projection: incomplete ${stmt.keyword} action`);
    return {
      type: stmt.keyword,
      field: stmt.parts.target.name,
      expr: expressionCstToAst(firstExpression(stmt)),
    };
  }
  if (stmt.keyword === "when") {
    const whenBlock = findBlockForStatement(cst, stmt, "when");
    return {
      type: "when",
      condition: expressionCstToAst(firstExpression(stmt)),
      actions: cellActionsCstToAst(cst, whenBlock),
    };
  }
  throw new Error(`v2 CST projection: unsupported cell action ${stmt.keyword}`);
}

export function stageCstToAst(cst, stageBlock) {
  if (!stageBlock || stageBlock.keyword !== "stage") {
    throw new Error("v2 CST projection: expected stage block");
  }
  const reads = [];
  const writes = [];
  const previousReads = new Set();
  const statements = [];
  for (const stmt of [...(stageBlock.statements ?? [])].sort((a, b) => a.from - b.from)) {
    if (stmt.keyword === "reads") {
      for (const item of fieldListFromStatement(stmt)) {
        reads.push(item.name);
        if (item.previous) previousReads.add(item.name);
      }
    } else if (stmt.keyword === "writes") {
      for (const item of fieldListFromStatement(stmt)) writes.push(item.name);
    }
  }
  const cellBlock = (stageBlock.children ?? []).find((block) => block.keyword === "cell");
  if (cellBlock) {
    statements.push({ type: "cell", actions: cellActionsCstToAst(cst, cellBlock) });
  }
  return {
    id: stageBlock.id,
    name: stageLabel(cst, stageBlock),
    reads: dedupe(reads),
    writes: dedupe(writes),
    declares: [],
    body: { statements },
    previousReads: [...previousReads],
  };
}

function fieldListFromStatement(stmt) {
  const afterKeyword = stmt.cleanText.slice(stmt.cleanText.indexOf(stmt.keyword) + stmt.keyword.length);
  const items = [];
  for (const part of afterKeyword.split(",")) {
    const words = [...part.matchAll(/\b[A-Za-z_][A-Za-z0-9_]*\b/g)].map((m) => m[0]);
    if (words.length === 0) continue;
    items.push({ name: words[0], previous: words.includes("previous") });
  }
  return items;
}

function stageLabel(cst, stageBlock) {
  const header = cst.source.slice(stageBlock.headerFrom, stageBlock.headerTo);
  const label = /"([^"]*)"/.exec(header);
  return label ? label[1] : stageBlock.id;
}

function dedupe(values) {
  return [...new Set(values)];
}

function firstExpression(stmt) {
  const expr = stmt.expressions?.[0]?.node;
  if (!expr) throw new Error(`v2 CST projection: ${stmt.keyword} action is missing expression`);
  return expr;
}

function findBlockForStatement(cst, stmt, keyword) {
  const block = (cst?.blocks ?? [])
    .filter((candidate) => candidate.keyword === keyword && candidate.from === stmt.from)
    .sort((a, b) => a.openBrace - b.openBrace)[0];
  if (!block) throw new Error(`v2 CST projection: missing ${keyword} block for statement`);
  return block;
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
