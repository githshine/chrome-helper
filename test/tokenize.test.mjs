/**
 * Node runner (optional): `node --test test/`
 * The same cases also run in the browser via test/browser.html.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { cases } from './cases.mjs';

const t = {
  ok: (value, message) => assert.ok(value, message),
  equal: (actual, expected, message) => assert.equal(actual, expected, message),
  deepEqual: (actual, expected, message) => assert.deepEqual(actual, expected, message)
};

for (const testCase of cases) {
  test(testCase.name, () => testCase.run(t));
}
