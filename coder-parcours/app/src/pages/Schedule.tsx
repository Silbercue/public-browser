import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Link, useSearchParams } from 'react-router';
import { apiGet, formatUsd, type YogaClass } from '../api';
import './booking.css';

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const EVENING_FROM = '17:00';

type Chip = 'Beginner' | 'Vinyasa' | 'Yin' | 'Evening';
const CHIPS: Chip[] = ['Beginner', 'Vinyasa', 'Yin', 'Evening'];
const STYLE_CHIPS: Chip[] = ['Vinyasa', 'Yin'];

/** Style chips widen each other (Vinyasa or Yin); level and time narrow the result. */
function matches(k: YogaClass, on: Set<Chip>): boolean {
  const styles = STYLE_CHIPS.filter((c) => on.has(c));
  if (styles.length && !styles.includes(k.style as Chip)) return false;
  if (on.has('Beginner') && k.level !== 'Beginner') return false;
  if (on.has('Evening') && k.start < EVENING_FROM) return false;
  return true;
}

const spotsLeftLabel = (n: number) => `${n} ${n === 1 ? 'spot' : 'spots'} left`;

export default function Schedule() {
  const [params, setParams] = useSearchParams();
  const [classes, setClasses] = useState<YogaClass[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [on, setOn] = useState<Set<Chip>>(() => new Set());
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  useEffect(() => {
    apiGet<{ classes: YogaClass[] }>('/api/classes').then((d) => setClasses(d.classes), () => setFailed(true));
  }, []);

  const firstOpenDay = classes ? DAYS.find((d) => classes.some((k) => k.day === d && !k.ended)) ?? DAYS[0] : null;
  const asked = params.get('day');
  const day = asked && DAYS.includes(asked) ? asked : firstOpenDay;

  const pickDay = (d: string, focus = false) => {
    setParams({ day: d }, { replace: true });
    if (focus) tabRefs.current[DAYS.indexOf(d)]?.focus();
  };
  const onTabKey = (e: KeyboardEvent, i: number) => {
    const to = e.key === 'ArrowRight' ? (i + 1) % DAYS.length
      : e.key === 'ArrowLeft' ? (i + DAYS.length - 1) % DAYS.length
        : e.key === 'Home' ? 0 : e.key === 'End' ? DAYS.length - 1 : -1;
    if (to < 0) return;
    e.preventDefault();
    pickDay(DAYS[to], true);
  };

  const toggle = (c: Chip) => setOn((prev) => {
    const next = new Set(prev);
    if (next.has(c)) next.delete(c);
    else next.add(c);
    return next;
  });
  const clear = () => setOn(new Set());

  const shown = classes && day ? classes.filter((k) => k.day === day && matches(k, on)).sort((a, b) => a.start.localeCompare(b.start)) : [];

  return (
    <section className="page" data-section="schedule">
      <h1>Schedule</h1>
      {failed && <p role="alert" className="notice notice-error">We could not load the classes. Please reload the page.</p>}
      {!classes && !failed && <p className="muted">Loading classes…</p>}
      {classes && day && (
        <>
          <div role="tablist" aria-label="Day of the week" className="day-tabs">
            {DAYS.map((d, i) => (
              <button
                key={d}
                ref={(el) => { tabRefs.current[i] = el; }}
                type="button"
                role="tab"
                id={`day-tab-${d}`}
                aria-selected={d === day}
                aria-controls="day-panel"
                tabIndex={d === day ? 0 : -1}
                className="day-tab"
                onClick={() => pickDay(d)}
                onKeyDown={(e) => onTabKey(e, i)}
              >
                {d}
              </button>
            ))}
          </div>
          <div className="chips" role="group" aria-label="Filter classes">
            <button type="button" className="chip" aria-pressed={on.size === 0} onClick={clear}>All</button>
            {CHIPS.map((c) => (
              <button key={c} type="button" className="chip" aria-pressed={on.has(c)} onClick={() => toggle(c)}>{c}</button>
            ))}
          </div>
          <div role="tabpanel" id="day-panel" aria-labelledby={`day-tab-${day}`}>
            {shown.length === 0 ? (
              <div className="empty">
                <p>No classes match these filters.</p>
                <button type="button" className="button secondary" onClick={clear}>Clear filters</button>
              </div>
            ) : (
              <ul className="card-list">
                {shown.map((k) => (
                  <li key={k.id} className={k.ended ? 'card class-card ended' : 'card class-card'}>
                    <div className="class-card-head">
                      <h2 className="class-name">{k.name}</h2>
                      {k.ended && <span className="tag tag-ended">Ended</span>}
                      {!k.ended && k.full && <span className="tag tag-full">Full</span>}
                    </div>
                    <p className="muted">{k.start} · {k.durationMin} min · {k.teacher}</p>
                    <p>{k.style} · {k.level} · {formatUsd(k.priceCents)}</p>
                    <p className="muted">{k.ended ? 'This class has ended.' : k.full ? 'No spots left' : spotsLeftLabel(k.spotsLeft)}</p>
                    <Link to={`/classes/${k.id}`} aria-label={`View class ${k.name}`}>View class</Link>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}
    </section>
  );
}
