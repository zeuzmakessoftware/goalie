import { describe, expect, it } from 'vitest';

import { EvaluatorRegistry } from '../../src/core/evaluators.js';
import {
  redactSecrets,
  resolveWithinWorkspace,
  sanitizeForPersistence,
  sanitizeTerminalText,
} from '../../src/core/sanitize.js';
import { CheckDefinitionSchema } from '../../src/core/schemas.js';
import { makeSpec, makeTask } from './fixtures.js';

describe('EvaluatorRegistry', () => {
  it('validates successful evaluator output', async () => {
    const registry = new EvaluatorRegistry();
    registry.register(
      {
        id: 'test-evaluator',
        version: '1',
        name: 'Test evaluator',
        description: '',
        deterministic: true,
      },
      () => ({ status: 'passed', score: 1, summary: 'Passed' }),
    );
    const spec = makeSpec();
    const task = makeTask('a');
    const check = CheckDefinitionSchema.parse({
      id: 'check:test',
      name: 'test',
      evaluatorId: 'test-evaluator@1',
      criterionIds: ['correctness'],
    });
    const result = await registry.evaluate('test-evaluator@1', {
      sessionId: 'session:test',
      task,
      check,
      spec,
      evidence: [],
      candidate: {},
    });
    expect(result).toMatchObject({ status: 'passed', score: 1 });
  });

  it('converts evaluator exceptions into persistable error results', async () => {
    const registry = new EvaluatorRegistry();
    registry.register(
      {
        id: 'broken',
        version: '1',
        name: 'Broken evaluator',
        description: '',
        deterministic: true,
      },
      () => {
        throw new Error('boom');
      },
    );
    const spec = makeSpec();
    const result = await registry.evaluate('broken', {
      sessionId: 'session:test',
      task: makeTask('a'),
      check: CheckDefinitionSchema.parse({
        id: 'check:broken',
        name: 'broken',
        evaluatorId: 'broken',
      }),
      spec,
      evidence: [],
      candidate: null,
    });
    expect(result.status).toBe('error');
    expect(result.error).toContain('boom');
  });
});

describe('sanitization', () => {
  it('redacts secret keys, token-shaped values, and terminal control codes', () => {
    const input: Record<string, unknown> = {
      password: 'hunter2',
      note: 'Authorization: Bearer abcdefghijklmnop',
      terminal: '\u001b[31mred\u001b[0m\u0000',
    };
    input.self = input;
    const sanitized = sanitizeForPersistence(input) as Record<string, unknown>;
    expect(sanitized.password).toBe('[REDACTED]');
    expect(sanitized.note).toBe('Authorization: [REDACTED]');
    expect(sanitized.terminal).toBe('red');
    expect(sanitized.self).toBe('[Circular]');
    expect(redactSecrets('sk-abcdefghijklmnopqrst')).toBe('[REDACTED]');
    expect(
      JSON.parse(redactSecrets('{"OPENROUTER_API_KEY":"plain-secret"}')),
    ).toEqual({ OPENROUTER_API_KEY: '[REDACTED]' });
    expect(sanitizeTerminalText('\u001b[2Jclean')).toBe('clean');
  });

  it('rejects lexical workspace escapes', () => {
    expect(resolveWithinWorkspace('/tmp/work', 'src/a.ts')).toBe(
      '/tmp/work/src/a.ts',
    );
    expect(() => resolveWithinWorkspace('/tmp/work', '../secret')).toThrow(
      /escapes workspace/u,
    );
  });
});
