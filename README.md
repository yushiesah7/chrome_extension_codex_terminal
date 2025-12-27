# chrome_extension_codex_terminal

Chrome 拡張（MV3 / Side Panel）から Native Messaging を使ってローカルの `codex`（Codex CLI）を実行し、
**ブラウザ上で選択したテキストをそのままCodexに質問して、回答をサイドパネルに表示**するためのプロジェクトです。

- 拡張の Native Host 名: `com.yushi.chrome_extension_codex_terminal`
- 対応OS: macOS（まずはここを前提）

## これ何？（初心者向け）

Chrome拡張は、セキュリティ上の理由から **勝手にPC上のコマンド（`codex` や `zsh`）を直接実行できません**。

そこでこのプロジェクトでは、Chromeが用意している仕組み（Native Messaging）を使って、

1. **拡張（ブラウザ側）**: 右クリックで「選択範囲」を取り出す
2. **Native Host（PC側）**: 受け取った文字列を `codex` に渡して実行する
3. **拡張（ブラウザ側）**: 返ってきた回答をサイドパネルに表示する

という流れを作っています。

## ディレクトリ構成

- `extension/`：Chrome 拡張（Side Panel UI）
- `native_host/`：Native Messaging Host（Node.js + `node-pty`）

## セットアップ（macOS / Chrome）

前提：
- Node.js（推奨: nvm など）
- ローカルで `codex` コマンドが動く（ターミナルで `codex --help` が通ること）
- `node-pty` ビルド用に Xcode Command Line Tools が必要な場合あり（未導入なら `xcode-select --install`）

補足：`npm ci` / `npm install` が必要なのは `native_host/` 側だけです（`extension/` はそのままChromeに読み込む）。

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
同様に `codex` も、host側で「よくある場所（nvm / Homebrew / PATH）」の順に探索します。

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
3. ページ上の適当な文章をドラッグして選択
4. 右クリック → **「Codexに聞く（選択範囲）」**
5. サイドパネルが開き、回答が表示されればOK

補足：
- サイドパネルの「会話を続ける」がONなら、同じCodexセッションを `codex exec resume` で再開して連続で質問できます（Chromeを閉じるまで）。「新しい会話」でリセットできます。
- 回答はMarkdownをHTMLに変換して表示します（コードブロック/箇条書き/リンク等がそれっぽく見えます）。

（手動でやる場合）
1. 拡張アイコンをクリック（サイドパネルを開く）
2. 「接続」を押す
3. 選択テキスト欄に貼り付けて「Codexに聞く」

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

### `codex` が見つからない / 実行できない

サイドパネルにエラーが出る場合は、まずターミナルで `codex` が起動できるか確認してください。

- `which codex` で場所が出るか
- `codex --help` が動くか

Chrome（GUI）経由は `PATH` が薄いので、`codex` を Homebrew で入れている場合は
`/opt/homebrew/bin/codex`（Apple Silicon）や `/usr/local/bin/codex`（Intel）にあるかも確認してください。

### `起動失敗: Error: posix_spawnp failed.`

`node-pty` の `spawn-helper`（内部バイナリ）に実行権が付いていない場合に発生します。

```bash
cd native_host
npm ci
```

すでに依存を入れている場合は以下でもOKです：

```bash
cd native_host
npm run postinstall
```

### `node-pty` のインストールに失敗する

- Xcode Command Line Tools が未導入の場合は導入する（`xcode-select --install`）
- Node バージョンを切り替えた後は `native_host/node_modules` を作り直す（`rm -rf native_host/node_modules && (cd native_host && npm ci)`）

## 仕様メモ

- Native Host は作業ディレクトリをホワイトリストで制限します（`/tmp/chrome_extension_codex_terminal` と `~/Downloads`）。
- Codexへの問い合わせは `codex exec` を使い、作業ディレクトリは `/tmp/chrome_extension_codex_terminal` 固定（読み取り専用サンドボックス）にしています。
