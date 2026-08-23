import type { AgentRole } from './types.js';
import {
  BROKER_TOOL_NAMES,
  type BrokerToolName,
} from '../runtime/tool-broker.js';

const MANAGER_DENIED_TOOLS = new Set<BrokerToolName>(['apply_patch', 'run_approved']);

/**
 * Provider-independent capability policy for the public Goalie broker surface.
 *
 * Reviewers are deliberately evidence-only: the orchestrator must put every
 * criterion, untrusted reference, diff, and verifier fact needed for a verdict
 * in the request prompt. They never receive a workspace browsing capability.
 */
export function brokerToolNamesForRole(role: AgentRole): readonly BrokerToolName[] {
  if (role === 'critic' || role === 'auditor') return [];
  if (role === 'manager') {
    return BROKER_TOOL_NAMES.filter(name => !MANAGER_DENIED_TOOLS.has(name));
  }
  return BROKER_TOOL_NAMES;
}

export function isEvidenceOnlyReviewer(role: AgentRole): boolean {
  return role === 'critic' || role === 'auditor';
}
