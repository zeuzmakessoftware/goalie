import { createHash } from 'node:crypto';
import { isAbsolute, relative, resolve } from 'node:path';
import { stripVTControlCharacters } from 'node:util';

export const DEFAULT_REDACTION = '[REDACTED]';

const SENSITIVE_KEY = /(?:^|[-_.])(?:authorization|proxy[-_]?authorization|cookie|set[-_]?cookie|password|passwd|pwd|secret|api[-_]?key|access[-_]?token|refresh[-_]?token|id[-_]?token|client[-_]?secret|private[-_]?key|session[-_]?key)(?:$|[-_.])/iu;
const SENSITIVE_VALUE_PATTERNS: readonly RegExp[] = [
  /\b(?:Bearer|Basic)\s+[A-Za-z0-9+/._~=-]{8,}/giu,
  /\bsk-[A-Za-z0-9_-]{12,}\b/gu,
  /\b(?:gh[pousr]|github_pat)_[A-Za-z0-9_]{12,}\b/gu,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/gu,
  /\bAKIA[A-Z0-9]{16}\b/gu,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/gu,
];
const URL_SECRET = /([?&](?:api[-_]?key|access[-_]?token|token|secret|password)=)[^&#\s]*/giu;

export interface RedactionOptions {
  readonly replacement?: string;
  readonly sensitiveKeys?: readonly (string | RegExp)[];
}

function keyIsSensitive(
  key: string,
  custom: readonly (string | RegExp)[],
): boolean {
  const segmented = key.replace(/([a-z0-9])([A-Z])/gu, '$1_$2');
  if (SENSITIVE_KEY.test(segmented)) return true;
  return custom.some((entry) => {
    if (typeof entry === 'string') {
      return entry.toLowerCase() === key.toLowerCase();
    }
    entry.lastIndex = 0;
    const matches = entry.test(key);
    entry.lastIndex = 0;
    return matches;
  });
}

export function redactSecretText(
  text: string,
  replacement = DEFAULT_REDACTION,
): string {
  let redacted = text.replace(URL_SECRET, `$1${replacement}`);
  for (const pattern of SENSITIVE_VALUE_PATTERNS) {
    redacted = redacted.replace(pattern, replacement);
  }
  return redacted;
}

/** Compatibility-friendly string redactor for serialized backend events. */
export function redactSecrets(
  text: string,
  options: RedactionOptions = {},
): string {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed !== null && typeof parsed === 'object') {
      return JSON.stringify(sanitizeForPersistence(parsed, options));
    }
  } catch {
    // Fall through to token-shaped text redaction.
  }
  return redactSecretText(text, options.replacement ?? DEFAULT_REDACTION);
}

export function sanitizeTerminalText(
  text: string,
  maxLength = 100_000,
): string {
  const withoutAnsi = stripVTControlCharacters(text)
    .replace(/\r\n?/gu, '\n')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, '');
  if (withoutAnsi.length <= maxLength) return withoutAnsi;
  const omitted = withoutAnsi.length - maxLength;
  return `${withoutAnsi.slice(0, maxLength)}\n…[${omitted} characters omitted]`;
}

export interface SanitizeOptions extends RedactionOptions {
  readonly maxDepth?: number;
  readonly maxStringLength?: number;
  readonly maxArrayLength?: number;
  readonly maxObjectKeys?: number;
}

/**
 * Produces a bounded, JSON-safe, redacted clone. It never mutates its input and
 * represents cycles/binary data explicitly rather than throwing or leaking it.
 */
export function sanitizeForPersistence(
  value: unknown,
  options: SanitizeOptions = {},
): unknown {
  const replacement = options.replacement ?? DEFAULT_REDACTION;
  const customKeys = options.sensitiveKeys ?? [];
  const maxDepth = options.maxDepth ?? 12;
  const maxStringLength = options.maxStringLength ?? 100_000;
  const maxArrayLength = options.maxArrayLength ?? 1_000;
  const maxObjectKeys = options.maxObjectKeys ?? 1_000;
  const ancestors = new Set<object>();

  const visit = (input: unknown, depth: number): unknown => {
    if (input === undefined) return '[undefined]';
    if (input === null || typeof input === 'boolean') return input;
    if (typeof input === 'number') {
      return Number.isFinite(input) ? input : `[${String(input)}]`;
    }
    if (typeof input === 'bigint') return `${input.toString()}n`;
    if (typeof input === 'string') {
      return sanitizeTerminalText(
        redactSecretText(input, replacement),
        maxStringLength,
      );
    }
    if (typeof input === 'symbol') return `[Symbol(${input.description ?? ''})]`;
    if (typeof input === 'function') return `[Function ${input.name || 'anonymous'}]`;
    if (input instanceof Date) return input.toISOString();
    if (Buffer.isBuffer(input)) {
      const digest = createHash('sha256').update(input).digest('hex');
      return `[Buffer ${input.byteLength} bytes sha256:${digest}]`;
    }
    if (depth >= maxDepth) return '[Maximum depth reached]';
    if (typeof input !== 'object') return String(input);
    if (ancestors.has(input)) return '[Circular]';

    ancestors.add(input);
    try {
      if (Array.isArray(input)) {
        const kept = input.slice(0, maxArrayLength).map((item) => visit(item, depth + 1));
        if (input.length > maxArrayLength) {
          kept.push(`[${input.length - maxArrayLength} items omitted]`);
        }
        return kept;
      }
      if (input instanceof Error) {
        return {
          name: input.name,
          message: visit(input.message, depth + 1),
          ...(input.stack === undefined
            ? {}
            : { stack: visit(input.stack, depth + 1) }),
        };
      }
      const output: Record<string, unknown> = {};
      const keys = Object.keys(input).sort();
      for (const key of keys.slice(0, maxObjectKeys)) {
        output[key] = keyIsSensitive(key, customKeys)
          ? replacement
          : visit((input as Record<string, unknown>)[key], depth + 1);
      }
      if (keys.length > maxObjectKeys) {
        output['[omittedKeys]'] = keys.length - maxObjectKeys;
      }
      return output;
    } finally {
      ancestors.delete(input);
    }
  };

  return visit(value, 0);
}

export function redactEnvironment(
  environment: NodeJS.ProcessEnv,
  options: RedactionOptions = {},
): Record<string, string | undefined> {
  return sanitizeForPersistence(environment, {
    ...options,
    maxDepth: 2,
  }) as Record<string, string | undefined>;
}

/** Lexically confines a path; callers handling symlinks must also use realpath. */
export function resolveWithinWorkspace(
  workspaceRoot: string,
  candidate: string,
): string {
  const root = resolve(workspaceRoot);
  const resolved = resolve(root, candidate);
  const fromRoot = relative(root, resolved);
  if (
    fromRoot === '..' ||
    fromRoot.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) ||
    isAbsolute(fromRoot)
  ) {
    throw new Error(`Path escapes workspace: ${candidate}`);
  }
  return resolved;
}
