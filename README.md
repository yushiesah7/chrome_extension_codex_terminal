# chrome_extension_codex_terminal

Chrome 拡張（MV3 / Side Panel）から Native Messaging を使ってローカルの `zsh` を起動し、サイドパネル内で入出力を表示するためのプロジェクトです。

- 拡張の Native Host 名: `com.yushi.chrome_extension_codex_terminal`
- 対応OS: macOS（まずはここを前提）

## ディレクトリ構成

- `extension/`：Chrome 拡張（Side Panel UI）
- `native_host/`：Native Messaging Host（Node.js + `node-pty`）

## セットアップ（macOS / Chrome）

前提：
- Node.js（推奨: nvm など）
- `node-pty` ビルド用に Xcode Command Line Tools が必要な場合あり（未導入なら `xcode-select --install`）

### 1) Chrome に拡張を読み込む

1. `chrome://extensions` を開く
2. 右上の「デベロッパーモード」を ON
3. 「パッケージ化されていない拡張機能を読み込む」→ `extension/` を選択
4. 表示される拡張の **ID**（例: `jcmkpaonbebopalhpaghpngobcghfhda`）を控える

### 2) Native Host を準備する

```bash
cd native_host
npm ci # または npm install
chmod +x run_host.sh
```

補足：Chrome（GUI）経由で Native Host を起動すると `PATH` が最小構成になり、nvm の `node` を見つけられないことがあります。`native_host/run_host.sh` は nvm / Homebrew / `PATH` の順で `node` を探索して起動します。

### 3) Native Messaging Host のマニフェストを配置する

Native Messaging Host のマニフェストを以下へ配置します：

```text
~/Library/Application Support/Google/Chrome/NativeMessagingHosts/
```

テンプレートから作成し、値を置き換えます：

```bash
mkdir -p "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
cp native_host/com.yushi.chrome_extension_codex_terminal.json.template \
  "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.yushi.chrome_extension_codex_terminal.json"
```

作成した `com.yushi.chrome_extension_codex_terminal.json` を編集して、以下を必ず設定します。

- `allowed_origins`: `__EXTENSION_ID__` を手順1の拡張IDに置換
- `path`: このリポジトリ内の `native_host/run_host.sh` の **絶対パス**に置換

### 4) 動作確認

1. Chrome を再起動
2. 任意のページを開く
3. 拡張アイコンをクリック（サイドパネルを開く）
4. サイドパネルで「接続」を押す
5. `echo hello` → Enter で出力が出ることを確認

## トラブルシューティング

### `Failed to start native messaging host.`

まず以下を確認してください。

- マニフェスト配置先が正しいか（`~/Library/Application Support/Google/Chrome/NativeMessagingHosts/`）
- マニフェストの `allowed_origins` が拡張IDと一致しているか
- マニフェストの `path` が実在するファイルを指しているか
- `native_host/run_host.sh` に実行権があるか（`chmod +x native_host/run_host.sh`）

Chrome から起動する時の最小環境（`PATH` が薄い状況）を手元で再現するには：

```bash
env -i HOME="$HOME" PATH=/usr/bin:/bin:/usr/sbin:/sbin \
  /absolute/path/to/native_host/run_host.sh
```

### `node-pty` のインストールに失敗する

- Xcode Command Line Tools が未導入の場合は導入する（`xcode-select --install`）
- Node バージョンを切り替えた後は `native_host/node_modules` を作り直す（`rm -rf native_host/node_modules && (cd native_host && npm ci)`）

## 仕様メモ

- Native Host は作業ディレクトリをホワイトリストで制限します（`/tmp/chrome_extension_codex_terminal` と `~/Downloads`）。
