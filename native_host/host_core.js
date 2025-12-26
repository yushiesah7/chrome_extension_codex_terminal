import os from 'node:os';
import path from 'node:path';

// 既定の作業ディレクトリ（/tmp配下。実行ユーザー専用権限で作成）
export const DEFAULT_WORKDIR = '/tmp/chrome_extension_codex_terminal';

// 許可する作業ディレクトリのルート一覧（必要最小限に固定）
export function getAllowedCwdRoots() {
  return [DEFAULT_WORKDIR, path.join(os.homedir(), 'Downloads')];
}

// CWD文字列を安全に解決する（~/ 展開・絶対パス以外はデフォルトへフォールバック）
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

// 許可されたルート配下にあるかを判定する（root自体とそのサブディレクトリを許可）
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
