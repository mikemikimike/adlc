import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitTreeTicketStore } from '../index.mjs';
import { ticket, writeDirectory, writeLegacy } from './helpers.mjs';

const git = (cwd, args) => execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' }).trim();

test('GitTreeTicketStore reads exact legacy and directory revisions without worktree fallback', () => {
  const root = mkdtempSync(join(tmpdir(), 'adlc-tickets-git-'));
  try {
    git(root, ['init']); git(root, ['config', 'user.email', 'test@example.com']); git(root, ['config', 'user.name', 'Test']);
    writeLegacy(root, [ticket('A')]); git(root, ['add', '.']); git(root, ['commit', '-m', 'legacy']);
    const legacyRevision = git(root, ['rev-parse', 'HEAD']);
    rmSync(join(root, '.adlc/tickets.json'));
    writeDirectory(root, [ticket('A'), ticket('B')]); git(root, ['add', '-A']); git(root, ['commit', '-m', 'directory']);
    const directoryRevision = git(root, ['rev-parse', 'HEAD']);
    assert.deepEqual(new GitTreeTicketStore({ cwd: root, revision: legacyRevision }).load().tickets.map((item) => item.id), ['A']);
    assert.deepEqual(new GitTreeTicketStore({ cwd: root, revision: directoryRevision }).load().tickets.map((item) => item.id), ['A', 'B']);
    writeLegacy(root, [ticket('HOSTILE')]);
    assert.deepEqual(new GitTreeTicketStore({ cwd: root, revision: directoryRevision }).load().tickets.map((item) => item.id), ['A', 'B']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('GitTreeTicketStore rejects symlink and executable JSON entries from an exact revision', () => {
  const root = mkdtempSync(join(tmpdir(), 'adlc-tickets-git-mode-'));
  try {
    git(root, ['init']); git(root, ['config', 'user.email', 'test@example.com']); git(root, ['config', 'user.name', 'Test']);
    writeDirectory(root, [ticket('A')]);
    git(root, ['add', '.']); git(root, ['commit', '-m', 'directory']);
    const shard = git(root, ['ls-tree', '-r', '--name-only', 'HEAD', '--', '.adlc/tickets']).split('\n').find((path) => path !== '.adlc/tickets/.store.json');
    rmSync(join(root, shard));
    try {
      symlinkSync('.store.json', join(root, shard));
      git(root, ['add', '-A']);
    } catch (err) {
      if (process.platform === 'win32' && (err.code === 'EPERM' || err.code === 'ENOTSUP')) {
        const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: root, input: '.store.json', encoding: 'utf8' }).trim();
        git(root, ['update-index', '--add', '--cacheinfo', `120000,${blob},${shard}`]);
      } else {
        throw err;
      }
    }
    git(root, ['commit', '-m', 'symlink shard']);
    assert.throws(() => new GitTreeTicketStore({ cwd: root, revision: 'HEAD' }).load(), { code: 'UNSAFE_GIT_MODE' });

    rmSync(join(root, shard), { force: true });
    const execBlob = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: root, input: `${JSON.stringify(ticket('A'))}\n`, encoding: 'utf8' }).trim();
    git(root, ['update-index', '--add', '--cacheinfo', `100755,${execBlob},${shard}`]);
    git(root, ['commit', '-m', 'executable shard']);
    assert.throws(() => new GitTreeTicketStore({ cwd: root, revision: 'HEAD' }).load(), { code: 'UNSAFE_GIT_MODE' });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('GitTreeTicketStore rejects option-like revisions and resolves moving refs once', () => {
  const root = mkdtempSync(join(tmpdir(), 'adlc-tickets-git-revision-'));
  try {
    git(root, ['init']); git(root, ['config', 'user.email', 'test@example.com']); git(root, ['config', 'user.name', 'Test']);
    writeLegacy(root, [ticket('A')]); git(root, ['add', '.']); git(root, ['commit', '-m', 'first']);
    assert.throws(() => new GitTreeTicketStore({ cwd: root, revision: '--help' }), { code: 'UNSAFE_GIT_REVISION' });
    const store = new GitTreeTicketStore({ cwd: root, revision: 'HEAD' });
    assert.deepEqual(store.load().tickets.map((item) => item.id), ['A']);
    writeLegacy(root, [ticket('B')]); git(root, ['add', '.']); git(root, ['commit', '-m', 'second']);
    assert.deepEqual(store.load().tickets.map((item) => item.id), ['B']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('GitTreeTicketStore reports an unreadable blob object as an operational GIT_PATH_MISSING', () => {
  // A tree entry can name an object the local object database does not have
  // (partial clone, pruned or corrupt object). `cat-file -p` must be allowed to
  // fail so the store reports the operational absence rather than a raw git error.
  const root = mkdtempSync(join(tmpdir(), 'adlc-tickets-git-absent-'));
  try {
    git(root, ['init']); git(root, ['config', 'user.email', 'test@example.com']); git(root, ['config', 'user.name', 'Test']);
    writeDirectory(root, [ticket('A')]);
    git(root, ['add', '.']); git(root, ['commit', '-m', 'directory']);
    const record = git(root, ['ls-tree', '-r', 'HEAD', '--', '.adlc/tickets']).split('\n').find((line) => !line.endsWith('.store.json'));
    const object = record.split(/\s+/)[2];
    rmSync(join(root, '.git', 'objects', object.slice(0, 2), object.slice(2)));
    assert.throws(() => new GitTreeTicketStore({ cwd: root, revision: 'HEAD' }).load(), { kind: 'operational', code: 'GIT_PATH_MISSING' });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('GitTreeTicketStore loads ULID-length shard names (Windows show REV:path limit)', () => {
  // git-for-windows stats `SHA:path` as a filesystem path; ULID ticket filenames
  // push that past MAX_PATH and `git show` fails even though the blob exists.
  // Loading via cat-file + ls-tree OID must still succeed.
  const root = mkdtempSync(join(tmpdir(), 'adlc-tickets-git-long-'));
  try {
    git(root, ['init']); git(root, ['config', 'user.email', 'test@example.com']); git(root, ['config', 'user.name', 'Test']);
    const longId = 'T-01KYQR3X1BA9S26V9R978TCJYR';
    writeDirectory(root, [ticket(longId)]);
    git(root, ['add', '.']); git(root, ['commit', '-m', 'long shard']);
    const ids = new GitTreeTicketStore({ cwd: root, revision: 'HEAD' }).load().tickets.map((item) => item.id);
    assert.deepEqual(ids, [longId]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
