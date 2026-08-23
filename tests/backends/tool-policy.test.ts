import { describe, expect, test } from 'vitest';
import { brokerToolNamesForRole, isEvidenceOnlyReviewer } from '../../src/backends/tool-policy.js';
import { BROKER_TOOL_NAMES } from '../../src/runtime/tool-broker.js';

describe('backend broker tool policy', () => {
  test('keeps the exact eight-tool worker surface', () => {
    expect(brokerToolNamesForRole('worker')).toEqual(BROKER_TOOL_NAMES);
  });

  test('keeps manager planning read-only while retaining bounded evidence tools', () => {
    expect(brokerToolNamesForRole('manager')).toEqual([
      'list_files',
      'read_file',
      'search',
      'git_diff',
      'run_check',
      'report_progress',
    ]);
  });

  test.each(['critic', 'auditor'] as const)('%s receives no workspace broker tools', role => {
    expect(brokerToolNamesForRole(role)).toEqual([]);
    expect(isEvidenceOnlyReviewer(role)).toBe(true);
  });
});
