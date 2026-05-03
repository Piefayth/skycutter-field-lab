import { compileV2 as compileDsl } from "../dsl/compile-v2.mjs";

const SAVED_RECIPE_STORAGE_KEY = "skycutter.fieldLab.savedRecipes.v1";
const RECIPE_FILE_TYPE = "skycutter-field-lab.recipe";
const RECIPE_FILE_VERSION = 1;

export function loadSavedRecipes() {
  try {
    const raw = localStorage.getItem(SAVED_RECIPE_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed.map((item) => normalizeRecipeSnapshot(item, { existingIds: [] })).filter(Boolean);
  } catch (error) {
    console.warn("could not load saved recipes:", error);
    return [];
  }
}

export function persistSavedRecipes(snapshots) {
  localStorage.setItem(SAVED_RECIPE_STORAGE_KEY, JSON.stringify(snapshots));
}

export function upsertSavedRecipe(snapshots, snapshot) {
  const next = snapshots.filter((recipe) => recipe.id !== snapshot.id);
  next.unshift(snapshot);
  return next;
}

export function makeRecipeSnapshot({
  id = null,
  name,
  summary,
  pipelineDsl,
  baseRecipeId,
  defaultRecipeId = null,
  existing = null,
  existingIds = [],
}) {
  if (typeof pipelineDsl !== "string" || pipelineDsl.trim() === "") {
    throw new Error("recipe has no pipeline DSL");
  }
  compileDsl(pipelineDsl);
  const now = new Date().toISOString();
  const snapshot = {
    type: RECIPE_FILE_TYPE,
    version: RECIPE_FILE_VERSION,
    id: id ?? uniqueSavedRecipeId(name, existingIds),
    name: String(name ?? "Untitled recipe").trim() || "Untitled recipe",
    summary: String(summary ?? ""),
    baseRecipeId: baseRecipeId ?? defaultRecipeId,
    pipelineDsl,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  return normalizeRecipeSnapshot(snapshot, { existingIds });
}

export function parseRecipeFile(text, { filename, baseRecipeId, existingIds = [] } = {}) {
  let raw = null;
  try {
    raw = JSON.parse(text);
  } catch {
    raw = {
      name: inferRecipeName(text) ?? filename?.replace(/\.[^.]+$/, "") ?? "Imported recipe",
      summary: "",
      baseRecipeId,
      pipelineDsl: text,
    };
  }
  const snapshot = normalizeRecipeSnapshot({
    ...raw,
    baseRecipeId: raw.baseRecipeId ?? baseRecipeId,
  }, { existingIds });
  if (!snapshot) throw new Error("file is not a Field Lab recipe");
  compileDsl(snapshot.pipelineDsl);
  return {
    ...snapshot,
    id: uniqueSavedRecipeId(snapshot.name, existingIds),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

export function downloadRecipeSnapshot(snapshot) {
  const blob = new Blob([`${JSON.stringify(snapshot, null, 2)}\n`], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${slugify(snapshot.name)}.fieldlab-recipe.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function pickRecipeFile() {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json,.fieldlab-recipe,application/json,text/plain";
    input.addEventListener("change", () => resolve(input.files?.[0] ?? null), { once: true });
    input.click();
  });
}

function normalizeRecipeSnapshot(value, { existingIds = [] } = {}) {
  if (!value || typeof value !== "object") return null;
  if (value.type && value.type !== RECIPE_FILE_TYPE) return null;
  if (typeof value.pipelineDsl !== "string" || value.pipelineDsl.trim() === "") return null;
  const name = String(value.name ?? inferRecipeName(value.pipelineDsl) ?? "Untitled recipe").trim()
    || "Untitled recipe";
  return {
    type: RECIPE_FILE_TYPE,
    version: RECIPE_FILE_VERSION,
    id: typeof value.id === "string" && value.id.startsWith("local:")
      ? value.id
      : uniqueSavedRecipeId(name, existingIds),
    name,
    summary: String(value.summary ?? ""),
    baseRecipeId: typeof value.baseRecipeId === "string" ? value.baseRecipeId : null,
    pipelineDsl: value.pipelineDsl,
    createdAt: typeof value.createdAt === "string" ? value.createdAt : new Date().toISOString(),
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : new Date().toISOString(),
  };
}

function uniqueSavedRecipeId(name, existingIds = []) {
  const base = slugify(name || "recipe");
  let id = `local:${base}`;
  const existing = new Set(existingIds);
  if (!existing.has(id)) return id;
  let i = 2;
  while (existing.has(`${id}-${i}`)) i++;
  return `${id}-${i}`;
}

function slugify(value) {
  const slug = String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "recipe";
}

function inferRecipeName(source) {
  try {
    return compileDsl(source).dsl?.recipe?.name ?? null;
  } catch {
    const match = String(source).match(/^\s*recipe\s+"([^"]+)"/m);
    return match?.[1] ?? null;
  }
}
