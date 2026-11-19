import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { cx } from './Money';

// Modals, popovers and menus.

/**
 * The last thing on the screen (not in a dialog, pop-up or menu) to have the focus. It's where
 * the focus goes back when the last dialog closes, even if the dialog was opened from a menu item
 * that has gone, or replaced another dialog (the import's steps).
 */
let screenFocus: HTMLElement | null = null;
if (typeof document !== 'undefined') {
  document.addEventListener('focusin', (e) => {
    const t = e.target as HTMLElement | null;
    // Not the title bar's menu buttons: a clicked one has the focus only until its menu opens.
    if (t && t !== document.body && !t.closest?.('.modal, .popover, .menu, .titlebar')) screenFocus = t;
  });
}

export function Modal({
  title,
  onClose,
  children,
  footer,
  width = 520,
  className,
}: {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // Read while rendering, before a box inside can take the focus.
  const [before] = useState(() => document.activeElement as HTMLElement | null);
  // The dialog takes the focus (unless a box inside has it already), so keys can't reach the
  // screen behind it, and gives it back when it closes: to what had it, if that's still there
  // and isn't a menu's item, otherwise to the dialog left underneath or the screen.
  useEffect(() => {
    const el = ref.current;
    if (el && !el.contains(document.activeElement)) el.focus({ preventScroll: true });
    return () => {
      requestAnimationFrame(() => {
        const now = document.activeElement;
        if (now && now !== document.body) return;
        const usable = before && before !== document.body && before.isConnected && !before.closest('.menu, .popover');
        const back = usable ? before : (topModal() ?? screenFocus);
        // If that has gone too (a budget cell's box, closed when the dialog opened), the screen's rows.
        const target = back?.isConnected ? back : document.querySelector<HTMLElement>('.reg-scroll, .budget-scroll');
        target?.focus({ preventScroll: true });
      });
    };
  }, [before]);
  // When the focused button goes away (the import moving on to its next file, say), the focus
  // would fall to the page: the top dialog takes it back.
  useEffect(() => {
    requestAnimationFrame(() => {
      const a = document.activeElement;
      if ((!a || a === document.body) && ref.current && isTopModal(ref.current)) ref.current.focus({ preventScroll: true });
    });
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Only the top dialog closes; one opened on top of another (F1, say) closes first.
      if (e.key === 'Escape' && !e.defaultPrevented && isTopModal(ref.current)) {
        e.stopPropagation();
        e.preventDefault(); // so no other dialog takes the same Esc
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  // Tab stays inside the dialog. A pop-up opened from it (a menu, the flag picker) is drawn
  // outside it and keeps its own Tab.
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== 'Tab' || e.defaultPrevented || !ref.current || !ref.current.contains(document.activeElement)) return;
    const list = focusables(ref.current);
    if (!list.length) return;
    if (e.shiftKey ? atStart(ref.current, list) : atEnd(list)) {
      e.preventDefault();
      list[e.shiftKey ? list.length - 1 : 0].focus();
    }
  };
  return createPortal(
    <div
      className="modal-back"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div ref={ref} className={cx('modal', className)} style={{ width }} role="dialog" aria-modal="true" tabIndex={-1} onKeyDown={onKeyDown}>
        <div className="modal-title">
          <span>{title}</span>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

/** True while a dialog is open. The app's own shortcuts, and the screens behind, wait until it closes. */
export function modalOpen(): boolean {
  return !!document.querySelector('.modal');
}

/** The top dialog, if any (dialogs are added to the page in the order they open). */
function topModal(): HTMLElement | null {
  const all = document.querySelectorAll<HTMLElement>('.modal');
  return all[all.length - 1] ?? null;
}

/** True if `el` is the top dialog. */
export function isTopModal(el: Element | null): boolean {
  return !!el && topModal() === el;
}

/** What Tab can reach inside `el`, in order. */
function focusables(el: HTMLElement): HTMLElement[] {
  return [
    ...el.querySelectorAll<HTMLElement>(
      'input:not([type="hidden"]):not(:disabled), select:not(:disabled), textarea:not(:disabled), button:not(:disabled), [href], summary, [tabindex]:not([tabindex="-1"])',
    ),
  ].filter((x) => x.tabIndex >= 0 && x.getClientRects().length > 0);
}

// Whether Tab (or Shift+Tab) would leave the dialog. The focus can also be on something Tab
// doesn't reach by itself (a clicked control, or the dialog itself): then it goes by its place.
const follows = (a: Node, x: Node) => !!(a.compareDocumentPosition(x) & Node.DOCUMENT_POSITION_FOLLOWING);
function atStart(dialog: HTMLElement, list: HTMLElement[]): boolean {
  const a = document.activeElement as HTMLElement;
  const i = list.indexOf(a);
  return i >= 0 ? i === 0 : a === dialog || !list.some((x) => follows(x, a));
}
function atEnd(list: HTMLElement[]): boolean {
  const a = document.activeElement as HTMLElement;
  const i = list.indexOf(a);
  return i >= 0 ? i === list.length - 1 : !list.some((x) => follows(a, x));
}

/**
 * A floating panel next to `anchor`. Closes on outside click or Escape.
 * Keeps itself inside the window.
 * It takes the focus (Tab stays inside it) and gives it back when it closes, unless
 * `autoFocus` is false: lists that belong to a box being typed in keep the focus in the box.
 */
export function Popover({
  anchor,
  onClose,
  children,
  align = 'left',
  width,
  className,
  autoFocus = true,
}: {
  anchor: HTMLElement | null;
  onClose: () => void;
  children: ReactNode;
  align?: 'left' | 'right' | 'center';
  width?: number;
  className?: string;
  autoFocus?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  // Read while rendering, before a box inside can take the focus.
  const [before] = useState(() => document.activeElement as HTMLElement | null);
  useEffect(() => {
    if (!autoFocus) return;
    const el = ref.current;
    // A menu, or a box with autoFocus, has already taken it.
    if (el && !el.contains(document.activeElement)) focusables(el)[0]?.focus({ preventScroll: true });
    return () => {
      requestAnimationFrame(() => {
        const now = document.activeElement;
        if ((!now || now === document.body) && before?.isConnected) before.focus({ preventScroll: true });
      });
    };
  }, [autoFocus, before]);
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== 'Tab' || e.defaultPrevented || !autoFocus || !ref.current) return;
    const list = focusables(ref.current);
    if (!list.length) return;
    const i = list.indexOf(document.activeElement as HTMLElement);
    if (e.shiftKey ? i <= 0 : i === list.length - 1) {
      e.preventDefault();
      list[e.shiftKey ? list.length - 1 : 0].focus();
    }
  };
  useLayoutEffect(() => {
    if (!anchor || !ref.current) return;
    const r = anchor.getBoundingClientRect();
    const w = ref.current.offsetWidth;
    const h = ref.current.offsetHeight;
    let left = align === 'right' ? r.right - w : align === 'center' ? r.left + r.width / 2 - w / 2 : r.left;
    left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
    let top = r.bottom + 4;
    if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 4);
    setPos({ top, left });
  }, [anchor, align]);
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (ref.current && !ref.current.contains(t) && !(anchor && anchor.contains(t))) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        e.preventDefault();
        onClose();
      }
    };
    const t = setTimeout(() => window.addEventListener('mousedown', onDown), 0);
    window.addEventListener('keydown', onKey, true);
    return () => {
      clearTimeout(t);
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [anchor, onClose]);
  return createPortal(
    <div
      ref={ref}
      className={cx('popover', className)}
      style={{ top: pos?.top ?? -9999, left: pos?.left ?? -9999, width }}
      onKeyDown={onKeyDown}
    >
      {children}
    </div>,
    document.body,
  );
}

export type MenuEntry =
  | 'sep'
  | { head: string }
  | {
      label: string;
      onClick: () => void;
      disabled?: boolean;
      danger?: boolean;
      checked?: boolean;
      shortcut?: string;
    };

export function Menu({
  items,
  onClose,
  onSwitch,
}: {
  items: MenuEntry[];
  onClose: () => void;
  /** Left/right arrow: move to the previous (-1) or next (1) menu in a menu bar. */
  onSwitch?: (dir: -1 | 1) => void;
}) {
  const anyChecks = items.some((i) => typeof i === 'object' && 'checked' in i && i.checked !== undefined);
  const ref = useRef<HTMLDivElement>(null);
  // Keyboard use: the first item takes focus, the arrow keys move, Enter chooses. When the menu
  // closes without opening anything, focus goes back to where it was.
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLButtonElement>('.menu-item:not(:disabled)')?.focus({ preventScroll: true });
    return () => {
      requestAnimationFrame(() => {
        if (document.activeElement === document.body && before?.isConnected) before.focus({ preventScroll: true });
      });
    };
  }, []);
  const onKeyDown = (e: React.KeyboardEvent) => {
    const list = [...(ref.current?.querySelectorAll<HTMLButtonElement>('.menu-item:not(:disabled)') ?? [])];
    if (!list.length) return;
    const i = list.indexOf(document.activeElement as HTMLButtonElement);
    const go = (n: number) => {
      e.preventDefault();
      list[(n + list.length) % list.length].focus();
    };
    if (e.key === 'ArrowDown') go(i + 1);
    else if (e.key === 'ArrowUp') go(i < 0 ? list.length - 1 : i - 1);
    else if (e.key === 'Home') go(0);
    else if (e.key === 'End') go(list.length - 1);
    else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && onSwitch) {
      e.preventDefault();
      onSwitch(e.key === 'ArrowLeft' ? -1 : 1);
    }
  };
  return (
    <div className="menu" role="menu" ref={ref} onKeyDown={onKeyDown}>
      {items.map((item, i) => {
        if (item === 'sep') return <div key={i} className="menu-sep" />;
        if ('head' in item)
          return (
            <div key={i} className="menu-head">
              {item.head}
            </div>
          );
        return (
          <button
            key={i}
            role="menuitem"
            disabled={item.disabled}
            className={cx('menu-item', item.danger && 'danger')}
            onClick={() => {
              onClose();
              item.onClick();
            }}
          >
            {anyChecks && <span className="mi-check">{item.checked ? '✓' : ''}</span>}
            <span className="mi-label">{item.label}</span>
            {item.shortcut && <span className="mi-key">{item.shortcut}</span>}
          </button>
        );
      })}
    </div>
  );
}

/** A button that opens a menu. */
export function MenuButton({
  label,
  items,
  className = 'btn small',
  align = 'left',
  title,
}: {
  label: ReactNode;
  items: MenuEntry[] | (() => MenuEntry[]);
  className?: string;
  align?: 'left' | 'right';
  title?: string;
}) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  return (
    <>
      <button className={className} title={title} onClick={(e) => setAnchor(anchor ? null : e.currentTarget)}>
        {label}
      </button>
      {anchor && (
        <Popover anchor={anchor} onClose={() => setAnchor(null)} align={align}>
          <Menu items={typeof items === 'function' ? items() : items} onClose={() => setAnchor(null)} />
        </Popover>
      )}
    </>
  );
}

/** Opens a menu at the mouse position (right-click menus). */
export function useContextMenu(): [
  (e: React.MouseEvent, items: MenuEntry[]) => void,
  ReactNode,
] {
  const [state, setState] = useState<{ x: number; y: number; items: MenuEntry[] } | null>(null);
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const open = (e: React.MouseEvent, items: MenuEntry[]) => {
    e.preventDefault();
    setState({ x: e.clientX, y: e.clientY, items });
  };
  const node = state
    ? createPortal(
        <>
          <div
            ref={anchorRef}
            style={{ position: 'fixed', left: state.x, top: state.y, width: 1, height: 1, pointerEvents: 'none' }}
          />
          <ContextMenuInner anchorRef={anchorRef} items={state.items} onClose={() => setState(null)} />
        </>,
        document.body,
      )
    : null;
  return [open, node];
}

/**
 * Shift+F10 and the Menu key open a right-click menu, as in other Windows programs: the menu
 * of the item that has the focus (it carries `data-kbmenu`), or else of the current row of
 * the list that has it (the register and the budget mark it `data-kbmenu="current"`).
 * Text boxes keep the keys, and nothing opens while a dialog or another menu is showing.
 */
export function useKeyboardContextMenus() {
  useEffect(() => {
    let openedOnDown = false;
    const onDown = (e: KeyboardEvent) => {
      const shiftF10 = e.key === 'F10' && e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey;
      if (e.key !== 'ContextMenu' && !shiftF10) return;
      const target = keyboardMenuTarget();
      if (!target) return;
      e.preventDefault();
      e.stopPropagation();
      openedOnDown = e.key === 'ContextMenu';
      target.scrollIntoView({ block: 'nearest' });
      const r = target.getBoundingClientRect();
      target.dispatchEvent(
        new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          clientX: r.left + Math.min(r.width / 2, 160),
          clientY: r.bottom - 2,
        }),
      );
    };
    // Windows opens the Menu key's menu when the key is let go: this one is open already.
    const onUp = (e: KeyboardEvent) => {
      if (e.key === 'ContextMenu' && openedOnDown) {
        openedOnDown = false;
        e.preventDefault();
      }
    };
    window.addEventListener('keydown', onDown, true);
    window.addEventListener('keyup', onUp, true);
    return () => {
      window.removeEventListener('keydown', onDown, true);
      window.removeEventListener('keyup', onUp, true);
    };
  }, []);
}

function keyboardMenuTarget(): HTMLElement | null {
  if (document.querySelector('.modal-back, .popover')) return null;
  const a = document.activeElement as HTMLElement | null;
  if (a) {
    const typing =
      a.isContentEditable ||
      a.tagName === 'TEXTAREA' ||
      a.tagName === 'SELECT' ||
      (a.tagName === 'INPUT' && !/^(checkbox|radio)$/.test((a as HTMLInputElement).type));
    if (typing) return null;
    const own = a.closest<HTMLElement>('[data-kbmenu]');
    if (own) return own;
  }
  const scope: ParentNode = a && a !== document.body ? a : document;
  return scope.querySelector<HTMLElement>('[data-kbmenu="current"]');
}

function ContextMenuInner({
  anchorRef,
  items,
  onClose,
}: {
  anchorRef: React.RefObject<HTMLDivElement | null>;
  items: MenuEntry[];
  onClose: () => void;
}) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => setAnchor(anchorRef.current), [anchorRef]);
  if (!anchor) return null;
  return (
    <Popover anchor={anchor} onClose={onClose}>
      <Menu items={items} onClose={onClose} />
    </Popover>
  );
}
