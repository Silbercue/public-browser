import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';
import { ApiError, apiGet, apiSend, dayName, spotsLabel, type Booking, type YogaClass } from '../api';
import Dialog from '../components/Dialog';
import { useRequireUser, useSession } from '../components/Layout';

type Action = { kind: 'cancel' | 'reschedule'; booking: Booking } | null;

export default function Bookings() {
  const user = useRequireUser();
  const { handleAuthError } = useSession();
  const [bookings, setBookings] = useState<Booking[] | null>(null);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [action, setAction] = useState<Action>(null);

  const fail = useCallback((err: unknown) => {
    if (!handleAuthError(err)) setError(err instanceof ApiError ? err.message : 'Something went wrong. Please try again.');
  }, [handleAuthError]);

  const load = useCallback(() => {
    apiGet<{ bookings: Booking[] }>('/api/bookings').then((d) => setBookings(d.bookings.filter((b) => !b.class.ended)), fail);
  }, [fail]);

  useEffect(() => {
    if (user) load();
  }, [user, load]);

  const done = (message: string) => {
    setAction(null);
    setStatus(message);
    load();
  };

  return (
    <section className="page" data-section="bookings">
      <h1>My bookings</h1>
      {error && <p role="alert" className="notice notice-error">{error}</p>}
      {!bookings && !error && <p className="muted">Loading your bookings…</p>}
      {bookings && bookings.length === 0 && (
        <div className="empty">
          <p>No upcoming bookings.</p>
          <Link to="/schedule" className="button secondary">Browse the schedule</Link>
        </div>
      )}
      {bookings && bookings.length > 0 && (
        <ul className="booking-list">
          {bookings.map((b) => (
            <li key={b.id} className="card booking">
              <div>
                <h2 className="booking-name">{b.class.name}</h2>
                <p className="muted">{dayName(b.class.day)} · {b.class.start} · {spotsLabel(b.spots)}</p>
                <p className="muted">{b.class.style} with {b.class.teacher} · Ref. {b.reference}</p>
              </div>
              <div className="actions">
                <button type="button" className="button secondary" onClick={() => { setStatus(''); setAction({ kind: 'reschedule', booking: b }); }}>Reschedule</button>
                <button type="button" className="button secondary danger" onClick={() => { setStatus(''); setAction({ kind: 'cancel', booking: b }); }}>Cancel</button>
              </div>
            </li>
          ))}
        </ul>
      )}
      <p role="status" className="status-line">{status}</p>
      {action?.kind === 'cancel' && (
        <CancelDialog booking={action.booking} onClose={() => setAction(null)} onDone={() => done('Booking cancelled.')} onError={fail} />
      )}
      {action?.kind === 'reschedule' && (
        <RescheduleDialog
          booking={action.booking}
          others={bookings ?? []}
          onClose={() => setAction(null)}
          onDone={(k) => done(`Moved to ${dayName(k.day)} ${k.start}.`)}
          onError={fail}
        />
      )}
    </section>
  );
}

type DialogProps = { booking: Booking; onClose: () => void; onError: (err: unknown) => void };

function CancelDialog({ booking, onClose, onDone, onError }: DialogProps & { onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const cancel = async () => {
    setBusy(true);
    try {
      await apiSend('POST', `/api/bookings/${booking.id}/cancel`);
      onDone();
    } catch (err) {
      onClose();
      onError(err);
    }
  };
  return (
    <Dialog title="Cancel this booking?" onClose={onClose}>
      <p>{booking.class.name}, {dayName(booking.class.day)} {booking.class.start}, {spotsLabel(booking.spots)}.</p>
      <div className="actions">
        <button type="button" className="button primary danger" disabled={busy} onClick={cancel}>Yes, cancel</button>
        <button type="button" className="button secondary" onClick={onClose} data-autofocus>Keep booking</button>
      </div>
    </Dialog>
  );
}

function RescheduleDialog({ booking, others, onClose, onDone, onError }: DialogProps & {
  others: Booking[]; onDone: (k: YogaClass) => void;
}) {
  const [options, setOptions] = useState<YogaClass[] | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const taken = new Set(others.map((b) => b.classId));
    apiGet<{ classes: YogaClass[] }>(`/api/classes?style=${encodeURIComponent(booking.class.style)}`).then(
      (d) => setOptions(d.classes.filter((k) => k.id !== booking.classId && !k.ended && k.spotsLeft >= booking.spots && !taken.has(k.id))),
      (err) => setError(err instanceof ApiError ? err.message : 'We could not load other dates.'),
    );
  }, [booking, others]);

  const pick = async (k: YogaClass) => {
    setBusy(true);
    setError('');
    try {
      await apiSend('POST', `/api/bookings/${booking.id}/reschedule`, { classId: k.id });
      onDone(k);
    } catch (err) {
      if (err instanceof ApiError && err.status !== 401) {
        setError(err.message);
        setBusy(false);
      } else {
        onClose();
        onError(err);
      }
    }
  };

  return (
    <Dialog title={`Reschedule ${booking.class.name}`} onClose={onClose}>
      <p className="muted">Other {booking.class.style} dates with {spotsLabel(booking.spots)} free:</p>
      {error && <p role="alert" className="field-error">{error}</p>}
      {!options && !error && <p className="muted">Loading dates…</p>}
      {options && options.length === 0 && <p>No other dates for this class style.</p>}
      {options && options.length > 0 && (
        <ul className="option-list">
          {options.map((k) => (
            <li key={k.id}>
              <button type="button" className="button secondary option" disabled={busy} onClick={() => pick(k)}>
                {dayName(k.day)} {k.start} · {k.name} · {k.teacher}
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="actions">
        <button type="button" className="button secondary" onClick={onClose}>Keep current date</button>
      </div>
    </Dialog>
  );
}
