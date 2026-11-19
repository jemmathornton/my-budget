import { useEffect, useId, useRef, useState } from 'react';
import { registerDraft } from '../../state/persistence';

/**
 * Text typed into a note box. Saved to the budget 500 ms after typing stops, when the box loses
 * focus, and when it closes for any reason: Esc, clicking elsewhere, changing screen, switching
 * budget or closing the app. (Saving only on blur lost the text, because React doesn't send a
 * blur for a box it is removing.)
 */
export function useDraftText(saved: string, save: (text: string, mergeKey: string) => void, delayMs = 500) {
  const mergeKey = 'draft' + useId(); // one undo step each time the box is opened
  const [text, setText] = useState(saved);
  const s = useRef({ text: saved, dirty: false, save, timer: null as ReturnType<typeof setTimeout> | null });
  s.current.save = save;
  const flush = () => {
    const c = s.current;
    if (c.timer) clearTimeout(c.timer);
    c.timer = null;
    if (!c.dirty) return;
    c.dirty = false;
    c.save(c.text, mergeKey);
  };
  // Changed elsewhere (undo, a reload) while nothing is waiting to be saved here: show the new text.
  useEffect(() => {
    if (!s.current.dirty) {
      s.current.text = saved;
      setText(saved);
    }
  }, [saved]);
  useEffect(() => {
    const off = registerDraft(flush);
    return () => {
      flush();
      off();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const onChange = (t: string) => {
    const c = s.current;
    c.text = t;
    c.dirty = true;
    setText(t);
    if (c.timer) clearTimeout(c.timer);
    c.timer = setTimeout(flush, delayMs);
  };
  return { text, onChange, flush };
}
