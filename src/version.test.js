// Unit tests for SemVer release calculation and markdown notes generation in scripts/version.mjs.
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const SOURCE_SCRIPT = fileURLToPath(new URL('../scripts/version.mjs', import.meta.url));
const tempDirs = [];

function createRepo(initialVersion = '0.1.0') {
  const dir = mkdtempSync(path.join(tmpdir(), 'ttc-version-test-'));
  tempDirs.push(dir);
  mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  copyFileSync(SOURCE_SCRIPT, path.join(dir, 'scripts', 'version.mjs'));
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ version: initialVersion }));
  execFileSync('git', ['init'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'tag.gpgsign', 'false'], { cwd: dir, stdio: 'ignore' });
  return dir;
}

function commit(dir, subject, body = '') {
  const args = ['commit', '--allow-empty', '-m', subject];
  if (body) args.push('-m', body);
  execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
}

function tag(dir, name) {
  execFileSync('git', ['tag', name], { cwd: dir, stdio: 'ignore' });
}

function runVersion(dir, ...args) {
  return execFileSync('node', ['scripts/version.mjs', ...args], {
    cwd: dir,
    encoding: 'utf8',
  }).trim();
}

afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop(), { recursive: true, force: true });
});

describe('scripts/version.mjs SemVer calculation and release notes', () => {
  it('returns package.json version (0.1.0) when no vX.Y.Z tag exists yet', () => {
    const emptyRepo = createRepo();
    expect(runVersion(emptyRepo)).toBe('0.1.0');

    const untaggedRepo = createRepo();
    commit(untaggedRepo, 'feat: bootstrap archive');
    expect(runVersion(untaggedRepo)).toBe('0.1.0');
  });

  it.each([
    'fix: handle empty episode title',
    'perf: cache search results',
    'docs: clarify deployment steps',
    'chore: tidy snapshot script',
    'update archive copy without prefix',
  ])('bumps patch (0.1.0 -> 0.1.1) for "%s" after tag v0.1.0', (subject) => {
    const dir = createRepo();
    commit(dir, 'chore: initial release');
    tag(dir, 'v0.1.0');
    commit(dir, subject);

    expect(runVersion(dir)).toBe('0.1.1');
  });

  it('bumps minor (0.1.0 -> 0.2.0) for feat(ui) commits and formats scoped notes subjects', () => {
    const dir = createRepo();
    commit(dir, 'chore: initial release');
    tag(dir, 'v0.1.0');
    commit(dir, 'fix: align episode spacing');
    const featHash = commit(dir, 'feat(ui): add density selector');

    expect(runVersion(dir, '--notes', 'notes.md')).toBe('0.2.0');

    const notes = readFileSync(path.join(dir, 'notes.md'), 'utf8');
    expect(notes).toContain(`### Features\n- **ui:** add density selector (${featHash})`);
  });

  it.each([
    { label: 'feat!: prefix', subject: 'feat!: drop legacy api endpoint', body: '' },
    {
      label: 'BREAKING CHANGE: footer',
      subject: 'feat: redesign catalog query',
      body: 'Detailed rationale.\n\nBREAKING CHANGE: removes deprecated filter parameter',
    },
  ])('bumps major (0.1.0 -> 1.0.0) when $label appears after tag v0.1.0', ({ subject, body }) => {
    const dir = createRepo();
    commit(dir, 'chore: initial release');
    tag(dir, 'v0.1.0');
    commit(dir, 'fix: minor cleanup');
    commit(dir, subject, body);

    expect(runVersion(dir)).toBe('1.0.0');
  });

  it('ignores pre-release or suffixed tags after v0.1.0 without producing NaN', () => {
    const dir = createRepo();
    commit(dir, 'chore: initial release');
    tag(dir, 'v0.1.0');
    commit(dir, 'chore: prepare release candidate');
    tag(dir, 'v0.1.0-rc.1');
    tag(dir, 'v0.2.0-beta.1');
    commit(dir, 'fix: ignore pre-release tag suffix');

    expect(runVersion(dir)).toBe('0.1.1');
  });

  it.each(['preview-notes.md', 'notes.md'])(
    'writes %s with categorized sections and short commit hashes',
    (fileName) => {
      const dir = createRepo();
      commit(dir, 'chore: initial release');
      tag(dir, 'v0.1.0');

      const breakingHash = commit(dir, 'feat!: replace snapshot schema');
      const featHash = commit(dir, 'feat(ui): add year filter');
      const fixHash = commit(dir, 'fix: escape LIKE wildcards');
      const otherHash = commit(dir, 'docs: document worker routes');

      expect(runVersion(dir, '--notes', fileName)).toBe('1.0.0');

      const otherFile = fileName === 'preview-notes.md' ? 'notes.md' : 'preview-notes.md';
      expect(existsSync(path.join(dir, otherFile))).toBe(false);

      const content = readFileSync(path.join(dir, fileName), 'utf8');
      expect(content).toBe(
        [
          `### Breaking changes\n- replace snapshot schema (${breakingHash})\n`,
          `### Features\n- **ui:** add year filter (${featHash})\n`,
          `### Fixes\n- escape LIKE wildcards (${fixHash})\n`,
          `### Other changes\n- document worker routes (${otherHash})\n`,
        ].join('\n'),
      );
    },
  );
});

