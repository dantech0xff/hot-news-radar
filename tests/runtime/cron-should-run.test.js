import test from 'node:test';
import assert from 'node:assert/strict';

import { shouldRun, validateCronExpression } from '../../src/channels/runner.js';

const at = iso => new Date(iso);

test('a bare 7 in the minute field does not match minute 0', () => {
  assert.equal(shouldRun('7 * * * *', at('2026-10-03T05:00:00.000Z')), false);
  assert.equal(shouldRun('7 * * * *', at('2026-10-03T05:07:00.000Z')), true);
  assert.equal(shouldRun('7,30 * * * *', at('2026-10-03T05:00:00.000Z')), false);
  assert.equal(shouldRun('7,30 * * * *', at('2026-10-03T05:30:00.000Z')), true);
});

test('a bare 7 in the hour field does not match midnight', () => {
  assert.equal(shouldRun('0 7 * * *', at('2026-10-03T00:00:00.000Z')), false);
  assert.equal(shouldRun('0 7 * * *', at('2026-10-03T07:00:00.000Z')), true);
  // The default Telegram/Facebook schedule used to fire at 00:00 as well.
  assert.equal(shouldRun('0 1,7,13 * * *', at('2026-10-03T00:00:00.000Z')), false);
  assert.equal(shouldRun('0 1,7,13 * * *', at('2026-10-03T07:00:00.000Z')), true);
  assert.equal(shouldRun('0 1,7,13 * * *', at('2026-10-03T13:00:00.000Z')), true);
});

test('the hour field is matched in the channel timezone', () => {
  // 07:00 and 00:00 in Asia/Singapore (UTC+8).
  assert.equal(shouldRun('0 7 * * *', at('2026-10-02T23:00:00.000Z'), 'Asia/Singapore'), true);
  assert.equal(shouldRun('0 7 * * *', at('2026-10-02T16:00:00.000Z'), 'Asia/Singapore'), false);
});

test('7 still means Sunday in the day-of-week field', () => {
  const sunday = at('2026-10-04T09:00:00.000Z');
  const monday = at('2026-10-05T09:00:00.000Z');
  assert.equal(validateCronExpression('0 9 * * 7'), true);
  assert.equal(shouldRun('0 9 * * 7', sunday), true);
  assert.equal(shouldRun('0 9 * * 0', sunday), true);
  assert.equal(shouldRun('0 9 * * 7', monday), false);
  assert.equal(shouldRun('0 9 * * 1,7', sunday), true);
  assert.equal(shouldRun('0 9 * * 1,7', monday), true);
  assert.equal(shouldRun('0 9 * * 1,7', at('2026-10-03T09:00:00.000Z')), false, 'Saturday');
});

test('the production schedule 0 0-17 * * * is unchanged', () => {
  const schedule = '0 0-17 * * *';
  for (const hour of [0, 7, 9, 17]) {
    assert.equal(shouldRun(schedule, at(`2026-10-03T${String(hour).padStart(2, '0')}:00:00.000Z`)), true, `${hour}:00`);
  }
  for (const time of ['18:00', '23:00', '00:30', '07:07']) {
    assert.equal(shouldRun(schedule, at(`2026-10-03T${time}:00.000Z`)), false, time);
  }
});
