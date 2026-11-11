import test from 'node:test';
import assert from 'node:assert/strict';
import { normalise, addClip, removeClip, setIn, setOut, clipTime, clipFileName, parseTime, parseRange } from '../src/clips.js';

test('normalise clamps to the video and rejects empty ranges', () => {
  assert.deepEqual(normalise({ start: -1, end: 99 }, 10), { start: 0, end: 10 });
  assert.deepEqual(normalise({ start: 1.2344, end: 2.3456 }, 10), { start: 1.234, end: 2.346 });
  assert.deepEqual(normalise({ start: 2, end: '' }, 10), { start: 2, end: 10 });
  assert.throws(() => normalise({ start: 5, end: 5 }, 10));
  assert.throws(() => normalise({ start: 6, end: 5 }, 10));
  assert.throws(() => normalise({ start: 9.995, end: 10 }, 10));
  assert.deepEqual(normalise({ start: 9.98, end: 10 }, 10), { start: 9.98, end: 10 });
});

test('clips stay sorted, without exact duplicates', () => {
  let c = [];
  c = addClip(c, { start: 5, end: 7 }, 10);
  c = addClip(c, { start: 1, end: 2 }, 10);
  c = addClip(c, { start: 5, end: 6 }, 10);
  c = addClip(c, { start: 1, end: 2 }, 10);
  assert.deepEqual(c, [{ start: 1, end: 2 }, { start: 5, end: 6 }, { start: 5, end: 7 }]);
  assert.deepEqual(removeClip(c, 1), [{ start: 1, end: 2 }, { start: 5, end: 7 }]);
  assert.throws(() => addClip(c, { start: 3, end: 3 }, 10));
});

test('setting In past Out (or Out before In) moves the other edge', () => {
  assert.deepEqual(setIn({ start: 0, end: 4 }, 2, 10), { start: 2, end: 4 });
  assert.deepEqual(setIn({ start: 0, end: 4 }, 6, 10), { start: 6, end: 10 });
  assert.deepEqual(setOut({ start: 3, end: 10 }, 5, 10), { start: 3, end: 5 });
  assert.deepEqual(setOut({ start: 3, end: 10 }, 1, 10), { start: 0, end: 1 });
});

test('times and file names', () => {
  assert.equal(clipTime(3.25), '0:03.250');
  assert.equal(clipTime(75.5), '1:15.500');
  assert.equal(clipTime(59.9996), '1:00.000');
  assert.equal(clipTime(3723.25), '1:02:03.250');
  assert.equal(clipFileName('trip', 0, 1, 'ascii', 'gif'), 'trip-ascii.gif');
  assert.equal(clipFileName('trip', 2, 12, 'dither', 'mp4'), 'trip-clip03-dither.mp4');
});

test('reading times and ranges', () => {
  assert.equal(parseTime('83.25'), 83.25);
  assert.equal(parseTime('1:23.250'), 83.25);
  assert.equal(parseTime('1:01:23.2504'), 3683.25);
  assert.equal(parseTime('.5'), 0.5);
  for (const bad of ['', 'abc', '1:2:3:4', '-1', '1:-2']) assert.throws(() => parseTime(bad), bad);
  assert.deepEqual(parseRange('0:01.250-0:02.500'), { start: 1.25, end: 2.5 });
  assert.deepEqual(parseRange('1.25 – 2.5'), { start: 1.25, end: 2.5 });
  assert.deepEqual(parseRange('1:00..1:05.125'), { start: 60, end: 65.125 });
  assert.deepEqual(parseRange('3 to 4'), { start: 3, end: 4 });
  assert.throws(() => parseRange('3'));
  for (const t of [0, 1.001, 59.999, 61.5, 3599.999, 3723.25]) assert.equal(parseTime(clipTime(t)), t, `round trip ${t}`);
});
