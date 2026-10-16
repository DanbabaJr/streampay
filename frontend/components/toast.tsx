"use client";

import React, { createContext, useContext, useState, useEffect } from "react";
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
  useEffect(() => {
    if (!toast.duration || toast.duration <= 0) return;
    const timer = setTimeout(() => {
      onDismiss(toast.id);
    }, toast.duration);
    return () => clearTimeout(timer);
  }, [toast.id, toast.duration, onDismiss]);

  const icons: Record<ToastType, string> = {
    success: "✓",
    error: "✕",
    info: "ℹ",
  };

  return (
    <div
      className={`toast-item toast-${toast.type}`}
      role={toast.type === "error" ? "alert" : "status"}
    >
      <span className="toast-icon" aria-hidden="true">
        {icons[toast.type]}
      </span>
      <div className="toast-message">{toast.message}</div>
      <button
        type="button"
        className="toast-close"
        onClick={() => onDismiss(toast.id)}
        aria-label="Dismiss notification"
      >
        ×
      </button>
    </div>
  );
}
