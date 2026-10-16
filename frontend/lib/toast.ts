export type ToastType = "success" | "error" | "info";

export interface Toast {
  id: string;
  type: ToastType;
  message: string;
  duration?: number;
}

export interface ToastStore {
  getToasts: () => Toast[];
  addToast: (message: string, type?: ToastType, duration?: number) => string;
  removeToast: (id: string) => void;
  clear: () => void;
  subscribe: (listener: (toasts: Toast[]) => void) => () => void;
  success: (message: string, duration?: number) => string;
  error: (message: string, duration?: number) => string;
  info: (message: string, duration?: number) => string;
}

let globalToastCounter = 0;

export function createToastStore(initial: Toast[] = []): ToastStore {
  let toasts = [...initial];
  const listeners = new Set<(toasts: Toast[]) => void>();

  function notify() {
    for (const listener of listeners) {
      listener(toasts);
    }
  }

  function addToast(message: string, type: ToastType = "info", duration: number = 5000): string {
    const id = `toast-${Date.now()}-${++globalToastCounter}`;
    toasts = [...toasts, { id, type, message, duration }];
    notify();
    return id;
  }

  function removeToast(id: string): void {
    toasts = toasts.filter((t) => t.id !== id);
    notify();
  }

  function clear(): void {
    toasts = [];
    notify();
  }

  function subscribe(listener: (toasts: Toast[]) => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  return {
    getToasts: () => toasts,
    addToast,
    removeToast,
    clear,
    subscribe,
    success: (message: string, duration?: number) => addToast(message, "success", duration),
    error: (message: string, duration?: number) => addToast(message, "error", duration ?? 6000),
    info: (message: string, duration?: number) => addToast(message, "info", duration),
  };
}

export const defaultToastStore = createToastStore();
