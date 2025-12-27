#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

find_node() {
  # Chrome（GUI）から起動されると PATH が最小構成になり、nvm の node が見つからないことがある。
  # まずは nvm の default を優先し、なければ一般的な場所を探す。

  version_to_tuple() {
    local v="${1#v}"
    local major="" minor="" patch=""
    IFS='.' read -r major minor patch <<< "$v"
    major="${major:-0}"
    minor="${minor:-0}"
    patch="${patch:-0}"
    printf '%s %s %s\n' "$major" "$minor" "$patch"
  }

  choose_best_nvm_node() {
    local nvm_dir="$1"
    local require_codex="$2"

    local best_node=""
    local best_major=-1
    local best_minor=-1
    local best_patch=-1

    local node_bin=""
    for node_bin in "$nvm_dir"/versions/node/v*/bin/node; do
      [[ -x "$node_bin" ]] || continue
      local ver_dir="${node_bin%/bin/node}"
      local ver="${ver_dir##*/}" # e.g. v22.12.0
      local codex_bin="${ver_dir}/bin/codex"
      if [[ "$require_codex" == "1" && ! -x "$codex_bin" ]]; then
        continue
      fi

      local major minor patch
      read -r major minor patch <<<"$(version_to_tuple "$ver")"
      major=$((10#$major))
      minor=$((10#$minor))
      patch=$((10#$patch))

      if (( major > best_major || (major == best_major && minor > best_minor) || (major == best_major && minor == best_minor && patch > best_patch) )); then
        best_node="$node_bin"
        best_major="$major"
        best_minor="$minor"
        best_patch="$patch"
      fi
    done

    [[ -n "$best_node" ]] || return 1
    printf '%s\n' "$best_node"
    return 0
  }

  if [[ -n "${HOME:-}" ]]; then
    local nvm_dir="${NVM_DIR:-$HOME/.nvm}"
    local default_version=""

    if [[ -f "$nvm_dir/alias/default" ]]; then
      default_version="$(tr -d '\r\n' < "$nvm_dir/alias/default" 2>/dev/null || true)"
    fi

    # default が存在し、かつそのバージョンに codex が入っているなら優先する
    if [[ "$default_version" == v* && -x "$nvm_dir/versions/node/$default_version/bin/node" ]]; then
      if [[ -x "$nvm_dir/versions/node/$default_version/bin/codex" ]]; then
        printf '%s\n' "$nvm_dir/versions/node/$default_version/bin/node"
        return 0
      fi
    fi

    # codex が入っている node を優先（複数ある場合は最新）
    local best=""
    best="$(choose_best_nvm_node "$nvm_dir" 1 || true)"
    if [[ -n "$best" ]]; then
      printf '%s\n' "$best"
      return 0
    fi

    # fallback: 最新の node を使う（codex が見つからない環境向け）
    best="$(choose_best_nvm_node "$nvm_dir" 0 || true)"
    if [[ -n "$best" ]]; then
      printf '%s\n' "$best"
      return 0
    fi
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

export PATH="$(dirname "$NODE_BIN"):${PATH:-}"
exec "$NODE_BIN" "$SCRIPT_DIR/host.js"
