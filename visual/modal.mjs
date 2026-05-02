// =============================================================================
// Field-lab styled modal — promptModal + confirmModal.
//
// Replacements for `window.prompt` / `window.confirm` so dialogs match
// the rest of the lab (dark ink, signal-green accent, IBM Plex Mono).
// Both return a Promise: `null` / `false` on cancel.
//
// Modals trap focus on the input (prompt) or OK button (confirm) until
// closed. Enter confirms; Esc cancels. Click on the backdrop also
// cancels. Only one modal can be open at a time — calling open while
// another is up rejects the prior with cancel.
// =============================================================================

let activeReject = null;

export function promptModal({ title, message, defaultValue = "", validate, placeholder = "" }) {
  return openModal({
    title,
    body: ({ host, onConfirm, onCancel }) => {
      const lbl = document.createElement("label");
      lbl.className = "modal__label";
      lbl.textContent = message ?? "";
      host.appendChild(lbl);
      const input = document.createElement("input");
      input.type = "text";
      input.className = "modal__input";
      input.value = defaultValue;
      input.placeholder = placeholder;
      input.spellcheck = false;
      input.autocomplete = "off";
      host.appendChild(input);
      const status = document.createElement("div");
      status.className = "modal__status";
      host.appendChild(status);

      input.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          tryConfirm();
        } else if (event.key === "Escape") {
          event.preventDefault();
          onCancel();
        }
      });

      function tryConfirm() {
        const value = input.value.trim();
        if (typeof validate === "function") {
          const error = validate(value);
          if (error) {
            status.textContent = error;
            status.classList.add("is-error");
            return;
          }
        }
        onConfirm(value);
      }

      return {
        confirm: tryConfirm,
        focus: () => input.focus({ preventScroll: true }),
      };
    },
    confirmLabel: "OK",
    cancelLabel: "Cancel",
  });
}

// Multi-field form modal. `fields` is an array of
//   { name, type: "text" | "number", label, default?, min?, max?,
//     step?, placeholder?, required?, validate?(value) → string|null }.
// On confirm, returns an object keyed by field.name; on cancel returns
// null. Each field's validate runs on submit; the first failure becomes
// a status line and aborts the close.
export function formModal({ title, fields = [], confirmLabel = "Add", cancelLabel = "Cancel" }) {
  return openModal({
    title,
    body: ({ host, onConfirm }) => {
      const inputs = new Map();
      for (const field of fields) {
        const wrap = document.createElement("div");
        wrap.className = "modal__field";
        const lbl = document.createElement("label");
        lbl.className = "modal__label";
        lbl.textContent = field.label ?? field.name;
        wrap.appendChild(lbl);
        const input = document.createElement("input");
        input.type = field.type === "number" ? "number" : "text";
        input.className = "modal__input";
        if (field.placeholder) input.placeholder = field.placeholder;
        if (field.default !== undefined) input.value = String(field.default);
        if (field.type === "number") {
          if (field.min !== undefined) input.min = String(field.min);
          if (field.max !== undefined) input.max = String(field.max);
          if (field.step !== undefined) input.step = String(field.step);
        }
        input.spellcheck = false;
        input.autocomplete = "off";
        wrap.appendChild(input);
        host.appendChild(wrap);
        inputs.set(field.name, input);
      }
      const status = document.createElement("div");
      status.className = "modal__status";
      host.appendChild(status);

      function tryConfirm() {
        const out = {};
        for (const field of fields) {
          const input = inputs.get(field.name);
          let value = field.type === "number" ? Number(input.value) : input.value.trim();
          if (field.required && (value === "" || (field.type === "number" && !Number.isFinite(value)))) {
            status.textContent = `${field.label ?? field.name} is required`;
            status.classList.add("is-error");
            input.focus();
            return;
          }
          if (typeof field.validate === "function") {
            const error = field.validate(value);
            if (error) {
              status.textContent = error;
              status.classList.add("is-error");
              input.focus();
              return;
            }
          }
          out[field.name] = value;
        }
        onConfirm(out);
      }

      for (const input of inputs.values()) {
        input.addEventListener("keydown", (event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            tryConfirm();
          }
        });
      }

      return {
        confirm: tryConfirm,
        focus: () => inputs.values().next().value?.focus({ preventScroll: true }),
      };
    },
    confirmLabel,
    cancelLabel,
  });
}

export function confirmModal({ title, message, danger = false, confirmLabel = "Confirm", cancelLabel = "Cancel" }) {
  return openModal({
    title,
    body: ({ host }) => {
      const text = document.createElement("p");
      text.className = "modal__message";
      text.textContent = message ?? "";
      host.appendChild(text);
      return { focusFirst: "confirm" };
    },
    confirmLabel,
    cancelLabel,
    danger,
  });
}

function openModal({ title, body, confirmLabel, cancelLabel, danger = false }) {
  // Cancel any in-flight modal so we never have two stacked.
  if (activeReject) {
    activeReject(null);
    activeReject = null;
  }

  return new Promise((resolve) => {
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop";
    backdrop.tabIndex = -1;

    const frame = document.createElement("div");
    frame.className = "modal";
    backdrop.appendChild(frame);

    const head = document.createElement("header");
    head.className = "modal__head";
    head.textContent = title ?? "";
    frame.appendChild(head);

    const host = document.createElement("div");
    host.className = "modal__body";
    frame.appendChild(host);

    const buttons = document.createElement("div");
    buttons.className = "modal__buttons";

    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.className = "btn";
    cancelBtn.textContent = cancelLabel;

    const confirmBtn = document.createElement("button");
    confirmBtn.type = "button";
    confirmBtn.className = `btn btn--primary${danger ? " btn--danger" : ""}`;
    confirmBtn.textContent = confirmLabel;

    buttons.appendChild(cancelBtn);
    buttons.appendChild(confirmBtn);
    frame.appendChild(buttons);

    document.body.appendChild(backdrop);

    const previouslyFocused = document.activeElement;

    function cleanup() {
      backdrop.remove();
      document.removeEventListener("keydown", onKeydown, true);
      activeReject = null;
      if (previouslyFocused && typeof previouslyFocused.focus === "function") {
        previouslyFocused.focus({ preventScroll: true });
      }
    }
    function close(value) {
      cleanup();
      resolve(value);
    }

    function onCancel() { close(typeof title === "string" && /confirm/i.test(title) ? false : null); }
    function onConfirm(value) {
      close(value === undefined ? true : value);
    }
    function onKeydown(event) {
      if (event.key === "Escape") {
        event.preventDefault();
        onCancel();
      }
    }

    cancelBtn.addEventListener("click", onCancel);
    backdrop.addEventListener("pointerdown", (event) => {
      if (event.target === backdrop) onCancel();
    });
    document.addEventListener("keydown", onKeydown, true);
    activeReject = onCancel;

    const handles = body({ host, onConfirm, onCancel }) ?? {};

    confirmBtn.addEventListener("click", () => {
      if (typeof handles.confirm === "function") handles.confirm();
      else onConfirm();
    });

    if (typeof handles.focus === "function") {
      handles.focus();
    } else if (handles.focusFirst === "confirm") {
      confirmBtn.focus({ preventScroll: true });
    } else {
      confirmBtn.focus({ preventScroll: true });
    }
  });
}
