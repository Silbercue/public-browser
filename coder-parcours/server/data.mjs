// Seed data of the Stillwater Yoga studio: one week of classes, reviews, test accounts, Maya's bookings.
import { TEST_ACCOUNTS } from '../shared/accounts.mjs';

export const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** Fixed studio clock: classes that start before Wednesday 10:00 have ended. */
export const STUDIO_CLOCK = { day: 'Wed', time: '10:00' };

/**
 * @typedef {{ author: string, rating: number, text: string }} Review
 * @typedef {{ id: string, name: string, style: 'Vinyasa'|'Yin'|'Hatha'|'Power', level: 'Beginner'|'All levels'|'Advanced',
 *   teacher: string, day: string, start: string, durationMin: number, priceCents: number, capacity: number,
 *   booked: number, description: string, reviews: Review[] }} YogaClass
 *   booked: spots taken at start, including Maya's bookings below.
 */

const REVIEW_POOL = [
  { author: 'Priya S.', rating: 5, text: 'Calm room, clear cues, I left feeling taller.' },
  { author: 'Daniel K.', rating: 4, text: 'Good pace. The mats near the window get a bit cold.' },
  { author: 'Hannah W.', rating: 5, text: 'The teacher remembered my name after one class.' },
  { author: 'Luis M.', rating: 3, text: 'Nice class, but it filled up quickly and felt crowded.' },
  { author: 'Grace O.', rating: 5, text: 'Exactly the reset I needed after work.' },
  { author: 'Ben T.', rating: 4, text: 'Challenging in a good way. Bring water.' },
  { author: 'Aiko N.', rating: 4, text: 'Lovely music and plenty of options for tight hips.' },
];

/** @type {Array<Omit<YogaClass, 'reviews'>>} */
const RAW = [
  { id: 'c01', name: 'Morning Vinyasa Flow', style: 'Vinyasa', level: 'All levels', teacher: 'Lena Park', day: 'Mon', start: '07:00', durationMin: 60, priceCents: 2200, capacity: 16, booked: 11, description: 'A steady flow to wake up the whole body before work.' },
  { id: 'c02', name: 'Yin Unwind', style: 'Yin', level: 'Beginner', teacher: 'Tom Reyes', day: 'Mon', start: '18:30', durationMin: 75, priceCents: 1800, capacity: 14, booked: 9, description: 'Long, quiet holds that release hips and lower back.' },
  { id: 'c03', name: 'Power Hour', style: 'Power', level: 'Advanced', teacher: 'Jade Kim', day: 'Tue', start: '07:00', durationMin: 60, priceCents: 2600, capacity: 12, booked: 10, description: 'Strong standing sequences, arm balances and a lot of sweat.' },
  { id: 'c04', name: 'Hatha Basics', style: 'Hatha', level: 'Beginner', teacher: 'Priya Nair', day: 'Tue', start: '18:00', durationMin: 60, priceCents: 2000, capacity: 18, booked: 12, description: 'The classic postures, slowly and with clear alignment cues.' },
  { id: 'c05', name: 'Sunrise Vinyasa', style: 'Vinyasa', level: 'Beginner', teacher: 'Lena Park', day: 'Wed', start: '07:00', durationMin: 60, priceCents: 2000, capacity: 16, booked: 8, description: 'Gentle sun salutations for people new to flowing yoga.' },
  { id: 'c06', name: 'Lunch Break Hatha', style: 'Hatha', level: 'All levels', teacher: 'Priya Nair', day: 'Wed', start: '12:15', durationMin: 45, priceCents: 1900, capacity: 15, booked: 6, description: 'A compact class that fits into a lunch break.' },
  { id: 'c07', name: 'Deep Yin', style: 'Yin', level: 'All levels', teacher: 'Tom Reyes', day: 'Wed', start: '18:30', durationMin: 75, priceCents: 2100, capacity: 20, booked: 13, description: 'Slow, supported poses with bolsters and blankets.' },
  { id: 'c08', name: 'Vinyasa Strength', style: 'Vinyasa', level: 'Advanced', teacher: 'Jade Kim', day: 'Thu', start: '07:30', durationMin: 60, priceCents: 2400, capacity: 14, booked: 9, description: 'Flowing sequences with longer holds to build strength.' },
  { id: 'c09', name: 'Power Flow', style: 'Power', level: 'All levels', teacher: 'Marco Silva', day: 'Thu', start: '19:00', durationMin: 60, priceCents: 2500, capacity: 12, booked: 12, description: 'Fast transitions and core work, scaled for every level.' },
  { id: 'c10', name: 'Gentle Hatha', style: 'Hatha', level: 'Beginner', teacher: 'Priya Nair', day: 'Fri', start: '09:00', durationMin: 60, priceCents: 1800, capacity: 18, booked: 7, description: 'Soft movement and breathing, good for stiff mornings.' },
  { id: 'c11', name: 'Yin and Breath', style: 'Yin', level: 'Beginner', teacher: 'Tom Reyes', day: 'Fri', start: '18:00', durationMin: 75, priceCents: 2000, capacity: 16, booked: 7, description: 'Yin postures paired with simple breathing practice.' },
  { id: 'c12', name: 'Weekend Vinyasa', style: 'Vinyasa', level: 'All levels', teacher: 'Lena Park', day: 'Sat', start: '09:30', durationMin: 75, priceCents: 2300, capacity: 20, booked: 14, description: 'A playful, longer flow to start the weekend.' },
  { id: 'c13', name: 'Power Core', style: 'Power', level: 'Advanced', teacher: 'Marco Silva', day: 'Sat', start: '11:30', durationMin: 60, priceCents: 2600, capacity: 12, booked: 12, description: 'Core-focused power yoga with plank and twist variations.' },
  { id: 'c14', name: 'Sunday Slow Hatha', style: 'Hatha', level: 'All levels', teacher: 'Ana Costa', day: 'Sun', start: '10:00', durationMin: 60, priceCents: 2200, capacity: 16, booked: 10, description: 'Unhurried postures and a long relaxation at the end.' },
];

/** @type {YogaClass[]} */
export const CLASSES = RAW.map((k, i) => ({
  ...k,
  reviews: [0, 1, 2].map((j) => REVIEW_POOL[(i * 3 + j) % REVIEW_POOL.length]),
}));

/** Maya's two upcoming bookings (already counted in `booked`). */
export const MAYA_BOOKINGS = [
  { id: 'b1', classId: 'c08', spots: 1, reference: 'SW-7KQ2' },
  { id: 'b2', classId: 'c11', spots: 2, reference: 'SW-M4TA' },
];

/**
 * Whether a class lies before the studio clock.
 * @param {{ day: string, start: string }} k
 * @returns {boolean}
 */
export function isEnded(k) {
  const d = DAYS.indexOf(k.day);
  const now = DAYS.indexOf(STUDIO_CLOCK.day);
  return d < now || (d === now && k.start < STUDIO_CLOCK.time);
}

/**
 * A fresh, independent copy of all seed data for one sandbox.
 * @returns {{ classes: YogaClass[], accounts: Array<{ id: string, email: string, password: string, name: string,
 *   phone: string, settings: { emailReminders: boolean, newsletter: boolean } }>,
 *   bookings: Array<{ id: string, accountId: string, classId: string, spots: number, reference: string }> }}
 */
export function createInitialData() {
  const accounts = TEST_ACCOUNTS.map((a, i) => ({
    id: `a${i + 1}`, email: a.email, password: a.password, name: a.name, phone: '',
    settings: { emailReminders: true, newsletter: false },
  }));
  return {
    classes: CLASSES.map((k) => ({ ...k, reviews: k.reviews.map((r) => ({ ...r })) })),
    accounts,
    bookings: MAYA_BOOKINGS.map((b) => ({ ...b, accountId: 'a1' })),
  };
}
