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
    const rgb = hslToRgb(hue / 360, 0.96, 0.68);
    // Store hue alongside RGB so callers building backgrounds can pick
    // a different lightness without round-tripping through RGB. The
    // Keep `r`/`g`/`b` flat for consumers that just want the colour.
    palette.set(name, { hue, r: rgb.r, g: rgb.g, b: rgb.b });
  }
  return palette;
}

export function fieldRgbForName(name, palette = activePalette) {
  const key = String(name ?? "field");
  const entry = palette.get(key);
  if (entry) return { r: entry.r, g: entry.g, b: entry.b };
  return standaloneColor(key);
}

export function fieldHueFor(name, palette = activePalette) {
  const key = String(name ?? "field");
  const entry = palette.get(key);
  if (entry?.hue !== undefined) return entry.hue;
  // Fallback when the palette hasn't been populated for this name yet.
  // Skips chooseSeparatedHue's spreading, but is fine for one-off
  // standalone callers (graph chip render before recipe load, etc.).
  return hashName(key) % 360;
}

export function fieldCssColor(name, palette = activePalette) {
  const { r, g, b } = fieldRgbForName(name, palette);
  return `rgb(${r}, ${g}, ${b})`;
}

export function fieldCssTint(name, mix = 38, palette = activePalette) {
  return `color-mix(in srgb, ${fieldCssColor(name, palette)} ${mix}%, transparent)`;
}

// Background-pill colour for a field token. Drops lightness from the
// palette's 68% (used for text) to 52% so the pill reads as a distinct
// saturated wash on a dark surround instead of a same-colour ghost of
// the text. `alpha` is the final pill opacity (0..1). 24% alpha tuned
// for the live editor's 10.5px font — at smaller pixel sizes the pill
// has less surface area, so it needs more saturation/opacity than the
// 12px demo to read as the same visual weight.
export function fieldCssBgPill(name, alpha = 0.24, palette = activePalette) {
  const hue = fieldHueFor(name, palette);
  return `hsl(${hue} 96% 52% / ${alpha})`;
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
