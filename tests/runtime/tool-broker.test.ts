import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { FileMutationJournal } from '../../src/runtime/mutation-journal.js';
import {
  commandContainmentPreflight,
  resolveCommandWriteScope,
  ToolBroker,
  ToolBrokerError,
} from '../../src/runtime/tool-broker.js';

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map(candidate => rm(candidate, { recursive: true, force: true })));
});

async function workspace(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'goalie-broker-'));
  cleanup.push(root);
  await mkdir(path.join(root, 'src'), { recursive: true });
  return root;
}

describe('ToolBroker', () => {
  test('enforces an actor capability ceiling before parsing or dispatching tool input', async () => {
    const root = await workspace();
    await writeFile(path.join(root, 'src', 'secret.txt'), 'not reviewer context\n');
    const broker = new ToolBroker({
      root,
      actorId: 'critic:evidence-only',
      writeSet: [],
      allowedTools: [],
    });

    await expect(broker.invoke('read_file', { path: 'src/secret.txt' })).rejects.toMatchObject({
      code: 'TOOL_NOT_ALLOWED',
    });
    await expect(broker.invoke('apply_patch', undefined)).rejects.toMatchObject({
      code: 'TOOL_NOT_ALLOWED',
    });
  });

  test('applies idempotent patches and rejects operation-id reuse', async () => {
    const root = await workspace();
    const journalPath = path.join(root, '.state', 'mutations.jsonl');
    const broker = new ToolBroker({
      root,
      actorId: 'worker-1',
      writeSet: ['src/**'],
      journal: new FileMutationJournal(journalPath),
    });
    const request = {
      operationId: 'patch-1',
      operations: [{ type: 'write' as const, path: 'src/value.ts', content: 'export const value = 1;\n' }],
    };

    const first = await broker.applyPatch(request);
    const second = await broker.applyPatch(request);
    expect(second).toEqual(first);
    expect(await readFile(path.join(root, 'src/value.ts'), 'utf8')).toContain('value = 1');

    await expect(
      broker.applyPatch({
        operationId: 'patch-1',
        operations: [{ type: 'write', path: 'src/value.ts', content: 'different' }],
      }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });

    const reopened = new ToolBroker({
      root,
      actorId: 'worker-1',
      writeSet: ['src/**'],
      journal: new FileMutationJournal(journalPath),
    });
    await expect(reopened.applyPatch(request)).resolves.toEqual(first);
  });

  test('executes one mutation for concurrent calls with the same operation id', async () => {
    const root = await workspace();
    const journalPath = path.join(root, '.state', 'mutations.jsonl');
    const target = path.join(root, 'src', 'delete-once.txt');
    await writeFile(target, 'present\n');
    const broker = new ToolBroker({
      root,
      actorId: 'worker-1',
      writeSet: ['src/**'],
      journal: new FileMutationJournal(journalPath),
    });
    const request = {
      operationId: 'concurrent-delete',
      operations: [{ type: 'delete' as const, path: 'src/delete-once.txt' }],
    };

    const [left, right] = await Promise.all([broker.applyPatch(request), broker.applyPatch(request)]);
    expect(right).toEqual(left);
    await expect(readFile(target)).rejects.toMatchObject({ code: 'ENOENT' });

    const records = (await readFile(journalPath, 'utf8'))
      .trimEnd()
      .split('\n')
      .map(line => JSON.parse(line) as { status: string });
    expect(records.map(record => record.status)).toEqual(['started', 'completed']);
  });

  test('rejects loader and language-runtime injection environment entries', async () => {
    const root = await workspace();
    for (const key of [
      'LD_PRELOAD',
      'ld_library_path',
      'DYLD_INSERT_LIBRARIES',
      'NODE_OPTIONS',
      'PYTHONPATH',
      'RUBYOPT',
    ]) {
      expect(() =>
        new ToolBroker({
          root,
          actorId: 'worker-1',
          approvedCommands: [
            {
              id: `unsafe-${key}`,
              kind: 'check',
              argv: [process.execPath, '-e', 'process.exit(0)'],
              env: { [key]: '/tmp/provider-controlled' },
            },
          ],
        }),
      ).toThrowError(expect.objectContaining({ code: 'INVALID_CONFIG' }));
    }
  });

  test('injects a bounded approved environment only inside containment', async () => {
    const root = await workspace();
    const broker = new ToolBroker({
      root,
      actorId: 'worker-1',
      approvedCommands: [
        {
          id: 'approved-env',
          kind: 'check',
          argv: [
            process.execPath,
            '-e',
            'process.stdout.write(JSON.stringify({approved:process.env.GOALIE_APPROVED_VALUE,home:process.env.HOME??null}))',
          ],
          env: { GOALIE_APPROVED_VALUE: 'inside-the-sandbox' },
        },
      ],
    });

    const containment = await commandContainmentPreflight();
    if (!containment.available) {
      await expect(broker.runCheck('approved-env')).rejects.toMatchObject({ code: 'CONTAINMENT_UNAVAILABLE' });
    } else {
      const result = await broker.runCheck('approved-env');
      expect(JSON.parse(result.stdout)).toEqual({ approved: 'inside-the-sandbox', home: null });
    }
  });

  test('hides protected evidence from list, read, and search', async () => {
    const root = await workspace();
    await mkdir(path.join(root, 'verifiers'), { recursive: true });
    await writeFile(path.join(root, 'src', 'visible.txt'), 'needle');
    await writeFile(path.join(root, 'verifiers', 'hidden.txt'), 'needle secret');
    const broker = new ToolBroker({
      root,
      actorId: 'critic-1',
      protectedPaths: ['verifiers/**'],
    });

    expect((await broker.listFiles()).files).toEqual(['src/visible.txt']);
    expect((await broker.search({ query: 'needle' })).matches).toHaveLength(1);
    await expect(broker.readFile('verifiers/hidden.txt')).rejects.toThrow('cannot be read');
  });

  test('rolls back earlier files when a multi-file patch fails', async () => {
    const root = await workspace();
    await writeFile(path.join(root, 'src', 'existing.ts'), 'const original = true;\n');
    const broker = new ToolBroker({ root, actorId: 'worker-1', writeSet: ['src/**'] });
    await expect(
      broker.applyPatch({
        operationId: 'rollback-patch',
        operations: [
          { type: 'write', path: 'src/created.ts', content: 'partial\n' },
          {
            type: 'replace',
            path: 'src/existing.ts',
            oldText: 'missing target',
            newText: 'replacement',
          },
        ],
      }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    await expect(readFile(path.join(root, 'src', 'created.ts'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(path.join(root, 'src', 'existing.ts'), 'utf8')).toBe('const original = true;\n');
  });

  test('runs only exact kickoff-approved commands in the correct category', async () => {
    const root = await workspace();
    const broker = new ToolBroker({
      root,
      actorId: 'worker-1',
      writeSet: ['src/**'],
      approvedCommands: [
        {
          id: 'unit',
          kind: 'check',
          argv: [process.execPath, '-e', 'process.stdout.write("checks-ok")'],
        },
        {
          id: 'format',
          kind: 'command',
          argv: [process.execPath, '-e', 'process.stdout.write("format-ok")'],
        },
      ],
    });

    const containment = await commandContainmentPreflight();
    if (!containment.available) {
      // CI itself may prohibit nested sandbox namespaces. That is a valid
      // fail-closed outcome; the command must never fall back unsandboxed.
      await expect(broker.runCheck('unit')).rejects.toMatchObject({ code: 'CONTAINMENT_UNAVAILABLE' });
    } else {
      // Once preflight says the mechanism is usable, an ordinary crash or
      // dependency denial is a test failure, never "containment unavailable".
      await expect(broker.runCheck('unit')).resolves.toMatchObject({ stdout: 'checks-ok', exitCode: 0 });
      await expect(broker.runApprovedCommand('format')).resolves.toMatchObject({ stdout: 'format-ok' });
    }
    await expect(broker.runApprovedCommand('unit')).rejects.toBeInstanceOf(ToolBrokerError);
    await expect(broker.runCheck('not-approved')).rejects.toMatchObject({ code: 'COMMAND_NOT_APPROVED' });
  });

  test('accepts only kickoff-allowlisted dynamic command arguments', async () => {
    const root = await workspace();
    const broker = new ToolBroker({
      root,
      actorId: 'worker-1',
      writeSet: ['src/**'],
      approvedCommands: [{
        id: 'choose-color',
        kind: 'command',
        argv: [process.execPath, '-e', 'process.stdout.write(process.argv.at(-1) ?? "")'],
        allowedArgs: ['blue', 'red'],
      }],
    });

    await expect(broker.runApprovedCommand('choose-color', ['--eval'])).rejects.toMatchObject({
      code: 'COMMAND_ARGUMENT_NOT_APPROVED',
    });
    await expect(broker.invoke('run_approved', {
      commandId: 'choose-color',
      validatedArgs: new Array(33).fill('blue'),
    })).rejects.toMatchObject({ code: 'INVALID_INPUT' });

    const containment = await commandContainmentPreflight();
    if (!containment.available) {
      await expect(broker.runApprovedCommand('choose-color', ['blue'])).rejects.toMatchObject({
        code: 'CONTAINMENT_UNAVAILABLE',
      });
    } else {
      await expect(broker.runApprovedCommand('choose-color', ['blue'])).resolves.toMatchObject({
        stdout: 'blue',
      });
    }
  });

  test('validates and acknowledges bounded progress reports without mutation', async () => {
    const root = await workspace();
    const broker = new ToolBroker({ root, actorId: 'worker-9', writeSet: [] });

    await expect(broker.invoke('report_progress', {
      summary: 'Verifier isolated the duplicate-ingestion race.',
      status: 'working',
      percent: 60,
    })).resolves.toEqual({
      accepted: true,
      actorId: 'worker-9',
      status: 'working',
      summary: 'Verifier isolated the duplicate-ingestion race.',
      percent: 60,
    });
    await expect(broker.invoke('report_progress', {
      summary: 'bad percentage',
      percent: 101,
    })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  test('supports the Node test runner inside read-only command containment', async () => {
    const root = await workspace();
    await writeFile(
      path.join(root, 'smoke.test.mjs'),
      'import test from "node:test"; import assert from "node:assert/strict"; test("smoke", () => assert.equal(2 + 2, 4));\n',
    );
    const broker = new ToolBroker({
      root,
      actorId: 'evaluator',
      writeSet: [],
      approvedCommands: [
        { id: 'node-test', kind: 'check', argv: [process.execPath, '--test', 'smoke.test.mjs'] },
      ],
    });

    const containment = await commandContainmentPreflight();
    if (!containment.available) {
      await expect(broker.runCheck('node-test')).rejects.toMatchObject({ code: 'CONTAINMENT_UNAVAILABLE' });
    } else {
      const outcome = await broker.runCheck('node-test');
      expect(outcome).toMatchObject({ exitCode: 0 });
      expect(outcome.stdout).toContain('pass 1');
    }
  });

  test('keeps network commands pending without explicit kickoff approval', async () => {
    const root = await workspace();
    const broker = new ToolBroker({
      root,
      actorId: 'worker-1',
      approvedCommands: [
        {
          id: 'download',
          kind: 'command',
          network: true,
          argv: [process.execPath, '-e', 'process.exit(0)'],
        },
      ],
    });
    await expect(broker.runApprovedCommand('download')).rejects.toMatchObject({
      code: 'NETWORK_APPROVAL_REQUIRED',
    });
  });

  test('denies sockets and protected-path writes at the OS boundary or fails closed', async () => {
    const root = await workspace();
    await mkdir(path.join(root, '.git'), { recursive: true });
    await writeFile(path.join(root, '.git', 'config'), 'protected\n');
    const denyNetwork = [
      'const net = require("node:net");',
      'const server = net.createServer();',
      'server.once("error", () => process.exit(0));',
      'server.listen(0, "127.0.0.1", () => process.exit(91));',
    ].join('');
    const denyProtectedWrite = [
      'const fs = require("node:fs");',
      'try { fs.writeFileSync(".git/config", "tampered"); process.exit(92); }',
      'catch { process.exit(0); }',
    ].join('');
    const broker = new ToolBroker({
      root,
      actorId: 'worker-1',
      approvedCommands: [
        { id: 'network-probe', kind: 'check', argv: [process.execPath, '-e', denyNetwork] },
        { id: 'write-probe', kind: 'check', argv: [process.execPath, '-e', denyProtectedWrite] },
      ],
    });

    for (const checkId of ['network-probe', 'write-probe']) {
      const outcome = await broker.runCheck(checkId).catch((error: unknown) => error);
      expect(outcome).toMatchObject(
        outcome instanceof Error ? { code: 'CONTAINMENT_UNAVAILABLE' } : { exitCode: 0 },
      );
    }
    expect(await readFile(path.join(root, '.git', 'config'), 'utf8')).toBe('protected\n');
  });

  test('preflights containment and never exposes shared temp siblings', async () => {
    const status = await commandContainmentPreflight({ refresh: true });
    expect(status.platform).toBe(process.platform);
    expect(typeof status.available).toBe('boolean');
    const root = await workspace();
    const sharedSecretRoot = await mkdtemp(path.join(tmpdir(), 'goalie-shared-secret-'));
    cleanup.push(sharedSecretRoot);
    const secret = path.join(sharedSecretRoot, 'credentials');
    await writeFile(secret, 'CLOUD_TOKEN=should-not-leak');
    const probeScript = [
      'const fs = require("node:fs");',
      `try { fs.readFileSync(${JSON.stringify(secret)}); process.exit(93); }`,
      'catch {',
      ' const p = require("node:path").join(process.env.TMPDIR, "private-write");',
      ' fs.writeFileSync(p, "ok"); process.stdout.write(process.env.TMPDIR);',
      '}',
    ].join('');
    const broker = new ToolBroker({
      root,
      actorId: 'worker-1',
      approvedCommands: [
        { id: 'credential-probe', kind: 'check', argv: [process.execPath, '-e', probeScript] },
      ],
    });

    const outcome = await broker.runCheck('credential-probe').catch((error: unknown) => error);
    if (outcome instanceof Error) {
      expect(outcome).toMatchObject({ code: 'CONTAINMENT_UNAVAILABLE' });
    } else {
      expect(outcome).toMatchObject({ exitCode: 0 });
      const privateTemp = (outcome as { stdout: string }).stdout;
      await expect(readFile(path.join(privateTemp, 'private-write'))).rejects.toMatchObject({ code: 'ENOENT' });
    }
    expect(await readFile(secret, 'utf8')).toContain('should-not-leak');
  });

  test('masks workspace credential files from approved command processes', async () => {
    const root = await workspace();
    await writeFile(path.join(root, '.env'), 'OPENROUTER_API_KEY=must-not-leak\n');
    await mkdir(path.join(root, 'service'), { recursive: true });
    await writeFile(path.join(root, 'service', '.npmrc'), '//registry.example/:_authToken=must-not-leak\n');
    const probeScript = [
      'const fs = require("node:fs");',
      'for (const candidate of [".env", "service/.npmrc"]) {',
      ' try { const value = fs.readFileSync(candidate, "utf8"); if (value.includes("must-not-leak")) process.exit(97); }',
      ' catch {}',
      '}',
      'process.stdout.write("credentials-masked");',
    ].join('');
    const broker = new ToolBroker({
      root,
      actorId: 'worker-1',
      approvedCommands: [
        { id: 'workspace-secret-probe', kind: 'check', argv: [process.execPath, '-e', probeScript] },
      ],
    });

    const outcome = await broker.runCheck('workspace-secret-probe').catch((error: unknown) => error);
    if (outcome instanceof Error) {
      expect(outcome).toMatchObject({ code: 'CONTAINMENT_UNAVAILABLE' });
    } else {
      expect(outcome).toMatchObject({ exitCode: 0, stdout: 'credentials-masked' });
    }
  });

  test('mounts checks with a read-only workspace', async () => {
    const root = await workspace();
    const target = path.join(root, 'src', 'checked.txt');
    await writeFile(target, 'original\n');
    const mutationProbe = [
      'const fs = require("node:fs");',
      'try { fs.writeFileSync("src/checked.txt", "tampered\\n"); process.exit(94); }',
      'catch { process.stdout.write("workspace-read-only"); }',
    ].join('');
    const broker = new ToolBroker({
      root,
      actorId: 'critic-1',
      writeSet: ['src/**'],
      approvedCommands: [
        { id: 'read-only-check', kind: 'check', argv: [process.execPath, '-e', mutationProbe] },
      ],
    });

    const outcome = await broker.runCheck('read-only-check').catch((error: unknown) => error);
    if (outcome instanceof Error) {
      expect(outcome).toMatchObject({ code: 'CONTAINMENT_UNAVAILABLE' });
    } else {
      expect(outcome).toMatchObject({ exitCode: 0, stdout: 'workspace-read-only' });
    }
    expect(await readFile(target, 'utf8')).toBe('original\n');
  });

  test('mounts mutating commands only at representable write-set targets', async () => {
    const root = await workspace();
    const mutationProbe = [
      'const fs = require("node:fs");',
      'fs.writeFileSync("src/allowed.txt", "allowed\\n");',
      'try { fs.writeFileSync("outside.txt", "forbidden\\n"); process.exit(95); }',
      'catch { process.stdout.write("scope-enforced"); }',
    ].join('');
    const broker = new ToolBroker({
      root,
      actorId: 'worker-1',
      writeSet: ['src/**'],
      approvedCommands: [
        { id: 'scoped-mutation', kind: 'command', argv: [process.execPath, '-e', mutationProbe] },
      ],
    });

    const outcome = await broker.runApprovedCommand('scoped-mutation').catch((error: unknown) => error);
    if (outcome instanceof Error) {
      expect(outcome).toMatchObject({ code: 'CONTAINMENT_UNAVAILABLE' });
    } else {
      expect(outcome).toMatchObject({ exitCode: 0, stdout: 'scope-enforced' });
      expect(await readFile(path.join(root, 'src', 'allowed.txt'), 'utf8')).toBe('allowed\n');
    }
    await expect(readFile(path.join(root, 'outside.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('fails closed when a command write set cannot be represented exactly', async () => {
    const root = await workspace();
    await expect(
      resolveCommandWriteScope({
        root,
        kind: 'command',
        writeSet: ['src/*.ts'],
        protectedPaths: [],
      }),
    ).rejects.toMatchObject({ code: 'UNREPRESENTABLE_WRITE_SET' });

    await expect(
      resolveCommandWriteScope({
        root,
        kind: 'command',
        writeSet: ['src/**'],
        protectedPaths: [],
      }),
    ).resolves.toEqual({
      writable: [{ path: path.join(await realpath(root), 'src'), recursive: true }],
      protected: [],
    });
  });
});
