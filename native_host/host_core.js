import os from 'node:os';
import path from 'node:path';

export const DEFAULT_WORKDIR = '/tmp/chrome_extension_codex_terminal';

export function getAllowedCwdRoots() {
  return [DEFAULT_WORKDIR, path.join(os.homedir(), 'Downloads')];
}

export function resolveCwd(cwdRaw) {
  const fallback = DEFAULT_WORKDIR;
  if (!cwdRaw || typeof cwdRaw !== 'string') return fallback;

  let expanded = cwdRaw;
  if (expanded.startsWith('~/')) {
    expanded = path.join(os.homedir(), expanded.slice(2));
  }

  if (!path.isAbsolute(expanded)) return fallback;

  return path.resolve(expanded);
}

export function isAllowedCwd(resolvedCwd, allowedRoots = getAllowedCwdRoots()) {
  if (!resolvedCwd || typeof resolvedCwd !== 'string') return false;

  const target = path.resolve(resolvedCwd);

  for (const root of allowedRoots) {
    if (!root) continue;
    const normalizedRoot = path.resolve(root);
    if (target === normalizedRoot) return true;
    if (target.startsWith(normalizedRoot + path.sep)) return true;
  }

  return false;
}
