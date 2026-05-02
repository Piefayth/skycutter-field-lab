// =============================================================================
// Pipeline graph editor — walking skeleton.
//
// The Pipeline window's contents become two panes:
//
//   ┌────────────────────────────────────────┐
//   │   pipeline DSL editor                  │
//   ├ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ┤   ← phosphor sweep separator
//   │   graph canvas — nodes + wires         │
//   └────────────────────────────────────────┘
//
// Visual grammar mirrors the rest of the field-lab app:
//   - bone-mute graticule on dark ink (no signal-green in the grid;
//     wires are the only "live" thing on the canvas)
//   - depth-tick numerals along the top edge so the column-by-depth
//     layout reads as a schematic, not an arbitrary node-soup
//   - node cards lift their grammar from .lab-section: corner register
//     marks, flat ink-700 head bar, [N.NN] + condensed-uppercase title
//     + gradient rule, ink-850 body
//   - outputs render as field-color chips from the same name-derived
//     palette the probe/editor use
//   - hollow terminal ports that only fill when their wire is touched
//   - touched wires bloom + march via stroke-dashoffset (slow, ~2.4s)
//   - selected node highlights via bone-bright border + a phosphor
//     sweep beneath its head bar (mirrors .lab-header::after); other
//     nodes recede to 0.78 opacity so the signal-path is unambiguous
//
// What's deliberately NOT in this commit (in priority order):
//   - Position persistence per-recipe in localStorage
//   - Wire-rewiring (drag a port to connect/disconnect)
//   - Add-node / delete-node from the canvas
//   - Variable nodes (parameters / fields / sources / planet const as
//     value-shaped nodes with output ports)
//   - Per-node previews (output-field thumbnails)
//   - Pan / zoom (uses native scrolling)
// =============================================================================

import { createEditorView } from "./editor-core.mjs";
import { extractDslFieldNames, extractDslSourceNames, extractDslImmutableNames } from "./editor-fieldlab-lang.mjs";
import { configureFieldColorPalette, fieldCssColor, fieldCssTint, fieldRgbForName } from "./field-colors.mjs";
import { renderGeodesicPreviewGpu } from "./geodesic-preview-renderer.mjs";
import { showToast } from "./toast.mjs";
import { diagnoseDsl } from "../dsl/compiler.mjs";

const NODE_W = 280;
const NODE_H = 86;       // base; nodeHeight grows with port count
const VAR_W = 96;        // variable nodes are smaller — they're values, not stages
const VAR_H = 44;
const RAIL_W = 160;
const RAIL_H = 54;
const COL_GAP = 64;
const ROW_GAP = 28;
const PADDING_X = 24;
const PADDING_Y = 32;     // leaves room for depth-tick row above first node
const PREVIEW_W = 72;
const MIN_ZOOM = 0.35;
const MAX_ZOOM = 2.2;

export function mountPipelineGraph(rootEl, api) {
  rootEl.classList.add("pg-root");
  rootEl.replaceChildren();

  // ---- Layout: pipeline DSL + graph ----------------------------------------
  const dslPane = document.createElement("section");
  dslPane.className = "pg-dsl-pane";
  rootEl.appendChild(dslPane);

  const dslHeader = document.createElement("div");
  dslHeader.className = "pg-dsl-pane__header";
  dslPane.appendChild(dslHeader);

  const dslTitle = document.createElement("div");
  dslTitle.className = "pg-dsl-pane__title";
  dslTitle.textContent = "DSLS";
  dslHeader.appendChild(dslTitle);

  const dslStatus = document.createElement("div");
  dslStatus.className = "pg-dsl-pane__status";
  dslHeader.appendChild(dslStatus);

  let activeDslSection = "pipeline";
  let suppressDslToggle = false;

  const dslStack = document.createElement("div");
  dslStack.className = "pg-dsl-stack";
  dslStack.dataset.active = activeDslSection;
  dslPane.appendChild(dslStack);

  const pipelineDslSection = makeDslEditorSection("pipeline", "pipeline", { open: true });
  const stampDslSection = makeDslEditorSection("stamps", "stamp");
  const presetDslSection = makeDslEditorSection("presets", "preset");
  dslStack.append(pipelineDslSection.root, stampDslSection.root, presetDslSection.root);

  const dslButtons = document.createElement("div");
  dslButtons.className = "pg-dsl-pane__buttons";
  dslPane.appendChild(dslButtons);

  const dslApplyBtn = mkButton("Apply DSL", "btn--primary");
  const dslResetBtn = mkButton("Revert");
  dslButtons.appendChild(dslApplyBtn);
  dslButtons.appendChild(dslResetBtn);

  const dslDiagnostics = document.createElement("pre");
  dslDiagnostics.className = "pg-dsl-pane__diagnostics";
  dslPane.appendChild(dslDiagnostics);

  const dslCmHost = pipelineDslSection.editorHost;
  const dslEditor = pipelineDslSection.editor;
  const dslSections = [pipelineDslSection, stampDslSection, presetDslSection];
  setupDslAccordion();
  installDslDebugHook();

  const graphWrap = document.createElement("div");
  graphWrap.className = "pg-graph-wrap";
  rootEl.appendChild(graphWrap);

  // Viewport-sized graticule. It is not part of the transformed graph
  // scene because zooming out can make the scene smaller than the
  // viewport; the grid still tracks pan/zoom through CSS variables.
  const grid = document.createElement("div");
  grid.className = "pg-grid";
  graphWrap.appendChild(grid);

  const graphScene = document.createElement("div");
  graphScene.className = "pg-graph-scene";
  graphWrap.appendChild(graphScene);

  // Depth-tick numerals along the top edge. Populated per-rebuild so
  // the labels track the active recipe's column count.
  const depthRow = document.createElement("div");
  depthRow.className = "pg-depth-ticks";
  graphScene.appendChild(depthRow);

  // Wires SVG layer — beneath nodes so wires draw under the cards.
  const wireSvg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  wireSvg.setAttribute("class", "pg-wires");
  graphScene.appendChild(wireSvg);

  // Preview wire — the line that follows the cursor while the user is
  // dragging from an output port. Single SVG path, hidden by default,
  // its `d` attribute updated on every pointermove during a drag.
  const previewWire = document.createElementNS("http://www.w3.org/2000/svg", "path");
  previewWire.setAttribute("class", "pg-wire pg-wire--preview");
  previewWire.style.display = "none";
  wireSvg.appendChild(previewWire);

  // Node container — absolutely-positioned cards laid out inside.
  const nodeLayer = document.createElement("div");
  nodeLayer.className = "pg-node-layer";
  graphScene.appendChild(nodeLayer);

  const graphHud = document.createElement("div");
  graphHud.className = "pg-graph-hud";
  graphWrap.appendChild(graphHud);

  const zoomOutBtn = mkButton("-", "pg-graph-hud__btn");
  zoomOutBtn.title = "Zoom out";
  const zoomResetBtn = mkButton("100", "pg-graph-hud__btn");
  zoomResetBtn.title = "Reset zoom and pan";
  const zoomInBtn = mkButton("+", "pg-graph-hud__btn");
  zoomInBtn.title = "Zoom in";
  const zoomFitBtn = mkButton("Fit", "pg-graph-hud__btn");
  zoomFitBtn.title = "Fit graph to viewport";
  const zoomReadout = document.createElement("span");
  zoomReadout.className = "pg-graph-hud__readout";
  graphHud.append(zoomOutBtn, zoomResetBtn, zoomInBtn, zoomFitBtn, zoomReadout);

  graphWrap.addEventListener("pointerdown", (event) => {
    if (![0, 1, 2].includes(event.button)) return;
    if (event.target.closest(".pg-graph-hud, .pg-node, .pg-var, .pg-rail, .pg-port, .pg-port-row")) return;
    beginPan(event);
  });
  graphWrap.addEventListener("wheel", onGraphWheel, { passive: false });
  graphWrap.addEventListener("contextmenu", (event) => event.preventDefault());
  graphWrap.addEventListener("pointerenter", () => scheduleWireReroute());
  window.addEventListener("resize", () => scheduleWireReroute());
  const resizeObserver = typeof ResizeObserver !== "undefined"
    ? new ResizeObserver(() => scheduleWireReroute())
    : null;
  resizeObserver?.observe(graphWrap);
  resizeObserver?.observe(nodeLayer);

  // ---- Graph state -------------------------------------------------------
  const positions = new Map();   // id → { x, y }
  const nodeEls = new Map();     // id → element
  const itemById = new Map();    // id → list-item (kind, varType, varValue, …)
  const previewCanvases = new Map(); // "nodeId:field" → canvas
  const previewPopouts = new Map();
  let nextPreviewPopoutId = 1;
  let selectedId = null;
  let loadedDslSource = "";
  let dslDirty = false;
  let paramMetaMap = new Map();
  let zoom = 1;
  let pan = { x: 0, y: 0 };
  let graphBounds = { width: 1, height: 1 };
  let wireRerouteFrame = 0;
  let lastPreviewAt = 0;
  let fieldKindMap = new Map();

  // ---- Build / refresh ---------------------------------------------------
  function refresh() {
    refreshPipelineDsl();
    rebuildGraph();
  }

  function mkButton(label, cls = "") {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `btn ${cls}`.trim();
    button.textContent = label;
    return button;
  }

  function makeDslEditorSection(title, kind, { open = false } = {}) {
    const root = document.createElement("details");
    root.className = "pg-dsl-section";
    root.dataset.dslSection = kind;
    root.open = open;

    const summary = document.createElement("summary");
    summary.className = "pg-dsl-section__summary";
    root.appendChild(summary);

    const label = document.createElement("span");
    label.className = "pg-dsl-section__title";
    label.textContent = title;
    summary.appendChild(label);

    const count = document.createElement("span");
    count.className = "pg-dsl-section__count";
    summary.appendChild(count);

    const editorHost = document.createElement("div");
    editorHost.className = "pg-dsl-section__editor";
    if (kind === "pipeline") editorHost.classList.add("pg-dsl-pane__cm");
    root.appendChild(editorHost);

    const editor = createEditorView({
      parent: editorHost,
      language: "fieldlab",
      onApply: () => applyPipelineDsl(),
      onDocChange: () => {
        dslDirty = true;
        validatePipelineDsl();
      },
    });

    return { kind, root, count, editorHost, editor };
  }

  function setupDslAccordion() {
    for (const section of dslSections) {
      section.root.addEventListener("toggle", () => {
        if (suppressDslToggle) return;
        if (section.root.open) {
          activateDslSection(section.kind);
          return;
        }
        if (activeDslSection === section.kind) {
          activateDslSection(section.kind);
        }
      });
    }
    activateDslSection(activeDslSection);
  }

  function activateDslSection(kind) {
    activeDslSection = kind;
    dslStack.dataset.active = kind;
    suppressDslToggle = true;
    for (const section of dslSections) {
      section.root.open = section.kind === kind;
    }
    suppressDslToggle = false;
    const active = dslSections.find((section) => section.kind === kind);
    requestAnimationFrame(() => active?.editor.refreshLayout?.());
  }

  function installDslDebugHook() {
    window.fieldLabDebug ??= {};
    window.fieldLabDebug.pipelineDslScroll = () => {
      const rows = {};
      const containers = {
        root: rectSummary(rootEl),
        pane: rectSummary(dslPane),
        stack: rectSummary(dslStack),
      };
      for (const section of dslSections) {
        const editorEl = section.editor.view.dom;
        const scroller = section.editor.view.scrollDOM;
        rows[section.kind] = {
          open: section.root.open,
          host: rectSummary(section.editorHost),
          editor: rectSummary(editorEl),
          scroller: {
            ...rectSummary(scroller),
            overflowY: getComputedStyle(scroller).overflowY,
            scrollTop: scroller.scrollTop,
            scrollHeight: scroller.scrollHeight,
            clientHeight: scroller.clientHeight,
            canScroll: scroller.scrollHeight > scroller.clientHeight,
          },
        };
      }
      console.table(Object.entries(rows).map(([kind, row]) => ({
        kind,
        open: row.open,
        hostH: row.host.height,
        editorH: row.editor.height,
        scrollerH: row.scroller.height,
        clientH: row.scroller.clientHeight,
        scrollH: row.scroller.scrollHeight,
        overflowY: row.scroller.overflowY,
        canScroll: row.scroller.canScroll,
      })));
      console.table(containers);
      return { containers, sections: rows };
    };
  }

  function rectSummary(el) {
    const rect = el.getBoundingClientRect();
    return {
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    };
  }

  function refreshPipelineDsl() {
    const source = api.getPipelineDsl?.();
    const hasSource = typeof source === "string";
    const text = hasSource ? source : "";
    const canApply = typeof api.applyPipelineDsl === "function";
    dslApplyBtn.disabled = !canApply;
    dslResetBtn.disabled = !canApply;
    dslCmHost.classList.toggle("pg-dsl-pane__cm--empty", !text);
    if (!dslDirty || text !== loadedDslSource) {
      loadedDslSource = text;
      dslDirty = false;
      setSplitDslSource(text);
      if (hasSource) {
        validatePipelineDsl();
      } else {
        dslStatus.textContent = "no pipeline dsl source";
        dslStatus.classList.remove("is-error");
        dslDiagnostics.textContent = "";
        dslDiagnostics.hidden = true;
      }
    }
  }

  function validatePipelineDsl() {
    const source = composePipelineDsl();
    refreshDslFieldNames();
    dslCmHost.classList.toggle("pg-dsl-pane__cm--empty", !dslEditor.getSource());
    updateDslExtractCounts();
    const result = diagnoseDsl(source);
    dslStatus.classList.toggle("is-error", !result.ok);
    if (result.ok) {
      const stageCount = result.stages.length;
      dslStatus.textContent = `${dslDirty ? "edited, " : ""}valid — ${stageCount} stage${stageCount === 1 ? "" : "s"}`;
      dslDiagnostics.textContent = "";
      dslDiagnostics.hidden = true;
      return result;
    }
    dslStatus.textContent = `${dslDirty ? "edited, " : ""}${result.errors.length} diagnostic${result.errors.length === 1 ? "" : "s"}`;
    dslDiagnostics.textContent = result.errors.map((error) => `error: ${error.message}`).join("\n");
    dslDiagnostics.hidden = false;
    return result;
  }

  function applyPipelineDsl() {
    const result = validatePipelineDsl();
    if (!result.ok) {
      showToast("pipeline DSL has diagnostics", { kind: "error" });
      return;
    }
    const source = composePipelineDsl();
    try {
      api.applyPipelineDsl(source);
      loadedDslSource = source;
      dslDirty = false;
      validatePipelineDsl();
    } catch (error) {
      console.error("DSL apply failed:", error);
      showToast(`DSL apply failed: ${error.message}`, { kind: "error" });
      dslStatus.textContent = `apply failed: ${error.message}`;
      dslStatus.classList.add("is-error");
      dslDiagnostics.textContent = `error: ${error.message}`;
      dslDiagnostics.hidden = false;
    }
  }

  function revertPipelineDsl() {
    setSplitDslSource(loadedDslSource ?? "");
    dslDirty = false;
    validatePipelineDsl();
  }

  function setSplitDslSource(source) {
    const split = splitPipelineDsl(source);
    refreshDslFieldNames(split);
    dslEditor.setSource(split.main);
    stampDslSection.editor.setSource(split.stamps);
    presetDslSection.editor.setSource(split.presets);
    updateDslExtractCounts();
  }

  function refreshDslFieldNames(split = null) {
    const source = split
      ? `${split.main}\n${split.stamps}\n${split.presets}`
      : composePipelineDsl();
    const names = extractDslFieldNames(source);
    const sources = extractDslSourceNames(source);
    const immutables = extractDslImmutableNames(source);
    configureFieldColorPalette(names);
    for (const section of dslSections) section.editor.setFieldNames?.(names, sources, immutables);
  }

  function composePipelineDsl() {
    return [
      dslEditor.getSource().trim(),
      stampDslSection.editor.getSource().trim(),
      presetDslSection.editor.getSource().trim(),
    ].filter(Boolean).join("\n\n");
  }

  function updateDslExtractCounts() {
    pipelineDslSection.count.textContent = `${extractTopLevelBlocks(dslEditor.getSource(), "stage").length}`;
    stampDslSection.count.textContent = `${extractTopLevelBlocks(stampDslSection.editor.getSource(), "stamp").length}`;
    presetDslSection.count.textContent = `${extractTopLevelBlocks(presetDslSection.editor.getSource(), "preset").length}`;
  }

  dslApplyBtn.addEventListener("click", applyPipelineDsl);
  dslResetBtn.addEventListener("click", revertPipelineDsl);

  function rebuildGraph() {
    nodeLayer.replaceChildren();
    nodeEls.clear();
    previewCanvases.clear();
    // Wipe wire paths but keep the preview wire (which hides itself
    // when no drag is in progress).
    for (const child of [...wireSvg.children]) {
      if (child !== previewWire) wireSvg.removeChild(child);
    }
    depthRow.replaceChildren();

    // Drop any prior empty-state element.
    for (const stale of graphWrap.querySelectorAll(".pg-empty")) stale.remove();

    const stageItems = api.list();
    const paramMeta = api.paramMeta?.() ?? [];
    const fieldMeta = api.fieldMeta?.() ?? [];
    paramMetaMap = new Map(paramMeta.map((decl) => [decl.name, decl]).filter(([name]) => Boolean(name)));
    fieldKindMap = new Map(fieldMeta.map((decl) => [decl.name, decl.kind ?? "field"]).filter(([name]) => Boolean(name)));
    const graphModel = buildGraphModel(stageItems, api.edges?.() ?? [], paramMeta, fieldMeta);
    const items = graphModel.items;
    const edges = graphModel.edges;
    if (!stageItems.length) {
      const empty = document.createElement("div");
      empty.className = "pg-empty";
      const cross = document.createElement("div");
      cross.className = "pg-empty__crosshair";
      empty.appendChild(cross);
      const label = document.createElement("div");
      label.textContent = "no nodes — load or build a pipeline";
      empty.appendChild(label);
      graphWrap.appendChild(empty);
      graphWrap.classList.remove("pg-graph-wrap--has-selection");
      return;
    }

    // Auto-layout: column = topological depth (longest path from any
    // source). Stack within column by insertion order. Deterministic
    // spatial reflection of the topo sort the runtime already does.
    const depthByNode = computeDepths(items.map((i) => i.id), edges);
    const columns = new Map(); // depth → ids[]
    let maxDepth = 0;
    for (const item of items) {
      const d = depthByNode.get(item.id) ?? 0;
      if (d > maxDepth) maxDepth = d;
      if (!columns.has(d)) columns.set(d, []);
      columns.get(d).push(item.id);
    }

    // Quick lookup: id → item, used by renderNode, wirePath, and
    // height-aware layout below.
    itemById.clear();
    for (const item of items) itemById.set(item.id, item);

    const orderedColumns = orderColumns(columns, edges);
    for (const [depth, ids] of orderedColumns) {
      let y = PADDING_Y;
      ids.forEach((id) => {
        const x = PADDING_X + depth * (NODE_W + COL_GAP);
        positions.set(id, { x, y });
        y += nodeHeight(id) + ROW_GAP;
      });
    }

    // Depth ticks across the top edge — D.00, D.01, … aligned with
    // each column's center. Makes "left → right" mean "deeper in the
    // dataflow" without anyone having to ask.
    for (let d = 0; d <= maxDepth; d++) {
      const tick = document.createElement("span");
      tick.className = "pg-depth-tick";
      tick.textContent = `D.${String(d).padStart(2, "0")}`;
      tick.style.left = `${PADDING_X + d * (NODE_W + COL_GAP) + NODE_W / 2 - 18}px`;
      depthRow.appendChild(tick);
    }

    // Render nodes.
    items.forEach((item, idx) => {
      const node = renderNode(item, idx);
      nodeLayer.appendChild(node);
      nodeEls.set(item.id, node);
    });

    // Render wires.
    for (const edge of edges) {
      const fromId = edge.from?.node;
      const toId = edge.to?.node;
      if (!positions.has(fromId) || !positions.has(toId)) continue;
      wireSvg.appendChild(makeWire(fromId, toId, edge));
    }

    recomputeBounds();
    scheduleWireReroute();
    renderPreviews(true);

    if (selectedId && !positions.has(selectedId)) selectedId = null;
    if (!selectedId && items.length) selectedId = items[0].id;
    if (selectedId) highlightSelected(selectedId);
  }

  // Single source of truth for canvas sizing. Called from rebuildGraph
  // and after every drag, so the SVG viewport + nodeLayer scroll extent
  // both track the current node positions. Without the post-drag call,
  // dragging a node below the initial layout shoves its wire endpoints
  // past wireSvg.height; with overflow:visible the path still renders,
  // but the scroll region wouldn't grow to expose the dragged node.
  function recomputeBounds() {
    let maxX = 0, maxY = 0;
    for (const [id, { x, y }] of positions.entries()) {
      const w = nodeWidth(id);
      const h = nodeHeight(id);
      maxX = Math.max(maxX, x + w);
      maxY = Math.max(maxY, y + h);
    }
    const totalW = maxX + PADDING_X;
    const totalH = maxY + PADDING_X;
    graphBounds = { width: Math.max(totalW, 1), height: Math.max(totalH, 1) };
    graphScene.style.width = `${graphBounds.width}px`;
    graphScene.style.height = `${graphBounds.height}px`;
    nodeLayer.style.width = `${totalW}px`;
    nodeLayer.style.height = `${totalH}px`;
    depthRow.style.width = `${totalW}px`;
    wireSvg.setAttribute("viewBox", `0 0 ${totalW} ${totalH}`);
    wireSvg.setAttribute("width", totalW);
    wireSvg.setAttribute("height", totalH);
    applyViewport();
  }

  function nodeWidth(id) {
    const kind = itemById.get(id)?.kind;
    if (kind === "variable") return VAR_W;
    if (kind === "rail") return RAIL_W;
    return NODE_W;
  }

  function nodeHeight(id) {
    const item = itemById.get(id);
    if (item?.kind === "variable") return VAR_H;
    if (item?.kind === "rail") {
      const count = Math.max(railPortCount(item), 1);
      return Math.max(RAIL_H, 34 + count * 18);
    }
    const inCount = item?.inputs?.fields?.length ?? 0;
    const paramCount = item?.inputs?.params?.length ?? 0;
    const outCount = item?.outputs?.fields?.length ?? 0;
    const previewRows = outCount > 0 ? Math.ceil(outCount / 3) : 0;
    const previewHeight = previewRows > 0 ? 18 + previewRows * (previewThumbHeight() + 14) : 0;
    return Math.max(NODE_H, 54 + Math.max(inCount + paramCount, outCount, 1) * 18 + previewHeight);
  }

  function previewThumbHeight() {
    return PREVIEW_W;
  }

  function renderNode(item, listIndex) {
    if (item.kind === "variable") return renderVariableNode(item);
    if (item.kind === "rail") return renderRailNode(item);
    return renderKernelNode(item, listIndex);
  }

  function renderRailNode(item) {
    const el = document.createElement("div");
    el.className = `pg-rail pg-rail--${item.railSide}`;
    el.dataset.nodeId = item.id;
    const { x, y } = positions.get(item.id);
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
    el.style.width = `${RAIL_W}px`;
    el.style.minHeight = `${nodeHeight(item.id)}px`;

    const label = document.createElement("span");
    label.className = "pg-rail__title";
    label.textContent = item.railSide === "input" ? "inputs" : "state out";
    el.appendChild(label);

    const side = item.railSide === "input" ? "out" : "in";

    const fieldRows = item.railSide === "input"
      ? item.outputs?.fields ?? []
      : item.inputs?.fields ?? [];
    if (fieldRows.length) {
      el.appendChild(renderRailRows("fields", fieldRows, item.id, side, "field"));
    }
    if (item.railSide === "input" && item.outputs?.sources?.length) {
      el.appendChild(renderRailRows("sources", item.outputs.sources, item.id, side, "source"));
    }
    if (item.railSide === "input" && item.outputs?.params?.length) {
      el.appendChild(renderRailRows("params", item.outputs.params, item.id, side, "param"));
    }

    attachDrag(el, item, false);
    return el;
  }

  function renderRailRows(labelText, names, nodeId, side, kind) {
    const group = document.createElement("div");
    group.className = "pg-rail__group";
    const groupLabel = document.createElement("span");
    groupLabel.className = "pg-rail__group-label";
    groupLabel.textContent = labelText;
    group.appendChild(groupLabel);

    const rows = document.createElement("div");
    rows.className = "pg-rail__rows";
    for (const name of names) {
      const row = makePortRow(name, nodeId, side, kind);
      row.classList.add("pg-port-row--rail");
      rows.appendChild(row);
    }
    group.appendChild(rows);
    return group;
  }

  function renderKernelNode(item, listIndex) {
    const el = document.createElement("div");
    el.className = "pg-node";
    el.dataset.nodeId = item.id;
    const { x, y } = positions.get(item.id);
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
    el.style.width = `${NODE_W}px`;
    el.style.minHeight = `${nodeHeight(item.id)}px`;

    const enabled = api.getEnabled?.(item.id);
    if (enabled === false) el.classList.add("pg-node--disabled");

    // Head bar: [N.NN] + title + gradient rule, mirroring .lab-section.
    const head = document.createElement("header");
    head.className = "pg-node__head";

    const title = document.createElement("span");
    title.className = "pg-node__title";
    title.textContent = item.label;
    head.appendChild(title);

    const rule = document.createElement("span");
    rule.className = "pg-node__rule";
    head.appendChild(rule);

    const kind = summarizeDslKind(item.dsl);
    if (kind) {
      const kindTag = document.createElement("span");
      kindTag.className = "pg-node__kind-tag";
      kindTag.textContent = kindShortLabel(kind);
      kindTag.title = kind;
      head.appendChild(kindTag);
    }

    el.appendChild(head);

    // Body: field reads + param reads on the left, field writes on the
    // right. Fields are state dataflow; params are UI-supplied recipe
    // inputs, visually sourced from the input rail.
    const body = document.createElement("div");
    body.className = "pg-node__body";

    const inputs = item.inputs ?? {};
    const outputs = item.outputs ?? {};
    const inFields  = inputs.fields  ?? [];
    const inParams = inputs.params ?? [];
    const outFields = outputs.fields ?? [];
    const declared = new Set(outputs.declared ?? []);

    const cols = document.createElement("div");
    cols.className = "pg-node__cols";

    const inCol = document.createElement("div");
    inCol.className = "pg-port-col pg-port-col--in";
    for (const f of inFields) inCol.appendChild(makePortRow(f, item.id, "in", fieldKindMap.get(f) === "source" ? "source" : "field"));
    for (const p of inParams) inCol.appendChild(makePortRow(p, item.id, "in", "param"));
    cols.appendChild(inCol);

    const outCol = document.createElement("div");
    outCol.className = "pg-port-col pg-port-col--out";
    for (const f of outFields) outCol.appendChild(makePortRow(f, item.id, "out", declared.has(f) ? "declared" : "field"));
    cols.appendChild(outCol);

    body.appendChild(cols);
    if (outFields.length) {
      body.appendChild(renderOutputPreviews(item.id, outFields));
    }
    el.appendChild(body);

    attachDrag(el, item, /* selectable */ true);
    return el;
  }

  function renderOutputPreviews(nodeId, fields) {
    const wrap = document.createElement("div");
    wrap.className = "pg-node__previews pg-node__previews--geodesic";
    wrap.style.setProperty("--preview-h", `${previewThumbHeight()}px`);
    wrap.style.setProperty("--preview-aspect", "1 / 1");
    const label = document.createElement("span");
    label.className = "pg-node__previews-label";
    label.textContent = "out preview";
    wrap.appendChild(label);
    const gridEl = document.createElement("div");
    gridEl.className = "pg-node__preview-grid";
    for (const field of fields) {
      const cell = document.createElement("div");
      cell.className = "pg-preview";
      cell.style.setProperty("--accent", fieldAccent(field));
      const canvas = document.createElement("canvas");
      canvas.className = "pg-preview__canvas pg-preview__canvas--geodesic";
      canvas.width = PREVIEW_W;
      canvas.height = PREVIEW_W;
      canvas.dataset.field = field;
      canvas.addEventListener("pointerdown", (event) => {
        event.preventDefault();
        event.stopPropagation();
      });
      canvas.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        openPreviewPopout(nodeId, field);
      });
      previewCanvases.set(`${nodeId}:${field}`, canvas);
      const name = document.createElement("span");
      name.className = "pg-preview__name";
      name.textContent = field;
      cell.append(canvas, name);
      gridEl.appendChild(cell);
    }
    wrap.appendChild(gridEl);
    return wrap;
  }

  // Variable nodes — pure value sources. Smaller, square-ish; no head
  // bar, no register marks. The rendered content is type + value, so a
  // user reading the graph sees the binding inline ("FieldRef u",
  // "Scalar 0.16") without a click.
  function renderVariableNode(item) {
    const el = document.createElement("div");
    el.className = "pg-var";
    el.dataset.nodeId = item.id;
    el.dataset.varType = item.varType ?? "?";
    const { x, y } = positions.get(item.id);
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
    el.style.width = `${VAR_W}px`;
    el.style.height = `${VAR_H}px`;

    const typeRow = document.createElement("span");
    typeRow.className = "pg-var__type";
    typeRow.textContent = item.varType ?? "?";
    el.appendChild(typeRow);

    const valueRow = document.createElement("span");
    valueRow.className = "pg-var__value";
    valueRow.textContent = formatVarValue(item.varType, item.varValue);
    el.appendChild(valueRow);

    // Variable nodes have only an output port (right). They're sources.
    el.appendChild(makePort("out", "right", item.id));

    // Variable nodes are now selectable — clicking opens the body
    // editor's value-editing surface so the user can change the bound
    // value without touching the recipe source.
    attachDrag(el, item, /* selectable */ true);
    return el;
  }

  function attachDrag(el, item, selectable) {
    if (selectable) {
      el.addEventListener("dblclick", (event) => {
        if (event.target.closest(".pg-port, .pg-port-row, .pg-preview")) return;
        event.preventDefault();
        selectNode(item.id);
        focusStageInDsl(item.id);
      });
    }
    el.addEventListener("pointerdown", (event) => {
      if (event.target.closest(".pg-port, .pg-port-row")) return;
      el.setPointerCapture(event.pointerId);
      const start = positions.get(item.id);
      const startMouse = { x: event.clientX, y: event.clientY };
      let dragged = false;
      function onMove(ev) {
        const dx = (ev.clientX - startMouse.x) / zoom;
        const dy = (ev.clientY - startMouse.y) / zoom;
        if (!dragged && Math.hypot(dx, dy) > 3) dragged = true;
        if (!dragged) return;
        positions.set(item.id, { x: Math.max(0, start.x + dx), y: Math.max(0, start.y + dy) });
        const p = positions.get(item.id);
        el.style.left = `${p.x}px`;
        el.style.top = `${p.y}px`;
        rerouteWires();
      }
      function onUp() {
        el.removeEventListener("pointermove", onMove);
        el.removeEventListener("pointerup", onUp);
        if (!dragged && selectable) selectNode(item.id);
      }
      el.addEventListener("pointermove", onMove);
      el.addEventListener("pointerup", onUp);
    });
  }

  function makePortRow(portLabel, nodeId, side, kind = "field") {
    const meta = kind === "param" ? paramMetaMap.get(portLabel) : null;
    const portName = portKey(kind, portLabel, meta);
    const row = document.createElement("div");
    row.className = `pg-port-row pg-port-row--${side} pg-port-row--${kind}`;
    if (kind === "param") row.classList.add(`pg-port-row--param-${paramVisualType(meta)}`);
    row.dataset.field = portLabel;
    row.dataset.portKind = kind;
    if (meta) row.dataset.paramType = paramVisualType(meta);
    row.dataset.nodeId = nodeId;
    row.dataset.portSide = side;
    row.dataset.portName = portName;
    row.style.setProperty("--accent", portAccent(kind, portLabel, meta));
    row.title = kind === "param"
      ? `${portLabel} (${paramVisualType(meta)})`
      : kind === "source" ? `source ${portLabel}`
        : kind === "declared" ? `declares ${portLabel}` : portLabel;

    const dot = document.createElement("span");
    dot.className = `pg-port-dot pg-port-dot--${side}`;
    row.appendChild(dot);

    const name = document.createElement("span");
    name.className = "pg-port-name";
    name.textContent = portLabel;
    if (side === "out") {
      row.insertBefore(name, dot);
    } else {
      row.appendChild(name);
    }
    if (side === "out") {
      row.addEventListener("pointerdown", (event) => {
        if (event.button !== 0) return;
        beginWireDrag(event, nodeId, portName);
      });
    }
    return row;
  }

  function makePort(side, anchor, nodeId) {
    const port = document.createElement("span");
    port.className = `pg-port pg-port--${side} pg-port--${anchor}`;
    port.dataset.nodeId = nodeId;
    port.dataset.portSide = side;
    if (side === "out") {
      port.addEventListener("pointerdown", (event) => beginWireDrag(event, nodeId, "out"));
    }
    return port;
  }

  function makeWire(fromId, toId, edge) {
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("class", "pg-wire");
    path.dataset.from = fromId;
    path.dataset.to = toId;
    const fromPort = edge?.from?.port ?? "out";
    const toPort = edge?.to?.port ?? "in";
    path.dataset.fromPort = fromPort;
    path.dataset.toPort = toPort;
    path.style.setProperty("--wire", wireAccent(fromPort, toPort));
    path.style.setProperty("--wire-glow", wireGlow(fromPort, toPort));
    path.setAttribute("d", wirePath(fromId, fromPort, toId, toPort));
    return path;
  }

  function endpointForPort(nodeId, side, portName) {
    const node = nodeEls.get(nodeId);
    const nodePos = positions.get(nodeId);
    if (!node || !nodePos) return null;
    const row = node.querySelector(
      `.pg-port-row[data-port-side="${side}"][data-port-name="${cssEscape(portName)}"]`,
    );
    const dot = row?.querySelector?.(".pg-port-dot");
    if (row && dot) {
      const sceneRect = graphScene.getBoundingClientRect();
      const dotRect = dot.getBoundingClientRect();
      if (sceneRect.width > 0 && sceneRect.height > 0 && dotRect.width > 0 && dotRect.height > 0) {
        return {
          x: (dotRect.left + dotRect.width / 2 - sceneRect.left) / zoom,
          y: (dotRect.top + dotRect.height / 2 - sceneRect.top) / zoom,
        };
      }
    }
    return {
      x: side === "out" ? nodePos.x + nodeWidth(nodeId) : nodePos.x,
      y: nodePos.y + nodeHeight(nodeId) / 2,
    };
  }

  function wirePath(fromId, fromPort, toId, toPort) {
    const a = endpointForPort(fromId, "out", fromPort);
    const b = endpointForPort(toId, "in", toPort);
    if (!a || !b) return "";
    const tension = Math.max(40, Math.abs(b.x - a.x) * 0.45);
    return `M ${a.x} ${a.y} C ${a.x + tension} ${a.y}, ${b.x - tension} ${b.y}, ${b.x} ${b.y}`;
  }

  function rerouteWires() {
    for (const path of wireSvg.querySelectorAll(".pg-wire:not(.pg-wire--preview)")) {
      const fromId = path.dataset.from;
      const toId = path.dataset.to;
      const fromPort = path.dataset.fromPort ?? "out";
      const toPort = path.dataset.toPort ?? "in";
      path.setAttribute("d", wirePath(fromId, fromPort, toId, toPort));
    }
    recomputeBounds();
  }

  function scheduleWireReroute() {
    if (wireRerouteFrame) cancelAnimationFrame(wireRerouteFrame);
    wireRerouteFrame = requestAnimationFrame(() => {
      wireRerouteFrame = requestAnimationFrame(() => {
        wireRerouteFrame = 0;
        rerouteWires();
      });
    });
  }

  // Wire-drag flow: pointerdown on an output port starts the drag,
  // pointermove on the document updates a preview wire that follows
  // the cursor, pointerup hit-tests for an input port and either
  // commits a new edge or cancels.
  function resolveDropTarget(clientX, clientY, fromNodeId) {
    const el = document.elementFromPoint(clientX, clientY);
    if (!el || !el.closest) return null;
    const row = el.closest(".pg-port-row--in");
    if (row && row.dataset.nodeId && row.dataset.nodeId !== fromNodeId) {
      return { el: row, nodeId: row.dataset.nodeId, portName: row.dataset.portName ?? "in" };
    }
    const port = el.closest(".pg-port--in");
    if (port && port.dataset.nodeId && port.dataset.nodeId !== fromNodeId) {
      return { el: port, nodeId: port.dataset.nodeId, portName: "in" };
    }
    return null;
  }

  function beginWireDrag(event, fromNodeId, fromPortName = "out") {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const start = endpointForPort(fromNodeId, "out", fromPortName);
    if (!start) return;
    document.body.classList.add("pg-wiring");
    const { x: x1, y: y1 } = start;
    let hoverTarget = null;

    function updatePreview(clientX, clientY) {
      const { x: x2, y: y2 } = clientToGraph(clientX, clientY);
      const tension = Math.max(40, Math.abs(x2 - x1) * 0.45);
      previewWire.setAttribute("d",
        `M ${x1} ${y1} C ${x1 + tension} ${y1}, ${x2 - tension} ${y2}, ${x2} ${y2}`);
      previewWire.style.display = "";
    }
    updatePreview(event.clientX, event.clientY);

    function onMove(ev) {
      updatePreview(ev.clientX, ev.clientY);
      const target = resolveDropTarget(ev.clientX, ev.clientY, fromNodeId);
      if (hoverTarget && hoverTarget !== target?.el) hoverTarget.classList.remove("pg-port--target");
      if (target) target.el.classList.add("pg-port--target");
      hoverTarget = target?.el ?? null;
    }
    function onUp(ev) {
      document.removeEventListener("pointermove", onMove, true);
      document.removeEventListener("pointerup", onUp, true);
      document.body.classList.remove("pg-wiring");
      previewWire.style.display = "none";
      if (hoverTarget) hoverTarget.classList.remove("pg-port--target");
      const target = resolveDropTarget(ev.clientX, ev.clientY, fromNodeId);
      if (target) {
        const ok = api.addEdge?.(fromNodeId, fromPortName, target.nodeId, target.portName);
        if (ok) refresh();
      }
    }
    document.addEventListener("pointermove", onMove, true);
    document.addEventListener("pointerup", onUp, true);
  }

  function clientToGraph(clientX, clientY) {
    const rect = graphWrap.getBoundingClientRect();
    return {
      x: (clientX - rect.left - pan.x) / zoom,
      y: (clientY - rect.top - pan.y) / zoom,
    };
  }

  function applyViewport() {
    graphScene.style.transform = `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`;
    grid.style.setProperty("--pg-grid-size", `${40 * zoom}px`);
    grid.style.setProperty("--pg-grid-x", `${pan.x}px`);
    grid.style.setProperty("--pg-grid-y", `${pan.y}px`);
    zoomReadout.textContent = `${Math.round(zoom * 100)}%`;
  }

  function setZoom(nextZoom, anchor = null) {
    const clamped = clampNumber(nextZoom, MIN_ZOOM, MAX_ZOOM);
    const rect = graphWrap.getBoundingClientRect();
    const anchorClient = anchor ?? {
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2,
    };
    const before = clientToGraph(anchorClient.clientX, anchorClient.clientY);
    zoom = clamped;
    pan = {
      x: anchorClient.clientX - rect.left - before.x * zoom,
      y: anchorClient.clientY - rect.top - before.y * zoom,
    };
    clampPan();
    applyViewport();
  }

  function clampPan() {
    const rect = graphWrap.getBoundingClientRect();
    const scaledW = graphBounds.width * zoom;
    const scaledH = graphBounds.height * zoom;
    const minX = Math.min(24, rect.width - scaledW - 24);
    const minY = Math.min(24, rect.height - scaledH - 24);
    const maxX = Math.max(rect.width - 24, 24);
    const maxY = Math.max(rect.height - 24, 24);
    pan.x = clampNumber(pan.x, minX, maxX);
    pan.y = clampNumber(pan.y, minY, maxY);
  }

  function onGraphWheel(event) {
    if (event.target.closest?.(".pg-graph-hud")) return;
    event.preventDefault();
    const factor = Math.exp(-event.deltaY * 0.0012);
    setZoom(zoom * factor, { clientX: event.clientX, clientY: event.clientY });
  }

  function beginPan(event) {
    event.preventDefault();
    graphWrap.setPointerCapture(event.pointerId);
    const startMouse = { x: event.clientX, y: event.clientY };
    const startPan = { ...pan };
    let moved = false;
    graphWrap.classList.add("pg-graph-wrap--panning");
    function onMove(ev) {
      const dx = ev.clientX - startMouse.x;
      const dy = ev.clientY - startMouse.y;
      if (!moved && Math.hypot(dx, dy) > 3) moved = true;
      pan = { x: startPan.x + dx, y: startPan.y + dy };
      clampPan();
      applyViewport();
    }
    function onUp() {
      graphWrap.removeEventListener("pointermove", onMove);
      graphWrap.removeEventListener("pointerup", onUp);
      graphWrap.classList.remove("pg-graph-wrap--panning");
      if (!moved) clearSelection();
    }
    graphWrap.addEventListener("pointermove", onMove);
    graphWrap.addEventListener("pointerup", onUp);
  }

  function fitGraphToViewport() {
    const rect = graphWrap.getBoundingClientRect();
    const nextZoom = clampNumber(
      Math.min((rect.width - 48) / graphBounds.width, (rect.height - 48) / graphBounds.height),
      MIN_ZOOM,
      1,
    );
    zoom = nextZoom;
    pan = {
      x: Math.max(24, (rect.width - graphBounds.width * zoom) / 2),
      y: Math.max(24, (rect.height - graphBounds.height * zoom) / 2),
    };
    applyViewport();
  }

  zoomOutBtn.addEventListener("click", () => setZoom(zoom / 1.18));
  zoomInBtn.addEventListener("click", () => setZoom(zoom * 1.18));
  zoomResetBtn.addEventListener("click", () => {
    zoom = 1;
    pan = { x: 0, y: 0 };
    applyViewport();
  });
  zoomFitBtn.addEventListener("click", fitGraphToViewport);

  function renderPreviews(force = false) {
    const hasPopouts = previewPopouts.size > 0;
    if (api.isVisible && !api.isVisible() && !hasPopouts) return;
    const now = performance.now();
    if (!force && now - lastPreviewAt < 250) return;
    lastPreviewAt = now;
    const state = api.getState?.();
    if (!state?.fields) return;
    const previewView = api.getPreviewView?.() ?? null;
    if (!api.isVisible || api.isVisible()) {
      for (const canvas of previewCanvases.values()) {
        if (!force && !isElementOnScreen(canvas)) continue;
        drawFieldPreview(canvas, state.fields[canvas.dataset.field], canvas.dataset.field, undefined, state.grid, previewView);
      }
    }
    for (const preview of previewPopouts.values()) {
      drawFieldPreview(preview.canvas, state.fields[preview.field], preview.field, previewResolutionForGrid(state.grid, { popout: true }), state.grid, previewView);
    }
  }

  function openPreviewPopout(nodeId, field) {
    const id = nextPreviewPopoutId++;
    const preview = createPreviewPopout(id, nodeId, field);
    previewPopouts.set(id, preview);
    renderPreviews(true);
  }

  function createPreviewPopout(id, nodeId, field) {
    const root = document.createElement("section");
    root.className = "pg-preview-popout";
    const offset = (id - 1) % 8;
    root.style.top = `${96 + offset * 22}px`;
    root.style.right = `${420 - offset * 18}px`;

    const head = document.createElement("header");
    head.className = "pg-preview-popout__head";
    root.appendChild(head);

    const title = document.createElement("span");
    title.className = "pg-preview-popout__title";
    title.textContent = `${itemById.get(nodeId)?.label ?? nodeId} / ${field}`;
    head.appendChild(title);

    const close = document.createElement("button");
    close.type = "button";
    close.className = "pg-preview-popout__close";
    close.textContent = "×";
    close.title = "Close preview";
    head.appendChild(close);

    const canvas = document.createElement("canvas");
    canvas.className = "pg-preview-popout__canvas pg-preview-popout__canvas--geodesic";
    canvas.style.setProperty("--preview-aspect", "1 / 1");
    root.appendChild(canvas);

    document.body.appendChild(root);

    close.addEventListener("click", () => {
      previewPopouts.delete(id);
      root.remove();
    });
    close.addEventListener("pointerdown", (event) => {
      event.stopPropagation();
    });

    head.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      if (event.target.closest(".pg-preview-popout__close")) return;
      event.preventDefault();
      root.setPointerCapture(event.pointerId);
      const start = { x: event.clientX, y: event.clientY };
      const rect = root.getBoundingClientRect();
      const origin = { x: rect.left, y: rect.top };
      function onMove(ev) {
        const nextX = clampNumber(origin.x + ev.clientX - start.x, 0, window.innerWidth - 120);
        const nextY = clampNumber(origin.y + ev.clientY - start.y, 0, window.innerHeight - 80);
        root.style.left = `${nextX}px`;
        root.style.top = `${nextY}px`;
        root.style.right = "auto";
      }
      function onUp() {
        root.removeEventListener("pointermove", onMove);
        root.removeEventListener("pointerup", onUp);
      }
      root.addEventListener("pointermove", onMove);
      root.addEventListener("pointerup", onUp);
    });

    return { id, root, title, canvas, nodeId, field };
  }

  function selectNode(id) {
    if (!id) return;
    selectedId = id;
    highlightSelected(id);
    api.onChange?.("select", id);
  }

  function clearSelection() {
    if (!selectedId) return;
    selectedId = null;
    highlightSelected(null);
    api.onChange?.("select", null);
  }

  function focusStageInDsl(id) {
    const range = findStageRange(dslEditor.getSource(), id);
    if (!range) {
      showToast(`stage "${id}" not found in DSL`, { kind: "error" });
      return;
    }
    dslEditor.view.dispatch({
      selection: { anchor: range.from },
      scrollIntoView: true,
    });
    dslEditor.view.focus();
  }

  function highlightSelected(id) {
    graphWrap.classList.toggle("pg-graph-wrap--has-selection", Boolean(id));
    for (const el of nodeLayer.querySelectorAll(".pg-node, .pg-var, .pg-rail")) {
      el.classList.toggle("pg-node--selected", el.dataset.nodeId === id);
    }
    // Wire bloom + march on touched, port "energized" on the endpoints
    // of those wires. Together they communicate "current flowing".
    const energized = new Set();
    for (const path of wireSvg.querySelectorAll(".pg-wire")) {
      const isTouched = path.dataset.from === id || path.dataset.to === id;
      path.classList.toggle("pg-wire--touched", isTouched);
      if (isTouched) {
        energized.add(`${path.dataset.from}:out:${path.dataset.fromPort ?? "out"}`);
        energized.add(`${path.dataset.to}:in:${path.dataset.toPort ?? "in"}`);
      }
    }
    for (const portEl of nodeLayer.querySelectorAll(".pg-port")) {
      const owner = portEl.parentElement?.dataset.nodeId;
      if (!owner) continue;
      const side = portEl.classList.contains("pg-port--out") ? "out" : "in";
      portEl.classList.toggle("pg-port--energized", energized.has(`${owner}:${side}:${side}`));
    }
    for (const row of nodeLayer.querySelectorAll(".pg-port-row")) {
      const owner = row.dataset.nodeId;
      const side = row.dataset.portSide;
      const port = row.dataset.portName;
      row.classList.toggle("pg-port-row--energized", energized.has(`${owner}:${side}:${port}`));
    }
  }

  refresh();

  return {
    refresh,
    refreshPreviews: renderPreviews,
    hasPreviewPopouts() { return previewPopouts.size > 0; },
    select(id) { selectNode(id); },
    setStatus(message, isError) {
      dslStatus.textContent = message ?? "";
      dslStatus.classList.toggle("is-error", Boolean(isError));
    },
    apply: applyPipelineDsl,
    reset: revertPipelineDsl,
    get currentId() { return selectedId; },
  };
}

function drawFieldPreview(canvas, field, fieldName, resolution = null, grid = null, view = null) {
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
      accent: fieldRgb(fieldName),
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

function isElementOnScreen(el) {
  const rect = el.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return false;
  return rect.right >= 0
    && rect.bottom >= 0
    && rect.left <= window.innerWidth
    && rect.top <= window.innerHeight;
}

function previewResolutionForGrid(grid, { popout = false } = {}) {
  const size = popout ? Math.min(640, Math.max(384, Math.round(Math.sqrt(grid?.cells ?? 4096) * 2.6))) : PREVIEW_W;
  return { width: size, height: size };
}

function fieldRgb(name) {
  return fieldRgbForName(name);
}

function clampNumber(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function normalizePreviewResolution(resolution = null) {
  const width = Number(resolution?.width ?? PREVIEW_W);
  const height = Number(resolution?.height ?? PREVIEW_W);
  return {
    width: clampNumber(Number.isFinite(width) ? Math.round(width) : PREVIEW_W, 16, 1024),
    height: clampNumber(Number.isFinite(height) ? Math.round(height) : PREVIEW_W, 16, 1024),
  };
}

function fieldAccent(name) {
  return fieldCssColor(name);
}

function paramVisualType(meta) {
  if (meta?.type === "boolean") return "boolean";
  if (meta?.control === "stepper") return "stepper";
  return "number";
}

function portKey(kind, name, meta = null) {
  return kind === "param" ? `param:${paramVisualType(meta)}:${name}` : name;
}

function portAccent(kind, name, meta = null) {
  if (kind === "param") return paramAccent(paramVisualType(meta));
  return fieldAccent(name);
}

function paramAccent(type) {
  if (type === "boolean") return "var(--info)";
  if (type === "stepper") return "var(--violet)";
  return "var(--amber)";
}

function paramTypeFromPort(port) {
  const match = /^param:([^:]+):/.exec(String(port ?? ""));
  return match?.[1] ?? null;
}

function wireAccent(fromPort, toPort) {
  const paramType = paramTypeFromPort(fromPort) ?? paramTypeFromPort(toPort);
  if (paramType) return paramAccent(paramType);
  return fieldCssColor(toPort ?? fromPort);
}

function wireGlow(fromPort, toPort) {
  const paramType = paramTypeFromPort(fromPort) ?? paramTypeFromPort(toPort);
  if (paramType) {
    return `color-mix(in srgb, ${paramAccent(paramType)} 34%, transparent)`;
  }
  return fieldCssTint(toPort ?? fromPort, 38);
}

function railPortCount(item) {
  return (item.inputs?.fields?.length ?? 0)
    + (item.inputs?.sources?.length ?? 0)
    + (item.inputs?.params?.length ?? 0)
    + (item.outputs?.fields?.length ?? 0)
    + (item.outputs?.sources?.length ?? 0)
    + (item.outputs?.params?.length ?? 0);
}

// Render a variable-node's bound value inline. FieldRef shows the field
// name; Scalar shows the number; FieldRefList shows count+first; Vec2
// shows components. Truncated for the small node footprint.
function formatVarValue(type, value) {
  if (value === null || value === undefined) return "—";
  if (type === "FieldRef") return value.name ?? String(value);
  if (type === "Scalar") return String(value);
  if (type === "FieldRefList") {
    if (!Array.isArray(value)) return String(value);
    if (value.length === 0) return "(empty)";
    return `${value.length} field${value.length === 1 ? "" : "s"}`;
  }
  if (type === "Vec2") return Array.isArray(value) ? `${value[0]},${value[1]}` : String(value);
  return String(value);
}

function computeDepths(ids, edges) {
  const depths = new Map(ids.map((id) => [id, 0]));
  let changed = true;
  let safety = ids.length + 1;
  while (changed && safety-- > 0) {
    changed = false;
    for (const edge of edges) {
      const from = edge.from?.node;
      const to = edge.to?.node;
      if (!depths.has(from) || !depths.has(to) || from === to) continue;
      const candidate = (depths.get(from) ?? 0) + 1;
      if (candidate > (depths.get(to) ?? 0)) {
        depths.set(to, candidate);
        changed = true;
      }
    }
  }
  return depths;
}

function buildGraphModel(stageItems, baseEdges, paramDecls = [], fieldDecls = []) {
  const items = [...stageItems];
  const edges = [...baseEdges];
  const lastWriter = new Map();
  const inputFields = new Set();
  const inputSources = new Set();
  const inputParams = new Set();
  const outputFields = new Set();
  const inputRailId = "rail:input";
  const outputRailId = "rail:output";
  const paramMeta = new Map(paramDecls.map((decl) => [decl.name, decl]).filter(([name]) => Boolean(name)));
  const paramOrder = new Map(paramDecls.map((decl, index) => [decl.name, index]).filter(([name]) => Boolean(name)));
  const declaredFields = fieldDecls.filter((decl) => decl?.name && decl.kind !== "source" && decl.kind !== "declared");
  const declaredSources = fieldDecls.filter((decl) => decl?.name && decl.kind === "source");
  const sourceNames = new Set(declaredSources.map((decl) => decl.name));
  const fieldOrder = new Map(fieldDecls.map((decl, index) => [decl.name, index]).filter(([name]) => Boolean(name)));

  for (const decl of declaredFields) inputFields.add(decl.name);
  for (const decl of declaredSources) inputSources.add(decl.name);

  for (const item of stageItems) {
    for (const field of item.inputs?.fields ?? []) {
      if (sourceNames.has(field)) {
        inputSources.add(field);
        edges.push({
          from: { node: inputRailId, port: field },
          to: { node: item.id, port: field },
          rail: true,
        });
        continue;
      }
      if (lastWriter.has(field)) continue;
      inputFields.add(field);
      edges.push({
        from: { node: inputRailId, port: field },
        to: { node: item.id, port: field },
        rail: true,
      });
    }
    for (const param of item.inputs?.params ?? []) {
      inputParams.add(param);
      const paramPort = portKey("param", param, paramMeta.get(param));
      edges.push({
        from: { node: inputRailId, port: paramPort },
        to: { node: item.id, port: paramPort },
        rail: true,
      });
    }
    const declared = new Set(item.outputs?.declared ?? []);
    for (const field of item.outputs?.fields ?? []) {
      if (declared.has(field)) {
        lastWriter.set(field, item.id);
      } else if (!sourceNames.has(field)) {
        lastWriter.set(field, item.id);
      }
    }
  }

  for (const [field, writerId] of lastWriter) {
    if (isDeclaredPipelineName(field, stageItems)) continue;
    outputFields.add(field);
    edges.push({
      from: { node: writerId, port: field },
      to: { node: outputRailId, port: field },
      rail: true,
    });
  }

  if (inputFields.size > 0 || inputSources.size > 0 || inputParams.size > 0) {
    items.push({
      id: inputRailId,
      label: "State In",
      kind: "rail",
      railSide: "input",
      inputs: { fields: [] },
      outputs: {
        fields: sortFieldsForRail(inputFields, fieldOrder),
        sources: sortFieldsForRail(inputSources, fieldOrder),
        params: sortParamsForRail(inputParams, paramOrder),
      },
    });
  }
  if (outputFields.size > 0) {
    items.push({
      id: outputRailId,
      label: "State Out",
      kind: "rail",
      railSide: "output",
      inputs: { fields: [...outputFields] },
      outputs: { fields: [] },
    });
  }

  return { items, edges };
}

function sortParamsForRail(params, paramOrder) {
  return [...params].sort((a, b) => {
    const ai = paramOrder.has(a) ? paramOrder.get(a) : Number.MAX_SAFE_INTEGER;
    const bi = paramOrder.has(b) ? paramOrder.get(b) : Number.MAX_SAFE_INTEGER;
    if (ai !== bi) return ai - bi;
    return a.localeCompare(b);
  });
}

function sortFieldsForRail(fields, fieldOrder) {
  return [...fields].sort((a, b) => {
    const ai = fieldOrder.has(a) ? fieldOrder.get(a) : Number.MAX_SAFE_INTEGER;
    const bi = fieldOrder.has(b) ? fieldOrder.get(b) : Number.MAX_SAFE_INTEGER;
    if (ai !== bi) return ai - bi;
    return a.localeCompare(b);
  });
}

function isDeclaredPipelineName(name, stageItems) {
  for (const item of stageItems) {
    if ((item.outputs?.declared ?? []).includes(name)) return true;
  }
  return false;
}

function orderColumns(columns, edges) {
  const ordered = new Map([...columns.entries()].sort(([a], [b]) => a - b));
  const idsByDepth = [...ordered.keys()];
  const orderIndex = new Map();
  for (const depth of idsByDepth) {
    const ids = ordered.get(depth);
    ids.forEach((id, index) => orderIndex.set(id, index));
  }
  for (const depth of idsByDepth) {
    if (depth === 0) continue;
    const ids = ordered.get(depth);
    ids.sort((a, b) => predecessorScore(a, edges, orderIndex) - predecessorScore(b, edges, orderIndex));
    ids.forEach((id, index) => orderIndex.set(id, index));
  }
  return ordered;
}

function predecessorScore(id, edges, orderIndex) {
  const scores = [];
  for (const edge of edges) {
    if (edge.to?.node !== id) continue;
    if (!orderIndex.has(edge.from?.node)) continue;
    scores.push(orderIndex.get(edge.from.node));
  }
  if (!scores.length) return orderIndex.get(id) ?? 0;
  return scores.reduce((sum, value) => sum + value, 0) / scores.length;
}

function summarizeDslKind(dsl) {
  const body = dsl?.body;
  if (!body) return null;
  const statements = body.statements ?? [];
  if (statements.length === 0) return "dsl";
  const kinds = [...new Set(statements.map((statement) => statement.type))];
  if (kinds.length === 1) return kinds[0];
  return kinds.join(" + ");
}

function kindShortLabel(kind) {
  if (!kind) return "DSL";
  if (kind.includes("+")) return "MIX";
  return kind.slice(0, 4).toUpperCase();
}

function findStageRange(source, targetId) {
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
    const block = readStageBlockEnd(source, cursor);
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

function readStageBlockEnd(source, start) {
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

function extractTopLevelBlocks(source, keyword) {
  return extractTopLevelBlockRanges(source, keyword).map((range) => range.text.trim());
}

function splitPipelineDsl(source) {
  const stampRanges = extractTopLevelBlockRanges(source, "stamp");
  const presetRanges = extractTopLevelBlockRanges(source, "preset");
  const ranges = [...stampRanges, ...presetRanges].sort((a, b) => a.from - b.from);
  let main = source ?? "";
  for (const range of [...ranges].sort((a, b) => b.from - a.from)) {
    main = `${main.slice(0, range.from)}\n${main.slice(range.to)}`;
  }
  return {
    main: cleanSplitDslText(main),
    stamps: stampRanges.map((range) => range.text.trim()).join("\n\n"),
    presets: presetRanges.map((range) => range.text.trim()).join("\n\n"),
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
    const block = readStageBlockEnd(source, cursor);
    if (!block) break;
    blocks.push({ from: start, to: block.end, text: source.slice(start, block.end) });
    i = block.end;
  }
  return blocks;
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

function cssEscape(value) {
  const text = String(value ?? "");
  if (globalThis.CSS?.escape) return globalThis.CSS.escape(text);
  return text.replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
}
