import { fieldRgbForName } from "./field-colors.mjs";
import { renderGeodesicPreviewGpu } from "./geodesic-preview-renderer.mjs";

export const PREVIEW_SIZE = 72;

export function drawFieldPreview(canvas, field, fieldName, resolution = null, grid = null, view = null) {
  const dpr = grid?.kind === "geodesic" ? 1 : Math.max(1, Math.min(window.devicePixelRatio || 1, 2));
  const previewResolution = normalizePreviewResolution(resolution ?? previewResolutionForGrid(grid));
  const width = previewResolution.width;
  const height = previewResolution.height;
  const targetW = Math.floor(width * dpr);
  const targetH = Math.floor(height * dpr);
  if (grid?.kind === "geodesic" && grid.topology) {
    if (!field) {
      if (canvas.width !== targetW || canvas.height !== targetH) {
        canvas.width = targetW;
        canvas.height = targetH;
      }
      return;
    }
    const rendered = renderGeodesicPreviewGpu(canvas, {
      field,
      topology: grid.topology,
      accent: fieldRgbForName(fieldName),
      range: fieldRange(field),
      view,
      width: targetW,
      height: targetH,
    });
    if (!rendered && canvas.width !== targetW) canvas.width = targetW;
    if (!rendered && canvas.height !== targetH) canvas.height = targetH;
    return;
  }
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  if (canvas.width !== targetW || canvas.height !== targetH) {
    canvas.width = targetW;
    canvas.height = targetH;
  }
  if (!field) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    return;
  }
  ctx.clearRect(0, 0, canvas.width, canvas.height);
}

export function isElementOnScreen(el) {
  const rect = el.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return false;
  return rect.right >= 0
    && rect.bottom >= 0
    && rect.left <= window.innerWidth
    && rect.top <= window.innerHeight;
}

export function previewResolutionForGrid(grid, { popout = false } = {}) {
  const size = popout ? Math.min(640, Math.max(384, Math.round(Math.sqrt(grid?.cells ?? 4096) * 2.6))) : PREVIEW_SIZE;
  return { width: size, height: size };
}

function fieldRange(field) {
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < field.length; i++) {
    const value = field[i];
    if (!Number.isFinite(value)) continue;
    if (value < min) min = value;
    if (value > max) max = value;
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    min = 0;
    max = 1;
  }
  return { min, max };
}

function normalizePreviewResolution(resolution = null) {
  const width = Number(resolution?.width ?? PREVIEW_SIZE);
  const height = Number(resolution?.height ?? PREVIEW_SIZE);
  return {
    width: clampNumber(Number.isFinite(width) ? Math.round(width) : PREVIEW_SIZE, 16, 1024),
    height: clampNumber(Number.isFinite(height) ? Math.round(height) : PREVIEW_SIZE, 16, 1024),
  };
}

function clampNumber(value, min, max) {
  return Math.max(min, Math.min(max, value));
}
