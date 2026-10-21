import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { ApiError, apiGet, apiSend, dayName, formatUsd, notifyCartChanged, type YogaClass } from '../api';
import Dialog from '../components/Dialog';
import './booking.css';

type Review = { author: string; rating: number; text: string };

export default function ClassDetail() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const [k, setK] = useState<YogaClass | null>(null);
  const [reviews, setReviews] = useState<Review[] | null>(null);
  const [loadError, setLoadError] = useState('');
  const [bookError, setBookError] = useState('');
  const [busy, setBusy] = useState(false);
  const [added, setAdded] = useState(false);

  useEffect(() => {
    setK(null);
    setReviews(null);
    setLoadError('');
    setBookError('');
    setAdded(false);
    const path = `/api/classes/${encodeURIComponent(id)}`;
    apiGet<YogaClass>(path).then(setK, (err) => setLoadError(err instanceof ApiError ? err.message : 'We could not load this class.'));
    apiGet<{ reviews: Review[] }>(`${path}/reviews`).then((d) => setReviews(d.reviews), () => setReviews([]));
  }, [id]);

  const book = async () => {
    if (!k) return;
    setBusy(true);
    setBookError('');
    try {
      await apiSend('POST', '/api/cart/items', { classId: k.id, spots: 1 });
      notifyCartChanged();
      setAdded(true);
    } catch (err) {
      setBookError(err instanceof ApiError ? err.message : 'Something went wrong. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  if (loadError) {
    return (
      <section className="page" data-section="class-detail">
        <h1>Class not found</h1>
        <p role="alert" className="notice notice-error">{loadError}</p>
        <Link to="/schedule" className="button secondary">Back to the schedule</Link>
      </section>
    );
  }
  if (!k) {
    return (
      <section className="page" data-section="class-detail">
        <h1>Class</h1>
        <p className="muted">Loading class…</p>
      </section>
    );
  }

  const blocked = k.ended ? 'This class has ended.' : k.full ? 'Class full — check another day' : '';
  const spots = k.ended ? 'Closed' : k.full ? 'No spots left' : `${k.spotsLeft} of ${k.capacity} spots left`;

  return (
    <section className="page narrow-wide" data-section="class-detail">
      <p><Link to={`/schedule?day=${k.day}`}>Back to {dayName(k.day)}</Link></p>
      <h1>{k.name}</h1>
      <p className="muted">{dayName(k.day)} · {k.start} · {k.durationMin} min</p>
      <p>{k.description}</p>
      <dl className="facts">
        <div><dt>Teacher</dt><dd>{k.teacher}</dd></div>
        <div><dt>Style</dt><dd>{k.style} · {k.level}</dd></div>
        <div><dt>Price</dt><dd>{formatUsd(k.priceCents)} per spot</dd></div>
        <div><dt>Spots</dt><dd>{spots}</dd></div>
      </dl>
      <div className="book-box">
        <button
          type="button"
          className="button primary"
          disabled={Boolean(blocked) || busy}
          aria-describedby={blocked ? 'book-blocked' : bookError ? 'book-error' : undefined}
          onClick={book}
        >
          Book this class
        </button>
        {blocked && <p id="book-blocked" className="book-note">{blocked}</p>}
        {bookError && <p id="book-error" role="alert" className="field-error">{bookError}</p>}
      </div>
      <h2>Reviews</h2>
      {!reviews && <p className="muted">Loading reviews…</p>}
      {reviews && reviews.length === 0 && <p className="muted">No reviews yet.</p>}
      {reviews && reviews.length > 0 && (
        <ul className="review-list">
          {reviews.map((r, i) => (
            <li key={`${r.author}-${i}`} className="review card">
              <p className="review-head"><strong>{r.author}</strong> <span aria-label={`${r.rating} out of 5 stars`}>{'★'.repeat(r.rating)}{'☆'.repeat(5 - r.rating)}</span></p>
              <p>{r.text}</p>
            </li>
          ))}
        </ul>
      )}
      {added && (
        <Dialog title="Added to cart" onClose={() => setAdded(false)}>
          <p>{k.name}, {dayName(k.day)} {k.start}: one spot is in your cart.</p>
          <div className="actions">
            <button type="button" className="button primary" data-autofocus onClick={() => navigate('/cart')}>Go to cart</button>
            <button type="button" className="button secondary" onClick={() => setAdded(false)}>Keep browsing</button>
          </div>
        </Dialog>
      )}
    </section>
  );
}
