import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateBug, validateDecoy, widthClassForPx, CATEGORIES, STATIONS, WIDTHS, SEVERITIES } from './schema.mjs';

/** @returns {any} */
function bug(over = {}) {
  return {
    id: 'P01',
    category: 'fiddly',
    title: 'Tiny remove button',
    stations: ['cart'],
    widths: ['phone'],
    severity: 'medium',
    symptom: 'The remove button is hard to hit.',
    grader: 'Counts if the report names the cart remove button on phone.',
    client: { css: () => '' },
    ...over,
  };
}

const has = (problems, re) => problems.some((p) => re.test(p));

test('lists match the brief', () => {
  assert.deepEqual(CATEGORIES, ['fiddly', 'next-step', 'layout', 'function', 'timing', 'background']);
  assert.equal(STATIONS.length, 10);
  assert.deepEqual(SEVERITIES, ['low', 'medium', 'high']);
  assert.equal(WIDTHS.phone.px, 390);
  assert.equal(WIDTHS.tablet.media, '(min-width: 601px) and (max-width: 1100px)');
  assert.equal(WIDTHS.desktop.media, '(min-width: 1101px)');
});

test('validateBug accepts a valid client bug and a valid server bug', () => {
  assert.deepEqual(validateBug(bug()), []);
  assert.deepEqual(validateBug(bug({ client: undefined, widths: ['all'], server: { setup: () => {} } })), []);
});

test('validateBug flags id, lists, empty texts and missing client/server', () => {
  assert.ok(has(validateBug(bug({ id: 'p1' })), /id/));
  assert.ok(has(validateBug(bug({ category: 'ugly' })), /category/));
  assert.ok(has(validateBug(bug({ stations: ['kitchen'] })), /station/));
  assert.ok(has(validateBug(bug({ stations: [] })), /station/));
  assert.ok(has(validateBug(bug({ widths: ['watch'] })), /width/));
  assert.ok(has(validateBug(bug({ widths: [] })), /width/));
  assert.ok(has(validateBug(bug({ severity: 'huge' })), /severity/));
  assert.ok(has(validateBug(bug({ symptom: '  ' })), /symptom/));
  assert.ok(has(validateBug(bug({ grader: '' })), /grader/));
  assert.ok(has(validateBug(bug({ client: undefined })), /client or server/));
  assert.ok(has(validateBug(null), /object/));
});

test('validateBug: server part requires widths all', () => {
  const p = validateBug(bug({ server: { setup: () => {} }, widths: ['phone'] }));
  assert.ok(has(p, /server.*all/), p.join('|'));
  assert.deepEqual(validateBug(bug({ server: { setup: () => {} }, widths: ['all'] })), []);
});

test('validateBug: roles.change and roles.capture require widths all', () => {
  const c = validateBug(bug({ category: 'function', roles: { change: { feature: 'Coupon codes now apply.' } } }));
  assert.ok(has(c, /roles\.change.*all/), c.join('|'));
  const f = validateBug(bug({ category: 'function', roles: { capture: { flow: 'Apply YOGA10.' } } }));
  assert.ok(has(f, /roles\.capture.*all/), f.join('|'));
  assert.deepEqual(validateBug(bug({ category: 'function', widths: ['all'], roles: { change: { feature: 'x' }, capture: { flow: 'y' } } })), []);
});

test('validateBug: roles.trap only for timing', () => {
  const trap = { trap: { reached: 'first click', passed: 'second click' } };
  assert.ok(has(validateBug(bug({ roles: trap })), /trap.*timing/));
  assert.deepEqual(validateBug(bug({ category: 'timing', roles: trap })), []);
});

test('validateBug: removesDecoys only decoy ids', () => {
  assert.ok(has(validateBug(bug({ removesDecoys: ['x'] })), /removesDecoys/));
  assert.ok(has(validateBug(bug({ removesDecoys: 'D01' })), /removesDecoys/));
  assert.deepEqual(validateBug(bug({ removesDecoys: ['D01', 'D12'] })), []);
  assert.deepEqual(validateBug(bug({ removesDecoys: [] })), []);
});

test('validateBug: source is reserved for loadCatalog', () => {
  assert.ok(has(validateBug(bug({ source: 'public' })), /source/));
});

test('validateDecoy', () => {
  const d = { id: 'D01', station: 'cart', title: 'Price updates after a second', grader: 'Expected behaviour.' };
  assert.deepEqual(validateDecoy(d), []);
  assert.deepEqual(validateDecoy({ ...d, conflicts: ['F01', 'P17'] }), []);
  assert.ok(has(validateDecoy({ ...d, conflicts: ['x'] }), /conflicts/));
  assert.ok(has(validateDecoy({ ...d, id: 'P01' }), /id/));
  assert.ok(has(validateDecoy({ ...d, station: 'moon' }), /station/));
  assert.ok(has(validateDecoy({ ...d, title: '' }), /title/));
  assert.ok(has(validateDecoy({ ...d, grader: '' }), /grader/));
});

test('widthClassForPx follows the media queries', () => {
  assert.equal(widthClassForPx(320), 'phone');
  assert.equal(widthClassForPx(375), 'phone');
  assert.equal(widthClassForPx(600), 'phone');
  assert.equal(widthClassForPx(601), 'tablet');
  assert.equal(widthClassForPx(1100), 'tablet');
  assert.equal(widthClassForPx(1101), 'desktop');
  assert.equal(widthClassForPx(1440), 'desktop');
});

test("validateBug: width 'all' must stand alone", () => {
  assert.ok(has(validateBug(bug({ widths: ['all', 'phone'] })), /'all' must stand alone/));
  assert.ok(has(validateBug(bug({ widths: ['phone', 'all'] })), /'all' must stand alone/));
  assert.deepEqual(validateBug(bug({ widths: ['all'] })), [], 'Gegenprobe: all alone is fine');
  assert.deepEqual(validateBug(bug({ widths: ['phone', 'tablet'] })), [], 'Gegenprobe: several concrete widths are fine');
});

test('validateBug: a client part needs css or setup, and both must be functions', () => {
  assert.ok(has(validateBug(bug({ client: {} })), /client needs css or setup/));
  assert.ok(has(validateBug(bug({ client: { css: 'a { }' } })), /client\.css must be a function/));
  assert.ok(has(validateBug(bug({ client: { setup: 'x' } })), /client\.setup must be a function/));
  assert.ok(has(validateBug(bug({ client: 'css' })), /client must be an object/));
  assert.deepEqual(validateBug(bug({ client: { css: () => '' } })), []);
  assert.deepEqual(validateBug(bug({ client: { setup: () => {} } })), [], 'setup alone is enough');
  assert.deepEqual(validateBug(bug({ client: { css: () => '', setup: () => {} } })), []);
});
