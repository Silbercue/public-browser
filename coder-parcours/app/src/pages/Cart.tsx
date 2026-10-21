import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { ApiError, apiGet, apiSend, dayName, formatUsd, notifyCartChanged, type Cart as CartData } from '../api';
import Dialog from '../components/Dialog';
import './booking.css';

const MIN_SPOTS = 1;
const MAX_SPOTS = 5;

type Item = CartData['items'][number];
type CouponMessage = { kind: 'ok' | 'error'; text: string } | null;

const errorText = (err: unknown) => (err instanceof ApiError ? err.message : 'Something went wrong. Please try again.');

export default function Cart() {
  const [cart, setCart] = useState<CartData | null>(null);
  const [loadError, setLoadError] = useState('');
  const [lineError, setLineError] = useState<{ id: string; text: string } | null>(null);
  const [removing, setRemoving] = useState<Item | null>(null);
  const [code, setCode] = useState('');
  const [couponMsg, setCouponMsg] = useState<CouponMessage>(null);
  const [applying, setApplying] = useState(false);
  // Stepper clicks run one after another; only the answer to the last one is shown.
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const pending = useRef(0);

  useEffect(() => {
    apiGet<CartData>('/api/cart').then(setCart, (err) => setLoadError(errorText(err)));
  }, []);

  const reload = () => apiGet<CartData>('/api/cart').then(setCart, () => { /* keep what is shown */ });

  const setSpots = (item: Item, spots: number) => {
    if (!cart || spots < MIN_SPOTS || spots > MAX_SPOTS) return;
    setLineError(null);
    setCart({ ...cart, items: cart.items.map((it) => (it.id === item.id ? { ...it, spots } : it)) });
    pending.current++;
    queue.current = queue.current.then(async () => {
      try {
        const next = await apiSend<CartData>('PATCH', `/api/cart/items/${item.id}`, { spots });
        if (pending.current === 1) setCart(next);
      } catch (err) {
        setLineError({ id: item.id, text: errorText(err) });
        await reload();
      } finally {
        pending.current--;
        notifyCartChanged();
      }
    });
  };

  const remove = async (item: Item) => {
    setRemoving(null);
    try {
      setCart(await apiSend<CartData>('DELETE', `/api/cart/items/${item.id}`));
    } catch (err) {
      setLineError({ id: item.id, text: errorText(err) });
      await reload();
    }
    notifyCartChanged();
  };

  const apply = async (e: FormEvent) => {
    e.preventDefault();
    setApplying(true);
    try {
      const next = await apiSend<CartData>('POST', '/api/cart/coupon', { code });
      setCart(next);
      setCouponMsg({ kind: 'ok', text: `${next.coupon ?? code.trim().toUpperCase()} applied: 10% off.` });
    } catch (err) {
      setCouponMsg({ kind: 'error', text: errorText(err) });
    } finally {
      setApplying(false);
    }
  };

  return (
    <section className="page" data-section="cart">
      <h1>Your cart</h1>
      {loadError && <p role="alert" className="notice notice-error">{loadError}</p>}
      {!cart && !loadError && <p className="muted">Loading your cart…</p>}
      {cart && cart.items.length === 0 && (
        <div className="empty">
          <p>Your cart is empty.</p>
          <Link to="/schedule" className="button secondary">Browse the schedule</Link>
        </div>
      )}
      {cart && cart.items.length > 0 && (
        <div className="cart-layout">
          <ul className="cart-items">
            {cart.items.map((it) => (
              <li key={it.id} className="card cart-item">
                <div className="cart-item-info">
                  <h2 className="cart-item-name">{it.name}</h2>
                  <p className="muted">{dayName(it.day)} · {it.start} · {it.teacher}</p>
                  <p>{formatUsd(it.priceCents)} per spot · <span className="line-total">{formatUsd(it.priceCents * it.spots)}</span></p>
                </div>
                <div className="cart-item-controls">
                  <div className="stepper" role="group" aria-label={`Spots for ${it.name}`}>
                    <button type="button" className="step" aria-label="Decrease spots" disabled={it.spots <= MIN_SPOTS} onClick={() => setSpots(it, it.spots - 1)}>−</button>
                    <span className="step-value" data-testid="spots-value" aria-live="polite">{it.spots}</span>
                    <button type="button" className="step" aria-label="Increase spots" disabled={it.spots >= MAX_SPOTS} onClick={() => setSpots(it, it.spots + 1)}>+</button>
                  </div>
                  <button type="button" className="button secondary danger" onClick={() => setRemoving(it)}>Remove</button>
                </div>
                {lineError?.id === it.id && <p role="alert" className="field-error cart-item-error">{lineError.text}</p>}
              </li>
            ))}
          </ul>
          <div className="card cart-summary">
            <form className="coupon" onSubmit={apply} noValidate>
              <label htmlFor="coupon-code">Coupon code</label>
              <div className="coupon-row">
                <input
                  id="coupon-code"
                  value={code}
                  autoComplete="off"
                  onChange={(e) => setCode(e.target.value)}
                  aria-describedby={couponMsg ? 'coupon-message' : undefined}
                  aria-invalid={couponMsg?.kind === 'error' ? true : undefined}
                />
                <button type="submit" className="button secondary" disabled={applying}>Apply</button>
              </div>
              {couponMsg && (
                <p
                  id="coupon-message"
                  data-testid="coupon-message"
                  role={couponMsg.kind === 'error' ? 'alert' : 'status'}
                  className={couponMsg.kind === 'error' ? 'field-error' : 'field-ok'}
                >
                  {couponMsg.text}
                </p>
              )}
            </form>
            <dl className="totals">
              <div><dt>Subtotal</dt><dd data-testid="subtotal">{formatUsd(cart.subtotalCents)}</dd></div>
              {cart.discountCents > 0 && (
                <div><dt>Discount ({cart.coupon})</dt><dd data-testid="discount">−{formatUsd(cart.discountCents)}</dd></div>
              )}
              <div className="grand"><dt>Total (USD)</dt><dd data-testid="total">{formatUsd(cart.totalCents)}</dd></div>
            </dl>
            <Link to="/checkout" className="button primary block">Continue to checkout</Link>
          </div>
        </div>
      )}
      {removing && (
        <Dialog title="Remove this class?" onClose={() => setRemoving(null)}>
          <p>{removing.name}, {dayName(removing.day)} {removing.start} will leave your cart.</p>
          <div className="actions">
            <button type="button" className="button primary danger" onClick={() => remove(removing)}>Remove</button>
            <button type="button" className="button secondary" data-autofocus onClick={() => setRemoving(null)}>Keep it</button>
          </div>
        </Dialog>
      )}
    </section>
  );
}
