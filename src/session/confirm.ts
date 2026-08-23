import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

export async function confirmKickoff(summary: string, assumeYes = false): Promise<boolean> {
  stdout.write(`\n${summary}\n\n`);
  if (assumeYes) {
    stdout.write('Kickoff confirmed by --yes.\n');
    return true;
  }
  if (!stdin.isTTY || !stdout.isTTY) {
    throw new Error('Kickoff confirmation requires a TTY. Use --yes only after reviewing the resolved specification.');
  }
  const prompt = createInterface({ input: stdin, output: stdout });
  try {
    const answer = (await prompt.question('Kick off this match? [Y/n] ')).trim().toLowerCase();
    return answer === '' || answer === 'y' || answer === 'yes';
  } finally {
    prompt.close();
  }
}
