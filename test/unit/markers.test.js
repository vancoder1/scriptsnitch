import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readMarker, writeMarker, fitStatusState } from '../../src/report/markers.js';
import { emptyStatusState } from '../../src/state.js';

test('round-trips a marker', () => {
  const data = { v: 1, url: 'https://x.example/a.js?q=--><script>', note: 'ünïcode ✓', n: [1, 2] };
  const body = writeMarker('Hello', 'status', data);
  assert.match(body, /^<!-- scriptsnitch:status \{/);
  assert.ok(!body.slice(0, body.indexOf(' -->') + 4).slice(4, -4).includes('-->'), 'the JSON cannot end the comment early');
  assert.deepEqual(readMarker(body, 'status'), data);
  assert.ok(body.endsWith('Hello'));
});

test('writeMarker replaces an existing marker and readMarker ignores others', () => {
  const once = writeMarker('text', 'site', { a: 1 });
  const twice = writeMarker(once, 'site', { a: 2 });
  assert.equal(twice.match(/scriptsnitch:site/g).length, 1);
  assert.deepEqual(readMarker(twice, 'site'), { a: 2 });
  assert.equal(readMarker(twice, 'status'), null);
  assert.equal(readMarker('<!-- scriptsnitch:site {not json -->', 'site'), null);
  assert.equal(readMarker(null, 'site'), null);
});

test('keeps the status marker under 60000 characters by dropping sightings first, then log lines', () => {
  const big = emptyStatusState();
  big.run = 900;
  for (let r = 1; r <= 900; r++) big.log.push([`2026-0${1 + (r % 9)}-01`, 12, 0, 1, null]);
  for (let i = 0; i < 1500; i++) big.sightings[`new-destination|https://host-${i}.example.test/some/long/path/to/make/it/large|*`] = [895 + (i % 5), 899];
  const before = JSON.stringify(big).length;
  assert.ok(before > 60000);
  const fitted = fitStatusState(big, 60000);
  assert.ok(JSON.stringify(fitted).length <= 60000);
  assert.ok(Object.keys(fitted.sightings).length < 1500 && Object.keys(fitted.sightings).length > 0, 'only as many as needed go');
  assert.equal(fitted.log.length, 900, 'log lines stay while sightings can still go');
  const oldest = Math.min(...Object.values(fitted.sightings).flat());
  assert.ok(oldest >= 896, 'the oldest sightings went first');

  const logHeavy = emptyStatusState();
  for (let r = 1; r <= 3000; r++) logHeavy.log.push([`2026-01-${String(1 + (r % 28)).padStart(2, '0')}`, 12, 1, 2, 'pass']);
  logHeavy.sightings['k|x|*'] = [1];
  const f2 = fitStatusState(logHeavy, 60000);
  assert.deepEqual(f2.sightings, {});
  assert.ok(f2.log.length < 3000 && f2.log.length > 0);
  assert.deepEqual(f2.log.at(-1), logHeavy.log.at(-1), 'the newest log lines are kept');
  assert.equal(JSON.stringify(fitStatusState(emptyStatusState())), JSON.stringify(emptyStatusState()));
});
