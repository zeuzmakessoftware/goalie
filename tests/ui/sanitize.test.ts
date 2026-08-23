import assert from 'node:assert/strict';
import { test } from 'vitest';
import { clipText, sanitizeTerminalText, singleLine } from '../../src/ui/sanitize.js';

test('strips CSI color and cursor-control sequences', () => {
  assert.equal(
    sanitizeTerminalText('\u001b[31mRED\u001b[0m\u001b[2J safe'),
    'RED safe',
  );
});

test('strips OSC terminal title and hyperlink payloads', () => {
  assert.equal(
    sanitizeTerminalText(
      '\u001b]0;hostile-title\u0007hello \u001b]8;;https://example.com\u0007link\u001b]8;;\u0007',
    ),
    'hello link',
  );
});

test('normalizes line endings and removes unsafe controls', () => {
  assert.equal(sanitizeTerminalText('a\r\nb\u0000c\td'), 'a\nbc\td');
  assert.equal(singleLine('a\r\nb\tc'), 'a b c');
  assert.equal(sanitizeTerminalText('safe\u202eevil\u2069'), 'safeevil');
});

test('length bounds count Unicode code points and clip visibly', () => {
  assert.equal(sanitizeTerminalText('⚽⚽⚽', { maxLength: 2 }), '⚽⚽');
  assert.equal(clipText('abcdefgh', 5), 'abcd…');
});
