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
