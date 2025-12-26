// Native Messaging host 名（manifest / host manifest と一致させる）
const NATIVE_HOST_NAME = 'com.yushi.chrome_extension_codex_terminal';

const terminalEl = document.getElementById('terminal'); // xterm コンテナ
const statusEl = document.getElementById('status');
const connectBtn = document.getElementById('connectBtn');
const disconnectBtn = document.getElementById('disconnectBtn');
const cwdSelect = document.getElementById('cwdSelect');

/** @type {chrome.runtime.Port | null} */
let port = null;
let hasConnectedStatus = false; // hostからのstatusを受信したかどうか

/** @type {Terminal | null} */
let term = null;
/** @type {FitAddon.FitAddon | null} */
let fitAddon = null;
/** @type {ResizeObserver | null} */
let resizeObserver = null;

function setStatus(text) {
  statusEl.textContent = text;
}

// UIの接続/切断状態をまとめて切り替え
function setConnectedState(connected) {
  connectBtn.disabled = connected;
  disconnectBtn.disabled = !connected;
  cwdSelect.disabled = connected;
  if (term) term.options.disableStdin = !connected;
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

function ensureTerminal() {
  if (term) return;

  if (typeof Terminal !== 'function') {
    setStatus('エラー: xterm.js の読み込みに失敗しました');
    return;
  }

  term = new Terminal({
    cursorBlink: true,
    convertEol: true,
    scrollback: 3000,
    disableStdin: true,
    theme: {
      background: '#0b0d10',
      foreground: '#e6edf3'
    }
  });

  fitAddon = new FitAddon.FitAddon();
  term.loadAddon(fitAddon);

  term.open(terminalEl);
  fitAddon.fit();

  // Terminal -> Host（キー入力をそのまま送る）
  term.onData((data) => {
    if (!port) return;
    port.postMessage({ type: 'input', data });
  });

  // Terminal -> Host（画面サイズ変更）
  term.onResize(({ cols, rows }) => {
    if (!port) return;
    port.postMessage({ type: 'resize', cols, rows });
  });

  // コンテナのサイズ変化でフィット
  if (typeof ResizeObserver === 'function') {
    resizeObserver = new ResizeObserver(() => {
      if (fitAddon) fitAddon.fit();
    });
    resizeObserver.observe(terminalEl);
  } else {
    window.addEventListener('resize', () => {
      if (fitAddon) fitAddon.fit();
    });
  }
}

// Native Hostに接続し、statusを待ってから接続完了扱いにする
async function connect() {
  disconnect();
  ensureTerminal();

  setStatus('接続中...');

  port = chrome.runtime.connectNative(NATIVE_HOST_NAME);

  hasConnectedStatus = false;
  // Host→拡張のメッセージを受信
  port.onMessage.addListener((msg) => {
    if (!msg || typeof msg !== 'object') return;

    if (msg.type === 'output' && typeof msg.data === 'string') {
      if (term) term.write(msg.data);
      return;
    }

    if (msg.type === 'status' && typeof msg.text === 'string') {
      setStatus(msg.text);
      if (!hasConnectedStatus) {
        hasConnectedStatus = true;
        setConnectedState(true);
        if (fitAddon) fitAddon.fit();
        if (term) term.focus();
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
  port.postMessage({
    type: 'start',
    cwd,
    cols: term?.cols,
    rows: term?.rows
  });

  // 接続試行中。実際の接続完了は status メッセージ受信で更新。
}

connectBtn.addEventListener('click', connect);
disconnectBtn.addEventListener('click', disconnect);

// Start disconnected
setConnectedState(false);
