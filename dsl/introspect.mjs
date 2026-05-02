// Lightweight DSL metadata extraction for editor/UI surfaces.

import { parseTopLevelDeclarations } from "./parse.mjs";

export function extractDslNames(source) {
  try {
    const schema = parseTopLevelDeclarations(String(source ?? ""));
    const fieldNames = (schema.fields ?? [])
      .filter((decl) => decl?.kind !== "source")
      .map((decl) => decl?.name)
      .filter(Boolean);
    const sourceNames = (schema.sources ?? [])
      .map((decl) => decl?.name)
      .filter(Boolean);
    const parameterNames = (schema.parameters ?? [])
      .map((decl) => decl?.name)
      .filter(Boolean);
    const constantNames = (schema.constants ?? [])
      .map((decl) => decl?.name)
      .filter(Boolean);
    const planetNames = Object.keys(schema.planet ?? {});
    return {
      fields: unique(fieldNames),
      sources: unique(sourceNames),
      parameters: unique(parameterNames),
      constants: unique(constantNames),
      planet: unique(planetNames),
      immutables: unique([...parameterNames, ...constantNames, ...planetNames]),
    };
  } catch {
    return {
      fields: [],
      sources: [],
      parameters: [],
      constants: [],
      planet: [],
      immutables: [],
    };
  }
}

function unique(names) {
  return [...new Set(names.map((name) => String(name ?? "").trim()).filter(Boolean))];
}
