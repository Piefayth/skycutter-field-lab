// =============================================================================
// Floating window primitive.
//
// Each window is a `<section class="win">` positioned absolutely, with a
// title-bar that drags the window. Title-bar buttons minimize (collapse
// to title-only) and close (hide entirely; reopen via the Window menu).
// Click anywhere on the window to bring it to the front (z-counter).
// State (position, size, minimized, visible) persists per-window-id in
// localStorage so reopening the lab restores the layout.
//
// Usage:
//   const win = createWindow({
//     id: "pipeline",
//     title: "Pipeline",
//     contentEl: <DOM node>,
//     defaultPos: { x: 24, y: 80 },
//     defaultSize: { w: 360, h: 480 },
//   });
//   container.appendChild(win.element);
//   win.show() / win.hide() / win.toggle()
// =============================================================================

const STORAGE_KEY = "fieldLab.windows.v1";

const DOCK_SLOT_W = 200;
const DOCK_GAP = 10;
const DOCK_MARGIN = 14;

let zCounter = 100;

const registry = new Map();
const dockStack = [];
// Single-occupancy left-dock slot. The left column is part of the grid
// (driven by `--left-dock-w` on the document root), so two windows can't
// both dock-left without overlapping. dockLeft() evicts the existing
// occupant before claiming the slot.
let leftDockedWin = null;

function setLeftDockWidth(px) {
  document.documentElement.style.setProperty("--left-dock-w", `${px}px`);
}

// Dock positions are computed relative to the `#windowLayer` element,
// not the browser viewport — the layer sits below the top menu bar +
// metrics header inside the CSS grid. The right edge of the dock
// stops just left of the inspector panel (`#panel`) so docked windows
// don't pile up under the side controls. Falls back to layer / viewport
// dimensions when the panel isn't mounted (test contexts).
function dockBounds() {
  const layer = document.querySelector("#windowLayer");
  const panel = document.querySelector("#panel");
  if (layer) {
    const layerRect = layer.getBoundingClientRect();
    let rightEdge = layerRect.width;
    if (panel) {
      const panelRect = panel.getBoundingClientRect();
      rightEdge = Math.max(0, panelRect.left - layerRect.left);
    }
    return { right: rightEdge, height: layerRect.height };
  }
  return { right: window.innerWidth, height: window.innerHeight };
}

function relayoutDock() {
  const { right } = dockBounds();
  const startX = right - DOCK_MARGIN;
  for (let i = 0; i < dockStack.length; i++) {
    const win = dockStack[i];
    const x = startX - (i + 1) * DOCK_SLOT_W - i * DOCK_GAP;
    win.element.style.left = `${Math.max(0, x)}px`;
    // Position via `bottom` so every minimized window's bottom edge
    // sits at exactly DOCK_MARGIN above the layer's bottom — works
    // regardless of the rendered titlebar height (titles that wrap to
    // two lines would otherwise drift relative to neighbours).
    win.element.style.top = "auto";
    win.element.style.bottom = `${DOCK_MARGIN}px`;
    win.element.style.width = `${DOCK_SLOT_W}px`;
  }
}

window.addEventListener("resize", relayoutDock);

export function getWindow(id) {
  return registry.get(id) ?? null;
}

export function listWindows() {
  return [...registry.values()];
}

export function createWindow({ id, title, contentEl, defaultPos = { x: 24, y: 80 }, defaultSize = { w: 360, h: 480 }, defaultVisible = true }) {
  if (registry.has(id)) throw new Error(`window "${id}" already created`);

  const root = document.createElement("section");
  root.className = "win";
  root.dataset.winId = id;

  const head = document.createElement("header");
  head.className = "win__head";

  const titleEl = document.createElement("span");
  titleEl.className = "win__title";
  titleEl.textContent = title;
  head.appendChild(titleEl);

  const btnRow = document.createElement("span");
  btnRow.className = "win__buttons";

  const dockLeftBtn = document.createElement("button");
  dockLeftBtn.type = "button";
  dockLeftBtn.className = "win__btn win__btn--dockleft";
  dockLeftBtn.title = "Dock left";
  dockLeftBtn.textContent = "◧";
  btnRow.appendChild(dockLeftBtn);

  const minBtn = document.createElement("button");
  minBtn.type = "button";
  minBtn.className = "win__btn win__btn--min";
  minBtn.title = "Minimize";
  minBtn.textContent = "—";
  btnRow.appendChild(minBtn);

  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "win__btn win__btn--close";
  closeBtn.title = "Close";
  closeBtn.textContent = "×";
  btnRow.appendChild(closeBtn);

  head.appendChild(btnRow);
  root.appendChild(head);

  const body = document.createElement("div");
  body.className = "win__body";
  body.appendChild(contentEl);
  root.appendChild(body);

  // Resize grip (bottom-right). Pointer-driven; no native textarea
  // resize because we want to drive it from the window edge.
  const grip = document.createElement("div");
  grip.className = "win__grip";
  grip.title = "Resize";
  root.appendChild(grip);

  const saved = loadWindowState(id);
  // `floatX/floatY/floatW/floatH` are the position the window returns to
  // when un-minimized. While docked, `x/y/w` are owned by the dock
  // layout; restoring rewrites them from the float-* values.
  const state = {
    x: clampNum(saved?.x, defaultPos.x),
    y: clampNum(saved?.y, defaultPos.y),
    w: clampNum(saved?.w, defaultSize.w, 240),
    h: clampNum(saved?.h, defaultSize.h, 160),
    floatX: clampNum(saved?.floatX ?? saved?.x, defaultPos.x),
    floatY: clampNum(saved?.floatY ?? saved?.y, defaultPos.y),
    floatW: clampNum(saved?.floatW ?? saved?.w, defaultSize.w, 240),
    floatH: clampNum(saved?.floatH ?? saved?.h, defaultSize.h, 160),
    leftDockW: clampNum(saved?.leftDockW, 380, 240),
    minimized: typeof saved?.minimized === "boolean" ? saved.minimized : false,
    dockedLeft: typeof saved?.dockedLeft === "boolean" ? saved.dockedLeft : false,
    visible: typeof saved?.visible === "boolean" ? saved.visible : defaultVisible,
  };
  // Mutually exclusive — bottom-dock wins if a corrupt saved state has
  // both flags. Keeps the click-to-toggle handlers from getting into a
  // state where state.dockedLeft is true but the window is rendering
  // as bottom-docked.
  if (state.minimized) state.dockedLeft = false;
  // Publish the left-dock width to the grid CSS var BEFORE applyAll's
  // first paint so the viewport doesn't flash at full width on load.
  if (state.dockedLeft && state.visible) setLeftDockWidth(state.leftDockW);
  applyAll();
  bringToFront();

  // -----------------------------------------------------------------
  // Drag (title bar). Dragging a docked window pops it back to floating
  // — feels right; you grabbed it, you want to move it.
  // -----------------------------------------------------------------
  let dragOff = null;
  head.addEventListener("pointerdown", (event) => {
    if (event.target.closest(".win__btn")) return;
    if (state.minimized) {
      // Un-dock first; subsequent drag updates floatX/Y.
      undock();
    }
    if (state.dockedLeft) {
      // Same behaviour as minimize-dock: grabbing the title bar pops
      // the window back into the floating layout.
      undockLeft();
    }
    head.setPointerCapture(event.pointerId);
    dragOff = { x: event.clientX - state.x, y: event.clientY - state.y };
    bringToFront();
  });
  head.addEventListener("pointermove", (event) => {
    if (!dragOff) return;
    state.x = Math.max(0, event.clientX - dragOff.x);
    state.y = Math.max(0, event.clientY - dragOff.y);
    state.floatX = state.x;
    state.floatY = state.y;
    applyPos();
  });
  head.addEventListener("pointerup", () => {
    if (dragOff) save();
    dragOff = null;
  });
  head.addEventListener("dblclick", (event) => {
    if (event.target.closest(".win__btn")) return;
    if (state.minimized) undock();
    else dock();
  });

  // -----------------------------------------------------------------
  // Resize (bottom-right grip). No-op while minimized.
  // -----------------------------------------------------------------
  let resizeOff = null;
  grip.addEventListener("pointerdown", (event) => {
    if (state.minimized) return;
    grip.setPointerCapture(event.pointerId);
    resizeOff = state.dockedLeft
      ? { mode: "left-dock", startW: state.leftDockW, startX: event.clientX }
      : { mode: "float", startW: state.w, startH: state.h, startX: event.clientX, startY: event.clientY };
    bringToFront();
  });
  grip.addEventListener("pointermove", (event) => {
    if (!resizeOff) return;
    if (resizeOff.mode === "left-dock") {
      state.leftDockW = Math.max(240, resizeOff.startW + (event.clientX - resizeOff.startX));
      setLeftDockWidth(state.leftDockW);
      applyDockedLeftLayout();
    } else {
      state.w = Math.max(240, resizeOff.startW + (event.clientX - resizeOff.startX));
      state.h = Math.max(160, resizeOff.startH + (event.clientY - resizeOff.startY));
      state.floatW = state.w;
      state.floatH = state.h;
      applySize();
    }
  });
  grip.addEventListener("pointerup", () => {
    if (resizeOff) save();
    resizeOff = null;
  });

  // -----------------------------------------------------------------
  // Buttons. Minimize toggles bottom dock; dock-left toggles left
  // column dock; close hides + un-docks.
  // -----------------------------------------------------------------
  dockLeftBtn.addEventListener("click", () => {
    if (state.dockedLeft) undockLeft();
    else dockLeft();
  });
  minBtn.addEventListener("click", () => {
    if (state.dockedLeft) undockLeft();
    if (state.minimized) undock();
    else dock();
  });
  closeBtn.addEventListener("click", () => {
    // Closing while docked restores the float position first so re-open
    // lands you back where the window was before minimizing.
    if (state.dockedLeft) undockLeft();
    if (state.minimized) undock();
    state.visible = false;
    applyAll();
    save();
  });

  function dock() {
    state.minimized = true;
    if (!dockStack.includes(win)) dockStack.push(win);
    applyAll();
    relayoutDock();
    save();
  }

  function undock() {
    state.minimized = false;
    const idx = dockStack.indexOf(win);
    if (idx >= 0) dockStack.splice(idx, 1);
    state.x = state.floatX;
    state.y = state.floatY;
    state.w = state.floatW;
    state.h = state.floatH;
    // Clear the bottom-positioning the dock layout applied so applyPos's
    // `top: ${state.y}px` isn't fighting an inline `bottom`.
    root.style.bottom = "";
    applyAll();
    relayoutDock();
    save();
  }

  function dockLeft() {
    if (leftDockedWin && leftDockedWin !== win) leftDockedWin.undockLeft();
    state.dockedLeft = true;
    leftDockedWin = win;
    setLeftDockWidth(state.leftDockW);
    applyAll();
    save();
  }

  function undockLeft() {
    state.dockedLeft = false;
    if (leftDockedWin === win) {
      leftDockedWin = null;
      setLeftDockWidth(0);
    }
    state.x = state.floatX;
    state.y = state.floatY;
    state.w = state.floatW;
    state.h = state.floatH;
    // Clear inline `bottom` and `height: auto` left over from the docked-
    // left layout so applyPos / applySize regain ownership.
    root.style.bottom = "";
    root.style.height = "";
    applyAll();
    save();
  }

  // Click anywhere → focus (z-order).
  root.addEventListener("pointerdown", () => bringToFront(), { capture: true });

  function applyAll() {
    root.style.display = state.visible ? "flex" : "none";
    root.classList.toggle("win--minimized", state.minimized);
    root.classList.toggle("win--docked-left", state.dockedLeft && !state.minimized);
    grip.style.display = state.minimized ? "none" : "";
    if (state.dockedLeft && !state.minimized) {
      applyDockedLeftLayout();
    } else if (!state.minimized) {
      // Floating: position and size come from state directly.
      applyPos();
      applySize();
    }
    // Bottom-dock: relayoutDock owns position/size; applyAll's caller invokes it.
  }
  function applyPos() {
    root.style.left = `${state.x}px`;
    root.style.top = `${state.y}px`;
  }
  function applySize() {
    root.style.width = `${state.w}px`;
    root.style.height = state.minimized ? "" : `${state.h}px`;
  }
  function applyDockedLeftLayout() {
    root.style.left = "0";
    root.style.top = "0";
    root.style.bottom = "0";
    root.style.right = "";
    root.style.height = "auto";
    root.style.width = `${state.leftDockW}px`;
  }
  function bringToFront() {
    zCounter += 1;
    root.style.zIndex = String(zCounter);
  }
  function save() {
    saveWindowState(id, state);
  }

  const win = {
    id,
    title,
    element: root,
    contentEl: body,
    dockLeft,
    undockLeft,
    isDockedLeft: () => state.dockedLeft,
    show() {
      state.visible = true;
      if (state.minimized) {
        // Came back from "minimized + closed". Restore as floating.
        undock();
      } else {
        applyAll();
        save();
      }
      bringToFront();
    },
    hide() {
      if (state.minimized) undock();
      state.visible = false;
      applyAll();
      save();
    },
    toggle() { state.visible ? this.hide() : this.show(); },
    isVisible: () => state.visible,
    isMinimized: () => state.minimized,
    bringToFront,
    onChange: null, // Optional listener invoked after visibility / state changes.
  };

  // Notify listeners on visibility change so the menu's checkmarks
  // update without the menu having to poll.
  for (const [name, btn] of [["min", minBtn], ["close", closeBtn]]) {
    btn.addEventListener("click", () => win.onChange?.(win));
  }

  registry.set(id, win);

  // If state restored as minimized, register with the dock now that
  // `win` exists. Re-runs `applyAll` once layout owns the position.
  if (state.minimized && state.visible) {
    dockStack.push(win);
    relayoutDock();
  }
  // If state restored as docked-left, claim the left slot. Eviction of
  // any prior occupant is necessary because two windows can't share the
  // single left column. The CSS var was already published above, before
  // applyAll's first paint; we just need to claim the slot pointer here.
  if (state.dockedLeft && state.visible) {
    if (leftDockedWin && leftDockedWin !== win) leftDockedWin.undockLeft();
    leftDockedWin = win;
  }

  return win;
}

function clampNum(value, fallback, min = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(min, n) : fallback;
}

function loadWindowState(id) {
  try {
    const all = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
    return all[id] ?? null;
  } catch { return null; }
}

function saveWindowState(id, state) {
  try {
    const all = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
    all[id] = {
      x: state.x, y: state.y, w: state.w, h: state.h,
      floatX: state.floatX, floatY: state.floatY,
      floatW: state.floatW, floatH: state.floatH,
      leftDockW: state.leftDockW,
      minimized: state.minimized, dockedLeft: state.dockedLeft,
      visible: state.visible,
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
  } catch (error) {
    console.error("could not persist window state:", error);
  }
}
