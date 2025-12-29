# Codex Terminal（Chrome拡張）仕様書

最終更新: 2025-12-29（JST）

## 1. 目的
ローカル環境の `codex` を、Chrome拡張のサイドパネルから実行して対話できるようにする。

- サイドパネルで質問を入力し、結果（Markdown）を表示する
- 画像添付に対応する
- 会話ログをMarkdownとしてエクスポートできる

## 2. ユーザー体験（UX）
### 2.1 何をする場所か
- このサイドパネルは「質問を入力して送信し、回答を読む」場所
- 設定からモデルやコマンド等を調整する

### 2.2 基本操作
- 質問入力: 下部の入力欄
- 送信: Enter または「送信」ボタン
- 改行: Shift+Enter
- 画像添付:
  - 添付ボタン
  - 画像の貼り付け
  - ドラッグ&ドロップ

## 3. 主要機能
### 3.1 チャット（Markdown表示）
- ユーザー入力とアシスタント出力をバブル表示
- 出力はMarkdownとしてレンダリング
- Mermaidコードブロックを検出してSVGレンダリング

### 3.2 画像添付
- 画像を最大4枚まで添付
- サイズ上限: 15MB（1枚あたり）
- 送信前に必要に応じて縮小してアップロード

### 3.3 設定
- プロンプトテンプレート
- モデル
- 推論レベル
- 起動CIコマンド
- CIリスタートコマンド

### 3.4 Markdownエクスポート
- 会話履歴をMarkdownとして出力
- 範囲指定:
  - 全て
  - 最新1件
  - 最新N件
  - 指定1件
- コピー/ダウンロード

## 4. データ/状態
- `chrome.storage.local`:
  - プロンプトテンプレート
  - CIコマンド
  - モデル
  - 推論レベル
  - effort caps
- `chrome.storage.session`:
  - threadId

## 5. Native Messaging
- Native Host: `com.yushi.chrome_extension_codex_terminal`
- サイドパネルからNative Hostに接続し、`codex` 実行を委譲する

## 6. 表示仕様（UI）
### 6.1 ヘッダー
- 接続状態/会話/モデル/推論をチップ表示
- 設定ボタンからメニューを開く

### 6.2 コンポーザー
- 添付ボタン
- 入力欄
- 送信ボタン
- クリアボタン

## 7. アクセシビリティ（方針）
- キーボード操作で主要操作が完結する
- `:focus-visible` のフォーカスリングを表示する

参考（閲覧: 2025-12-29）:
- Chrome拡張 UI / a11y: https://developer.chrome.com/docs/extensions/how-to/ui/a11y
- WCAG 2.2 Focus Visible: https://www.w3.org/WAI/WCAG22/Understanding/focus-visible.html

## 8. 制約/注意
- 画像添付には上限がある
- Native Messaging はローカル環境のセットアップが必要

## 9. トラブルシュート
- 接続ができない:
  - Native Hostのインストール/ホスト名一致を確認
- 送信できない:
  - 入力が空、または実行中の可能性

## 10. 用語
- threadId: Native Host側の会話スレッド識別子
- Mermaid: 図の記法。コードブロックからSVGを生成する
