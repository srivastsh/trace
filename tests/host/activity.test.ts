import { describe, expect, it } from 'vitest';
import type { ActivitySnapshot, Metric } from '../../src/contracts';
import { contextAssessment, quotaDeadline } from '../../src/host/activity';

const now = 1700000000000;
const metric = (value: number): Metric => ({
  value, status: 'reported', sourceField: 'usage.input', sourceKind: 'server-reported',
  observedAt: now, adapterVersion: 'fixture', endpoint: 'conversation',
});
const base: ActivitySnapshot = {
  state: 'reported', adapterVersion: 'fixture', comparable: false, quotas: [],
};

describe('ACT-02 context display', () => {
  it('keeps zero and displays percentages only for comparable metrics', () => {
    const report = { ...base, input: metric(0), effectiveWindow: metric(200) };
    expect(contextAssessment(report)).toEqual({ kind: 'unknown' });
    expect(contextAssessment({ ...report, comparable: true })).toEqual({
      kind: 'comparable', input: 0, limit: 200, percentage: 0,
    });
    expect(contextAssessment({ ...base, input: metric(150), catalogMaximum: metric(200), comparable: true }))
      .toEqual({ kind: 'unknown' });
  });

  it('retains conflicting counts and rejects prior reply counters during a stream', () => {
    const report: ActivitySnapshot = {
      ...base, input: metric(250), effectiveWindow: metric(200), comparableReason: 'Conflicting reported values',
    };
    expect(contextAssessment(report)).toEqual({ kind: 'conflict', input: 250, limit: 200 });
    expect(contextAssessment({ ...report, comparableReason: 'Different accounting scopes' })).toEqual({ kind: 'unknown' });
    expect(contextAssessment({ ...report, state: 'streaming', comparable: true })).toEqual({ kind: 'unknown' });
  });
});

describe('ACT-03 deadlines', () => {
  it('anchors relative resets to their observation and prefers a reported deadline', () => {
    const quota = { feature: 'Reasoning', scope: 'session', observedAt: now, resetSeconds: metric(45) };
    expect(quotaDeadline(quota)).toBe(now + 45_000);
    expect(quotaDeadline({ ...quota, deadline: metric(now + 1_000) })).toBe(now + 1_000);
    expect(quotaDeadline({ ...quota, resetSeconds: metric(0) })).toBe(now);
  });
});
