import test from 'node:test';
import assert from 'node:assert/strict';
import { parseField, clampSnap } from '../src/fields.js';

const pct = { min: 0, max: 1, step: 0.01, percent: true };

test('percent sliders take "55%", "55" or "0.55"', () => {
  assert.equal(parseField('55%', pct), 0.55);
  assert.equal(parseField('55', pct), 0.55);
  assert.equal(parseField('0.55', pct), 0.55);
  assert.equal(parseField(' 100 % ', pct), 1);
  assert.equal(parseField('150%', pct), 1, 'clamped');
  assert.equal(parseField('Off', pct), 0);
  assert.equal(parseField('1', pct), 1, '1 is the top of the range, not 1%');
});

test('units from the labels are ignored; values clamp and snap', () => {
  assert.equal(parseField('1.5 cells', { min: 0.5, max: 6, step: 0.5 }), 1.5);
  assert.equal(parseField('1.7', { min: 0.5, max: 6, step: 0.5 }), 1.5);
  assert.equal(parseField('8 px', { min: 1, max: 16, step: 1 }), 8);
  assert.equal(parseField('4×', { min: 1, max: 16, step: 1 }), 4);
  assert.equal(parseField('24 fps', { min: 1, max: 60, step: 1 }), 24);
  assert.equal(parseField('99 fps', { min: 1, max: 60, step: 1 }), 60);
  assert.equal(parseField('391', { min: 32, max: 1280, step: 2 }), 392);
  assert.equal(parseField('-20', { min: -100, max: 100, step: 1 }), -20);
  assert.equal(parseField('+20', { min: -100, max: 100, step: 1 }), 20);
  assert.equal(parseField('1,25', { min: 0.2, max: 3, step: 0.01 }), 1.25);
  assert.equal(parseField('3 → 27 colours', { min: 2, max: 6, step: 1 }), 3);
});

test('levels read "1-bit", "2 bit" and "4 levels"', () => {
  const lv = { min: 2, max: 8, step: 1 };
  assert.equal(parseField('1-bit', lv), 2);
  assert.equal(parseField('2 bit', lv), 4);
  assert.equal(parseField('4 levels', lv), 4);
});

test('nonsense is rejected', () => {
  for (const bad of ['', '   ', 'abc', 'px', '--3']) assert.equal(parseField(bad, pct), null, bad);
});

test('clampSnap keeps step precision clean', () => {
  assert.equal(clampSnap(0.1 + 0.2, { min: 0, max: 1, step: 0.01 }), 0.3);
  assert.equal(clampSnap(1.004, { min: 0.2, max: 3, step: 0.01 }), 1);
  assert.equal(clampSnap(NaN, { min: 0, max: 1 }), null);
});
