import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { apiGet, dayName, formatUsd, type YogaClass } from '../api';

/** Welcome, a way into the schedule and three upcoming classes with free spots. */
export default function Home() {
  const [featured, setFeatured] = useState<YogaClass[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    apiGet<{ classes: YogaClass[] }>('/api/classes').then(
      (d) => setFeatured(d.classes.filter((k) => !k.ended && !k.full).slice(0, 3)),
      () => setFailed(true),
    );
  }, []);

  return (
    <section className="page" data-section="home">
      <div className="hero">
        <h1>Welcome to Stillwater Yoga</h1>
        <p>Small classes, calm rooms and teachers who know your name. Find a class that fits your week.</p>
        <Link to="/schedule" className="button primary">See the schedule</Link>
      </div>
      <h2>Coming up this week</h2>
      {failed && <p role="alert" className="notice notice-error">We could not load the classes. Please reload the page.</p>}
      {!featured && !failed && <p className="muted">Loading classes…</p>}
      {featured && (
        <ul className="card-list">
          {featured.map((k) => (
            <li key={k.id} className="card">
              <h3>{k.name}</h3>
              <p className="muted">{dayName(k.day)} · {k.start} · {k.teacher}</p>
              <p>{k.style} · {k.level} · {formatUsd(k.priceCents)}</p>
              <Link to={`/classes/${k.id}`} aria-label={`View class ${k.name}`}>View class</Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
