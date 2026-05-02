// Field Lab DSL compiler.
//
// Design intent:
// - Text is canonical. The graph is derived from named stages and their
//   declared reads/writes.
// - The language is deliberately bounded: declarations describe field
//   dependencies; stage bodies are first-class DSL statements that compile
//   to the current script-shape kernel code.
// - Feedback across frames stays in fields; within one step the compiler
//   emits an acyclic pipeline sorted by declared dependencies.
//
// Syntax v0:
//
//   recipe "Weather"
//   summary "Forcing-driven weather pipeline."
//   recommendedPreset weather
//   grid geodesic tiles 48
//
//   planet gravity 9.81
//   planet radius 6.371e6
//   const rainoutRate 0.024
//
//   use clock dt, frame
//   use geo lon, lat, px, py, pz, N, PI, TAU
//   use sim wind, advect, diffuse, clamp, normalize, cell, event, each
//   use core clamp, smoothstep, max, min, abs, hypot, noise, sample
//
//   field pressure, moisture, cloud
//   source moistureSource, heatSource
//
//   setting simRateHz slider min 0 max 360 step 1 default 90 label "SIM RATE"
//   param enableForcing boolean default true label "sources / sinks"
//
//   preset weather "Weather" {
//     fill pressure 0
//     region cloud lon -0.6..0.6 lat 0..PI/2 amount 1
//     spot pressure lon 0 lat 0 radius 0.5 amount -1
//     eachCell {
//       set heatSource = cos(lat)
//     }
//   }
//
//   stamp stormSeed "Storm seed" {
//     spot pressure lon lon lat lat radius r * 1.35 amount -0.72
//     spot moisture lon lon lat lat radius r * 1.6 amount 0.44
//   }
//
//   stage id "Human name" {
//     reads fieldA, fieldB
//     writes fieldC, fieldD
//     cell {
//       add fieldC = fieldA - fieldB
//     }
//   }
//
// Or, for first-class primitives:
//
//   stage wind "Wind" {
//     reads pressure
//     declares windU, windV, lift
//     wind pressure -> windU, windV, lift strength params.windStrength
//   }
//
// `reads` are used to derive topology edges. `writes` and `declares` become output ports.
// `writes` mutate recipe fields. `declares` introduce pipeline-scoped temporary fields.
// Stage logic is constrained to DSL primitives and expression helpers so the
// graph, editor, validator, and generated UI can inspect the whole recipe.

export function compileDsl(source) {
  const schema = parseTopLevelDeclarations(source);
  const presets = parsePresets(source);
  const stamps = parseStamps(source);
  const stages = parseStages(source);
  annotateStageParamRefs(stages, schema);
  validateNameUniqueness(schema, stages);
  validatePresets(presets, schema);
  validateStamps(stamps, schema);
  validateStages(stages, schema);
  const declared = buildDeclaredPipelineSummary(stages);
  const nodes = {};
  for (const stage of stages) {
    const outputs = [...stage.writes, ...stage.declares];
    nodes[stage.id] = {
      name: stage.name,
      dsl: {
        reads: stage.reads,
        writes: stage.writes,
        declares: stage.declares,
        outputs,
        params: stage.params,
        body: stage.body,
      },
      run: stage.code,
    };
  }
  return {
    nodes,
    edges: deriveEdges(stages),
    dsl: {
      recipe: schema.recipe,
      grid: schema.grid,
      planet: schema.planet,
      constants: schema.constants,
      resolution: schema.resolution,
      imports: schema.imports,
      sources: schema.sources,
      fields: schema.fields,
      declared,
      settings: schema.settings,
      parameters: schema.parameters,
      presets,
      stamps,
      stages: stages.map(({ id, name, reads, writes, declares, params, body }) => ({ id, name, reads, writes, declares, outputs: [...writes, ...declares], params, body })),
    },
  };
}

export function diagnoseDsl(source) {
  try {
    const schema = parseTopLevelDeclarations(source);
    const presets = parsePresets(source);
    const stamps = parseStamps(source);
    const stages = parseStages(source);
    annotateStageParamRefs(stages, schema);
    validateNameUniqueness(schema, stages);
    validatePresets(presets, schema);
    validateStamps(stamps, schema);
    validateStages(stages, schema);
    const declared = buildDeclaredPipelineSummary(stages);
    return {
      ok: true,
      errors: [],
      recipe: schema.recipe,
      grid: schema.grid,
      planet: schema.planet,
      constants: schema.constants,
      resolution: schema.resolution,
      imports: schema.imports,
      sources: schema.sources,
      fields: schema.fields,
      declared,
      settings: schema.settings,
      parameters: schema.parameters,
      presets,
      stamps,
      stages: stages.map(({ id, name, reads, writes, declares, params, body }) => ({ id, name, reads, writes, declares, outputs: [...writes, ...declares], params, body })),
    };
  } catch (error) {
    return {
      ok: false,
      errors: [{
        message: error.message,
      }],
      stages: [],
    };
  }
}

export function parseTopLevelDeclarations(source) {
  const recipe = {};
  const planet = {};
  const constants = [];
  let grid = null;
  const imports = [];
  const fields = [];
  const sources = [];
  const settings = [];
  const parameters = [];
  let i = 0;
  while (i < source.length) {
    const lineStart = i;
    const lineEnd = source.indexOf("\n", i);
    const end = lineEnd === -1 ? source.length : lineEnd;
    const rawLine = source.slice(lineStart, end);
    const trimmed = rawLine.trim();
    const contentStart = lineStart + rawLine.search(/\S|$/);

    if (!trimmed || trimmed.startsWith("//")) {
      i = end + 1;
      continue;
    }

    if (startsWithKeyword(source, contentStart, "stage")) {
      i = skipStageBlock(source, contentStart);
      continue;
    }
    if (startsWithKeyword(source, contentStart, "preset")) {
      i = skipNamedBlock(source, contentStart, "preset");
      continue;
    }
    if (startsWithKeyword(source, contentStart, "stamp")) {
      i = skipNamedBlock(source, contentStart, "stamp");
      continue;
    }

    if (startsWithKeyword(source, contentStart, "recipe")) {
      recipe.name = parseQuotedOrBareDirective(trimmed, "recipe");
    } else if (startsWithKeyword(source, contentStart, "summary")) {
      recipe.summary = parseQuotedOrBareDirective(trimmed, "summary");
    } else if (startsWithKeyword(source, contentStart, "recommendedPreset")) {
      recipe.recommendedPreset = parseQuotedOrBareDirective(trimmed, "recommendedPreset");
    } else if (startsWithKeyword(source, contentStart, "planet")) {
      const decl = parsePlanetDirective(trimmed);
      planet[decl.name] = decl.value;
    } else if (startsWithKeyword(source, contentStart, "const")) {
      constants.push(parseConstDirective(trimmed));
    } else if (startsWithKeyword(source, contentStart, "grid")) {
      grid = parseGridDirective(trimmed);
    } else if (startsWithKeyword(source, contentStart, "use")) {
      imports.push(parseUseDirective(trimmed));
    } else if (startsWithKeyword(source, contentStart, "field")) {
      fields.push(...parseFieldDirective(trimmed, "field", "field"));
    } else if (startsWithKeyword(source, contentStart, "source")) {
      sources.push(...parseFieldDirective(trimmed, "source", "source"));
    } else if (startsWithKeyword(source, contentStart, "setting")) {
      settings.push(parseControlDirective(trimmed, "setting"));
    } else if (startsWithKeyword(source, contentStart, "param")) {
      parameters.push(parseControlDirective(trimmed, "param"));
    }

    i = end + 1;
  }
  return {
    recipe,
    grid: grid ?? { kind: "geodesic", frequency: 64, tiles: 64 },
    planet,
    constants: uniqueDecls(constants),
    resolution: {},
    imports,
    sources: uniqueDecls(sources),
    fields: uniqueDecls([...fields, ...sources]),
    settings: uniqueDecls(settings),
    parameters: uniqueDecls(parameters),
  };
}

export function parsePresets(source) {
  return parseActionBlocks(source, "preset", parsePresetBody);
}

export function parseStamps(source) {
  return parseActionBlocks(source, "stamp", parsePresetBody);
}

function parseActionBlocks(source, keyword, parseBody) {
  const blocks = [];
  let i = 0;
  while (i < source.length) {
    const next = findNextKeyword(source, keyword, i);
    if (next === -1) break;
    i = next + keyword.length;
    i = skipWs(source, i);
    const id = readIdent(source, i);
    i = id.end;
    i = skipWs(source, i);
    const label = source[i] === "\"" ? readString(source, i) : { value: id.value, end: i };
    i = skipWs(source, label.end);
    if (source[i] !== "{") throw new Error(`Expected "{" after ${keyword} ${id.value}`);
    const block = readBlock(source, i);
    blocks.push({
      id: id.value,
      label: label.value,
      actions: parseBody(block.value),
    });
    i = block.end;
  }
  return blocks;
}

export function parseStages(source) {
  const stages = [];
  let i = 0;
  while (i < source.length) {
    const next = findNextKeyword(source, "stage", i);
    if (next === -1) break;
    i = next + "stage".length;
    i = skipWs(source, i);
    const id = readIdent(source, i);
    i = id.end;
    i = skipWs(source, i);
    const name = source[i] === "\"" ? readString(source, i) : { value: id.value, end: i };
    i = skipWs(source, name.end);
    if (source[i] !== "{") throw new Error(`Expected "{" after stage ${id.value}`);
    const block = readBlock(source, i);
    stages.push(parseStageBlock(id.value, name.value, block.value));
    i = block.end;
  }
  if (stages.length === 0) throw new Error("DSL contains no stages");
  return stages;
}

function skipStageBlock(source, start) {
  return skipNamedBlock(source, start, "stage");
}

function skipNamedBlock(source, start, keyword) {
  let i = start + keyword.length;
  i = skipWs(source, i);
  const id = readIdent(source, i);
  i = skipWs(source, id.end);
  if (source[i] === "\"") {
    const name = readString(source, i);
    i = skipWs(source, name.end);
  }
  if (source[i] !== "{") throw new Error(`Expected "{" after ${keyword} ${id.value}`);
  return readBlock(source, i).end;
}

function parseFieldDirective(line, keyword, kind) {
  return line
    .replace(new RegExp(`^${keyword}\\s+`), "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((name) => ({ name, kind }));
}

function parseQuotedOrBareDirective(line, key) {
  const rest = line.replace(new RegExp(`^${key}\\s+`), "").trim();
  if (!rest) throw new Error(`Invalid ${key} declaration: ${line}`);
  if (rest.startsWith("\"")) {
    const parsed = readString(rest, 0);
    return parsed.value;
  }
  return rest;
}

function parsePlanetDirective(line) {
  const match = /^planet\s+([A-Za-z_][A-Za-z0-9_]*)\s+(.+)$/.exec(line);
  if (!match) throw new Error(`Invalid planet declaration: ${line}`);
  const [, name, rawValue] = match;
  return { name, value: parseLiteralToken(rawValue.trim(), line) };
}

function parseConstDirective(line) {
  const match = /^const\s+([A-Za-z_][A-Za-z0-9_]*)\s+(.+)$/.exec(line);
  if (!match) throw new Error(`Invalid const declaration: ${line}`);
  const [, name, rawValue] = match;
  return { name, value: parseLiteralToken(rawValue.trim(), line) };
}

function parseGridDirective(line) {
  const match = /^grid\s+geodesic(?:\s+(?:frequency|tiles|tileSize)\s+|\s+)(\d+)$/.exec(line);
  if (match) {
    const frequency = Number(match[1]);
    if (!Number.isInteger(frequency) || frequency < 1 || frequency > 512) {
      throw new Error(`Geodesic grid frequency must be 1..512: ${line}`);
    }
    return { kind: "geodesic", frequency, tiles: frequency };
  }
  throw new Error(`Invalid grid declaration: ${line}`);
}

function parseUseDirective(line) {
  const match = /^use\s+([A-Za-z_][A-Za-z0-9_]*)\s+(.+)$/.exec(line);
  if (!match) throw new Error(`Invalid use declaration: ${line}`);
  const [, from, names] = match;
  return {
    from,
    names: names
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean),
  };
}

function parsePresetBody(body) {
  const lines = body
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("//"));
  const actions = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let match = /^fill\s+(\w+)\s+(.+)$/.exec(line);
    if (match) {
      actions.push({ type: "fill", field: match[1], value: parseExpr(tokenizeExpr(match[2])) });
      continue;
    }

    match = /^spot\s+(\w+)\s+lon\s+(.+?)\s+lat\s+(.+?)\s+radius\s+(.+?)\s+amount\s+(.+)$/.exec(line);
    if (match) {
      actions.push({
        type: "spot",
        field: match[1],
        lon: parseExpr(tokenizeExpr(match[2])),
        lat: parseExpr(tokenizeExpr(match[3])),
        radius: parseExpr(tokenizeExpr(match[4])),
        amount: parseExpr(tokenizeExpr(match[5])),
      });
      continue;
    }

    match = /^ellipse\s+(\w+)\s+lon\s+(.+?)\s+lat\s+(.+?)\s+rx\s+(.+?)\s+ry\s+(.+?)\s+amount\s+(.+?)(?:\s+angle\s+(.+))?$/.exec(line);
    if (match) {
      actions.push({
        type: "ellipse",
        center: "lonlat",
        field: match[1],
        lon: parseExpr(tokenizeExpr(match[2])),
        lat: parseExpr(tokenizeExpr(match[3])),
        rx: parseExpr(tokenizeExpr(match[4])),
        ry: parseExpr(tokenizeExpr(match[5])),
        amount: parseExpr(tokenizeExpr(match[6])),
        angle: parseExpr(tokenizeExpr(match[7] ?? "0")),
      });
      continue;
    }

    match = /^region\s+(\w+)\s+lon\s+(.+?)\s+lat\s+(.+?)\s+amount\s+(.+)$/.exec(line);
    if (match) {
      const lon = parseRangeExpr(match[2], line);
      const lat = parseRangeExpr(match[3], line);
      actions.push({
        type: "region",
        field: match[1],
        lonMin: lon.min,
        lonMax: lon.max,
        latMin: lat.min,
        latMax: lat.max,
        amount: parseExpr(tokenizeExpr(match[4])),
      });
      continue;
    }

    if (line === "eachCell {") {
      const block = collectNamedBlock(lines, i, "eachCell");
      actions.push({
        type: "eachCell",
        actions: parseActionLines(block.actions, "preset"),
      });
      i = block.endIndex;
      continue;
    }

    throw new Error(`Unknown preset action: ${line}`);
  }
  return actions;
}

function parseRangeExpr(source, line) {
  const parts = String(source).split(/\s*\.\.\s*/);
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(`Invalid region range in: ${line}`);
  }
  return {
    min: parseExpr(tokenizeExpr(parts[0])),
    max: parseExpr(tokenizeExpr(parts[1])),
  };
}

function parseControlDirective(line, keyword) {
  const tokens = tokenizeDirective(line);
  const [, name, kind = "slider", ...rest] = tokens;
  if (!name) throw new Error(`Invalid ${keyword} declaration: ${line}`);
  const isBoolean = kind === "boolean" || kind === "checkbox" || kind === "toggle";
  const decl = {
    name,
    kind: keyword,
    type: isBoolean ? "boolean" : "number",
  };
  if (!isBoolean) decl.control = kind === "number" ? "slider" : kind;

  for (let i = 0; i < rest.length; i++) {
    const key = rest[i];
    const value = rest[i + 1];
    if (key === "range") {
      decl.min = numberToken(value, line);
      decl.max = numberToken(rest[i + 2], line);
      i += 2;
    } else if (key === "min" || key === "max" || key === "step") {
      decl[key] = numberToken(value, line);
      i++;
    } else if (key === "default") {
      decl.default = isBoolean ? booleanToken(value, line) : numberToken(value, line);
      i++;
    } else if (key === "label") {
      decl.label = value ?? name;
      i++;
    } else if (/^-?\d+(?:\.\d+)?\.\.-?\d+(?:\.\d+)?$/.test(key)) {
      const [min, max] = key.split("..");
      decl.min = Number(min);
      decl.max = Number(max);
    }
  }
  return decl;
}

function parseLiteralToken(value, line) {
  if (value === "true") return true;
  if (value === "false") return false;
  if (value.startsWith("\"")) return readString(value, 0).value;
  const number = Number(value);
  if (Number.isFinite(number)) return number;
  throw new Error(`Invalid literal in declaration: ${line}`);
}

function tokenizeDirective(line) {
  const tokens = [];
  const re = /"((?:\\"|[^"])*)"|[^\s]+/g;
  let match;
  while ((match = re.exec(line))) {
    tokens.push(match[1] === undefined ? match[0] : match[1].replace(/\\"/g, "\""));
  }
  return tokens;
}

function numberToken(value, line) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`Invalid number in declaration: ${line}`);
  return number;
}

function booleanToken(value, line) {
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`Invalid boolean in declaration: ${line}`);
}

function uniqueDecls(decls) {
  const out = [];
  const seen = new Set();
  for (const decl of decls) {
    if (!decl?.name || seen.has(decl.name)) continue;
    seen.add(decl.name);
    out.push(decl);
  }
  return out;
}

function parseStageBlock(id, name, body) {
  const reads = parseListDirective(body, "reads");
  const writes = parseListDirective(body, "writes");
  const declares = parseListDirective(body, "declares");
  const readableFields = new Set(reads);
  if (body.includes("code ```")) {
    throw new Error(`${id}: raw JS code blocks are not supported; use DSL primitives instead`);
  }
  const parsedBody = parseDslBody(body);
  const code = compileStageBody(parsedBody, [...writes, ...declares], readableFields);
  return { id, name, reads, writes, declares, params: [], body: parsedBody, code };
}

function buildDeclaredPipelineSummary(stages) {
  return stages.flatMap((stage) => (stage.declares ?? []).map((name) => ({
    name,
    kind: "declared",
    scope: "pipeline",
    stage: stage.id,
  })));
}

function annotateStageParamRefs(stages, schema) {
  const declaredParams = new Set((schema.parameters ?? []).map((decl) => decl.name).filter(Boolean));
  for (const stage of stages) {
    stage.params = collectParamRefs(stage.body, declaredParams);
  }
}

function collectParamRefs(body, declaredParams) {
  const refs = [];
  const seen = new Set();
  function add(name) {
    if (!declaredParams.has(name) || seen.has(name)) return;
    seen.add(name);
    refs.push(name);
  }
  for (const statement of body.statements ?? []) collectParamRefsFromStatement(statement, add);
  return refs;
}

function collectParamRefsFromStatement(statement, add) {
  if (statement.type === "cell" || statement.type === "each") {
    for (const action of statement.actions ?? []) collectParamRefsFromAction(action, add);
  } else if (statement.type === "event") {
    collectParamRefsFromExpr(statement.condition, add);
    for (const action of statement.actions ?? []) collectParamRefsFromAction(action, add);
  } else if (statement.type === "wind") {
    collectParamRefsFromExpr(parseExpr(tokenizeExpr(statement.strength)), add);
  } else if (statement.type === "advect") {
    collectParamRefsFromExpr(parseExpr(tokenizeExpr(statement.dt)), add);
  } else if (statement.type === "diffuse") {
    collectParamRefsFromExpr(parseExpr(tokenizeExpr(statement.amount)), add);
  } else if (statement.type === "clamp") {
    collectParamRefsFromExpr(parseExpr(tokenizeExpr(statement.lo)), add);
    collectParamRefsFromExpr(parseExpr(tokenizeExpr(statement.hi)), add);
  } else if (statement.type === "normalize") {
    collectParamRefsFromExpr(parseExpr(tokenizeExpr(statement.damping)), add);
    collectParamRefsFromExpr(parseExpr(tokenizeExpr(statement.condition)), add);
  }
}

function collectParamRefsFromAction(action, add) {
  if (action.type === "let") {
    collectParamRefsFromExpr(action.expr, add);
  } else if (action.type === "add" || action.type === "set") {
    collectParamRefsFromExpr(action.expr, add);
  } else if (action.type === "when") {
    collectParamRefsFromExpr(action.condition, add);
    for (const child of action.actions ?? []) collectParamRefsFromAction(child, add);
  }
}

function collectParamRefsFromExpr(ast, add) {
  if (!ast) return;
  switch (ast.type) {
    case "Identifier":
      add(ast.name);
      return;
    case "Member":
      collectParamRefsFromExpr(ast.object, add);
      return;
    case "Unary":
      collectParamRefsFromExpr(ast.expr, add);
      return;
    case "Binary":
      collectParamRefsFromExpr(ast.left, add);
      collectParamRefsFromExpr(ast.right, add);
      return;
    case "Conditional":
      collectParamRefsFromExpr(ast.test, add);
      collectParamRefsFromExpr(ast.consequent, add);
      collectParamRefsFromExpr(ast.alternate, add);
      return;
    case "Call":
      collectParamRefsFromExpr(ast.callee, add);
      for (const arg of ast.args ?? []) collectParamRefsFromExpr(arg, add);
      return;
    default:
      return;
  }
}

function parseListDirective(body, key) {
  const re = new RegExp(`(?:^|\\n)\\s*${key}\\s+([^\\n]+)`);
  const match = body.match(re);
  if (!match) return [];
  return match[1]
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function parseDslBody(body) {
  const lines = body
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("//"))
    .filter((line) => !/^(reads|writes|declares)\s+/.test(line));
  const statements = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith("event when ")) {
      const event = collectEventBlock(lines, i);
      statements.push({
        type: "event",
        condition: parseExpr(tokenizeExpr(event.cond)),
        actions: parseActionLines(event.actions, "event"),
      });
      i = event.endIndex;
    } else if (line === "cell {") {
      const cell = collectNamedBlock(lines, i, "cell");
      statements.push({
        type: "cell",
        actions: parseActionLines(cell.actions, "cell"),
      });
      i = cell.endIndex;
    } else if (line === "each {") {
      const each = collectNamedBlock(lines, i, "each");
      statements.push({
        type: "each",
        actions: parseActionLines(each.actions, "each"),
      });
      i = each.endIndex;
    } else {
      statements.push(parsePrimitiveLine(line));
    }
  }
  return { type: "dsl", statements };
}

function compileStageBody(body, writes, visibleFields) {
  const out = [];
  const outputFields = new Set(writes);
  for (let i = 0; i < body.statements.length; i++) {
    const statement = body.statements[i];
    if (statement.type === "diffuse") {
      const group = collectPrimitiveRun(body.statements, i, "diffuse");
      out.push(group.length > 1 ? compileDiffuseGroup(group) : compileStatement(statement, visibleFields, outputFields));
      i += group.length - 1;
      continue;
    }
    if (statement.type === "advect") {
      const group = collectPrimitiveRun(body.statements, i, "advect");
      out.push(group.length > 1 ? compileAdvectGroup(group) : compileStatement(statement, visibleFields, outputFields));
      i += group.length - 1;
      continue;
    }
    if (statement.type === "clamp") {
      const group = collectPrimitiveRun(body.statements, i, "clamp");
      out.push(group.length > 1 ? compileClampGroup(group) : compileStatement(statement, visibleFields, outputFields));
      i += group.length - 1;
      continue;
    }
    out.push(compileStatement(statement, visibleFields, outputFields));
  }
  out.push(`return { ${writes.map((name) => `${name}: fields.${name}`).join(", ")} };`);
  return out.join("\n");
}

function collectPrimitiveRun(statements, start, type) {
  const out = [];
  const fields = new Set();
  for (let i = start; i < statements.length && statements[i].type === type; i++) {
    const field = statements[i].field;
    if (field && fields.has(field)) break;
    if (field) fields.add(field);
    out.push(statements[i]);
  }
  return out;
}

function compileStatement(statement, visibleFields, outputFields) {
  switch (statement.type) {
    case "event":
      return compileEventBlock(statement.condition, statement.actions, visibleFields);
    case "cell":
      return compileCellBlock(statement.actions, visibleFields, outputFields);
    case "each":
      return compileEachBlock(statement.actions, visibleFields);
    case "wind":
    case "advect":
    case "diffuse":
    case "clamp":
    case "normalize":
      return compilePrimitiveStatement(statement);
    default:
      throw new Error(`Unknown DSL statement: ${statement.type}`);
  }
}

function collectEventBlock(lines, startIndex) {
  const first = lines[startIndex];
  const match = /^event\s+when\s+(.+)\s*\{\s*$/.exec(first);
  if (!match) throw new Error(`Malformed event block: ${first}`);
  const block = collectBlockBody(lines, startIndex);
  return { cond: match[1].trim(), actions: block.actions, endIndex: block.endIndex };
}

function collectNamedBlock(lines, startIndex, name) {
  if (lines[startIndex] !== `${name} {`) throw new Error(`Malformed ${name} block: ${lines[startIndex]}`);
  return collectBlockBody(lines, startIndex);
}

function collectBlockBody(lines, startIndex) {
  const actions = [];
  let depth = 0;
  for (let i = startIndex + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.endsWith("{")) depth++;
    if (line === "}") {
      if (depth === 0) return { actions, endIndex: i };
      depth--;
    }
    actions.push(line);
  }
  throw new Error(`Unterminated block starting at line ${startIndex}`);
}

function parseActionLines(lines, mode) {
  const actions = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let match = /^let\s+(\w+)\s*=\s*(.+)$/.exec(line);
    if (match) {
      const [, name, expr] = match;
      actions.push({ type: "let", name, expr: parseExpr(tokenizeExpr(expr)) });
      continue;
    }

    match = /^add\s+(\w+)\s*=\s*(.+)$/.exec(line);
    if (match) {
      const [, field, expr] = match;
      actions.push({ type: "add", field, expr: parseExpr(tokenizeExpr(expr)) });
      continue;
    }

    match = /^set\s+(\w+)\s*=\s*(.+)$/.exec(line);
    if (match) {
      const [, field, expr] = match;
      actions.push({ type: "set", field, expr: parseExpr(tokenizeExpr(expr)) });
      continue;
    }

    match = /^when\s+(.+)\s*\{\s*$/.exec(line);
    if (match) {
      const block = collectBlockBody(lines, i);
      actions.push({
        type: "when",
        condition: parseExpr(tokenizeExpr(match[1])),
        actions: parseActionLines(block.actions, mode),
      });
      i = block.endIndex;
      continue;
    }

    throw new Error(`Unknown ${mode} action: ${line}`);
  }
  return actions;
}

function compileEventBlock(cond, actionList, visibleFields) {
  const condition = compileExpr(cond, visibleFields);
  const actions = actionList.map((action) => compileEventAction(action, visibleFields)).join("\n");
  return [
    "where(",
    "  { fields, params, consts, planet, dt, frame, events, stepName },",
    `  (c) => ${condition},`,
    "  (c) => {",
    indent(actions, 4),
    "  },",
    ");",
  ].join("\n");
}

function compileEventAction(action, visibleFields) {
  switch (action.type) {
    case "let":
      return `const ${action.name} = ${compileExpr(action.expr, visibleFields)};`;
    case "add":
      return `c.add("${action.field}", ${compileExpr(action.expr, visibleFields)});`;
    case "set":
      return `c.set("${action.field}", ${compileExpr(action.expr, visibleFields)});`;
    case "when":
      return [
        `if (${compileExpr(action.condition, visibleFields)}) {`,
        indent(action.actions.map((nested) => compileEventAction(nested, visibleFields)).join("\n"), 2),
        "}",
      ].join("\n");
    default:
      throw new Error(`Unknown event action: ${action.type}`);
  }
}

function compileCellBlock(actionList, visibleFields, outputFields) {
  const fieldNames = [...new Set([...visibleFields, ...outputFields])];
  const bindings = fieldNames.map((name) => `const ${fieldVar(name)} = fields.${name};`);
  const actions = compileDirectCellProgram(actionList, visibleFields);
  return [
    "{",
    indent(bindings.join("\n"), 2),
    indent(actions, 2),
    "}",
  ].join("\n");
}

function compileDirectCellProgram(actions, visibleFields) {
  if (
    actions.length === 1
    && actions[0].type === "when"
    && !exprDependsOnCell(actions[0].condition, visibleFields)
  ) {
    return [
      `if (${compileDirectExpr(actions[0].condition, visibleFields)}) {`,
      indent(compileDirectCellLoop(actions[0].actions, visibleFields), 2),
      "}",
    ].join("\n");
  }
  return compileDirectCellLoop(actions, visibleFields);
}

function compileDirectCellLoop(actions, visibleFields) {
  const hoisted = [];
  let start = 0;
  while (
    start < actions.length
    && actions[start].type === "let"
    && !exprDependsOnCell(actions[start].expr, visibleFields)
  ) {
    const action = actions[start];
    hoisted.push(`const ${action.name} = ${compileDirectExpr(action.expr, visibleFields)};`);
    start++;
  }
  const body = compileDirectCellLines(actions.slice(start), visibleFields);
  const readBindings = [...visibleFields].map((name) => `const ${fieldValueVar(name)} = ${fieldVar(name)}[i];`);
  return [
    ...hoisted,
    "for (let y = 0, i = 0; y < H; y++) {",
    "  for (let x = 0; x < W; x++, i++) {",
    indent([...readBindings, body].filter(Boolean).join("\n"), 4),
    "  }",
    "}",
  ].filter(Boolean).join("\n");
}

function compileDirectCellLines(actions, visibleFields) {
  const out = [];
  for (const action of actions) {
    if (action.type === "let") {
      out.push(`const ${action.name} = ${compileDirectExpr(action.expr, visibleFields)};`);
    } else if (action.type === "add") {
      out.push(`${fieldVar(action.field)}[i] += ${compileDirectExpr(action.expr, visibleFields)};`);
    } else if (action.type === "set") {
      out.push(`${fieldVar(action.field)}[i] = ${compileDirectExpr(action.expr, visibleFields)};`);
    } else if (action.type === "when") {
      out.push(`if (${compileDirectExpr(action.condition, visibleFields)}) {`);
      out.push(indent(compileDirectCellLines(action.actions, visibleFields), 2));
      out.push("}");
    } else {
      throw new Error(`Unknown cell action: ${action.type}`);
    }
  }
  return out.join("\n");
}

function fieldVar(name) {
  return `_f_${name}`;
}

function fieldValueVar(name) {
  return `_v_${name}`;
}

function compileEachBlock(actionList, visibleFields) {
  const actions = compileEachLines(actionList, visibleFields);
  return [
    "each(",
    "  { fields, params, consts, planet, dt, frame },",
    "  (c) => {",
    indent(actions, 4),
    "  },",
    ");",
  ].join("\n");
}

function compileEachLines(actions, visibleFields) {
  const out = [];
  for (const action of actions) {
    if (action.type === "let") {
      out.push(`const ${action.name} = ${compileExpr(action.expr, visibleFields)};`);
    } else if (action.type === "add") {
      out.push(`c.add("${action.field}", ${compileExpr(action.expr, visibleFields)});`);
    } else if (action.type === "set") {
      out.push(`c.set("${action.field}", ${compileExpr(action.expr, visibleFields)});`);
    } else if (action.type === "when") {
      out.push(`if (${compileExpr(action.condition, visibleFields)}) {`);
      out.push(indent(compileEachLines(action.actions, visibleFields), 2));
      out.push("}");
    } else {
      throw new Error(`Unknown each action: ${action.type}`);
    }
  }
  return out.join("\n");
}

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

const EXPR_FUNC_TARGETS = new Map([
  ["clamp", "c.clamp"],
  ["smoothstep", "c.smoothstep"],
  ["max", "c.max"],
  ["min", "c.min"],
  ["abs", "c.abs"],
  ["hypot", "Math.hypot"],
  ["noise", "c.noise"],
  ["noise2", "c.noise2"],
  ["sin", "c.sin"],
  ["asin", "Math.asin"],
  ["cos", "c.cos"],
  ["exp", "c.exp"],
  ["sqrt", "c.sqrt"],
  ["pow", "c.pow"],
]);

const EXPR_FUNC_ARITY = new Map([
  ["clamp", [3]],
  ["smoothstep", [3]],
  ["max", [1, 2]],
  ["min", [1, 2]],
  ["abs", [1]],
  ["hypot", [2]],
  ["noise", [1]],
  ["noise2", [2]],
  ["sin", [1]],
  ["asin", [1]],
  ["cos", [1]],
  ["exp", [1]],
  ["sqrt", [1]],
  ["pow", [2]],
]);

const CLOCK_IDENTIFIERS = new Set(["dt", "frame"]);
const GEO_IDENTIFIERS = new Set(["x", "y", "i", "lon", "lat", "u", "v", "px", "py", "pz", "N", "TAU", "PI"]);
const STAMP_IDENTIFIERS = new Set(["r", ...GEO_IDENTIFIERS]);

function tokenizeExpr(source) {
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

    const op = ["===", "!==", "??", "&&", "||", ">=", "<=", "==", "!=", "+", "-", "*", "/", "%", ">", "<", "!", "?", ":", ".", "(", ")", ","]
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

function parseExpr(tokens) {
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

function compileExpr(ast, visibleFields) {
  switch (ast.type) {
    case "Number":
      return ast.value;
    case "Identifier":
      return compileIdentifier(ast.name, visibleFields);
    case "Member":
      return compileMember(ast, visibleFields);
    case "Unary":
      return `(${ast.op}${compileExpr(ast.expr, visibleFields)})`;
    case "Binary":
      return `(${compileExpr(ast.left, visibleFields)} ${ast.op} ${compileExpr(ast.right, visibleFields)})`;
    case "Conditional":
      return `(${compileExpr(ast.test, visibleFields)} ? ${compileExpr(ast.consequent, visibleFields)} : ${compileExpr(ast.alternate, visibleFields)})`;
    case "Call":
      return compileCall(ast, visibleFields);
    default:
      throw new Error(`Unknown expression node: ${ast.type}`);
  }
}

function compileDirectExpr(ast, visibleFields) {
  switch (ast.type) {
    case "Number":
      return ast.value;
    case "Identifier":
      return compileDirectIdentifier(ast.name, visibleFields);
    case "Member":
      return compileDirectMember(ast, visibleFields);
    case "Unary":
      return `(${ast.op}${compileDirectExpr(ast.expr, visibleFields)})`;
    case "Binary":
      return `(${compileDirectExpr(ast.left, visibleFields)} ${ast.op} ${compileDirectExpr(ast.right, visibleFields)})`;
    case "Conditional":
      return `(${compileDirectExpr(ast.test, visibleFields)} ? ${compileDirectExpr(ast.consequent, visibleFields)} : ${compileDirectExpr(ast.alternate, visibleFields)})`;
    case "Call":
      return compileDirectCall(ast, visibleFields);
    default:
      throw new Error(`Unknown expression node: ${ast.type}`);
  }
}

function compileIdentifier(name, visibleFields) {
  if (name === "true" || name === "false" || name === "null" || name === "undefined") return name;
  if (name === "dt") return "c.dt";
  if (name === "frame") return "c.frame";
  if (visibleFields.has(name)) return `c.field.${name}`;
  return name;
}

function compileDirectIdentifier(name, visibleFields) {
  if (name === "true" || name === "false" || name === "null" || name === "undefined") return name;
  if (name === "dt" || name === "frame" || name === "x" || name === "y" || name === "i") return name;
  if (visibleFields.has(name)) return fieldValueVar(name);
  return name;
}

function compileMember(ast, visibleFields) {
  if (ast.object.type === "Identifier" && ast.object.name === "params") return `c.params.${ast.prop}`;
  if (ast.object.type === "Identifier" && ast.object.name === "consts") return `c.consts.${ast.prop}`;
  if (ast.object.type === "Identifier" && ast.object.name === "planet") return `c.planet.${ast.prop}`;
  return `${compileExpr(ast.object, visibleFields)}.${ast.prop}`;
}

function compileDirectMember(ast, visibleFields) {
  if (ast.object.type === "Identifier" && ast.object.name === "params") return `params.${ast.prop}`;
  if (ast.object.type === "Identifier" && ast.object.name === "consts") return `consts.${ast.prop}`;
  if (ast.object.type === "Identifier" && ast.object.name === "planet") return `planet.${ast.prop}`;
  return `${compileDirectExpr(ast.object, visibleFields)}.${ast.prop}`;
}

function compileCall(ast, visibleFields) {
  if (ast.callee.type === "Identifier" && ast.callee.name === "sample") {
    const [field, dx, dy] = ast.args;
    if (!field || field.type !== "Identifier") throw new Error("sample(field, dx, dy) requires a field identifier as first argument");
    return `c.sample("${field.name}", ${compileExpr(dx, visibleFields)}, ${compileExpr(dy, visibleFields)})`;
  }
  if (ast.callee.type === "Identifier" && ast.callee.name === "neighborMax") {
    const [field] = ast.args;
    if (!field || field.type !== "Identifier") throw new Error("neighborMax(field) requires a field identifier");
    return `c.neighborMax("${field.name}")`;
  }

  if (ast.callee.type === "Identifier" && EXPR_FUNC_TARGETS.has(ast.callee.name)) {
    const target = EXPR_FUNC_TARGETS.get(ast.callee.name);
    return `${target}(${ast.args.map((arg) => compileExpr(arg, visibleFields)).join(", ")})`;
  }

  throw new Error(`Unknown function call in DSL expression: ${formatCallee(ast.callee)}`);
}

function compileDirectCall(ast, visibleFields) {
  if (ast.callee.type === "Identifier" && ast.callee.name === "sample") {
    const [field, dx, dy] = ast.args;
    if (!field || field.type !== "Identifier") throw new Error("sample(field, dx, dy) requires a field identifier as first argument");
    return `sample(${fieldVar(field.name)}, x + ${compileDirectExpr(dx, visibleFields)}, y + ${compileDirectExpr(dy, visibleFields)})`;
  }
  if (ast.callee.type === "Identifier" && ast.callee.name === "neighborMax") {
    const [field] = ast.args;
    if (!field || field.type !== "Identifier") throw new Error("neighborMax(field) requires a field identifier");
    const fieldName = fieldVar(field.name);
    return `Math.max(${fieldName}[i], sample(${fieldName}, x + 1, y), sample(${fieldName}, x - 1, y), sample(${fieldName}, x, y + 1), sample(${fieldName}, x, y - 1))`;
  }

  if (ast.callee.type !== "Identifier") {
    throw new Error(`Unknown function call in DSL expression: ${formatCallee(ast.callee)}`);
  }

  const args = ast.args.map((arg) => compileDirectExpr(arg, visibleFields));
  switch (ast.callee.name) {
    case "clamp":
      return `Math.max(${args[1]}, Math.min(${args[2]}, ${args[0]}))`;
    case "smoothstep": {
      return `smoothstep(${args.join(", ")})`;
    }
    case "max":
      return `Math.max(${args.join(", ")})`;
    case "min":
      return `Math.min(${args.join(", ")})`;
    case "abs":
      return `Math.abs(${args[0]})`;
    case "hypot":
      return `Math.hypot(${args.join(", ")})`;
    case "noise":
      return `hashNoise(i, ${args[0]})`;
    case "noise2":
      return `noise2(${args.join(", ")})`;
    case "sin":
      return `Math.sin(${args[0]})`;
    case "asin":
      return `Math.asin(${args[0]})`;
    case "cos":
      return `Math.cos(${args[0]})`;
    case "exp":
      return `Math.exp(${args[0]})`;
    case "sqrt":
      return `Math.sqrt(${args[0]})`;
    case "pow":
      return `Math.pow(${args.join(", ")})`;
    default:
      throw new Error(`Unknown function call in DSL expression: ${formatCallee(ast.callee)}`);
  }
}

function exprDependsOnCell(ast, visibleFields) {
  switch (ast.type) {
    case "Number":
      return false;
    case "Identifier":
      if (ast.name === "true" || ast.name === "false" || ast.name === "null" || ast.name === "undefined") return false;
      if (ast.name === "dt" || ast.name === "frame") return false;
      if (ast.name === "x" || ast.name === "y" || ast.name === "i") return true;
      if (visibleFields.has(ast.name)) return true;
      return true;
    case "Member":
      if (ast.object.type === "Identifier" && ["params", "consts", "planet"].includes(ast.object.name)) return false;
      return exprDependsOnCell(ast.object, visibleFields);
    case "Unary":
      return exprDependsOnCell(ast.expr, visibleFields);
    case "Binary":
      return exprDependsOnCell(ast.left, visibleFields) || exprDependsOnCell(ast.right, visibleFields);
    case "Conditional":
      return exprDependsOnCell(ast.test, visibleFields)
        || exprDependsOnCell(ast.consequent, visibleFields)
        || exprDependsOnCell(ast.alternate, visibleFields);
    case "Call":
      if (ast.callee.type === "Identifier" && (ast.callee.name === "noise" || ast.callee.name === "sample")) return true;
      return ast.args.some((arg) => exprDependsOnCell(arg, visibleFields));
    default:
      return true;
  }
}

function formatCallee(callee) {
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

function indent(source, spaces) {
  const pad = " ".repeat(spaces);
  return source.split("\n").map((line) => `${pad}${line}`).join("\n");
}

function parsePrimitiveLine(line) {
  let match = /^wind\s+(\w+)\s*->\s*(\w+)\s*,\s*(\w+)(?:\s*,\s*(\w+))?\s+strength\s+(.+)$/.exec(line);
  if (match) {
    const [, pressure, windU, windV, lift, strength] = match;
    return { type: "wind", pressure, windU, windV, lift, strength };
  }

  match = /^advect\s+(\w+)\s+by\s+(\w+)\s*,\s*(\w+)\s+dt\s+(.+)$/.exec(line);
  if (match) {
    const [, field, windU, windV, dtExpr] = match;
    return { type: "advect", field, windU, windV, dt: dtExpr };
  }

  match = /^diffuse\s+(\w+)\s+amount\s+(.+)$/.exec(line);
  if (match) {
    const [, field, amount] = match;
    return { type: "diffuse", field, amount };
  }

  match = /^clamp\s+(\w+)\s+(.+?)\s+(.+)$/.exec(line);
  if (match) {
    const [, field, lo, hi] = match;
    return { type: "clamp", field, lo, hi };
  }

  match = /^normalize\s+(\w+)\s+damping\s+(.+?)\s+when\s+(.+)$/.exec(line);
  if (match) {
    const [, field, damping, cond] = match;
    return { type: "normalize", field, damping, condition: cond };
  }

  throw new Error(`Unknown DSL primitive: ${line}`);
}

function compilePrimitiveStatement(statement) {
  if (statement.type === "wind") {
    const lines = [`computeWind(${fieldRef(statement.pressure)}, ${fieldRef(statement.windU)}, ${fieldRef(statement.windV)}, ${statement.strength});`];
    if (statement.lift) lines.push(`computeLift(${fieldRef(statement.lift)}, ${fieldRef(statement.windU)}, ${fieldRef(statement.windV)});`);
    return lines.join("\n");
  }

  if (statement.type === "advect") {
    return `advect(${fieldRef(statement.field)}, tmp.${statement.field}, ${fieldRef(statement.windU)}, ${fieldRef(statement.windV)}, ${statement.dt});`;
  }

  if (statement.type === "diffuse") {
    return `diffuse(${fieldRef(statement.field)}, tmp.${statement.field}, ${statement.amount});`;
  }

  if (statement.type === "clamp") {
    return `clampField(${fieldRef(statement.field)}, ${statement.lo}, ${statement.hi});`;
  }

  if (statement.type === "normalize") {
    return `if (${statement.condition}) normalizeField(${fieldRef(statement.field)}, ${statement.damping});`;
  }

  throw new Error(`Unknown primitive statement: ${statement.type}`);
}

function compileDiffuseGroup(statements) {
  const bindings = [];
  for (const [index, statement] of statements.entries()) {
    bindings.push(`const ${fieldVar(statement.field)} = fields.${statement.field};`);
    bindings.push(`const _tmp_${statement.field} = tmp.${statement.field};`);
    bindings.push(`const _amount_${index} = clamp(${statement.amount}, 0, 0.24);`);
  }
  const lines = [];
  for (const [index, statement] of statements.entries()) {
    const field = fieldVar(statement.field);
    const tmpField = `_tmp_${statement.field}`;
    lines.push(`const _lap_${index} = (${field}[idx(x - 1, y)] + ${field}[idx(x + 1, y)] + ${field}[idx(x, y - 1)] + ${field}[idx(x, y + 1)]) * 0.25;`);
    lines.push(`${tmpField}[i] = lerp(${field}[i], _lap_${index}, _amount_${index});`);
  }
  return [
    "{",
    indent(bindings.join("\n"), 2),
    "  for (let y = 0; y < H; y++) {",
    "    for (let x = 0; x < W; x++) {",
    "      const i = idx(x, y);",
    indent(lines.join("\n"), 6),
    "    }",
    "  }",
    ...statements.map((statement) => `  ${fieldVar(statement.field)}.set(_tmp_${statement.field});`),
    "}",
  ].join("\n");
}

function compileAdvectGroup(statements) {
  const bindings = [];
  for (const statement of statements) {
    bindings.push(`const ${fieldVar(statement.field)} = fields.${statement.field};`);
    bindings.push(`const _tmp_${statement.field} = tmp.${statement.field};`);
  }
  for (const name of new Set(statements.flatMap((statement) => [statement.windU, statement.windV]))) {
    bindings.push(`const ${fieldVar(name)} = fields.${name};`);
  }
  const lines = [];
  for (const statement of statements) {
    const field = fieldVar(statement.field);
    const tmpField = `_tmp_${statement.field}`;
    lines.push(`${tmpField}[i] = sample(${field}, x - ${fieldVar(statement.windU)}[i] * (${statement.dt}) * 15.0, y - ${fieldVar(statement.windV)}[i] * (${statement.dt}) * 15.0);`);
  }
  return [
    "{",
    indent(bindings.join("\n"), 2),
    "  for (let y = 0; y < H; y++) {",
    "    for (let x = 0; x < W; x++) {",
    "      const i = idx(x, y);",
    indent(lines.join("\n"), 6),
    "    }",
    "  }",
    ...statements.map((statement) => `  ${fieldVar(statement.field)}.set(_tmp_${statement.field});`),
    "}",
  ].join("\n");
}

function compileClampGroup(statements) {
  const bindings = statements.map((statement) => `const ${fieldVar(statement.field)} = fields.${statement.field};`);
  const lines = statements.map((statement) => {
    const field = fieldVar(statement.field);
    return `${field}[i] = clamp(${field}[i], ${statement.lo}, ${statement.hi});`;
  });
  return [
    "{",
    indent(bindings.join("\n"), 2),
    "  for (let i = 0; i < N; i++) {",
    indent(lines.join("\n"), 4),
    "  }",
    "}",
  ].join("\n");
}

function fieldRef(name) {
  return `fields.${name}`;
}

// Recipe-level name uniqueness. The DSL has a single global scope —
// bare identifiers in stage bodies resolve to one of: declared field,
// declared source, declared param, declared const, declared planet
// constant, declared (per-stage) name, or builtin. A name living in
// two of those at once would make resolution ambiguous, so we reject
// the recipe at compile time and tell the author exactly where the
// collision is.
function validateNameUniqueness(schema, stages = []) {
  const declaredBy = new Map();
  function claim(name, kind) {
    if (!name) return;
    const prior = declaredBy.get(name);
    if (prior && prior !== kind) {
      throw new Error(`Name "${name}" is declared as both ${prior} and ${kind}; the DSL has one global namespace, rename one`);
    }
    declaredBy.set(name, kind);
  }
  // schema.fields is the union (`field` decls + `source` decls). Only
  // claim true field decls here so sources don't get claimed twice
  // (once as field, once below as source).
  for (const decl of schema.fields ?? []) {
    if (decl?.kind === "source") continue;
    claim(decl?.name, "field");
  }
  for (const decl of schema.sources ?? []) claim(decl?.name, "source");
  for (const decl of schema.settings ?? []) claim(decl?.name, "setting");
  for (const decl of schema.parameters ?? []) claim(decl?.name, "param");
  for (const decl of schema.constants ?? []) claim(decl?.name, "const");
  for (const name of Object.keys(schema.planet ?? {})) claim(name, "planet");
  for (const stage of stages ?? []) {
    for (const name of stage.declares ?? []) claim(name, "declared");
  }
  // Builtin names that recipe declarations can never shadow without
  // breaking semantics: literals (true/false) and the math/sample
  // helpers that DSL bodies invoke as function calls.
  //
  // Geodesic position coordinates (x, y, lon, lat, u, v, px, py, pz, i)
  // and projection constants (PI, TAU, N, W, H, E) are deliberately NOT
  // reserved — recipes are allowed to declare a `field u` (gray-scott)
  // or `field W` (inverter-front), in which case a bare reference
  // resolves to the field. The position coord is then unreachable
  // inside that recipe's stages, which is the recipe author's choice.
  const RESERVED = new Set([
    "true", "false", "null", "undefined",
    "neighborMax", "sample",
    "max", "min", "abs", "hypot", "sin", "asin", "cos", "exp", "sqrt", "pow",
    "smoothstep", "clamp", "noise", "noise2",
  ]);
  for (const [name, kind] of declaredBy) {
    if (RESERVED.has(name)) {
      throw new Error(`Name "${name}" (${kind}) collides with a builtin/reserved identifier; rename it`);
    }
  }
}

function validateStages(stages, schema = {}) {
  const ids = new Set();
  const declaredFields = new Set((schema.fields ?? []).map((decl) => decl.name).filter(Boolean));
  const sourceFields = new Set((schema.sources ?? []).map((decl) => decl.name).filter(Boolean));
  const declaredParams = new Set((schema.parameters ?? []).map((decl) => decl.name).filter(Boolean));
  const declaredConstants = new Set((schema.constants ?? []).map((decl) => decl.name).filter(Boolean));
  const declaredPlanet = new Set(Object.keys(schema.planet ?? {}));
  const declaredPipelineFields = new Set();
  for (const stage of stages) {
    for (const name of stage.declares ?? []) {
      if (declaredPipelineFields.has(name)) throw new Error(`Duplicate declared field: ${name}`);
      if (declaredFields.has(name)) throw new Error(`${stage.id}: declared field ${name} conflicts with recipe field`);
      declaredPipelineFields.add(name);
    }
  }
  const imports = buildImportSets(schema.imports ?? []);
  const availableDeclaredFields = new Set();
  for (const stage of stages) {
    if (ids.has(stage.id)) throw new Error(`Duplicate stage id: ${stage.id}`);
    ids.add(stage.id);

    const reads = new Set(stage.reads);
    const writes = new Set(stage.writes);
    const declares = new Set(stage.declares);
    for (const name of declares) {
      if (reads.has(name)) throw new Error(`${stage.id}: declared field ${name} cannot also be read`);
      if (writes.has(name)) throw new Error(`${stage.id}: declared field ${name} cannot also be written`);
    }
    if (declaredFields.size > 0) {
      for (const field of reads) {
        if (!declaredFields.has(field) && !availableDeclaredFields.has(field)) {
          throw new Error(`${stage.id}: field ${field} is not declared`);
        }
      }
      for (const field of writes) {
        if (!declaredFields.has(field)) throw new Error(`${stage.id}: field ${field} is not declared`);
      }
    }
    for (const field of declares) {
      if (declaredFields.has(field)) throw new Error(`${stage.id}: declared field ${field} conflicts with recipe field`);
    }
    for (const field of writes) {
      if (sourceFields.has(field)) throw new Error(`${stage.id}: source ${field} is immutable and cannot be written`);
    }
    if (declaredParams.size > 0) {
      for (const param of stage.params ?? []) {
        if (!declaredParams.has(param)) throw new Error(`${stage.id}: param ${param} is not declared`);
      }
    }
    const readableFields = new Set(reads);
    for (const statement of stage.body.statements) {
      validateStatement(statement, stage, reads, writes, declares, readableFields, declaredParams, declaredConstants, declaredPlanet, imports);
    }
    for (const field of declares) availableDeclaredFields.add(field);
  }
}

function validatePresets(presets, schema = {}) {
  const declaredFields = new Set((schema.fields ?? []).map((decl) => decl.name).filter(Boolean));
  const declaredParams = new Set((schema.parameters ?? []).map((decl) => decl.name).filter(Boolean));
  const declaredConstants = new Set((schema.constants ?? []).map((decl) => decl.name).filter(Boolean));
  const declaredPlanet = new Set(Object.keys(schema.planet ?? {}));
  const imports = buildImportSets(schema.imports ?? []);
  for (const preset of presets) {
    validatePresetActions(preset.actions, declaredFields, declaredParams, declaredConstants, declaredPlanet, imports, preset.id);
  }
}

function validateStamps(stamps, schema = {}) {
  const ids = new Set();
  const declaredFields = new Set((schema.fields ?? []).map((decl) => decl.name).filter(Boolean));
  const sourceFields = new Set((schema.sources ?? []).map((decl) => decl.name).filter(Boolean));
  const declaredParams = new Set((schema.parameters ?? []).map((decl) => decl.name).filter(Boolean));
  const declaredConstants = new Set((schema.constants ?? []).map((decl) => decl.name).filter(Boolean));
  const declaredPlanet = new Set(Object.keys(schema.planet ?? {}));
  const imports = buildImportSets(schema.imports ?? []);
  for (const stamp of stamps) {
    if (ids.has(stamp.id)) throw new Error(`Duplicate stamp id: ${stamp.id}`);
    ids.add(stamp.id);
    validateStampActions(stamp.actions, declaredFields, sourceFields, declaredParams, declaredConstants, declaredPlanet, imports, stamp.id);
  }
}

function validateStampActions(actions, declaredFields, sourceFields, declaredParams, declaredConstants, declaredPlanet, imports, label, locals = new Set()) {
  const allFieldsVisible = declaredFields.size === 0 ? null : declaredFields;
  const extra = STAMP_IDENTIFIERS;
  for (const action of actions) {
    if (action.type === "spot") {
      requireImport(imports, "init", "spot", label);
      requireDeclaredField(action.field, declaredFields, label, "spot");
      requireMutableField(action.field, sourceFields, label, "spot");
      validateExpr(action.lon, allFieldsVisible ?? new Set(), locals, `${label} spot lon`, declaredParams, declaredConstants, declaredPlanet, imports, extra);
      validateExpr(action.lat, allFieldsVisible ?? new Set(), locals, `${label} spot lat`, declaredParams, declaredConstants, declaredPlanet, imports, extra);
      validateExpr(action.radius, allFieldsVisible ?? new Set(), locals, `${label} spot radius`, declaredParams, declaredConstants, declaredPlanet, imports, extra);
      validateExpr(action.amount, allFieldsVisible ?? new Set(), locals, `${label} spot amount`, declaredParams, declaredConstants, declaredPlanet, imports, extra);
    } else if (action.type === "ellipse") {
      requireImport(imports, "init", "ellipse", label);
      requireDeclaredField(action.field, declaredFields, label, "ellipse");
      requireMutableField(action.field, sourceFields, label, "ellipse");
      validateExpr(action.lon, allFieldsVisible ?? new Set(), locals, `${label} ellipse lon`, declaredParams, declaredConstants, declaredPlanet, imports, extra);
      validateExpr(action.lat, allFieldsVisible ?? new Set(), locals, `${label} ellipse lat`, declaredParams, declaredConstants, declaredPlanet, imports, extra);
      validateExpr(action.rx, allFieldsVisible ?? new Set(), locals, `${label} ellipse rx`, declaredParams, declaredConstants, declaredPlanet, imports, extra);
      validateExpr(action.ry, allFieldsVisible ?? new Set(), locals, `${label} ellipse ry`, declaredParams, declaredConstants, declaredPlanet, imports, extra);
      validateExpr(action.amount, allFieldsVisible ?? new Set(), locals, `${label} ellipse amount`, declaredParams, declaredConstants, declaredPlanet, imports, extra);
      validateExpr(action.angle, allFieldsVisible ?? new Set(), locals, `${label} ellipse angle`, declaredParams, declaredConstants, declaredPlanet, imports, extra);
    } else if (action.type === "region") {
      throw new Error(`${label}: stamp action region is not supported`);
    } else {
      throw new Error(`${label}: stamp action ${action.type} is not supported`);
    }
  }
}

function validatePresetActions(actions, declaredFields, declaredParams, declaredConstants, declaredPlanet, imports, label, locals = new Set()) {
  const allFieldsVisible = declaredFields.size === 0 ? null : declaredFields;
  const extra = GEO_IDENTIFIERS;
  for (const action of actions) {
    if (action.type === "fill") {
      requireImport(imports, "init", "fill", label);
      requireDeclaredField(action.field, declaredFields, label, "fill");
      validateExpr(action.value, allFieldsVisible ?? new Set(), locals, `${label} fill ${action.field}`, declaredParams, declaredConstants, declaredPlanet, imports, extra);
    } else if (action.type === "spot") {
      requireImport(imports, "init", "spot", label);
      requireDeclaredField(action.field, declaredFields, label, "spot");
      validateExpr(action.lon, allFieldsVisible ?? new Set(), locals, `${label} spot lon`, declaredParams, declaredConstants, declaredPlanet, imports, extra);
      validateExpr(action.lat, allFieldsVisible ?? new Set(), locals, `${label} spot lat`, declaredParams, declaredConstants, declaredPlanet, imports, extra);
      validateExpr(action.radius, allFieldsVisible ?? new Set(), locals, `${label} spot radius`, declaredParams, declaredConstants, declaredPlanet, imports, extra);
      validateExpr(action.amount, allFieldsVisible ?? new Set(), locals, `${label} spot amount`, declaredParams, declaredConstants, declaredPlanet, imports, extra);
    } else if (action.type === "ellipse") {
      requireImport(imports, "init", "ellipse", label);
      requireDeclaredField(action.field, declaredFields, label, "ellipse");
      validateExpr(action.lon, allFieldsVisible ?? new Set(), locals, `${label} ellipse lon`, declaredParams, declaredConstants, declaredPlanet, imports, extra);
      validateExpr(action.lat, allFieldsVisible ?? new Set(), locals, `${label} ellipse lat`, declaredParams, declaredConstants, declaredPlanet, imports, extra);
      validateExpr(action.rx, allFieldsVisible ?? new Set(), locals, `${label} ellipse rx`, declaredParams, declaredConstants, declaredPlanet, imports, extra);
      validateExpr(action.ry, allFieldsVisible ?? new Set(), locals, `${label} ellipse ry`, declaredParams, declaredConstants, declaredPlanet, imports, extra);
      validateExpr(action.amount, allFieldsVisible ?? new Set(), locals, `${label} ellipse amount`, declaredParams, declaredConstants, declaredPlanet, imports, extra);
      validateExpr(action.angle, allFieldsVisible ?? new Set(), locals, `${label} ellipse angle`, declaredParams, declaredConstants, declaredPlanet, imports, extra);
    } else if (action.type === "region") {
      requireImport(imports, "init", "region", label);
      requireDeclaredField(action.field, declaredFields, label, "region");
      validateExpr(action.lonMin, allFieldsVisible ?? new Set(), locals, `${label} region lon min`, declaredParams, declaredConstants, declaredPlanet, imports, extra);
      validateExpr(action.lonMax, allFieldsVisible ?? new Set(), locals, `${label} region lon max`, declaredParams, declaredConstants, declaredPlanet, imports, extra);
      validateExpr(action.latMin, allFieldsVisible ?? new Set(), locals, `${label} region lat min`, declaredParams, declaredConstants, declaredPlanet, imports, extra);
      validateExpr(action.latMax, allFieldsVisible ?? new Set(), locals, `${label} region lat max`, declaredParams, declaredConstants, declaredPlanet, imports, extra);
      validateExpr(action.amount, allFieldsVisible ?? new Set(), locals, `${label} region amount`, declaredParams, declaredConstants, declaredPlanet, imports, extra);
    } else if (action.type === "eachCell") {
      requireImport(imports, "init", "eachCell", label);
      validatePresetCellActions(action.actions, declaredFields, declaredParams, declaredConstants, declaredPlanet, imports, label, new Set(locals));
    } else {
      throw new Error(`${label}: unknown preset action ${action.type}`);
    }
  }
}

function validatePresetCellActions(actions, declaredFields, declaredParams, declaredConstants, declaredPlanet, imports, label, locals = new Set()) {
  const visibleFields = declaredFields.size === 0 ? new Set() : declaredFields;
  const extra = GEO_IDENTIFIERS;
  for (const action of actions) {
    if (action.type === "let") {
      validateExpr(action.expr, visibleFields, locals, `${label} let ${action.name}`, declaredParams, declaredConstants, declaredPlanet, imports, extra);
      locals.add(action.name);
    } else if (action.type === "add" || action.type === "set") {
      requireDeclaredField(action.field, declaredFields, label, action.type);
      validateExpr(action.expr, visibleFields, locals, `${label} ${action.type} ${action.field}`, declaredParams, declaredConstants, declaredPlanet, imports, extra);
    } else if (action.type === "when") {
      validateExpr(action.condition, visibleFields, locals, `${label} when`, declaredParams, declaredConstants, declaredPlanet, imports, extra);
      validatePresetCellActions(action.actions, declaredFields, declaredParams, declaredConstants, declaredPlanet, imports, label, new Set(locals));
    } else {
      throw new Error(`${label}: unknown preset cell action ${action.type}`);
    }
  }
}

function validateStatement(statement, stage, reads, writes, declares, visibleFields, declaredParams, declaredConstants, declaredPlanet, imports) {
  switch (statement.type) {
    case "event":
      requireImport(imports, "sim", "event", stage.id);
      validateExpr(statement.condition, visibleFields, new Set(), `${stage.id} event condition`, declaredParams, declaredConstants, declaredPlanet, imports);
      validateActions(statement.actions, stage, reads, writes, declares, visibleFields, "event", declaredParams, declaredConstants, declaredPlanet, imports);
      break;
    case "cell":
      requireImport(imports, "sim", "cell", stage.id);
      validateActions(statement.actions, stage, reads, writes, declares, visibleFields, "cell", declaredParams, declaredConstants, declaredPlanet, imports);
      break;
    case "each":
      requireImport(imports, "sim", "each", stage.id);
      validateActions(statement.actions, stage, reads, writes, declares, visibleFields, "each", declaredParams, declaredConstants, declaredPlanet, imports);
      break;
    case "wind":
      requireImport(imports, "sim", "wind", stage.id);
      requireVisibleField(statement.pressure, visibleFields, stage.id, "wind pressure");
      requireOutput(statement.windU, writes, declares, stage.id);
      requireOutput(statement.windV, writes, declares, stage.id);
      if (statement.lift) requireOutput(statement.lift, writes, declares, stage.id);
      validateRawExpr(statement.strength, visibleFields, declaredParams, declaredConstants, declaredPlanet, imports, `${stage.id} wind strength`);
      break;
    case "advect":
      requireImport(imports, "sim", "advect", stage.id);
      requireVisibleField(statement.field, visibleFields, stage.id, "advect field");
      requireVisibleField(statement.windU, visibleFields, stage.id, "advect windU");
      requireVisibleField(statement.windV, visibleFields, stage.id, "advect windV");
      requireWrite(statement.field, writes, stage.id);
      validateRawExpr(statement.dt, visibleFields, declaredParams, declaredConstants, declaredPlanet, imports, `${stage.id} advect dt`);
      break;
    case "diffuse":
      requireImport(imports, "sim", statement.type, stage.id);
      requireVisibleField(statement.field, visibleFields, stage.id, statement.type);
      requireWrite(statement.field, writes, stage.id);
      validateRawExpr(statement.amount, visibleFields, declaredParams, declaredConstants, declaredPlanet, imports, `${stage.id} diffuse amount`);
      break;
    case "clamp":
      requireImport(imports, "sim", statement.type, stage.id);
      requireVisibleField(statement.field, visibleFields, stage.id, statement.type);
      requireWrite(statement.field, writes, stage.id);
      validateRawExpr(statement.lo, visibleFields, declaredParams, declaredConstants, declaredPlanet, imports, `${stage.id} clamp lo`);
      validateRawExpr(statement.hi, visibleFields, declaredParams, declaredConstants, declaredPlanet, imports, `${stage.id} clamp hi`);
      break;
    case "normalize":
      requireImport(imports, "sim", statement.type, stage.id);
      requireVisibleField(statement.field, visibleFields, stage.id, statement.type);
      requireWrite(statement.field, writes, stage.id);
      validateRawExpr(statement.damping, visibleFields, declaredParams, declaredConstants, declaredPlanet, imports, `${stage.id} normalize damping`);
      validateRawExpr(statement.condition, visibleFields, declaredParams, declaredConstants, declaredPlanet, imports, `${stage.id} normalize when`);
      break;
    default:
      throw new Error(`Unknown statement in ${stage.id}: ${statement.type}`);
  }
}

function validateRawExpr(source, visibleFields, declaredParams, declaredConstants, declaredPlanet, imports, label) {
  validateExpr(parseExpr(tokenizeExpr(source)), visibleFields, new Set(), label, declaredParams, declaredConstants, declaredPlanet, imports);
}

function validateActions(actions, stage, reads, writes, declares, visibleFields, mode, declaredParams, declaredConstants, declaredPlanet, imports, locals = new Set()) {
  for (const action of actions) {
    if (action.type === "let") {
      validateExpr(action.expr, visibleFields, locals, `${stage.id} let ${action.name}`, declaredParams, declaredConstants, declaredPlanet, imports, GEO_IDENTIFIERS);
      locals.add(action.name);
    } else if (action.type === "add" || action.type === "set") {
      requireOutput(action.field, writes, declares, stage.id);
      if (action.type === "add") requireRead(action.field, reads, stage.id);
      validateExpr(action.expr, visibleFields, locals, `${stage.id} ${action.type} ${action.field}`, declaredParams, declaredConstants, declaredPlanet, imports, GEO_IDENTIFIERS);
    } else if (action.type === "when") {
      validateExpr(action.condition, visibleFields, locals, `${stage.id} ${mode} when`, declaredParams, declaredConstants, declaredPlanet, imports, GEO_IDENTIFIERS);
      validateActions(action.actions, stage, reads, writes, declares, visibleFields, mode, declaredParams, declaredConstants, declaredPlanet, imports, new Set(locals));
    } else {
      throw new Error(`Unknown ${mode} action in ${stage.id}: ${action.type}`);
    }
  }
}

function validateExpr(
  ast,
  visibleFields,
  locals,
  label,
  declaredParams = new Set(),
  declaredConstants = new Set(),
  declaredPlanet = new Set(),
  imports = null,
  extraIdentifiers = new Set(),
) {
  switch (ast.type) {
    case "Number":
      return;
    case "Identifier":
      if (ast.name === "true" || ast.name === "false" || ast.name === "null" || ast.name === "undefined") return;
      if (locals.has(ast.name)) return;
      if (visibleFields.has(ast.name)) return;
      if (declaredParams.has(ast.name)) return;
      if (declaredConstants.has(ast.name)) return;
      if (declaredPlanet.has(ast.name)) return;
      if (CLOCK_IDENTIFIERS.has(ast.name)) {
        requireImport(imports, "clock", ast.name, label);
        return;
      }
      if (extraIdentifiers.has(ast.name)) {
        if (GEO_IDENTIFIERS.has(ast.name)) requireImport(imports, "geo", ast.name, label);
        return;
      }
      if (GEO_IDENTIFIERS.has(ast.name)) {
        requireImport(imports, "geo", ast.name, label);
        return;
      }
      if (ast.name === "r" && extraIdentifiers === STAMP_IDENTIFIERS) return;
      throw new Error(`${label}: unknown identifier ${ast.name}`);
    case "Member":
      // Namespaced refs (`params.X`, `consts.X`, `planet.X`) used to be
      // the way to reach param/const/planet values from a DSL body.
      // The DSL now uses bare names with a single global scope, and
      // recipe-level uniqueness is enforced — these prefixes are no
      // longer recognised. The error message names the new form.
      if (ast.object.type === "Identifier"
        && (ast.object.name === "params"
          || ast.object.name === "consts"
          || ast.object.name === "planet")) {
        throw new Error(`${label}: ${ast.object.name}.${ast.prop} is no longer supported — drop the \`${ast.object.name}.\` prefix and use bare \`${ast.prop}\``);
      }
      validateExpr(ast.object, visibleFields, locals, label, declaredParams, declaredConstants, declaredPlanet, imports, extraIdentifiers);
      return;
    case "Unary":
      validateExpr(ast.expr, visibleFields, locals, label, declaredParams, declaredConstants, declaredPlanet, imports, extraIdentifiers);
      return;
    case "Binary":
      validateExpr(ast.left, visibleFields, locals, label, declaredParams, declaredConstants, declaredPlanet, imports, extraIdentifiers);
      validateExpr(ast.right, visibleFields, locals, label, declaredParams, declaredConstants, declaredPlanet, imports, extraIdentifiers);
      return;
    case "Conditional":
      validateExpr(ast.test, visibleFields, locals, label, declaredParams, declaredConstants, declaredPlanet, imports, extraIdentifiers);
      validateExpr(ast.consequent, visibleFields, locals, label, declaredParams, declaredConstants, declaredPlanet, imports, extraIdentifiers);
      validateExpr(ast.alternate, visibleFields, locals, label, declaredParams, declaredConstants, declaredPlanet, imports, extraIdentifiers);
      return;
    case "Call":
      validateCall(ast, visibleFields, locals, label, declaredParams, declaredConstants, declaredPlanet, imports, extraIdentifiers);
      return;
    default:
      throw new Error(`${label}: unknown expression node ${ast.type}`);
  }
}

function validateCall(ast, visibleFields, locals, label, declaredParams, declaredConstants, declaredPlanet, imports, extraIdentifiers) {
  if (ast.callee.type === "Identifier" && ast.callee.name === "sample") {
    requireImport(imports, "core", "sample", label);
    if (ast.args.length !== 3) throw new Error(`${label}: sample expects 3 arguments`);
    const [field, dx, dy] = ast.args;
    if (field.type !== "Identifier") throw new Error(`${label}: sample first argument must be a field name`);
    requireVisibleField(field.name, visibleFields, label, "sample field");
    validateExpr(dx, visibleFields, locals, label, declaredParams, declaredConstants, declaredPlanet, imports, extraIdentifiers);
    validateExpr(dy, visibleFields, locals, label, declaredParams, declaredConstants, declaredPlanet, imports, extraIdentifiers);
    return;
  }
  if (ast.callee.type === "Identifier" && ast.callee.name === "neighborMax") {
    requireImport(imports, "core", "neighborMax", label);
    if (ast.args.length !== 1) throw new Error(`${label}: neighborMax expects 1 argument`);
    const [field] = ast.args;
    if (field.type !== "Identifier") throw new Error(`${label}: neighborMax first argument must be a field name`);
    requireVisibleField(field.name, visibleFields, label, "neighborMax field");
    return;
  }

  if (ast.callee.type !== "Identifier" || !EXPR_FUNC_TARGETS.has(ast.callee.name)) {
    throw new Error(`${label}: unknown function ${formatCallee(ast.callee)}`);
  }
  requireImport(imports, "core", ast.callee.name, label);

  const arity = EXPR_FUNC_ARITY.get(ast.callee.name);
  if (arity && !arity.includes(ast.args.length)) {
    throw new Error(`${label}: ${ast.callee.name} expects ${arity.join(" or ")} args, got ${ast.args.length}`);
  }
  for (const arg of ast.args) validateExpr(arg, visibleFields, locals, label, declaredParams, declaredConstants, declaredPlanet, imports, extraIdentifiers);
}

function buildImportSets(imports) {
  const sets = new Map();
  for (const decl of imports) {
    if (!sets.has(decl.from)) sets.set(decl.from, new Set());
    for (const name of decl.names ?? []) sets.get(decl.from).add(name);
  }
  return sets;
}

function requireImport(imports, from, name, label) {
  if (!imports) return;
  if (imports.get(from)?.has(name)) return;
  throw new Error(`${label}: ${from}.${name} is not imported`);
}

function requireWrite(field, writes, stageId) {
  if (!writes.has(field)) throw new Error(`${stageId}: writes to undeclared field ${field}`);
}

function requireOutput(field, writes, declares, stageId) {
  if (!writes.has(field) && !declares.has(field)) {
    throw new Error(`${stageId}: writes to undeclared field ${field}`);
  }
}

function requireRead(field, reads, stageId) {
  if (!reads.has(field)) throw new Error(`${stageId}: additive write to ${field} requires declaring it in reads`);
}

function requireDeclaredField(field, declaredFields, stageId, label) {
  if (declaredFields.size > 0 && !declaredFields.has(field)) {
    throw new Error(`${stageId}: ${label} references undeclared field ${field}`);
  }
}

function requireMutableField(field, sourceFields, stageId, label) {
  if (sourceFields.has(field)) {
    throw new Error(`${stageId}: ${label} references immutable source ${field}`);
  }
}

function requireVisibleField(field, visibleFields, stageId, label) {
  if (!visibleFields.has(field)) throw new Error(`${stageId}: ${label} references undeclared field ${field}`);
}

function deriveEdges(stages) {
  const edges = [];
  const lastWriter = new Map();
  for (const stage of stages) {
    for (const field of stage.reads) {
      const from = lastWriter.get(field);
      if (!from) continue;
      edges.push({
        from: { node: from, port: field },
        to: { node: stage.id, port: field },
      });
    }
    for (const field of [...stage.writes, ...stage.declares]) {
      lastWriter.set(field, stage.id);
    }
  }
  return edges;
}

function readIdent(source, i) {
  const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(source.slice(i));
  if (!match) throw new Error(`Expected identifier at ${i}`);
  return { value: match[0], end: i + match[0].length };
}

function readString(source, i) {
  let out = "";
  let j = i + 1;
  while (j < source.length) {
    const ch = source[j];
    if (ch === "\\" && j + 1 < source.length) {
      out += source[j + 1];
      j += 2;
      continue;
    }
    if (ch === "\"") return { value: out, end: j + 1 };
    out += ch;
    j++;
  }
  throw new Error("Unterminated string literal");
}

function readBlock(source, i) {
  let depth = 0;
  let j = i;
  let inFence = false;
  while (j < source.length) {
    if (source.startsWith("```", j)) {
      inFence = !inFence;
      j += 3;
      continue;
    }
    const ch = source[j];
    if (!inFence && ch === "{") depth++;
    if (!inFence && ch === "}") {
      depth--;
      if (depth === 0) return { value: source.slice(i + 1, j), end: j + 1 };
    }
    j++;
  }
  throw new Error("Unterminated stage block");
}

function findNextKeyword(source, keyword, start = 0) {
  let i = start;
  while (i < source.length) {
    if (source.startsWith("//", i)) {
      const end = source.indexOf("\n", i + 2);
      if (end === -1) return -1;
      i = end + 1;
      continue;
    }
    if (source.startsWith("/*", i)) {
      const end = source.indexOf("*/", i + 2);
      if (end === -1) return -1;
      i = end + 2;
      continue;
    }
    if (source[i] === "\"") {
      i = readString(source, i).end;
      continue;
    }
    if (startsWithKeyword(source, i, keyword)) return i;
    i++;
  }
  return -1;
}

function skipWs(source, i) {
  while (i < source.length && /\s/.test(source[i])) i++;
  return i;
}

function isWordBoundary(source, i) {
  if (i < 0 || i >= source.length) return true;
  return !/[A-Za-z0-9_]/.test(source[i]);
}

function startsWithKeyword(source, start, keyword) {
  return source.startsWith(keyword, start)
    && isWordBoundary(source, start - 1)
    && isWordBoundary(source, start + keyword.length);
}
