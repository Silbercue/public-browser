import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import { ApiError, apiGet, apiSend, onCartChanged, onSessionExpired, type Cart, type User } from '../api';
import ReportButton from './ReportButton';

const USER_KEY = 'sw_user';

function readHint(): User | null {
  try {
    const raw = localStorage.getItem(USER_KEY);
    const u = raw ? JSON.parse(raw) : null;
    return u && typeof u.name === 'string' && typeof u.email === 'string' ? u : null;
  } catch {
    return null;
  }
}
function writeHint(u: User | null) {
  try {
    if (u) localStorage.setItem(USER_KEY, JSON.stringify(u));
    else localStorage.removeItem(USER_KEY);
  } catch { /* storage blocked: the header falls back to "Log in" after a reload */ }
}

type Session = {
  /** undefined while the stored login is being checked */
  user: User | null | undefined;
  signedIn: (u: User) => void;
  /** Handles 401s of a page request; true when the error was a login problem and is taken care of. */
  handleAuthError: (err: unknown) => boolean;
  /** Sends the visitor to the login page and back here afterwards. */
  goToLogin: () => void;
};

const SessionContext = createContext<Session | null>(null);

export function useSession(): Session {
  const s = useContext(SessionContext);
  if (!s) throw new Error('useSession outside Layout');
  return s;
}

/** For pages behind a login: redirects when nobody is logged in, returns the user once known. */
export function useRequireUser(): User | null | undefined {
  const { user, goToLogin } = useSession();
  const { pathname } = useLocation();
  useEffect(() => {
    if (user === null && pathname !== '/login') goToLogin();
  }, [user, pathname, goToLogin]);
  return user;
}

const loginPath = (loc: { pathname: string; search: string }) => `/login?next=${encodeURIComponent(loc.pathname + loc.search)}`;

export default function Layout() {
  const location = useLocation();
  const navigate = useNavigate();
  const locRef = useRef(location);
  locRef.current = location;

  const [hint] = useState(readHint);
  const [user, setUser] = useState<User | null | undefined>(hint ? undefined : null);
  const [expired, setExpired] = useState(false);
  const [cartCount, setCartCount] = useState(0);
  const [menuOpen, setMenuOpen] = useState(false);

  const goToLogin = useCallback(() => {
    navigate(loginPath(locRef.current), { replace: true });
  }, [navigate]);

  const signedIn = useCallback((u: User) => {
    writeHint(u);
    setUser(u);
    setExpired(false);
  }, []);

  const signedOut = useCallback(() => {
    writeHint(null);
    setUser(null);
  }, []);

  useEffect(() => onSessionExpired(() => {
    signedOut();
    setExpired(true);
    if (locRef.current.pathname !== '/login') navigate(loginPath(locRef.current));
  }), [navigate, signedOut]);

  // A stored login is checked once on start; a login that is gone server side just logs the header out.
  useEffect(() => {
    if (!hint) return;
    apiGet<User>('/api/me').then(signedIn, (err) => {
      if (err instanceof ApiError && err.status === 401) signedOut();
      else setUser(hint);
    });
  }, [hint, signedIn, signedOut]);

  const refreshCart = useCallback(() => {
    apiGet<Cart>('/api/cart').then((c) => setCartCount(c.count), () => { /* keep the last count */ });
  }, []);
  useEffect(() => onCartChanged(refreshCart), [refreshCart]);
  useEffect(() => {
    refreshCart();
    setMenuOpen(false);
  }, [location.pathname, refreshCart, user]);

  const handleAuthError = useCallback((err: unknown) => {
    if (!(err instanceof ApiError) || err.status !== 401) return false;
    if (err.code === 'login_required') {
      signedOut();
      goToLogin();
    }
    return true; // session_expired: the listener above already redirected
  }, [goToLogin, signedOut]);

  const logout = async () => {
    try { await apiSend('POST', '/api/auth/logout'); } catch { /* cookie may already be gone */ }
    signedOut();
    setExpired(false);
    navigate('/');
  };

  const session = useMemo<Session>(() => ({ user, signedIn, handleAuthError, goToLogin }), [user, signedIn, handleAuthError, goToLogin]);

  const navClass = ({ isActive }: { isActive: boolean }) => (isActive ? 'nav-link active' : 'nav-link');

  return (
    <SessionContext.Provider value={session}>
      <a className="skip-link" href="#main">Skip to content</a>
      <header className="site-header">
        <div className="header-inner">
          <Link to="/" className="logo">Stillwater Yoga</Link>
          <button
            type="button"
            className="menu-button"
            aria-expanded={menuOpen}
            aria-controls="site-nav"
            onClick={() => setMenuOpen((o) => !o)}
          >
            Menu
          </button>
          <nav id="site-nav" aria-label="Main" className={menuOpen ? 'site-nav open' : 'site-nav'}>
            <NavLink to="/schedule" className={navClass}>Schedule</NavLink>
            <NavLink to="/bookings" className={navClass}>My bookings</NavLink>
            <NavLink to="/profile" className={navClass}>Profile</NavLink>
            <NavLink to="/cart" className={navClass}>{`Cart (${cartCount})`}</NavLink>
          </nav>
          <div className="auth">
            {user ? (
              <button type="button" className="button secondary" onClick={logout}>Log out</button>
            ) : (
              <Link
                to={location.pathname === '/login' ? `/login${location.search}` : loginPath(location)}
                className="button secondary"
              >
                Log in
              </Link>
            )}
          </div>
        </div>
      </header>
      <main id="main" className="site-main">
        {expired && (
          <p className="notice notice-warning" role="alert">Your session expired. Please log in again.</p>
        )}
        <Outlet />
      </main>
      <footer className="site-footer">
        <p>Stillwater Yoga · 12 Harbor Lane · Open daily 7:00–21:00</p>
      </footer>
      <ReportButton />
    </SessionContext.Provider>
  );
}
