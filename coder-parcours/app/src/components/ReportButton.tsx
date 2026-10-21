import { useEffect, useState, type FormEvent } from 'react';
import { useLocation } from 'react-router';
import { ApiError, apiSend } from '../api';
import Dialog from './Dialog';

const REPORT_KEY = 'sw_report';
const TESTER_KEY = 'sw_tester';
const TEXT_MAX = 4000;

function stored(key: string): string | null {
  try { return sessionStorage.getItem(key); } catch { return null; }
}
function store(key: string, value: string) {
  try { sessionStorage.setItem(key, value); } catch { /* storage blocked: only this page view keeps the flag */ }
}

/** Stores ?report=1 and ?tester= of this URL in the tab's session storage. */
function rememberFromUrl(search: string): void {
  const q = new URLSearchParams(search);
  if (q.get('report') === '1') store(REPORT_KEY, '1');
  const t = q.get('tester');
  if (t) store(TESTER_KEY, t);
}
// Runs when the bundle loads, so a visitor who leaves the first page right away keeps the flag.
rememberFromUrl(window.location.search);

/** "Report a problem" for human testers: shown once `?report=1` was in the URL of this tab. */
export default function ReportButton() {
  const location = useLocation();
  const [enabled, setEnabled] = useState(() => stored(REPORT_KEY) === '1' || new URLSearchParams(location.search).get('report') === '1');
  const [tester, setTester] = useState(() => new URLSearchParams(location.search).get('tester') || stored(TESTER_KEY));
  const [open, setOpen] = useState(false);

  useEffect(() => {
    rememberFromUrl(location.search);
    const q = new URLSearchParams(location.search);
    if (q.get('report') === '1') setEnabled(true);
    const t = q.get('tester');
    if (t) setTester(t);
  }, [location.search]);

  useEffect(() => {
    document.body.classList.toggle('has-report-button', enabled);
  }, [enabled]);

  if (!enabled) return null;
  return (
    <>
      <button type="button" className="button report-button" onClick={() => setOpen(true)}>Report a problem</button>
      {open && <ReportDialog path={location.pathname} tester={tester} onClose={() => setOpen(false)} />}
    </>
  );
}

function ReportDialog({ path, tester, onClose }: { path: string; tester: string | null; onClose: () => void }) {
  const [text, setText] = useState('');
  const [where, setWhere] = useState(path);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!text.trim()) {
      setError('Please describe the problem.');
      return;
    }
    setError('');
    setBusy(true);
    try {
      await apiSend('POST', '/api/reports', { text, path: where, viewportPx: window.innerWidth, tester: tester ?? undefined });
      setSent(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog title="Report a problem" onClose={onClose}>
      {sent ? (
        <>
          <p role="status" className="notice notice-success">Thanks — report saved.</p>
          <div className="actions">
            <button type="button" className="button primary" onClick={onClose} data-autofocus>Done</button>
          </div>
        </>
      ) : (
        <form onSubmit={submit} noValidate>
          <div className="field">
            <label htmlFor="report-text">What went wrong?</label>
            <textarea
              id="report-text"
              rows={5}
              maxLength={TEXT_MAX}
              value={text}
              onChange={(e) => setText(e.target.value)}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? 'report-text-error' : undefined}
              required
              data-autofocus
            />
            {error && <p id="report-text-error" className="field-error" role="alert">{error}</p>}
          </div>
          <div className="field">
            <label htmlFor="report-where">Where?</label>
            <input id="report-where" type="text" value={where} onChange={(e) => setWhere(e.target.value)} />
          </div>
          <div className="actions">
            <button type="submit" className="button primary" disabled={busy} aria-busy={busy || undefined}>
              {busy ? 'Sending…' : 'Send report'}
            </button>
          </div>
        </form>
      )}
    </Dialog>
  );
}
