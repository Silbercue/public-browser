import { useEffect, useState } from 'react';
import { ApiError, apiGet, apiSend } from '../api';
import Dialog from '../components/Dialog';
import { useRequireUser, useSession } from '../components/Layout';

type SettingsData = { emailReminders: boolean; newsletter: boolean };
const DEFAULTS: SettingsData = { emailReminders: true, newsletter: false };

function Switch({ id, label, hint, checked, onChange }: {
  id: string; label: string; hint: string; checked: boolean; onChange: (v: boolean) => void;
}) {
  return (
    <div className="switch-row">
      <div>
        <span id={`${id}-label`} className="switch-label">{label}</span>
        <p id={`${id}-hint`} className="field-hint">{hint}</p>
      </div>
      <button
        type="button"
        role="switch"
        className="switch"
        aria-checked={checked}
        aria-labelledby={`${id}-label`}
        aria-describedby={`${id}-hint`}
        onClick={() => onChange(!checked)}
      >
        <span className="switch-track" aria-hidden="true"><span className="switch-thumb" /></span>
        <span className="switch-state" aria-hidden="true">{checked ? 'On' : 'Off'}</span>
      </button>
    </div>
  );
}

export default function Settings() {
  const user = useRequireUser();
  const { handleAuthError } = useSession();
  const [values, setValues] = useState<SettingsData | null>(null);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);

  useEffect(() => {
    if (!user) return;
    apiGet<SettingsData>('/api/settings').then(setValues, (err) => {
      if (!handleAuthError(err)) setError(err instanceof ApiError ? err.message : 'We could not load your settings.');
    });
  }, [user, handleAuthError]);

  const save = async (next: SettingsData, message: string) => {
    setStatus('');
    setError('');
    setBusy(true);
    try {
      setValues(await apiSend<SettingsData>('PUT', '/api/settings', next));
      setStatus(message);
    } catch (err) {
      if (!handleAuthError(err)) setError(err instanceof ApiError ? err.message : 'Something went wrong. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  const change = (key: keyof SettingsData) => (v: boolean) => {
    setStatus('');
    setValues((s) => (s ? { ...s, [key]: v } : s));
  };

  return (
    <section className="page narrow" data-section="settings">
      <h1>Settings</h1>
      {!values && !error && <p className="muted">Loading your settings…</p>}
      {error && <p role="alert" className="notice notice-error">{error}</p>}
      {values && (
        <>
          <div className="switch-list">
            <Switch id="set-reminders" label="Email reminders" hint="A reminder the evening before each class."
              checked={values.emailReminders} onChange={change('emailReminders')} />
            <Switch id="set-newsletter" label="Newsletter" hint="Studio news and new classes, about once a month."
              checked={values.newsletter} onChange={change('newsletter')} />
          </div>
          <div className="actions">
            <button type="button" className="button primary" disabled={busy} onClick={() => save(values, 'Settings saved.')}>Save changes</button>
            <button type="button" className="button secondary" disabled={busy} onClick={() => setConfirmReset(true)}>Reset to defaults</button>
          </div>
          <p role="status" className="status-line">{status}</p>
        </>
      )}
      {confirmReset && (
        <Dialog title="Reset all settings?" onClose={() => setConfirmReset(false)}>
          <p>Email reminders go back on and the newsletter goes off.</p>
          <div className="actions">
            <button type="button" className="button primary" onClick={() => { setConfirmReset(false); save(DEFAULTS, 'Settings reset to defaults.'); }}>Reset</button>
            <button type="button" className="button secondary" onClick={() => setConfirmReset(false)} data-autofocus>Keep my settings</button>
          </div>
        </Dialog>
      )}
    </section>
  );
}
