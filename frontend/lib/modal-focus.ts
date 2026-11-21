/**
 * Modal focus management (issue #508).
 *
 * One controller used by both dialogs: focus moves inside on open, Tab and
 * Shift+Tab cycle within the dialog, Escape dismisses it, and closing returns
 * focus to the element that opened it. Kept as a DOM module (no React) so the
 * behaviour can be exercised in the accessibility suite under JSDOM.
 */

const TABBABLE_SELECTOR = [
  "a[href]",
  "area[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "iframe",
  "[contenteditable]:not([contenteditable='false'])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

/** Tab-reachable descendants, in document order. */
export function getFocusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(TABBABLE_SELECTOR)
  ).filter(
    (element) =>
      !element.hasAttribute("disabled") &&
      element.getAttribute("aria-hidden") !== "true" &&
      !element.closest("[inert]")
  );
}

/**
 * Focus the element that best explains the dialog: an explicit
 * `[data-autofocus]` target (typically the dialog title), else the first
 * tabbable control, else the container itself.
 */
export function focusInitial(container: HTMLElement): void {
  const preferred = container.querySelector<HTMLElement>("[data-autofocus]");
  if (preferred) {
    preferred.focus();
    return;
  }

  const [first] = getFocusableElements(container);
  if (first) {
    first.focus();
    return;
  }

  if (!container.hasAttribute("tabindex")) {
    container.setAttribute("tabindex", "-1");
  }
  container.focus();
}

/** Wrap Tab / Shift+Tab inside the container. */
export function trapTabKey(
  event: KeyboardEvent,
  container: HTMLElement
): void {
  if (event.key !== "Tab") return;

  const focusable = getFocusableElements(container);
  if (focusable.length === 0) {
    event.preventDefault();
    container.focus();
    return;
  }

  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  const active = container.ownerDocument.activeElement;

  if (event.shiftKey) {
    if (active === first || !container.contains(active)) {
      event.preventDefault();
      last.focus();
    }
    return;
  }

  if (active === last || !container.contains(active)) {
    event.preventDefault();
    first.focus();
  }
}

export interface ModalFocusControllerOptions {
  container: HTMLElement;
  onClose: () => void;
  /** Element to focus when the dialog closes; defaults to the opener. */
  returnFocusTo?: HTMLElement | null;
  /** Injected in tests; defaults to the container's document. */
  ownerDocument?: Document;
}

export interface ModalFocusController {
  activate(): void;
  deactivate(): void;
}

export function createModalFocusController({
  container,
  onClose,
  returnFocusTo,
  ownerDocument = container.ownerDocument,
}: ModalFocusControllerOptions): ModalFocusController {
  const HTMLElementCtor = ownerDocument.defaultView?.HTMLElement;
  const activeElement = ownerDocument.activeElement;
  const previouslyFocused =
    returnFocusTo ??
    (HTMLElementCtor && activeElement instanceof HTMLElementCtor
      ? (activeElement as HTMLElement)
      : null);

  function handleKeyDown(event: KeyboardEvent): void {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    trapTabKey(event, container);
  }

  return {
    activate() {
      focusInitial(container);
      // Capture phase: the trap still sees Tab if a child stops propagation.
      ownerDocument.addEventListener("keydown", handleKeyDown, true);
    },
    deactivate() {
      ownerDocument.removeEventListener("keydown", handleKeyDown, true);
      previouslyFocused?.focus();
    },
  };
}
