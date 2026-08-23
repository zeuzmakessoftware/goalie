import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface Shot {
  id: string;
  player: string;
  outcome: 'goal' | 'save';
  takenAt: number;
}

export interface Standing {
  player: string;
  goals: number;
  attempts: number;
}

export class PenaltyLedger {
  private readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  async record(shot: Shot): Promise<boolean> {
    const shots = await this.replay();
    if (shots.some(existing => existing.id === shot.id)) return false;
    await mkdir(dirname(this.path), { recursive: true });
    await appendFile(this.path, `${JSON.stringify(shot)}\n`, 'utf8');
    return true;
  }

  async replay(): Promise<Shot[]> {
    let raw = '';
    try {
      raw = await readFile(this.path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    return raw
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line) as Shot);
  }

  async standings(): Promise<Standing[]> {
    const table = new Map<string, Standing>();
    for (const shot of await this.replay()) {
      const current = table.get(shot.player) ?? { player: shot.player, goals: 0, attempts: 0 };
      current.attempts += 1;
      if (shot.outcome === 'goal') current.goals += 1;
      table.set(shot.player, current);
    }
    return [...table.values()].sort((a, b) => b.goals - a.goals);
  }
}
