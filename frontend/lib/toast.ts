export type ToastType = "success" | "error" | "info";

export interface Toast {
  id: string;
  type: ToastType;
  message: string;
  duration?: number;
}

export interface ToastAnnouncement {
  message: string;
  type: ToastType;
  key: string | null;
}

export interface ToastStore {
  getToasts: () => Toast[];
  getAnnouncement: () => ToastAnnouncement;
  addToast: (
    message: string,
    type?: ToastType,
    duration?: number,
    dedupeKey?: string
  ) => string;
  removeToast: (id: string) => void;
  clear: () => void;
  subscribe: (listener: (toasts: Toast[]) => void) => () => void;
  subscribeToAnnouncements: (listener: (announcement: ToastAnnouncement) => void) => () => void;
  announce: (message: string, type?: ToastType, dedupeKey?: string) => void;
  clearAnnouncements: () => void;
  success: (message: string, duration?: number, dedupeKey?: string) => string;
  error: (message: string, duration?: number, dedupeKey?: string) => string;
  info: (message: string, duration?: number, dedupeKey?: string) => string;
}

const EMPTY_ANNOUNCEMENT: ToastAnnouncement = { message: "", type: "info", key: null };
let globalToastCounter = 0;

export function createToastStore(initial: Toast[] = []): ToastStore {
  let toasts = [...initial];
  let announcement = EMPTY_ANNOUNCEMENT;
  let lastAnnouncementKey: string | null = null;
  const listeners = new Set<(toasts: Toast[]) => void>();
  const announcementListeners = new Set<(announcement: ToastAnnouncement) => void>();

  function notify() {
    for (const listener of listeners) {
      listener(toasts);
    }
  }

  function notifyAnnouncement() {
    for (const listener of announcementListeners) {
      listener(announcement);
    }
  }

  function announce(message: string, type: ToastType = "info", dedupeKey?: string): void {
    if (!message) return;
    const key = dedupeKey ?? `${type}\u0000${message}`;
    if (key === lastAnnouncementKey) return;
    lastAnnouncementKey = key;
    announcement = { message, type, key };
    notifyAnnouncement();
  }

  function clearAnnouncements(): void {
    if (announcement.key === null) return;
    announcement = EMPTY_ANNOUNCEMENT;
    lastAnnouncementKey = null;
    notifyAnnouncement();
  }

  function addToast(
    message: string,
    type: ToastType = "info",
    duration: number = 5000,
    dedupeKey?: string
  ): string {
    const id = `toast-${Date.now()}-${++globalToastCounter}`;
    toasts = [...toasts, { id, type, message, duration }];
    notify();
    announce(message, type, dedupeKey);
    return id;
  }

  function removeToast(id: string): void {
    toasts = toasts.filter((t) => t.id !== id);
    notify();
  }

  function clear(): void {
    toasts = [];
    notify();
    clearAnnouncements();
  }

  function subscribe(listener: (toasts: Toast[]) => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  function subscribeToAnnouncements(
    listener: (announcement: ToastAnnouncement) => void
  ): () => void {
    announcementListeners.add(listener);
    return () => announcementListeners.delete(listener);
  }

  return {
    getToasts: () => toasts,
    getAnnouncement: () => announcement,
    addToast,
    removeToast,
    clear,
    subscribe,
    subscribeToAnnouncements,
    announce,
    clearAnnouncements,
    success: (message: string, duration?: number, dedupeKey?: string) =>
      addToast(message, "success", duration, dedupeKey),
    error: (message: string, duration?: number, dedupeKey?: string) =>
      addToast(message, "error", duration ?? 6000, dedupeKey),
    info: (message: string, duration?: number, dedupeKey?: string) =>
      addToast(message, "info", duration, dedupeKey),
  };
}

export const defaultToastStore = createToastStore();
