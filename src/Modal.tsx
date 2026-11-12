import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { usePageScrollLock } from "./usePageScrollLock";
export function Modal({
  title,
  children,
  onClose,
  className = "",
  backdropClassName = "",
  hideHeader = false,
}: {
  title: string;
  children: ReactNode;
  onClose?: () => void;
  className?: string;
  backdropClassName?: string;
  hideHeader?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  usePageScrollLock(true);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const before = document.activeElement as HTMLElement;
    ref.current?.focus();
    function onKey(event: KeyboardEvent) {
      const dialogs = document.querySelectorAll('[role="dialog"]');
      if (dialogs[dialogs.length - 1] !== ref.current) return;
      if (event.key === "Escape" && closeRef.current) {
        event.preventDefault();
        closeRef.current();
      }
      if (event.key === "Tab") {
        const items = ref.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled),a[href],input:not(:disabled),textarea:not(:disabled),select:not(:disabled),[tabindex="0"]',
        );
        if (!items?.length) {
          event.preventDefault();
          return;
        }
        const first = items[0],
          last = items[items.length - 1];
        if (
          event.shiftKey &&
          (document.activeElement === first || document.activeElement === ref.current)
        ) {
          event.preventDefault();
          last.focus();
        } else if (
          !event.shiftKey &&
          (document.activeElement === last || document.activeElement === ref.current)
        ) {
          event.preventDefault();
          first.focus();
        }
      }
    }
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      if (
        before?.isConnected &&
        !(window.matchMedia("(pointer: coarse)").matches && before.matches("input,textarea,select"))
      )
        before.focus({ preventScroll: true });
    };
  }, []);
  return createPortal(
    <div
      className={`modal-backdrop ${backdropClassName}`}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose?.();
      }}
    >
      <div
        className={`modal ${className}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        ref={ref}
      >
        {!hideHeader && (
          <div className="modal-heading">
            <div>
              <span className="eyebrow">IMAGINE WORKSPACE</span>
              <h2>{title}</h2>
            </div>
            {onClose && (
              <button className="icon-button" aria-label="关闭窗口" onClick={onClose}>
                <X size={20} />
              </button>
            )}
          </div>
        )}
        {children}
      </div>
    </div>,
    document.body,
  );
}
