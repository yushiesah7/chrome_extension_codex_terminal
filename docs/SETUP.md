# セットアップ（macOS）

作成日時：2025-12-26 19:22（UTC+09:00）

## 目的

- Chrome拡張（Side Panel）から Native Messaging 経由でローカルの `codex`（Codex CLI）を実行し、選択テキストについて質問して回答を表示する。

## 事前条件

- Node.js が入っている（推奨: nvm 等）
- Chrome（Manifest V3）
- ローカルで `codex` コマンドが動く（ターミナルで `codex --help` が通ること）
- `node-pty` のビルド用に Xcode Command Line Tools が必要な場合あり（未導入なら `xcode-select --install`）

## 1. Native Host を準備

Native Host の依存関係を入れる：

```bash
cd native_host
npm ci # または npm install
```

補足：`npm ci` / `npm install` が必要なのは `native_host/` 側だけです（`extension/` はそのままChromeに読み込む）。

Native host を実行可能にする：

```bash
chmod +x native_host/run_host.sh
```

補足：Chrome（GUI）経由で Native Host を起動すると `PATH` が最小構成になり、nvm の `node` を見つけられないことがあります。`native_host/run_host.sh` は nvm / Homebrew / `PATH` の順で `node` を探索して起動します。

## 2. Chrome に拡張を読み込む

1. `chrome://extensions` を開く
2. 右上の「デベロッパーモード」をON
3. 「パッケージ化されていない拡張機能を読み込む」
4. このリポジトリの `extension/` を選ぶ
5. 拡張の「ID」を控える

## 3. Native Messaging host を登録

1. `native_host/com.yushi.chrome_extension_codex_terminal.json.template` をコピーして `.json` を作る
2. `__EXTENSION_ID__` を手順2で控えた拡張IDに置き換える
3. `path` をこのリポジトリ内の `native_host/run_host.sh` の **絶対パス**に置き換える
4. その `.json` を次へ配置する

```text
~/Library/Application Support/Google/Chrome/NativeMessagingHosts/
```

## 4. 動作確認

1. Chromeで任意のページを開く
2. ページ上の文章をドラッグして選択
3. 右クリック → **「Codexに聞く（選択範囲）」**
4. サイドパネルが開き、回答が表示されればOK

補足：サイドパネルの「会話を続ける」がONなら、続けて質問すると（前回までのQ&Aを含めて）回答できます。履歴は「履歴クリア」で消せます。

（手動でやる場合）
1. 拡張アイコンをクリック（サイドパネルが開く）
2. サイドパネルで「接続」を押す
3. 選択テキスト欄に貼り付けて「Codexに聞く」

## トラブルシュート

- サイドパネルが開かない：Chromeを最新にし、拡張の権限エラーがないか確認
- 接続できない：Native host の `.json` の `allowed_origins`（拡張ID）と `path` が正しいか確認
- `run_host.sh` が起動しない：`chmod +x` 済みか確認
- `Failed to start native messaging host.`：`PATH` が薄い状況を `env -i HOME="$HOME" PATH=/usr/bin:/bin:/usr/sbin:/sbin native_host/run_host.sh` で再現して原因を切り分ける
- `起動失敗: Error: posix_spawnp failed.`：`cd native_host && npm run postinstall`（または `npm ci`）で `node-pty` の `spawn-helper` 実行権を修正する
