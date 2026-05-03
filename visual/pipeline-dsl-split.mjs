export function findStageRange(source, targetId) {
  if (!source || !targetId) return null;
  let i = 0;
  while (i < source.length) {
    const start = source.indexOf("stage", i);
    if (start === -1) return null;
    if (!isWordBoundary(source, start - 1) || !isWordBoundary(source, start + 5)) {
      i = start + 5;
      continue;
    }
    let cursor = skipWs(source, start + 5);
    const id = readIdentifier(source, cursor);
    if (!id) {
      i = start + 5;
      continue;
    }
    cursor = skipWs(source, id.end);
    if (source[cursor] === "\"") {
      const name = readQuotedString(source, cursor);
      if (!name) return null;
      cursor = skipWs(source, name.end);
    }
    if (source[cursor] !== "{") {
      i = cursor + 1;
      continue;
    }
    const block = readBlockEnd(source, cursor);
    if (!block) return null;
    if (id.value === targetId) return { from: start, to: block.end };
    i = block.end;
  }
  return null;
}

export function extractTopLevelBlocks(source, keyword) {
  return extractTopLevelBlockRanges(source, keyword).map((range) => range.text.trim());
}

export function splitPipelineDsl(source) {
  const stampRanges = extractTopLevelBlockRanges(source, "stamp");
  // v2 surface keyword is `scenario`; legacy `preset` blocks are
  // accepted as an alias so any older saved-recipe text still
  // routes into the right editor section.
  const presetRanges = [
    ...extractTopLevelBlockRanges(source, "scenario"),
    ...extractTopLevelBlockRanges(source, "preset"),
  ];
  // Render-config slice — palette + view blocks. Overlays are
  // one-line declarations (no braces) so they don't match the
  // block extractor; they stay in the main pipeline section.
  const viewRanges = [
    ...extractTopLevelBlockRanges(source, "palette"),
    ...extractTopLevelBlockRanges(source, "view"),
  ];
  const ranges = [...stampRanges, ...presetRanges, ...viewRanges].sort((a, b) => a.from - b.from);
  let main = source ?? "";
  for (const range of [...ranges].sort((a, b) => b.from - a.from)) {
    main = `${main.slice(0, range.from)}\n${main.slice(range.to)}`;
  }
  return {
    main: cleanSplitDslText(main),
    stamps: stampRanges.map((range) => range.text.trim()).join("\n\n"),
    // The output key stays "presets" because the consumer
    // (pipeline-graph.mjs) refers to that section by id; renaming
    // it ripples into setSection lookups. Conceptually this slice
    // holds the recipe's scenarios.
    presets: presetRanges.sort((a, b) => a.from - b.from).map((range) => range.text.trim()).join("\n\n"),
    views: viewRanges.sort((a, b) => a.from - b.from).map((range) => range.text.trim()).join("\n\n"),
  };
}

function cleanSplitDslText(source) {
  return String(source ?? "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function extractTopLevelBlockRanges(source, keyword) {
  source = String(source ?? "");
  const blocks = [];
  let i = 0;
  while (i < source.length) {
    const start = source.indexOf(keyword, i);
    if (start < 0) break;
    if (!isWordBoundary(source, start - 1) || !isWordBoundary(source, start + keyword.length)) {
      i = start + keyword.length;
      continue;
    }
    let cursor = skipWs(source, start + keyword.length);
    const id = readIdentifier(source, cursor);
    if (!id) {
      i = start + keyword.length;
      continue;
    }
    cursor = skipWs(source, id.end);
    if (source[cursor] === "\"") {
      const name = readQuotedString(source, cursor);
      if (!name) {
        i = cursor + 1;
        continue;
      }
      cursor = skipWs(source, name.end);
    }
    if (source[cursor] !== "{") {
      i = cursor + 1;
      continue;
    }
    const block = readBlockEnd(source, cursor);
    if (!block) break;
    blocks.push({ from: start, to: block.end, text: source.slice(start, block.end) });
    i = block.end;
  }
  return blocks;
}

function readIdentifier(source, start) {
  const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(source.slice(start));
  if (!match) return null;
  return { value: match[0], end: start + match[0].length };
}

function readQuotedString(source, start) {
  let i = start + 1;
  while (i < source.length) {
    if (source[i] === "\\" && i + 1 < source.length) {
      i += 2;
      continue;
    }
    if (source[i] === "\"") return { end: i + 1 };
    i++;
  }
  return null;
}

function readBlockEnd(source, start) {
  let depth = 0;
  let i = start;
  let inFence = false;
  while (i < source.length) {
    if (source.startsWith("```", i)) {
      inFence = !inFence;
      i += 3;
      continue;
    }
    const ch = source[i];
    if (!inFence && ch === "{") depth++;
    if (!inFence && ch === "}") {
      depth--;
      if (depth === 0) return { end: i + 1 };
    }
    i++;
  }
  return null;
}

function skipWs(source, start) {
  let i = start;
  while (i < source.length && /\s/.test(source[i])) i++;
  return i;
}

function isWordBoundary(source, i) {
  if (i < 0 || i >= source.length) return true;
  return !/[A-Za-z0-9_]/.test(source[i]);
}
