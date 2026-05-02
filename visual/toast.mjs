// =============================================================================
// Toast notifications.
//
// Lightweight floating messages anchored top-right. Used to surface
// runtime errors that would otherwise only land in the editor's status
// line (which is easy to miss). Three kinds:
//
//   showToast(msg)                       — info, signal-green underline
//   showToast(msg, { kind: "warn" })     — amber underline
//   showToast(msg, { kind: "error" })    — danger underline, longer dwell
//
// Toasts auto-dismiss after `duration` ms; click to dismiss earlier.
// Multiple toasts stack vertically.
// =============================================================================

const DEFAULT_DURATION = 5000;
const ERROR_DURATION = 9000;

export function showToast(message, { kind = "info", duration } = {}) {
  const root = ensureToastRoot();
  const toast = document.createElement("div");
  toast.className = `toast toast--${kind}`;
  toast.textContent = message ?? "";
  toast.addEventListener("click", () => dismiss(toast));
  root.appendChild(toast);

  // Trigger the slide-in animation on the next frame so the initial
  // `transform` style takes effect before the transitioned-to value.
  requestAnimationFrame(() => toast.classList.add("toast--enter"));

  const dwell = duration ?? (kind === "error" ? ERROR_DURATION : DEFAULT_DURATION);
  setTimeout(() => dismiss(toast), dwell);
  return toast;
}

function dismiss(toast) {
  if (!toast.isConnected) return;
  toast.classList.remove("toast--enter");
  toast.classList.add("toast--leave");
  setTimeout(() => toast.remove(), 220);
}

function ensureToastRoot() {
  let root = document.querySelector(".toast-root");
  if (!root) {
    root = document.createElement("div");
    root.className = "toast-root";
    document.body.appendChild(root);
  }
  return root;
}
