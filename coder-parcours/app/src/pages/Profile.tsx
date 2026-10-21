import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { ApiError, apiGet, apiSend } from '../api';
import { useRequireUser, useSession } from '../components/Layout';

type ProfileData = { name: string; email: string; phone: string };
type Errors = { name?: string; phone?: string; form?: string };

export default function Profile() {
  const user = useRequireUser();
  const { handleAuthError, signedIn } = useSession();
  const [profile, setProfile] = useState<ProfileData | null>(null);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [errors, setErrors] = useState<Errors>({});
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState('');

  useEffect(() => {
    if (!user) return;
    apiGet<ProfileData>('/api/profile').then((p) => {
      setProfile(p);
      setName(p.name);
      setPhone(p.phone);
    }, (err) => {
      if (!handleAuthError(err)) setLoadError(err instanceof ApiError ? err.message : 'We could not load your profile.');
    });
  }, [user, handleAuthError]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setSaved(false);
    if (!name.trim()) {
      setErrors({ name: 'Enter your name.' });
      return;
    }
    setErrors({});
    setBusy(true);
    try {
      const p = await apiSend<ProfileData>('PUT', '/api/profile', { name: name.trim(), phone: phone.trim() });
      setProfile(p);
      setName(p.name);
      setPhone(p.phone);
      signedIn({ name: p.name, email: p.email });
      setSaved(true);
    } catch (err) {
      if (handleAuthError(err)) return;
      if (err instanceof ApiError && err.code === 'name_invalid') setErrors({ name: err.message });
      else if (err instanceof ApiError && err.code === 'phone_invalid') setErrors({ phone: err.message });
      else setErrors({ form: err instanceof ApiError ? err.message : 'Something went wrong. Please try again.' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="page narrow" data-section="profile">
      <h1>Profile</h1>
      {loadError && <p role="alert" className="notice notice-error">{loadError}</p>}
      {!profile && !loadError && <p className="muted">Loading your profile…</p>}
      {profile && (
        <form onSubmit={submit} noValidate className="form">
          <p className="muted">Signed in as {profile.email}</p>
          <div className="field">
            <label htmlFor="profile-name">Name</label>
            <input
              id="profile-name"
              type="text"
              autoComplete="name"
              maxLength={60}
              value={name}
              onChange={(e) => { setName(e.target.value); setSaved(false); }}
              aria-invalid={errors.name ? true : undefined}
              aria-describedby={errors.name ? 'profile-name-error' : undefined}
            />
            {errors.name && <p id="profile-name-error" className="field-error">{errors.name}</p>}
          </div>
          <div className="field">
            <label htmlFor="profile-phone">Phone</label>
            <input
              id="profile-phone"
              type="tel"
              autoComplete="tel"
              maxLength={20}
              value={phone}
              onChange={(e) => { setPhone(e.target.value); setSaved(false); }}
              aria-invalid={errors.phone ? true : undefined}
              aria-describedby={errors.phone ? 'profile-phone-error' : undefined}
            />
            {errors.phone && <p id="profile-phone-error" className="field-error">{errors.phone}</p>}
          </div>
          {errors.form && <p role="alert" className="field-error">{errors.form}</p>}
          <div className="actions">
            <button type="submit" className="button primary" disabled={busy} aria-busy={busy || undefined}>Save profile</button>
          </div>
          <p role="status" className="status-line">{saved ? 'Profile saved.' : ''}</p>
        </form>
      )}
      <p><Link to="/settings">Email and newsletter settings</Link></p>
    </section>
  );
}
