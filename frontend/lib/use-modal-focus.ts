"use client";

import { useEffect, useRef, type RefObject } from "react";
import { createModalFocusController } from "./modal-focus";

/**
 * React binding for the shared modal focus controller. The dialog must already
 * be mounted and visible when `active` becomes true (WalletModal opens its
 * native <dialog> in an effect declared before this hook).
 */
export function useModalFocus(
  containerRef: RefObject<HTMLElement | null>,
  active: boolean,
  onClose: () => void
): void {
  // Callers pass inline callbacks; keep the listener from re-binding on every
  // render (which would re-focus the dialog and steal focus repeatedly).
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!active) return;
    const container = containerRef.current;
    if (!container) return;

    const controller = createModalFocusController({
      container,
      onClose: () => onCloseRef.current(),
    });
    controller.activate();
    return () => controller.deactivate();
  }, [active, containerRef]);
}
