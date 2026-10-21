import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router';
import { ApiError, apiGet } from '../api';
import { useRequireUser, useSession } from '../components/Layout';
import './booking.css';

export default function Confirmation() {
  const { reference = '' } = useParams();
  const user = useRequireUser();
  const { handleAuthError } = useSession();
  // undefined while the reference is being checked
  const [found, setFound] = useState<boolean | undefined>(undefined);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!user) return;
    apiGet<{ found: boolean }>(`/api/confirmations/${encodeURIComponent(reference)}`).then(
      (d) => setFound(d.found === true),
      (err) => { if (!handleAuthError(err)) setError(err instanceof ApiError ? err.message : 'Something went wrong. Please try again.'); },
    );
  }, [user, reference, handleAuthError]);

  if (error) {
    return <section className="page narrow"><p role="alert" className="notice notice-error">{error}</p></section>;
  }
  if (found === undefined) {
    return <section className="page narrow"><p className="muted">Loading your confirmation…</p></section>;
  }
  if (!found) {
    return (
      <section className="page narrow">
        <div className="card confirmation">
          <h1>Booking not found</h1>
          <p>We could not find a booking with this reference.</p>
          <Link to="/bookings" className="button primary">See my bookings</Link>
        </div>
      </section>
    );
  }
  return (
    <section className="page narrow">
      <div className="card confirmation">
        <h1>Booking confirmed</h1>
        <p>Thank you. Your spots are reserved, see you on the mat.</p>
        <p>Your reference: <strong data-testid="reference">{reference}</strong></p>
        <Link to="/bookings" className="button primary">See my bookings</Link>
      </div>
    </section>
  );
}
