// JSON client for the studio API. Errors arrive as { error, message } and are thrown as ApiError.

export class ApiError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

export type User = { name: string; email: string };

export type YogaClass = {
  id: string; name: string; style: string; level: string; teacher: string; day: string; start: string;
  durationMin: number; priceCents: number; currency: string; capacity: number; spotsLeft: number;
  full: boolean; ended: boolean; description: string;
};

export type Booking = { id: string; classId: string; spots: number; reference: string; class: YogaClass };

export type Cart = {
  items: Array<{ id: string; classId: string; name: string; style: string; day: string; start: string; teacher: string;
    spots: number; priceCents: number; lineCents: number }>;
  count: number; coupon: string | null; subtotalCents: number; discountCents: number; totalCents: number; currency: string;
};

const NETWORK_MESSAGE = 'We could not reach the studio. Check your connection and try again.';

type Listener = () => void;
const expiredListeners = new Set<Listener>();
const cartListeners = new Set<Listener>();

/** Called on every 401 session_expired, before the error is thrown to the caller. */
export function onSessionExpired(fn: Listener): () => void {
  expiredListeners.add(fn);
  return () => { expiredListeners.delete(fn); };
}

/** Pages that change the cart call this so the header count follows. */
export function notifyCartChanged(): void {
  for (const fn of cartListeners) fn();
}
export function onCartChanged(fn: Listener): () => void {
  cartListeners.add(fn);
  return () => { cartListeners.delete(fn); };
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: body === undefined ? { Accept: 'application/json' } : { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, 'network', NETWORK_MESSAGE);
  }
  const text = await res.text();
  let data: any = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = null; }
  }
  if (!res.ok) {
    const code = data && typeof data.error === 'string' ? data.error : 'http_' + res.status;
    const message = data && typeof data.message === 'string' ? data.message : 'Something went wrong. Please try again.';
    if (res.status === 401 && code === 'session_expired') for (const fn of expiredListeners) fn();
    throw new ApiError(res.status, code, message);
  }
  return data as T;
}

export function apiGet<T = any>(path: string): Promise<T> {
  return request<T>('GET', path);
}

export function apiSend<T = any>(method: 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<T> {
  return request<T>(method, path, body ?? {});
}

/** 2200 -> "$22.00", 1950 -> "$19.50". */
export function formatUsd(cents: number): string {
  return '$' + (cents / 100).toFixed(2);
}

const DAY_NAMES: Record<string, string> = {
  Mon: 'Monday', Tue: 'Tuesday', Wed: 'Wednesday', Thu: 'Thursday', Fri: 'Friday', Sat: 'Saturday', Sun: 'Sunday',
};
export function dayName(day: string): string {
  return DAY_NAMES[day] ?? day;
}

export const spotsLabel = (n: number) => `${n} ${n === 1 ? 'spot' : 'spots'}`;

/** Only same-site paths are allowed as `?next=` targets. */
export function safeNext(next: string | null | undefined): string {
  if (!next || !next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\')) return '/';
  if (next === '/login' || next.startsWith('/login?') || next === '/register') return '/';
  return next;
}
