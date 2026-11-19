import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react';
import { Modal } from './overlay';
import { cx } from './Money';

// Promise-based confirm / choose / prompt dialogs, and toasts.

interface Choice {
  key: string;
  label: string;
  kind?: 'primary' | 'danger' | 'green';
}

interface DialogRequest {
  title: string;
  body: ReactNode;
  choices: Choice[];
  cancel: string | null;
  input?: { label: string; value: string; placeholder?: string };
  width?: number;
  resolve: (r: { key: string; value?: string } | null) => void;
}

let show: ((d: DialogRequest) => void) | null = null;

function request(d: Omit<DialogRequest, 'resolve'>): Promise<{ key: string; value?: string } | null> {
  return new Promise((resolve) => {
    if (!show) {
      resolve(window.confirm(String(d.title)) ? { key: d.choices[d.choices.length - 1].key } : null);
      return;
    }
    show({ ...d, resolve });
  });
}

/** Asks a yes/no question. Resolves true if the user clicked `okLabel`. */
export async function confirm(title: string, body: ReactNode, okLabel = 'OK', danger = false): Promise<boolean> {
  const r = await request({ title, body, choices: [{ key: 'ok', label: okLabel, kind: danger ? 'danger' : 'primary' }], cancel: 'Cancel' });
  return r?.key === 'ok';
}

/** Offers several choices. Resolves the chosen key, or null if cancelled. */
export async function choose(
  title: string,
  body: ReactNode,
  choices: Choice[],
  cancel: string | null = 'Cancel',
  width?: number,
): Promise<string | null> {
  const r = await request({ title, body, choices, cancel, width });
  return r?.key ?? null;
}

/** Asks for some text. Resolves the text, or null if cancelled. */
export async function prompt(
  title: string,
  label: string,
  value = '',
  okLabel = 'OK',
  body?: ReactNode,
): Promise<string | null> {
  const r = await request({
    title,
    body: body ?? null,
    choices: [{ key: 'ok', label: okLabel, kind: 'primary' }],
    cancel: 'Cancel',
    input: { label, value },
  });
  return r?.key === 'ok' ? (r.value ?? '') : null;
}

/** Shows an information message with a single OK button. */
export async function alertDialog(title: string, body: ReactNode): Promise<void> {
  await request({ title, body, choices: [{ key: 'ok', label: 'OK', kind: 'primary' }], cancel: null });
}

export function DialogHost() {
  const [queue, setQueue] = useState<DialogRequest[]>([]);
  const [value, setValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    show = (d) => setQueue((q) => [...q, d]);
    return () => {
      show = null;
    };
  }, []);
  const d = queue[0];
  useEffect(() => {
    if (d?.input) {
      setValue(d.input.value);
      setTimeout(() => inputRef.current?.select(), 0);
    }
  }, [d]);
  if (!d) return null;
  const finish = (r: { key: string; value?: string } | null) => {
    d.resolve(r);
    setQueue((q) => q.slice(1));
  };
  return (
    <Modal
      title={d.title}
      // Esc and ✕ cancel. A box with no Cancel takes them as its last button, which is always the
      // safe one ("OK", "Keep the app open").
      onClose={() => (d.cancel !== null ? finish(null) : finish({ key: d.choices[d.choices.length - 1].key, value }))}
      width={d.width ?? (d.choices.length > 2 ? 580 : 460)}
      footer={
        <>
          {d.cancel !== null && (
            <button className="btn" onClick={() => finish(null)}>
              {d.cancel}
            </button>
          )}
          {d.choices.map((c, i) => (
            <button
              key={c.key}
              className={cx('btn', c.kind)}
              autoFocus={!d.input && i === d.choices.length - 1}
              // The second click of a double-click mustn't answer the next box (1.5.11).
              onClick={(e) => e.detail <= 1 && finish({ key: c.key, value })}
            >
              {c.label}
            </button>
          ))}
        </>
      }
    >
      {d.body && <div style={{ marginBottom: d.input ? 10 : 0 }}>{d.body}</div>}
      {d.input && (
        <label className="field">
          <span className="field-label">{d.input.label}</span>
          <input
            ref={inputRef}
            value={value}
            autoFocus
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                finish({ key: d.choices[d.choices.length - 1].key, value });
              }
            }}
          />
        </label>
      )}
    </Modal>
  );
}

// ---- Any modal, opened from anywhere --------------------------------------------------------

type ModalRender = (close: () => void) => ReactNode;
let openFn: ((r: ModalRender) => void) | null = null;

/** Opens a modal built by `render`. The modal calls `close` when done. */
export function openModal(render: ModalRender): void {
  openFn?.(render);
}

export function ModalHost() {
  const [stack, setStack] = useState<{ id: number; render: ModalRender }[]>([]);
  const nextId = useRef(1);
  useEffect(() => {
    openFn = (render) => setStack((s) => [...s, { id: nextId.current++, render }]);
    return () => {
      openFn = null;
    };
  }, []);
  return (
    <>
      {stack.map((m) => (
        <Fragment key={m.id}>{m.render(() => setStack((s) => s.filter((x) => x.id !== m.id)))}</Fragment>
      ))}
    </>
  );
}

// ---- Toasts --------------------------------------------------------------------------------

interface Toast {
  id: number;
  text: string;
  kind: 'info' | 'ok' | 'error';
  action?: { label: string; fn: () => void };
}

let toasts: Toast[] = [];
let nextToast = 1;
const toastListeners = new Set<(t: Toast[]) => void>();

export function toast(text: string, kind: Toast['kind'] = 'info', action?: Toast['action']): void {
  const t = { id: nextToast++, text, kind, action };
  toasts = [...toasts, t];
  toastListeners.forEach((l) => l(toasts));
  setTimeout(
    () => {
      toasts = toasts.filter((x) => x.id !== t.id);
      toastListeners.forEach((l) => l(toasts));
    },
    kind === 'error' ? 9000 : action ? 7000 : 4500,
  );
}

export function Toasts() {
  const [list, setList] = useState<Toast[]>(toasts);
  useEffect(() => {
    toastListeners.add(setList);
    return () => {
      toastListeners.delete(setList);
    };
  }, []);
  return (
    <div className="toasts" role="status">
      {list.map((t) => (
        <div key={t.id} className={cx('toast', t.kind)}>
          <span>{t.text}</span>
          {t.action && (
            <button className="link" onClick={t.action.fn}>
              {t.action.label}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
