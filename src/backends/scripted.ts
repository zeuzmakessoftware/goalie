import type {
  AgentBackend,
  BackendAvailability,
  BackendCapabilities,
  BackendEvent,
  BackendRunRequest,
} from './types.js';
import type { BrokerToolName } from '../runtime/tool-broker.js';
import type { ToolBroker } from '../runtime/tool-broker.js';
import { errorMessage } from './types.js';

export type ScriptedStep =
  | { type: 'event'; event: BackendEvent }
  | { type: 'tool'; callId: string; name: BrokerToolName; input: unknown };

export type ScriptFactory = (
  request: BackendRunRequest,
) => readonly ScriptedStep[] | Promise<readonly ScriptedStep[]>;

/** Deterministic backend used by tests and honest, explicitly labelled fixtures. */
export class ScriptedBackend implements AgentBackend {
  readonly id = 'scripted' as const;
  readonly kind = 'scripted' as const;
  readonly capabilities: BackendCapabilities = {
    streaming: true,
    resume: false,
    structuredOutput: true,
    hostApprovals: true,
    hostTools: true,
    costReporting: 'usage-only',
  };

  constructor(private readonly createScript: ScriptFactory) {}

  async availability(): Promise<BackendAvailability> {
    return { available: true, version: 'deterministic-v1' };
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async *run(
    request: BackendRunRequest,
    suppliedBroker: ToolBroker,
    suppliedSignal?: AbortSignal,
  ): AsyncIterable<BackendEvent> {
    const broker = suppliedBroker ?? request.broker;
    const signal = suppliedSignal ?? request.signal;
    let steps: readonly ScriptedStep[];
    try {
      steps = await this.createScript(request);
    } catch (error) {
      yield { type: 'terminal', status: 'error', rawReason: 'script-factory-error', error: errorMessage(error) };
      return;
    }
    if (!steps.some(step => step.type === 'event' && step.event.type === 'session_started')) {
      yield {
        type: 'session_started',
        session: {
          backend: this.kind,
          id: `scripted:${request.runId}:${request.actorId}`,
          metadata: { resumable: 'false', fixture: 'true' },
        },
      };
    }
    let terminal = false;
    for (const step of steps) {
      if (signal?.aborted) {
        yield { type: 'terminal', status: 'cancelled', rawReason: 'abort-signal' };
        return;
      }
      if (step.type === 'event') {
        if (step.event.type === 'terminal') terminal = true;
        yield structuredClone(step.event);
        continue;
      }

      yield { type: 'tool_requested', callId: step.callId, name: step.name, input: step.input };
      if (!broker) {
        const error = 'Script requested a tool but no ToolBroker was supplied.';
        yield {
          type: 'tool_completed',
          callId: step.callId,
          name: step.name,
          output: { error },
          isError: true,
        };
        yield { type: 'terminal', status: 'blocked', rawReason: 'missing-tool-broker', error };
        return;
      }
      try {
        const output = await broker.invoke(step.name, step.input, signal);
        yield { type: 'tool_completed', callId: step.callId, name: step.name, output, isError: false };
      } catch (error) {
        yield {
          type: 'tool_completed',
          callId: step.callId,
          name: step.name,
          output: { error: errorMessage(error) },
          isError: true,
        };
      }
    }
    if (!terminal) yield { type: 'terminal', status: 'completed', rawReason: 'script-exhausted' };
  }
}
