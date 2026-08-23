const ANSI_PATTERN =
  /[\u001b\u009b](?:(?:\][^\u0007]*(?:\u0007|\u001b\\))|(?:P[^\u001b]*(?:\u001b\\))|(?:[_^X][^\u001b]*(?:\u001b\\))|(?:[[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d\/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))))/g;

const UNSAFE_CONTROL_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;
const BIDI_CONTROL_PATTERN = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;

export interface SanitizeOptions {
  maxLength?: number;
  preserveNewlines?: boolean;
}

/**
 * Removes terminal escape/control sequences from untrusted model and tool text.
 * Newlines and tabs remain available for transcript formatting unless disabled.
 */
export function sanitizeTerminalText(
  value: unknown,
  options: SanitizeOptions = {},
): string {
  const maxLength = Math.max(0, options.maxLength ?? 20_000);
  const preserveNewlines = options.preserveNewlines ?? true;
  let text = typeof value === 'string' ? value : String(value ?? '');

  text = text
    .replace(ANSI_PATTERN, '')
    .replace(/\r\n?/g, '\n')
    .replace(UNSAFE_CONTROL_PATTERN, '')
    .replace(BIDI_CONTROL_PATTERN, '');

  if (!preserveNewlines) {
    text = text.replace(/[\n\t]+/g, ' ');
  }

  return Array.from(text).slice(0, maxLength).join('');
}

export function singleLine(value: unknown, maxLength = 240): string {
  return sanitizeTerminalText(value, {
    maxLength,
    preserveNewlines: false,
  }).replace(/\s+/g, ' ').trim();
}

export function clipText(value: unknown, maxLength: number): string {
  const text = singleLine(value, Math.max(0, maxLength + 1));
  if (Array.from(text).length <= maxLength) return text;
  if (maxLength <= 1) return '…'.slice(0, maxLength);
  return `${Array.from(text).slice(0, maxLength - 1).join('')}…`;
}
