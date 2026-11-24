"use client";

/**
 * Visual toasts stay navigable, while one atomic live region announces updates:
 * info/success are polite and errors are assertive. Keeping live semantics off
 * the toast items prevents the same message from being announced twice.
 */

import React, {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { usePathname } from "next/navigation";
import {
  type Toast,
  type ToastAnnouncement,
  type ToastType,
  type ToastStore,
  createToastStore,
  defaultToastStore,
} from "../lib/toast";
import { useT } from "../lib/i18n/provider";

export type { Toast, ToastType, ToastStore };
export { createToastStore, defaultToastStore };

export function announcementPoliteness(type: ToastType): "polite" | "assertive" {
  return type === "error" ? "assertive" : "polite";
}

const ToastContext = createContext<ToastStore>(defaultToastStore);

export function ToastProvider({
  children,
  store,
}: {
  children: React.ReactNode;
  store?: ToastStore;
}) {
  const currentStore = store ?? defaultToastStore;
  const pathname = usePathname();
  const [toasts, setToasts] = useState<Toast[]>(() => currentStore.getToasts());
  const [announcement, setAnnouncement] = useState<ToastAnnouncement>(() =>
    currentStore.getAnnouncement()
  );

  useEffect(() => {
    return currentStore.subscribe((updated) => {
      setToasts(updated);
    });
  }, [currentStore]);

  useEffect(() => {
    return currentStore.subscribeToAnnouncements(setAnnouncement);
  }, [currentStore]);

  useEffect(() => {
    currentStore.clearAnnouncements();
  }, [currentStore, pathname]);

  return (
    <ToastContext.Provider value={currentStore}>
      {children}
      <ToastContainer toasts={toasts} onDismiss={currentStore.removeToast} />
      <div
        className="sr-only"
        data-live-region=""
        aria-live={announcementPoliteness(announcement.type)}
        aria-atomic="true"
      >
        {announcement.message}
      </div>
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
  const t = useT();
  if (toasts.length === 0) return null;

  return (
    <div className="toast-container" role="region" aria-label={t("toast.region")}>
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
  const t = useT();
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

  const iconLabels: Record<
    ToastType,
    "toast.type.success" | "toast.type.error" | "toast.type.info"
  > = {
    success: "toast.type.success",
    error: "toast.type.error",
    info: "toast.type.info",
  };

  return (
    <div
      ref={itemRef}
      className={`toast-item toast-${toast.type}`}
      tabIndex={isError ? -1 : undefined}
      onKeyDown={handleKeyDown}
    >
      <span className="toast-icon" aria-hidden="true">
        {icons[toast.type]}
      </span>
      <span className="sr-only">{t(iconLabels[toast.type])}: </span>
      <div className="toast-message">{toast.message}</div>
      <button
        type="button"
        className="toast-close"
        onClick={handleDismiss}
        aria-label={t("toast.dismiss", { type: toast.type })}
      >
        ×
      </button>
    </div>
  );
}
