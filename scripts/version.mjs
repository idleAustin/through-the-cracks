// Works out the app version from git: the latest vX.Y.Z tag, bumped by every commit since it.
//   type!: or BREAKING CHANGE in the body → major
//   feat:                                 → minor
//   anything else (fix, perf, docs, chore, ci, test, …, or no prefix) → patch
// Every change cuts a release, so each version is a tag you can check out to go back to that state.
// With no tag yet, package.json's version is the first release.
//
// Usage: node scripts/version.mjs [--notes <file>]   prints the version; --notes writes its release notes.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const BUMPS = ['patch', 'minor', 'major'];
const SECTIONS = ['Breaking changes', 'Features', 'Fixes', 'Other changes'];

const git = (...args) => execFileSync('git', args, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();

function packageVersion() {
  try {
    return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version || '0.1.0';
  } catch {
    return '0.1.0';
  }
}

const SEMVER_TAG = /^v\d+\.\d+\.\d+$/;

function latestTag() {
  try {
    const tags = git('tag', '--merged', 'HEAD', '--sort=-v:refname', 'v[0-9]*.[0-9]*.[0-9]*');
    return tags.split(/\r?\n/).map(t => t.trim()).find(t => SEMVER_TAG.test(t)) || null;
  } catch {
    return null;
  }
}

/** Each non-merge commit in `range` with the bump it asks for and the notes section it belongs to. */
function commits(range) {
  const log = git('log', '--no-merges', '--format=%h%x1f%s%x1f%b%x1e', ...(range ? [range] : []));
  return log.split('\x1e').map(entry => entry.trim()).filter(Boolean).map(entry => {
    const [hash, subject, body = ''] = entry.split('\x1f');
    const match = subject.match(/^(\w+)(?:\(([^)]*)\))?(!)?:\s*(.+)$/);
    const type = match?.[1];
    const scope = match?.[2];
    const description = match ? match[4] : subject;
    const breaking = Boolean(match?.[3]) || /^BREAKING[ -]CHANGE:/m.test(body);
    const bump = breaking ? 'major' : type === 'feat' ? 'minor' : 'patch';
    const section = breaking ? 'Breaking changes'
      : type === 'feat' ? 'Features'
      : type === 'fix' || type === 'perf' ? 'Fixes'
      : 'Other changes';
    return { hash, subject: scope ? `**${scope}:** ${description}` : description, bump, section };
  });
}

function bumped(version, bump) {
  const [major, minor, patch] = version.split('.').map(Number);
  if (bump === 'major') return `${major + 1}.0.0`;
  if (bump === 'minor') return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

/** The version this commit ships as, and the notes for what changed since the last release. */
function release() {
  try {
    git('rev-parse', '--verify', 'HEAD');
  } catch {
    return { version: packageVersion(), notes: '' }; // No repo or no commits yet, e.g. a Docker build.
  }
  const tag = latestTag();
  const changes = commits(tag ? `${tag}..HEAD` : null);
  const bump = changes.reduce((top, { bump }) => BUMPS.indexOf(bump) > BUMPS.indexOf(top) ? bump : top, null);
  const version = !tag ? packageVersion() : bump ? bumped(tag.slice(1), bump) : tag.slice(1);
  const notes = SECTIONS.map(section => {
    const lines = changes.filter(commit => commit.section === section).map(commit => `- ${commit.subject} (${commit.hash})`);
    return lines.length ? `### ${section}\n${lines.join('\n')}\n` : '';
  }).filter(Boolean).join('\n');
  return { version, notes };
}

const { version, notes } = release();
const notesIndex = process.argv.indexOf('--notes');
if (notesIndex !== -1) {
  const target = process.argv[notesIndex + 1] === 'preview-notes.md' ? '../preview-notes.md' : '../notes.md';
  writeFileSync(new URL(target, import.meta.url), notes);
}
console.log(version);
