import { useEffect, useId, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

type Props = { title: string; onClose: () => void; children: ReactNode };

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Modal dialog: Escape and the Close button close it, Tab stays inside, focus returns to where it came from. */
export default function Dialog({ title, onClose, children }: Props) {
  const titleId = useId();
  const boxRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const box = boxRef.current!;
    const first = box.querySelector<HTMLElement>('[data-autofocus]') ?? box.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? box).focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        closeRef.current();
        return;
      }
      if (e.key !== 'Tab') return;
      const items = [...box.querySelectorAll<HTMLElement>(FOCUSABLE)];
      if (!items.length) return;
      const firstEl = items[0], lastEl = items[items.length - 1];
      if (e.shiftKey && document.activeElement === firstEl) { e.preventDefault(); lastEl.focus(); }
      else if (!e.shiftKey && document.activeElement === lastEl) { e.preventDefault(); firstEl.focus(); }
    };
    document.addEventListener('keydown', onKey);
    document.body.classList.add('has-dialog');
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.classList.remove('has-dialog');
      if (opener && opener.isConnected) opener.focus();
    };
  }, []);

  return createPortal(
    <div className="dialog-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} ref={boxRef} tabIndex={-1}>
        <div className="dialog-head">
          <h2 id={titleId}>{title}</h2>
          <button type="button" className="icon-button" aria-label="Close" onClick={onClose}>
            <span aria-hidden="true">×</span>
          </button>
        </div>
        <div className="dialog-body">{children}</div>
      </div>
    </div>,
    document.body,
  );
}
