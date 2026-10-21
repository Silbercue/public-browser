// Completeness of decoy conflicts: every bug that sits at a decoy's station is either named in the decoy's
// conflicts or listed here with the reason it cannot make the decoy's grader ruling wrong. A new bug or decoy
// at a shared station fails this test until somebody decides.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadCatalog } from './load.mjs';

/** "decoy:bug" -> why the bug does not touch what the decoy's grader declares a false alarm. */
const NOT_A_CONFLICT = {
  'D01:P02': 'closing the dialog does not touch the disabled booking button or its note',
  'D01:P06': 'the note stays visible beside the button',
  'D01:P16': 'a full class cannot be booked, so the delayed request never starts',
  'D01:P17': 'reviews failing is unrelated to the full-class button',
  'D02:P03': 'cramped day tabs do not touch ended classes or the opening day',
  'D02:P09': 'overflow on phones does not touch ended classes or the opening day',
  'D02:P10': 'cut names on tablets do not touch ended classes or the opening day',
  'D03:P12': 'the total is not the disabled button or its hint',
  'D03:P13': 'double booking happens after the terms are accepted',
  'D04:P08': 'errors below the button are form errors; the redirect hint is not one',
  'D05:P04': 'touching buttons do not change which dates the dialog lists',
  'D05:P07': 'look-alike buttons do not change which dates the dialog lists',
  'D05:P13': 'double booking is about booking, not about the dates offered by reschedule',
  'D05:P14': 'the expired session empties the list; the reschedule dialog is never reached',
};

test('every bug at a decoy station is a conflict or has a reason', async () => {
  const catalog = await loadCatalog({ publicDir: 'bugs/public' });
  const seen = new Set();
  for (const d of catalog.decoys) {
    for (const b of catalog.bugs.filter((x) => x.stations.includes(d.station))) {
      const pair = `${d.id}:${b.id}`;
      seen.add(pair);
      const conflict = (d.conflicts ?? []).includes(b.id);
      const reason = NOT_A_CONFLICT[pair];
      assert.ok(conflict || reason, `${pair}: neither in conflicts nor in the exception list`);
      assert.ok(!(conflict && reason), `${pair}: listed as conflict and as exception`);
    }
  }
  for (const pair of Object.keys(NOT_A_CONFLICT)) assert.ok(seen.has(pair), `${pair}: exception for a pair that no longer shares a station`);
});

test('the login decoy conflicts with the session trap although they sit at different stations', async () => {
  const catalog = await loadCatalog({ publicDir: 'bugs/public' });
  const d04 = catalog.decoys.find((d) => d.id === 'D04');
  assert.ok(d04.conflicts.includes('P14'));
  const p14 = catalog.bugs.find((b) => b.id === 'P14');
  assert.ok(!p14.stations.includes(d04.station)); // the pair is not found by the station rule: it is listed by hand
});
