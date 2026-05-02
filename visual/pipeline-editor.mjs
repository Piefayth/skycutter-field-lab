// =============================================================================
// Editors hub — Pipeline DSL graph/editor.
//
// Recipes.mjs calls `editors.loadRecipe(runner, recipeId)` after loading
// a recipe and the mounted editors refresh themselves against the new runner.
// Persistence model (post-cutover): edits do NOT auto-save. The runner is
// the live, mutable source of truth during a session. Mutating a node
// body, renaming a node, drawing a wire, etc. all reshape the runner in
// place; a browser refresh discards them and reloads the recipe from
// disk in its baseline shape. The recipe source files are the only
// persistence today.
// =============================================================================

import { mountPipelineGraph } from "./pipeline-graph.mjs";

const registry = {
  runner: null,
  recipeId: null,
  selectedNodeId: null,
  loadRecipe: null,
  setStatus: null,
  refreshAll: null,
  refreshPreviews: null,
  hasPreviewPopouts: null,
  applyPipelineDsl: null,
  getState: null,
  getPreviewView: null,
  isVisible: null,
};

export const pipelineEditor = registry;

let pipelineEditorAPI = null;

let pipelineWin = null;

export function initEditors({ pipelineWindow, getState, getPreviewView }) {
  pipelineWin = pipelineWindow;
  registry.getState = getState ?? null;
  registry.getPreviewView = getPreviewView ?? null;

  pipelineEditorAPI = mountPipelineGraph(pipelineWin.contentEl, buildPipelineApi());

  registry.loadRecipe = loadRecipe;
  registry.setStatus = (msg, isError) => pipelineEditorAPI.setStatus(msg, isError);
  registry.refreshAll = refreshAll;
  registry.refreshPreviews = () => pipelineEditorAPI?.refreshPreviews?.();
  registry.hasPreviewPopouts = () => Boolean(pipelineEditorAPI?.hasPreviewPopouts?.());
  registry.isVisible = () => Boolean(pipelineWin?.isVisible?.() && !pipelineWin?.isMinimized?.());
}

function loadRecipe(runner, recipeId) {
  registry.runner = runner;
  registry.recipeId = recipeId;
  registry.selectedNodeId = runner.sortedIds[0] ?? null;
  refreshAll();
  pipelineEditorAPI?.setStatus(
    `pipeline ready — ${runner.sortedIds.length} node${runner.sortedIds.length === 1 ? "" : "s"}`,
  );
}

function refreshAll() {
  pipelineEditorAPI?.refresh();
}

// -----------------------------------------------------------------------
// Pipeline editor API
// -----------------------------------------------------------------------
function buildPipelineApi() {
  return {
    emptyLabel: "no recipe loaded",
    // Graph editor reads `runner` for richer info (output fields,
    // enabled state) and `edges()` for wire rendering.
    get runner() { return registry.runner; },
    getState: () => registry.getState?.() ?? null,
    getPreviewView: () => registry.getPreviewView?.() ?? null,
    isVisible: () => Boolean(pipelineWin?.isVisible?.() && !pipelineWin?.isMinimized?.()),
    edges: () => registry.runner?.edges ?? [],
    pipelineMeta: () => registry.runner?.pipelineMeta?.() ?? null,
    paramMeta: () => registry.runner?.pipelineMeta?.()?.parameters ?? [],
    fieldMeta: () => registry.runner?.pipelineMeta?.()?.fields ?? [],
    list() {
      const r = registry.runner;
      if (!r) return [];
      return r.sortedIds.map((id) => {
        const node = r.nodes[id];
        const dsl = r.nodeDsl?.(id) ?? node.dsl ?? null;
        const item = {
          id,
          label: node.name ?? id,
          dsl,
          inputs: {
            ...(node.inputs ?? {}),
            fields: dsl?.reads ?? [],
            params: dsl?.params ?? node.inputs?.params ?? [],
          },
          outputs: {
            fields: dsl?.outputs ?? [],
            declared: dsl?.declares ?? [],
          },
        };
        if (node.kind === "variable") {
          item.kind = "variable";
          item.varType = node.type;
          item.varValue = node.value;
        }
        return item;
      });
    },
    getDsl(id) { return registry.runner?.nodeDsl?.(id) ?? null; },
    getPipelineDsl() { return registry.runner?.pipelineDsl?.() ?? null; },
    applyPipelineDsl(source) {
      if (typeof registry.applyPipelineDsl !== "function") {
        throw new Error("pipeline DSL editing is not available");
      }
      return registry.applyPipelineDsl(source);
    },
    getEnabled(id) {
      const r = registry.runner;
      if (!r) return undefined;
      return r.nodes[id]?.enabled !== false;
    },
    setEnabled(id, value) {
      const r = registry.runner;
      if (!r) return;
      r.nodes[id].enabled = value;
    },
    setName(id, name) {
      const r = registry.runner;
      if (!r || !r.nodes[id]) return;
      r.nodes[id].name = name;
    },
    setValue(id, value) {
      const r = registry.runner;
      if (!r || !r.nodes[id]) return;
      if (r.nodes[id].kind !== "variable") {
        throw new Error(`node "${id}" is not a variable`);
      }
      r.nodes[id].value = value;
    },
    onChange(action, id) {
      registry.selectedNodeId = id;
      // Name / enabled / variable-value changes affect what the graph
      // renders (title, disabled styling, value text). Refresh the
      // pipeline pane so the graph picks up the new state.
      if (action === "name" || action === "enable" || action === "value") {
        pipelineEditorAPI?.refresh?.();
      }
    },
    // Wire-creation. Returns true if the runner accepted the edge —
    // the graph drag UI keys success on this. The edge lives on the
    // runner only; refresh discards it (until "Save as recipe" lands).
    addEdge(fromNodeId, fromPort, toNodeId, toPort) {
      const r = registry.runner;
      if (!r?.addEdge) return false;
      return r.addEdge(fromNodeId, fromPort, toNodeId, toPort);
    },
  };
}
