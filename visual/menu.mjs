// =============================================================================
// Top menu bar.
//
//   [SKYCUTTER · FIELD LAB]   File   Window           GRID 256×128
//
// Each menu opens on click into a panel of items. Items can be plain
// (run a callback), submenu (open a nested panel), or checkable (carry
// a check mark whose state is read live from `isChecked()`).
//
// Click outside the menu bar closes any open menu. Escape also closes.
// =============================================================================

export function buildMenuBar({ container, brand, rev, menus }) {
  const bar = document.createElement("nav");
  bar.className = "menu-bar";

  const brandEl = document.createElement("span");
  brandEl.className = "menu-bar__brand";
  brandEl.textContent = brand ?? "";
  bar.appendChild(brandEl);

  const list = document.createElement("ul");
  list.className = "menu-bar__list";
  for (const menu of menus) list.appendChild(buildMenu(menu));
  bar.appendChild(list);

  let revEl = null;
  if (rev) {
    revEl = document.createElement("span");
    revEl.className = "menu-bar__rev";
    revEl.textContent = rev;
    bar.appendChild(revEl);
  }

  container.appendChild(bar);

  // Click outside any open menu → close all open menus.
  document.addEventListener("pointerdown", (event) => {
    if (event.target.closest(".menu-bar__list")) return;
    closeAll(bar);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeAll(bar);
  });

  return {
    rebuild(menusNext) {
      list.replaceChildren();
      for (const menu of menusNext) list.appendChild(buildMenu(menu));
    },
    setRev(text) {
      if (revEl) revEl.textContent = text ?? "";
    },
  };
}

function buildMenu({ label, items }) {
  const li = document.createElement("li");
  li.className = "menu";

  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.className = "menu__trigger";
  trigger.textContent = label;
  li.appendChild(trigger);

  const panel = document.createElement("div");
  panel.className = "menu__panel";
  for (const item of items) panel.appendChild(buildItem(item, li));
  li.appendChild(panel);

  trigger.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    event.stopPropagation();
    const wasOpen = li.classList.contains("menu--open");
    closeAll(li.parentElement.parentElement);
    if (!wasOpen) {
      li.classList.add("menu--open");
      refreshChecks(li);
    }
  });

  return li;
}

function buildItem(item, ownerMenu) {
  if (item.type === "submenu") {
    const wrap = document.createElement("div");
    wrap.className = "submenu";
    const trigger = document.createElement("button");
    trigger.type = "button";
    trigger.className = "submenu__trigger";
    trigger.textContent = `${item.label} ▸`;
    wrap.appendChild(trigger);

    const panel = document.createElement("div");
    panel.className = "submenu__panel";
    for (const sub of item.items) panel.appendChild(buildItem(sub, ownerMenu));
    wrap.appendChild(panel);

    let open = false;
    trigger.addEventListener("pointerenter", () => {
      open = true;
      wrap.classList.add("submenu--open");
    });
    wrap.addEventListener("pointerleave", () => {
      open = false;
      wrap.classList.remove("submenu--open");
    });

    return wrap;
  }

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "menu__item";
  if (item.title) btn.title = item.title;

  if (item.type === "checkable") {
    btn.dataset.checkable = "1";
    btn.dataset.itemId = item.id ?? item.label;
    btn.dataset.checkedFn = "1";
    btn._isChecked = item.isChecked;
    renderCheckable(btn, item);
  } else {
    btn.textContent = item.label;
  }

  btn.addEventListener("click", () => {
    item.onClick?.();
    if (item.type === "checkable") renderCheckable(btn, item);
    closeAll(ownerMenu.parentElement.parentElement);
  });

  return btn;
}

function renderCheckable(btn, item) {
  const checked = item.isChecked?.() ?? false;
  btn.textContent = `${checked ? "✓" : "  "}  ${item.label}`;
  btn.classList.toggle("menu__item--checked", Boolean(checked));
}

function refreshChecks(menu) {
  for (const btn of menu.querySelectorAll(".menu__item[data-checkable='1']")) {
    if (typeof btn._isChecked !== "function") continue;
    const label = btn.textContent.trim().replace(/^[✓ ]+\s*/, "");
    const checked = btn._isChecked();
    btn.textContent = `${checked ? "✓" : "  "}  ${label}`;
    btn.classList.toggle("menu__item--checked", Boolean(checked));
  }
}

function closeAll(bar) {
  if (!bar) return;
  for (const m of bar.querySelectorAll(".menu--open")) m.classList.remove("menu--open");
}
