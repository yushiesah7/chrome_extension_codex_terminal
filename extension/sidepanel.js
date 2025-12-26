const NATIVE_HOST_NAME = 'com.yushi.chrome_extension_codex_terminal';

const terminalEl = document.getElementById('terminal');
const inputEl = document.getElementById('input');
const statusEl = document.getElementById('status');
const connectBtn = document.getElementById('connectBtn');
const disconnectBtn = document.getElementById('disconnectBtn');
const cwdSelect = document.getElementById('cwdSelect');

/** @type {chrome.runtime.Port | null} */
let port = null;

function appendTerminal(text) {
  terminalEl.textContent += text;
  terminalEl.scrollTop = terminalEl.scrollHeight;
}

function setStatus(text) {
  statusEl.textContent = text;
}

function setConnectedState(connected) {
  connectBtn.disabled = connected;
  disconnectBtn.disabled = !connected;
  inputEl.disabled = !connected;
  cwdSelect.disabled = connected;
}

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

async function connect() {
  disconnect();

  setStatus('接続中...');

  try {
    port = chrome.runtime.connectNative(NATIVE_HOST_NAME);
  } catch (e) {
    setStatus(`接続失敗: ${String(e)}`);
    return;
  }

  port.onMessage.addListener((msg) => {
    if (!msg || typeof msg !== 'object') return;

    if (msg.type === 'output' && typeof msg.data === 'string') {
      appendTerminal(msg.data);
      return;
    }

    if (msg.type === 'status' && typeof msg.text === 'string') {
      setStatus(msg.text);
      return;
    }

    if (msg.type === 'exit') {
      setStatus('セッション終了');
      setConnectedState(false);
      return;
    }
  });

  port.onDisconnect.addListener(() => {
    const err = chrome.runtime.lastError?.message;
    disconnect();
    if (err) setStatus(`切断: ${err}`);
  });

  const cwd = cwdSelect.value;
  port.postMessage({ type: 'start', cwd });

  setConnectedState(true);
  setStatus('接続済み');
  inputEl.focus();
}

connectBtn.addEventListener('click', connect);
disconnectBtn.addEventListener('click', disconnect);

inputEl.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  if (!port) return;

  const line = inputEl.value;
  inputEl.value = '';

  // Show what the user typed
  appendTerminal(`❯ ${line}\n`);

  port.postMessage({ type: 'input', data: `${line}\n` });
});

// Start disconnected
setConnectedState(false);
