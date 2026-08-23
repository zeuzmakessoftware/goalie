import { describe, expect, test } from 'vitest';
import { createBackend } from '../../src/backends/index.js';

describe('createBackend', () => {
  test('normalizes public provider aliases', () => {
    expect(createBackend('openrouter', { apiKey: 'test', model: 'provider/model' }).id).toBe('openrouter');
    expect(createBackend('codex').id).toBe('codex-app-server');
    expect(createBackend('claude').id).toBe('claude-agent-sdk');
    expect(createBackend('scripted', { script: () => [] }).id).toBe('scripted');
  });
});
