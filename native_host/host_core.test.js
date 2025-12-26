import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

import { DEFAULT_WORKDIR, isAllowedCwd, resolveCwd } from './host_core.js';

test('resolveCwd: null/undefined falls back to DEFAULT_WORKDIR', () => {
  assert.equal(resolveCwd(undefined), DEFAULT_WORKDIR);
  assert.equal(resolveCwd(null), DEFAULT_WORKDIR);
});

test('resolveCwd: non-absolute path falls back to DEFAULT_WORKDIR', () => {
  assert.equal(resolveCwd('relative/path'), DEFAULT_WORKDIR);
});

test('resolveCwd: absolute path is normalized', () => {
  assert.equal(resolveCwd('/tmp/../tmp/foo'), path.resolve('/tmp/foo'));
});

test('resolveCwd: expands ~/ to home directory', () => {
  assert.equal(resolveCwd('~/Downloads'), path.join(os.homedir(), 'Downloads'));
});

test('isAllowedCwd: allows DEFAULT_WORKDIR and its descendants', () => {
  assert.equal(isAllowedCwd(DEFAULT_WORKDIR), true);
  assert.equal(isAllowedCwd(path.join(DEFAULT_WORKDIR, 'subdir')), true);
});

test('isAllowedCwd: rejects unrelated absolute path', () => {
  assert.equal(isAllowedCwd('/etc'), false);
  assert.equal(isAllowedCwd('/private/etc'), false);
});

test('isAllowedCwd: allows ~/Downloads resolved path', () => {
  const downloadsPath = path.join(os.homedir(), 'Downloads');
  assert.equal(isAllowedCwd(downloadsPath), true);
});
