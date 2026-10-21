import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { ApiError, apiGet, apiSend, dayName, formatUsd, notifyCartChanged, spotsLabel, type Cart } from '../api';
import { useSession } from '../components/Layout';
import './booking.css';

type Profile = { name: string; email: string };

/** Where guests are sent; the login page shows "Please log in to book." for this target. */
export const CHECKOUT_LOGIN = '/login?next=%2Fcheckout';

export default function Checkout() {
  const { user, handleAuthError } = useSession();
  const navigate = useNavigate();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [cart, setCart] = useState<Cart | null>(null);
  const [accepted, setAccepted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (user === null) navigate(CHECKOUT_LOGIN, { replace: true });
  }, [user, navigate]);

  useEffect(() => {
    if (!user) return;
    const fail = (err: unknown) => {
      if (err instanceof ApiError && err.status === 401) {
        if (err.code === 'login_required') navigate(CHECKOUT_LOGIN, { replace: true });
        else handleAuthError(err);
        return;
      }
      setError(err instanceof ApiError ? err.message : 'Something went wrong. Please try again.');
    };
    apiGet<Profile>('/api/profile').then(setProfile, fail);
    apiGet<Cart>('/api/cart').then(setCart, fail);
  }, [user, navigate, handleAuthError]);

  const place = async () => {
    setBusy(true);
    setError('');
    try {
      const { reference } = await apiSend<{ reference: string }>('POST', '/api/checkout', { acceptTerms: true });
      notifyCartChanged();
      navigate(`/confirmation/${encodeURIComponent(reference)}`, { replace: true });
    } catch (err) {
      setBusy(false);
      if (err instanceof ApiError && err.status === 401) {
        if (err.code === 'login_required') navigate(CHECKOUT_LOGIN, { replace: true });
        else handleAuthError(err);
        return;
      }
      setError(err instanceof ApiError ? err.message : 'Something went wrong. Please try again.');
    }
  };

  const ready = profile && cart;

  return (
    <section className="page" data-section="checkout">
      <h1>Checkout</h1>
      {error && <p role="alert" className="notice notice-error">{error}</p>}
      {!ready && !error && <p className="muted">Loading checkout…</p>}
      {ready && cart.items.length === 0 && (
        <div className="empty">
          <p>Your cart is empty.</p>
          <Link to="/schedule" className="button secondary">Browse the schedule</Link>
        </div>
      )}
      {ready && cart.items.length > 0 && (
        <div className="checkout-layout">
          <div className="card">
            <h2>Your details</h2>
            <dl className="facts">
              <div><dt>Name</dt><dd>{profile.name}</dd></div>
              <div><dt>Email</dt><dd>{profile.email}</dd></div>
            </dl>
            <p className="muted"><Link to="/profile">Change your details</Link></p>
          </div>
          <div className="card">
            <h2>Overview</h2>
            <ul className="overview">
              {cart.items.map((it) => (
                <li key={it.id}>
                  <span>{it.name}, {dayName(it.day)} {it.start} · {spotsLabel(it.spots)}</span>
                  <span>{formatUsd(it.lineCents)}</span>
                </li>
              ))}
            </ul>
            <dl className="totals">
              <div><dt>Subtotal</dt><dd>{formatUsd(cart.subtotalCents)}</dd></div>
              {cart.discountCents > 0 && <div><dt>Discount ({cart.coupon})</dt><dd>−{formatUsd(cart.discountCents)}</dd></div>}
              <div className="grand"><dt>Total (USD)</dt><dd data-testid="total">{formatUsd(cart.totalCents)}</dd></div>
            </dl>
            <div className="terms">
              <input id="accept-terms" type="checkbox" checked={accepted} onChange={(e) => setAccepted(e.target.checked)} />
              <label htmlFor="accept-terms">I accept the studio terms</label>
            </div>
            {!accepted && <p id="terms-hint" className="book-note">Please accept the studio terms to continue.</p>}
            <button
              type="button"
              className="button primary block"
              disabled={!accepted || busy}
              aria-busy={busy || undefined}
              aria-describedby={!accepted ? 'terms-hint' : undefined}
              onClick={place}
            >
              {busy ? (<><span className="spinner" aria-hidden="true" />Booking…</>) : 'Place booking'}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
