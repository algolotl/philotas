import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyAdsbCoverage } from '../lib/adsb-coverage.js';

const reading = (run, aircraft) => ({ run, probedAt: '2026-08-16', aircraft });

test('every run reading zero is blind', () => {
  // vladivostok: 0, 0, 0. Kuwait was the other reproducible zero across runs 1
  // and 2, and is deliberately NOT the example here — run 3 read it at 1, so it
  // is unmeasured now.
  const { state } = classifyAdsbCoverage([reading('run1', 0), reading('run2', 0), reading('run3', 0)]);
  assert.equal(state, 'blind');
});

test('runs disagreeing about zero is unmeasured, not blind', () => {
  // ningbo: 0 on run 1, 1 on run 2. The whole reason this function exists.
  const { state } = classifyAdsbCoverage([reading('run1', 0), reading('run2', 1)]);
  assert.equal(state, 'unmeasured');
});

test('the order of the runs does not change the verdict', () => {
  assert.equal(classifyAdsbCoverage([reading('run2', 1), reading('run1', 0)]).state, 'unmeasured');
});

test('every run reading above zero is covered', () => {
  // qingdao: 1, 3, 1. Covered on this evidence, and the layer quotes the numbers
  // rather than asserting a threshold the runs cannot support — one aircraft
  // over a major container port is scarcity, and `covered` does not deny it.
  // Shanghai used to be this example and can no longer be: it reads 5, 5, 0.
  const { state } = classifyAdsbCoverage([reading('run1', 1), reading('run2', 3), reading('run3', 1)]);
  assert.equal(state, 'covered');
});

test('a single run never produces a verdict', () => {
  // 53 of 64 candidates have exactly one reading until run 3 lands. Run 1 called
  // ningbo zero-aircraft; publishing that as a finding would have been a false
  // claim about a working port.
  assert.throws(
    () => classifyAdsbCoverage([reading('run2', 0)]),
    /one run is not a measurement/i,
  );
  assert.throws(() => classifyAdsbCoverage([]), /one run is not a measurement/i);
});

test('a reading with no usable count is refused, not guessed at', () => {
  // Failing OPEN was the defect, and it failed open onto the most reassuring
  // verdict available. Measured before the guard: a row with no `aircraft`
  // field at all returned `covered`, because `Math.max(undefined, 0)` is NaN
  // and `NaN === 0` is false in both branches, so control fell through to the
  // bottom. A function whose whole premise is that one run is not enough
  // evidence cannot treat a row it cannot read as more evidence than one run.
  const malformed = [
    [{ run: 'r1', probedAt: '2026-08-16' }, { run: 'r2', probedAt: '2026-08-16', aircraft: 0 }],
    [{ run: 'r1', probedAt: '2026-08-16', aircraft: '0' }, { run: 'r2', probedAt: '2026-08-16', aircraft: 4 }],
    [{ run: 'r1', probedAt: '2026-08-16', aircraft: null }, { run: 'r2', probedAt: '2026-08-16', aircraft: 4 }],
    [{ run: 'r1', probedAt: '2026-08-16', aircraft: 1.5 }, { run: 'r2', probedAt: '2026-08-16', aircraft: 4 }],
    [{ run: 'r1', probedAt: '2026-08-16', aircraft: -1 }, { run: 'r2', probedAt: '2026-08-16', aircraft: 4 }],
    [{ run: 'r1', probedAt: '2026-08-16', aircraft: NaN }, { run: 'r2', probedAt: '2026-08-16', aircraft: 4 }],
  ];
  for (const readings of malformed) {
    assert.throws(
      () => classifyAdsbCoverage(readings),
      /not a measurement/i,
      `${JSON.stringify(readings[0])} should be refused, not classified`,
    );
  }
  // And the guard names the run it could not read, so a bad artefact row is
  // findable rather than just fatal.
  assert.throws(() => classifyAdsbCoverage(malformed[0]), /"r1"/);
});

test('the readings come back with the verdict', () => {
  const readings = [reading('run1', 0), reading('run2', 1)];
  const result = classifyAdsbCoverage(readings);
  assert.deepEqual(result.readings, readings);
});
