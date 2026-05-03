// Lightweight DSL metadata extraction for editor/UI surfaces.

import { parseDslAst } from "./ast-v2.mjs";

export function extractDslNames(source) {
  const names = parseDslAst(source).names;
  return {
    fields: names.fields,
    sources: names.sources,
    parameters: names.parameters,
    constants: names.constants,
    planet: names.planet,
    immutables: names.immutables,
  };
}
