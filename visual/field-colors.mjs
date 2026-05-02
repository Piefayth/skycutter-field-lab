// Deterministic field-name colors. This keeps authored field names out of
// style.css while making graph ports, wires, previews, and editor tokens agree.

let activePalette = new Map();

export function configureFieldColorPalette(fieldNames = []) {
  activePalette = createFieldColorPalette(fieldNames);
  return activePalette;
}

export function createFieldColorPalette(fieldNames = []) {
  const names = normalizeNames(fieldNames);
  const ordered = [...names].sort((a, b) => hashName(a) - hashName(b) || a.localeCompare(b));
  const palette = new Map();
  const usedHues = [];
  for (const name of ordered) {
    const hue = chooseSeparatedHue(hashName(name) % 360, usedHues);
    usedHues.push(hue);
    palette.set(name, hslToRgb(hue / 360, 0.96, 0.68));
  }
  return palette;
}

export function fieldRgbForName(name, palette = activePalette) {
  const key = String(name ?? "field");
  return palette.get(key) ?? standaloneColor(key);
}

export function fieldCssColor(name, palette = activePalette) {
  const { r, g, b } = fieldRgbForName(name, palette);
  return `rgb(${r}, ${g}, ${b})`;
}

export function fieldCssTint(name, mix = 38, palette = activePalette) {
  return `color-mix(in srgb, ${fieldCssColor(name, palette)} ${mix}%, transparent)`;
}

function normalizeNames(fieldNames) {
  return [...new Set(fieldNames.map((name) => String(name ?? "").trim()).filter(Boolean))];
}

function standaloneColor(name) {
  const hue = hashName(name) % 360;
  return hslToRgb(hue / 360, 0.96, 0.68);
}

function chooseSeparatedHue(preferredHue, usedHues) {
  if (usedHues.length === 0) return preferredHue;
  let bestHue = preferredHue;
  let bestScore = -Infinity;
  for (let hue = 0; hue < 360; hue += 4) {
    const minDistance = Math.min(...usedHues.map((used) => hueDistance(hue, used)));
    const preferencePenalty = hueDistance(hue, preferredHue) * 0.18;
    const score = minDistance - preferencePenalty;
    if (score > bestScore) {
      bestScore = score;
      bestHue = hue;
    }
  }
  return bestHue;
}

function hueDistance(a, b) {
  const delta = Math.abs(a - b) % 360;
  return Math.min(delta, 360 - delta);
}

function hashName(name) {
  let hash = 2166136261;
  for (let i = 0; i < name.length; i++) {
    hash ^= name.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function hslToRgb(h, s, l) {
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return {
    r: Math.round(hueToRgb(p, q, h + 1 / 3) * 255),
    g: Math.round(hueToRgb(p, q, h) * 255),
    b: Math.round(hueToRgb(p, q, h - 1 / 3) * 255),
  };
}

function hueToRgb(p, q, t) {
  let x = t;
  if (x < 0) x += 1;
  if (x > 1) x -= 1;
  if (x < 1 / 6) return p + (q - p) * 6 * x;
  if (x < 1 / 2) return q;
  if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
  return p;
}
