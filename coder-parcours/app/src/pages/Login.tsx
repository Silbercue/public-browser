import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { ApiError, apiSend, safeNext, type User } from '../api';
import { useSession } from '../components/Layout';

export default function Login() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { signedIn } = useSession();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const next = safeNext(params.get('next'));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!email.trim() || !password) {
      setError('Enter your email and password.');
      return;
    }
    setError('');
    setBusy(true);
    try {
      const { user } = await apiSend<{ user: User }>('POST', '/api/auth/login', { email: email.trim(), password });
      signedIn(user);
      navigate(next, { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong. Please try again.');
      setBusy(false);
    }
  };

  return (
    <section className="page narrow" data-section="login">
      <h1>Log in</h1>
      <form onSubmit={submit} noValidate className="form">
        <div className="field">
          <label htmlFor="login-email">Email</label>
          <input id="login-email" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="login-password">Password</label>
          <input
            id="login-password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? 'login-error' : undefined}
          />
          {error && <p id="login-error" className="field-error" role="alert">{error}</p>}
        </div>
        <div className="actions">
          <button type="submit" className="button primary" disabled={busy} aria-busy={busy || undefined}>Log in</button>
        </div>
      </form>
      <p>New here? <Link to={params.get('next') ? `/register?next=${encodeURIComponent(next)}` : '/register'}>Create an account</Link></p>
    </section>
  );
}
