import { useEffect, useMemo, useState } from 'react';
import { toast } from '../common/dialogs';
import { isTopModal, Modal } from '../common/overlay';
import { docCsv, docHtml, type PrintDoc } from './doc';

// The print preview (1.5.1), as YNAB4 had: the printout as it will look, with Print… (Windows'
// own print dialog, to pick the printer and pages), Save as PDF… and Save as CSV….

export function PrintPreview({ doc, onClose }: { doc: PrintDoc; onClose: () => void }) {
  const html = useMemo(() => docHtml(doc), [doc]);
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      toast(`That didn't work: ${e instanceof Error ? e.message : String(e)}`, 'error');
    } finally {
      setBusy(false);
    }
  };
  const print = () =>
    run(async () => {
      const r = await window.api.printPage(html, !!doc.landscape);
      if (r.ok) onClose();
      else if (r.reason && r.reason !== 'cancelled') toast(`It didn't print: ${r.reason}.`, 'error');
    });
  const pdf = () =>
    run(async () => {
      const p = await window.api.savePdf(html, doc.name + '.pdf');
      if (p) {
        toast('Saved ' + p, 'ok');
        onClose();
      }
    });
  // Ctrl+E here too, as the button's hint says (the app's own Ctrl+E waits while a dialog is open).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'e' && isTopModal(document.querySelector('.modal.print-preview'))) {
        e.preventDefault();
        void run(() => exportDoc(doc));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });
  return (
    <Modal
      title={`Print: ${doc.title}`}
      onClose={onClose}
      width={Math.min(window.innerWidth - 80, doc.landscape ? 1180 : 900)}
      className="print-preview"
      footer={
        <>
          <button className="btn" disabled={busy} onClick={() => run(() => exportDoc(doc))} title="A file for a spreadsheet (Ctrl+E)">
            Save as CSV…
          </button>
          <button className="btn" disabled={busy} onClick={pdf}>
            Save as PDF…
          </button>
          <span className="grow" />
          <button className="btn" onClick={onClose}>
            Close
          </button>
          <button className="btn primary" autoFocus disabled={busy} onClick={print}>
            Print…
          </button>
        </>
      }
    >
      <iframe className="print-frame" title="Print preview" sandbox="" srcDoc={html} />
    </Modal>
  );
}

/** Saves a printout as CSV, asking where. */
export async function exportDoc(doc: PrintDoc): Promise<void> {
  const p = await window.api.saveTextFile(doc.name + '.csv', [{ name: 'CSV (spreadsheet)', extensions: ['csv'] }], docCsv(doc));
  if (p) toast('Saved ' + p, 'ok');
}
