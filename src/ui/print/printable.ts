import { useEffect, useRef } from 'react';
import type { PrintDoc } from './doc';

// What File > Print (Ctrl+P) and Export (Ctrl+E) act on: the screen showing registers how to
// describe itself, and the latest to do so wins. Screens without a printout register nothing.

let current: (() => PrintDoc | null) | null = null;

/** Called by a screen while it's showing; `make` is called only when printing. */
export function usePrintable(make: () => PrintDoc | null): void {
  const ref = useRef(make);
  ref.current = make;
  useEffect(() => {
    const fn = () => ref.current();
    current = fn;
    return () => {
      if (current === fn) current = null;
    };
  }, []);
}

/** The printout of the screen showing, or null if it has none. */
export function currentDoc(): PrintDoc | null {
  return current?.() ?? null;
}
