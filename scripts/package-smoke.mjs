import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packDirectory = await mkdtemp(join(tmpdir(), 'goalie-pack-'));
// Keeping the consumer below the checkout lets the unpacked ESM resolve this
// development checkout's dependencies without a networked npm install.
const consumerRoot = await mkdtemp(join(repositoryRoot, '.goalie-package-smoke-'));

const exportedEntrypoints = {
  '.': 'main',
  './core': 'createInitialSessionState',
  './backends': 'createBackend',
  './playbooks': 'activatePlaybook',
  './runtime': 'ToolBroker',
  './replay': 'createReplayBundle',
};

function entryTargets(entry) {
  if (typeof entry === 'string') return [entry];
  if (!entry || typeof entry !== 'object') return [];
  return [...new Set(Object.values(entry).filter(value => typeof value === 'string'))];
}

try {
  const packed = await execute(
    'npm',
    ['pack', '--ignore-scripts', '--json', '--pack-destination', packDirectory],
    {
      cwd: repositoryRoot,
      env: { ...process.env, npm_config_cache: join(packDirectory, 'npm-cache') },
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  const metadata = JSON.parse(packed.stdout);
  const description = Array.isArray(metadata) ? metadata[0] : undefined;
  if (!description || typeof description.filename !== 'string') {
    throw new Error('npm pack did not return a tarball filename.');
  }
  const included = Array.isArray(description.files)
    ? description.files.map(item => item.path)
    : [];
  if (included.some(path => path.startsWith('src/') || path.startsWith('tests/'))) {
    throw new Error('The package tarball leaked source or test files.');
  }

  const tarball = join(packDirectory, description.filename);
  await execute('tar', ['-xzf', tarball, '-C', consumerRoot]);
  const packageRoot = join(consumerRoot, 'package');
  const packageJson = JSON.parse(
    await readFile(join(packageRoot, 'package.json'), 'utf8'),
  );

  if (packageJson.bin?.goalie !== 'dist/cli.js') {
    throw new Error('The packed goalie bin target is missing or incorrect.');
  }
  if (packageJson.main !== 'dist/cli.js' || packageJson.types !== 'dist/cli.d.ts') {
    throw new Error('The packed root main/types targets are inconsistent.');
  }

  for (const specifier of Object.keys(exportedEntrypoints)) {
    const entry = packageJson.exports?.[specifier];
    const targets = entryTargets(entry);
    if (targets.length === 0) {
      throw new Error(`Missing packed export ${specifier}.`);
    }
    for (const target of targets) {
      const path = join(packageRoot, target.replace(/^\.\//u, ''));
      const status = await stat(path).catch(() => undefined);
      if (!status?.isFile()) {
        throw new Error(`Packed export ${specifier} points to missing ${target}.`);
      }
    }
  }

  const consumer = join(consumerRoot, 'consumer');
  const modules = join(consumer, 'node_modules');
  await mkdir(modules, { recursive: true });
  await symlink(
    packageRoot,
    join(modules, 'goalie'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  const importAssertions = JSON.stringify(exportedEntrypoints);
  await execute(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `const entries = ${importAssertions};
       for (const [subpath, expected] of Object.entries(entries)) {
         const specifier = subpath === '.' ? 'goalie' : 'goalie/' + subpath.slice(2);
         const loaded = await import(specifier);
         if (!(expected in loaded)) throw new Error(specifier + ' lacks ' + expected);
       }`,
    ],
    { cwd: consumer, maxBuffer: 16 * 1024 * 1024 },
  );

  const cli = await execute(
    process.execPath,
    [join(packageRoot, packageJson.bin.goalie), 'version'],
    { cwd: consumer },
  );
  if (cli.stdout.trim() !== packageJson.version) {
    throw new Error(`Packed CLI reported ${cli.stdout.trim()}, expected ${packageJson.version}.`);
  }

  process.stdout.write(
    `Package smoke passed: ${description.filename} (${included.length} files), ${Object.keys(exportedEntrypoints).length} imports, CLI ${packageJson.version}.\n`,
  );
} finally {
  await Promise.all([
    rm(packDirectory, { recursive: true, force: true }),
    rm(consumerRoot, { recursive: true, force: true }),
  ]);
}
