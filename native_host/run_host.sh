#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

find_node() {
  # Chrome（GUI）から起動されると PATH が最小構成になり、nvm の node が見つからないことがある。
  # まずは nvm の default を優先し、なければ一般的な場所を探す。

  if [[ -n "${HOME:-}" ]]; then
    local nvm_dir="${NVM_DIR:-$HOME/.nvm}"
    local default_version=""

    if [[ -f "$nvm_dir/alias/default" ]]; then
      default_version="$(tr -d '\r\n' < "$nvm_dir/alias/default" 2>/dev/null || true)"
    fi

    if [[ "$default_version" == v* && -x "$nvm_dir/versions/node/$default_version/bin/node" ]]; then
      printf '%s\n' "$nvm_dir/versions/node/$default_version/bin/node"
      return 0
    fi

    # fallback: どれか一つでも入っていればOK（node-ptyのABI互換は別途注意）
    local candidate=""
    for candidate in "$nvm_dir"/versions/node/v*/bin/node; do
      if [[ -x "$candidate" ]]; then
        printf '%s\n' "$candidate"
        return 0
      fi
    done
  fi

  # Homebrew / 典型的なパス
  if [[ -x "/opt/homebrew/bin/node" ]]; then
    printf '%s\n' "/opt/homebrew/bin/node"
    return 0
  fi
  if [[ -x "/usr/local/bin/node" ]]; then
    printf '%s\n' "/usr/local/bin/node"
    return 0
  fi

  # 最後に PATH から探す（Chrome経由でも /usr/bin:/bin は入っている想定）
  if command -v node >/dev/null 2>&1; then
    command -v node
    return 0
  fi

  return 1
}

NODE_BIN="$(find_node || true)"
if [[ -z "$NODE_BIN" ]]; then
  echo "run_host.sh: node が見つかりません（Chromeから起動する場合は nvm/homebrew のパスが必要です）" >&2
  exit 127
fi

exec "$NODE_BIN" "$SCRIPT_DIR/host.js"
