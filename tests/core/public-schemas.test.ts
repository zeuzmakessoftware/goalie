import { describe, expect, it } from 'vitest';

import {
  BackendEventSchema,
  BackendRequestSchema,
  SessionStatusSchema,
} from '../../src/core/schemas.js';

describe('public runtime schemas', () => {
  it('accepts the documented brokered backend request and rejects extra authority', () => {
    const request = {
      actorId: 'worker:1',
      role: 'worker',
      cwd: 'lane',
      prompt: 'Repair the ledger.',
      outputSchema: { type: 'object' },
      policyProfile: {
        id: 'builder:bounded',
        tools: ['read_file', 'apply_patch', 'report_progress'],
        readOnly: false,
        network: false,
      },
    };

    expect(BackendRequestSchema.parse(request)).toEqual(request);
    expect(BackendRequestSchema.safeParse({ ...request, arbitraryShell: true }).success).toBe(false);
  });

  it('normalizes the documented backend terminal reasons at the schema boundary', () => {
    for (const status of ['completed', 'blocked', 'context_limit', 'budget', 'cancelled', 'error']) {
      expect(BackendEventSchema.safeParse({ type: 'terminal', status }).success).toBe(true);
    }
    expect(BackendEventSchema.safeParse({ type: 'terminal', status: 'provider_magic' }).success).toBe(false);
    expect(SessionStatusSchema.safeParse('paused_approval').success).toBe(true);
  });
});
