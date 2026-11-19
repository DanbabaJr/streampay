"use client";

/**
 * Toast notification system — WCAG 2.1 AA compliant
 *
 * Focus management spec:
 *  - Error toasts (role="alert", aria-live="assertive"): focus moves to the
 *    toast container when a new error appears, so keyboard users are aware.
 *    Focus is returned to the previously focused element when dismissed.
 *  - Success/info toasts (role="status", aria-live="polite"): announced
 *    without interrupting focus; the close button is reachable via Tab.
 *
 * Live-region spec:
 *  - The outer ToastContainer carries aria-live="polite" for success/info.
 *  - Error ToastItems additionally carry role="alert" which forces assertive
 *    announcement regardless of the container's live-region politeness.
 *  - aria-atomic="true" on each item ensures the full message is read.
 */

import React, {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  type Toast,
  type ToastType,
  type ToastStore,
  createToastStore,
  defaultToastStore,
} from "../lib/toast";

export type { Toast, ToastType, ToastStore };
export { createToastStore, defaultToastStore };

const ToastContext = createContext<ToastStore>(defaultToastStore);

export function ToastProvider({
  children,
  store,
}: {
  children: React.ReactNode;
  store?: ToastStore;
}) {
  const currentStore = store ?? defaultToastStore;
  const [toasts, setToasts] = useState<Toast[]>(() => currentStore.getToasts());

  useEffect(() => {
    return currentStore.subscribe((updated) => {
      setToasts(updated);
    });
  }, [currentStore]);

  return (
    <ToastContext.Provider value={currentStore}>
      {children}
      <ToastContainer toasts={toasts} onDismiss={currentStore.removeToast} />
    </ToastContext.Provider>
  );
}

export function useToast(): ToastStore {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    throw new Error("useToast must be used within a ToastProvider");
  }
  return ctx;
}

function ToastContainer({
  toasts,
  onDismiss,
}: {
  toasts: Toast[];
  onDismiss: (id: string) => void;
}) {
  if (toasts.length === 0) return null;

  return (
    /*
     * role="region" + aria-label gives the toast stack a named landmark so
     * SR users can navigate to it. aria-live="polite" is a fallback for
     * AT that don't honour per-item roles; individual error items use
     * role="alert" which is implicitly assertive.
     */
    <div
      className="toast-container"
      role="region"
      aria-label="Notifications"
      aria-live="polite"
    >
      {toasts.map((toast) => (
        <ToastItem key={toast.id} toast={toast} onDismiss={onDismiss} />
      ))}
    </div>
  );
}

function ToastItem({
  toast,
  onDismiss,
}: {
  toast: Toast;
  onDismiss: (id: string) => void;
}) {
  const itemRef = useRef<HTMLDivElement | null>(null);
  const returnFocusRef = useRef<Element | null>(null);
  const isError = toast.type === "error";

  // Auto-dismiss timer
  useEffect(() => {
    if (!toast.duration || toast.duration <= 0) return;
    const timer = setTimeout(() => {
      onDismiss(toast.id);
    }, toast.duration);
    return () => clearTimeout(timer);
  }, [toast.id, toast.duration, onDismiss]);

  // Focus management for error toasts (WCAG 2.4.3 Focus Order)
  // On mount: save the currently focused element, then move focus to the toast
  // so keyboard users immediately know about the error without finishing their
  // current task (assertive announcement already interrupts AT, but focus must
  // also move for keyboard-only users who aren't using a screen reader).
  useEffect(() => {
    if (!isError) return;
    // Save previous focus target so we can restore it on dismiss
    returnFocusRef.current = document.activeElement;
    // Move focus to the toast item so the close button is reachable via Tab
    requestAnimationFrame(() => {
      itemRef.current?.focus();
    });
  }, [isError]);

  function handleDismiss() {
    // Return focus to the element that was focused before the error appeared
    if (isError && returnFocusRef.current instanceof HTMLElement) {
      returnFocusRef.current.focus();
    }
    onDismiss(toast.id);
  }

  // Handle Escape key to dismiss (WCAG 2.1.1 Keyboard)
  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      e.stopPropagation();
      handleDismiss();
    }
  }

  const icons: Record<ToastType, string> = {
    success: "✓",
    error: "✕",
    info: "ℹ",
  };

  const iconLabels: Record<ToastType, string> = {
    success: "Success",
    error: "Error",
    info: "Information",
  };

  return (
    <div
      ref={itemRef}
      className={`toast-item toast-${toast.type}`}
      // role="alert" for errors (assertive); role="status" for success/info (polite)
      role={isError ? "alert" : "status"}
      aria-live={isError ? "assertive" : "polite"}
      aria-atomic="true"
      // tabIndex allows focus to land here (needed for error focus management)
      tabIndex={isError ? -1 : undefined}
      onKeyDown={handleKeyDown}
    >
      <span className="toast-icon" aria-hidden="true">
        {icons[toast.type]}
      </span>
      {/* Screen-reader-only type label prepended to message for non-visual context */}
      <span className="sr-only">{iconLabels[toast.type]}: </span>
      <div className="toast-message">{toast.message}</div>
      <button
        type="button"
        className="toast-close"
        onClick={handleDismiss}
        aria-label={`Dismiss ${toast.type} notification`}
      >
        ×
      </button>
    </div>
  );
}
