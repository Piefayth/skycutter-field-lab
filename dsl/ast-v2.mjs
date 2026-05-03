// Compatibility projection over the tolerant v2 CST front-end.
//
// Editor features originally consumed this module as a lightweight AST scanner.
// Keep that stable surface while moving the real syntax work into cst-v2.mjs.

import {
  blockStackAt as cstBlockStackAt,
  cursorContextAt,
  parseDslCst,
} from "./cst-v2.mjs";

const KNOWN_BLOCKS = new Set([
  "views", "stamps", "scenarios",
  "palette", "view", "stamp", "scenario",
  "step", "stage", "cell", "when", "for",
]);

export function parseDslAst(source) {
  const cst = parseDslCst(source);
  const blocks = cst.blocks.filter((block) => KNOWN_BLOCKS.has(block.keyword));
  return {
    type: "DslEditorAst",
    source: cst.source,
    cst,
    blocks,
    statements: cst.statements,
    symbols: cst.symbols,
    names: cst.names,
    errors: cst.errors,
  };
}

export function blockStackAt(ast, pos) {
  return cstBlockStackAt(ast?.cst ?? ast, pos);
}

export function innermostBlockAt(ast, pos) {
  const stack = blockStackAt(ast, pos);
  return stack[stack.length - 1] ?? null;
}

export function cursorContextForAst(ast, pos) {
  return cursorContextAt(ast?.cst ?? ast, pos);
}

export function foldRangeForLine(ast, lineStart, lineEnd) {
  const candidates = (ast?.blocks ?? [])
    .filter((block) => block.openBrace >= lineStart && block.openBrace < lineEnd && block.closeBrace > block.openBrace)
    .sort((a, b) => a.openBrace - b.openBrace);
  const block = candidates[0];
  if (!block) return null;
  return { from: block.openBrace + 1, to: block.closeBrace };
}

export function defaultFoldRanges(ast, sectionNames = ["views", "stamps", "scenarios"]) {
  const wanted = new Set(sectionNames);
  return (ast?.blocks ?? [])
    .filter((block) => wanted.has(block.keyword) && block.closeBrace > block.openBrace)
    .map((block) => ({ from: block.openBrace + 1, to: block.closeBrace }));
}

export function blockDepthAt(ast, pos) {
  return blockStackAt(ast, pos).length;
}

export function lineIndentDepth(ast, source, lineStart) {
  source = String(source ?? "");
  let depth = blockDepthAt(ast, lineStart);
  const rest = source.slice(lineStart);
  const first = /^[ \t]*(.)/.exec(rest)?.[1] ?? "";
  if (first === "}") depth--;
  return Math.max(0, depth);
}
