import { ToastNotification } from "@carbon/react";
import { createContext, useCallback, useContext, useState, type ReactNode } from "react";

type ToastKind = "success" | "error" | "warning" | "info";

interface Toast {
  id: number;
  kind: ToastKind;
  title: string;
  subtitle?: string | undefined;
}

type Notify = (kind: ToastKind, title: string, subtitle?: string) => void;

const ToastContext = createContext<Notify | null>(null);

let nextId = 1;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const remove = (id: number) => setToasts((list) => list.filter((t) => t.id !== id));
  const notify = useCallback<Notify>((kind, title, subtitle) => {
    setToasts((list) => [...list, { id: nextId++, kind, title, subtitle }]);
  }, []);

  return (
    <ToastContext.Provider value={notify}>
      {children}
      <div className="toast-area" aria-live="polite">
        {toasts.map((t) => (
          <ToastNotification
            key={t.id}
            kind={t.kind}
            title={t.title}
            subtitle={t.subtitle}
            timeout={t.kind === "error" ? 0 : 5000}
            onClose={() => {
              remove(t.id);
              return false;
            }}
            onCloseButtonClick={() => remove(t.id)}
          />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): Notify {
  const notify = useContext(ToastContext);
  if (!notify) throw new Error("ToastProvider 밖에서 useToast를 호출했습니다");
  return notify;
}
