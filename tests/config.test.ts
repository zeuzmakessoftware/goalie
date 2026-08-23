import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('config resolution', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('applies global, project, environment, then CLI precedence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'goalie-config-'));
    const global = join(root, 'global');
    const project = join(root, 'project');
    await mkdir(join(project, '.goalie'), { recursive: true });
    await mkdir(global, { recursive: true });
    await writeFile(join(global, 'config.json'), JSON.stringify({ budget: { maxMinutes: 60 }, models: { openrouter: 'global/model' } }));
    await writeFile(join(project, '.goalie', 'config.json'), JSON.stringify({ budget: { maxMinutes: 90 }, providers: { builder: 'claude' } }));
    vi.stubEnv('GOALIE_CONFIG_DIR', global);
    vi.stubEnv('OPENROUTER_MODEL', 'env/model');

    const config = await loadConfig(project, { maxMinutes: 120, builder: 'codex' });
    expect(config.budget.maxMinutes).toBe(120);
    expect(config.providers.builder).toBe('codex');
    expect(config.models.openrouter).toBe('env/model');
  });

  it('supports an explicit OpenRouter-only lineup and CLI model override', async () => {
    const project = await mkdtemp(join(tmpdir(), 'goalie-openrouter-config-'));
    vi.stubEnv('OPENROUTER_MODEL', 'env/model');

    const config = await loadConfig(project, {
      manager: 'openrouter',
      builder: 'openrouter',
      critic: 'openrouter',
      integrator: 'openrouter',
      fallback: ['openrouter'],
      openrouterModel: 'deepseek/deepseek-v4-flash',
      allowDegradedCritic: true,
    });

    expect(config.providers).toMatchObject({
      manager: 'openrouter',
      builder: 'openrouter',
      critic: 'openrouter',
      integrator: 'openrouter',
      fallback: ['openrouter'],
    });
    expect(config.models.openrouter).toBe('deepseek/deepseek-v4-flash');
    expect(config.allowDegradedCritic).toBe(true);
  });
});
