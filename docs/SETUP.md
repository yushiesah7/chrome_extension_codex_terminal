# セットアップ（macOS）

作成日時：2025-12-26 19:22（UTC+09:00）

## 目的

- Chrome拡張（Side Panel）から Native Messaging 経由でローカル `zsh` を起動し、入出力を表示する。

## 事前条件

- Node.js が入っている
- Chrome（Manifest V3）

## 1. Native Host を準備

このディレクトリで依存関係を入れる：

```bash
npm install
```

Native host を実行可能にする：

```bash
chmod +x native_host/run_host.sh
```

## 2. Chrome に拡張を読み込む

1. `chrome://extensions` を開く
2. 右上の「デベロッパーモード」をON
3. 「パッケージ化されていない拡張機能を読み込む」
4. このリポジトリの `extension/` を選ぶ
5. 拡張の「ID」を控える

## 3. Native Messaging host を登録

1. `native_host/com.yushi.chrome_extension_codex_terminal.json.template` をコピーして `.json` を作る
2. `__EXTENSION_ID__` を手順2で控えた拡張IDに置き換える
3. その `.json` を次へ配置する

```text
~/Library/Application Support/Google/Chrome/NativeMessagingHosts/
```

## 4. 動作確認

1. Chromeで任意のページを開く
2. 拡張アイコンをクリック（サイドパネルが開く）
3. サイドパネルで「接続」を押す
4. `echo hello` を打って Enter
5. `codex` を打って起動できることを確認

## トラブルシュート

- サイドパネルが開かない：Chromeを最新にし、拡張の権限エラーがないか確認
- 接続できない：Native host の `.json` の `allowed_origins`（拡張ID）と `path` が正しいか確認
- `run_host.sh` が起動しない：`chmod +x` 済みか確認
