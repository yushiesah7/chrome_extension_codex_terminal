// Native Messaging host 名（manifest / host manifest と一致させる）
const NATIVE_HOST_NAME = 'com.yushi.chrome_extension_codex_terminal';

const terminalEl = document.getElementById('terminal'); // 出力表示
const inputEl = document.getElementById('input');
const statusEl = document.getElementById('status');
const connectBtn = document.getElementById('connectBtn');
const disconnectBtn = document.getElementById('disconnectBtn');
const cwdSelect = document.getElementById('cwdSelect');

/** @type {chrome.runtime.Port | null} */
let port = null;
let hasConnectedStatus = false; // hostからのstatusを受信したかどうか

// 端末出力（ANSIエスケープ等）を素朴に整形する。
// 注意: このUIは本格的なターミナルエミュレータではないため、TUIアプリ等は正しく表示できない。
function normalizeTerminalOutput(text) {
  if (typeof text !== 'string') return '';

  // 改行を統一（\r は進捗表示等に使われるが、このUIでは扱えないため改行扱いにする）
  let out = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  // ANSI escape sequences を除去（色・カーソル移動・bracketed paste 等）
  // - OSC: ESC ] ... BEL or ESC \
  out = out.replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, '');
  // - CSI: ESC [ ... cmd
  out = out.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '');
  // - 1文字ESC（例: ESC c など）
  out = out.replace(/\u001b[@-Z\\-_]/g, '');

  return out;
}

// 出力を追記し、スクロールを末尾にキープ
function appendTerminal(text) {
  terminalEl.textContent += text;
  terminalEl.scrollTop = terminalEl.scrollHeight;
}

function setStatus(text) {
  statusEl.textContent = text;
}

// UIの接続/切断状態をまとめて切り替え
function setConnectedState(connected) {
  connectBtn.disabled = connected;
  disconnectBtn.disabled = !connected;
  inputEl.disabled = !connected;
  cwdSelect.disabled = connected;
}

// ポートを閉じてUIを未接続状態に戻す
function disconnect() {
  if (port) {
    try {
      port.disconnect();
    } catch {
      // ignore
    }
  }
  port = null;
  setConnectedState(false);
  setStatus('未接続');
}

// Native Hostに接続し、statusを待ってから接続完了扱いにする
async function connect() {
  disconnect();

  setStatus('接続中...');

  port = chrome.runtime.connectNative(NATIVE_HOST_NAME);

  hasConnectedStatus = false;
  // Host→拡張のメッセージを受信
  port.onMessage.addListener((msg) => {
    if (!msg || typeof msg !== 'object') return;

    if (msg.type === 'output' && typeof msg.data === 'string') {
      appendTerminal(normalizeTerminalOutput(msg.data));
      return;
    }

    if (msg.type === 'status' && typeof msg.text === 'string') {
      setStatus(msg.text);
      if (!hasConnectedStatus) {
        hasConnectedStatus = true;
        setConnectedState(true);
        inputEl.focus();
      }
      return;
    }

    if (msg.type === 'exit') {
      setStatus('セッション終了');
      setConnectedState(false);
      return;
    }
  });

  // 切断時にlastErrorを確認し、UIをリセット
  port.onDisconnect.addListener(() => {
    const err = chrome.runtime.lastError?.message;
    disconnect();
    if (err) setStatus(`切断: ${err}`);
  });

  const cwd = cwdSelect.value;
  // UI上の選択肢は限定しているが、DevTools等でDOMを改変すれば任意値を送れる。
  // 実際の検証は Host 側（isAllowedCwd）で行う。
  port.postMessage({ type: 'start', cwd });

  // 接続試行中。実際の接続完了は status メッセージ受信で更新。
}

connectBtn.addEventListener('click', connect);
disconnectBtn.addEventListener('click', disconnect);

// Enterで1行送信。送信前にエコーバックを出力。
inputEl.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  if (!port) return;

  const line = inputEl.value;
  inputEl.value = '';

  port.postMessage({ type: 'input', data: `${line}\n` });
});

// Start disconnected
setConnectedState(false);
