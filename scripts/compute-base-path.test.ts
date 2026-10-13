import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const script = join(__dirname, 'compute-base-path.sh');

function run(repository: string | undefined) {
  const env: NodeJS.ProcessEnv = { PATH: process.env['PATH'] };
  if (repository !== undefined) env['GITHUB_REPOSITORY'] = repository;
  return spawnSync('bash', [script], { env, encoding: 'utf8' });
}

describe('compute-base-path.sh (AC-48)', () => {
  it('prints the repository subpath for a project site', () => {
    const r = run('owner/taking_poster_photos');
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('BASE_PATH=/taking_poster_photos/\n');
  });

  it('prints / for <owner>.github.io, case-insensitively', () => {
    for (const repo of ['owner/owner.github.io', 'owner/Owner.GitHub.io', 'Someone/SOMEONE.GITHUB.IO']) {
      const r = run(repo);
      expect(r.status).toBe(0);
      expect(r.stdout).toBe('BASE_PATH=/\n');
    }
  });

  it('keeps the repository name case for project sites', () => {
    expect(run('Owner/My-Repo').stdout).toBe('BASE_PATH=/My-Repo/\n');
  });

  it('does not treat a repo that merely contains "github.io" in the middle as a user site', () => {
    expect(run('owner/github.io-notes').stdout).toBe('BASE_PATH=/github.io-notes/\n');
  });

  it('fails loudly when GITHUB_REPOSITORY is not set', () => {
    const r = run(undefined);
    expect(r.status).not.toBe(0);
  });

  it('the emitted value passes the vite.config BASE_PATH validation regex', () => {
    const re = /^\/([^/?#\s]+\/)*$/;
    for (const repo of ['o/taking_poster_photos', 'o/o.github.io', 'o/a.b-c_d']) {
      expect(run(repo).stdout.trim().replace('BASE_PATH=', '')).toMatch(re);
    }
  });
});
