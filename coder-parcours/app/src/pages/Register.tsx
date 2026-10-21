import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { ApiError, apiSend, safeNext, type User } from '../api';
import { useSession } from '../components/Layout';

type Field = 'name' | 'email' | 'password';
type Errors = Partial<Record<Field, string>>;

const FIELD_OF_CODE: Record<string, Field> = {
  name_required: 'name', email_invalid: 'email', email_taken: 'email', password_short: 'password',
};

function check(name: string, email: string, password: string): Errors {
  const errors: Errors = {};
  if (!name.trim()) errors.name = 'Enter your name.';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) errors.email = 'Enter a valid email address.';
  if (password.length < 8) errors.password = 'Use at least 8 characters.';
  return errors;
}

export default function Register() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { signedIn } = useSession();
  const [values, setValues] = useState({ name: '', email: '', password: '' });
  const [errors, setErrors] = useState<Errors>({});
  const [formError, setFormError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const found = check(values.name, values.email, values.password);
    setErrors(found);
    setFormError('');
    if (Object.keys(found).length) return;
    setBusy(true);
    try {
      const { user } = await apiSend<{ user: User }>('POST', '/api/auth/register', {
        name: values.name.trim(), email: values.email.trim(), password: values.password,
      });
      signedIn(user);
      navigate(safeNext(params.get('next')), { replace: true });
    } catch (err) {
      const field = err instanceof ApiError ? FIELD_OF_CODE[err.code] : undefined;
      const message = err instanceof ApiError ? err.message : 'Something went wrong. Please try again.';
      if (field) setErrors({ [field]: message });
      else setFormError(message);
      setBusy(false);
    }
  };

  const input = (field: Field, label: string, type: string, autoComplete: string, hint?: string) => {
    const id = `register-${field}`;
    const describedBy = [hint ? `${id}-hint` : '', errors[field] ? `${id}-error` : ''].filter(Boolean).join(' ');
    return (
      <div className="field">
        <label htmlFor={id}>{label}</label>
        <input
          id={id}
          type={type}
          autoComplete={autoComplete}
          value={values[field]}
          onChange={(e) => setValues((v) => ({ ...v, [field]: e.target.value }))}
          aria-invalid={errors[field] ? true : undefined}
          aria-describedby={describedBy || undefined}
        />
        {hint && <p id={`${id}-hint`} className="field-hint">{hint}</p>}
        {errors[field] && <p id={`${id}-error`} className="field-error">{errors[field]}</p>}
      </div>
    );
  };

  return (
    <section className="page narrow" data-section="register">
      <h1>Create an account</h1>
      <form onSubmit={submit} noValidate className="form">
        {input('name', 'Name', 'text', 'name')}
        {input('email', 'Email', 'email', 'email')}
        {input('password', 'Password', 'password', 'new-password', 'At least 8 characters')}
        {formError && <p className="field-error" role="alert">{formError}</p>}
        <div className="actions">
          <button type="submit" className="button primary" disabled={busy} aria-busy={busy || undefined}>Create account</button>
        </div>
      </form>
      <p>Already have an account? <Link to="/login">Log in</Link></p>
    </section>
  );
}
