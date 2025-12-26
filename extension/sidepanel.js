// Native Messaging host 名（manifest / host manifest と一致させる）
const NATIVE_HOST_NAME = 'com.yushi.chrome_extension_codex_terminal';

const STORAGE_KEY_PENDING = 'pendingCodexAsk';
const STORAGE_KEY_KEEP_SESSION = 'codexKeepSession';
const STORAGE_KEY_THREAD_ID = 'codexThreadId';

const statusEl = document.getElementById('status');
const connectBtn = document.getElementById('connectBtn');
const disconnectBtn = document.getElementById('disconnectBtn');

const questionEl = document.getElementById('question');
const askBtn = document.getElementById('askBtn');
const clearBtn = document.getElementById('clearBtn');

const keepSessionEl = document.getElementById('keepSession');
const sessionMetaEl = document.getElementById('sessionMeta');
const newSessionBtn = document.getElementById('newSessionBtn');

const selectionEl = document.getElementById('selection');
const answerEl = document.getElementById('answer');
const pageUrlEl = document.getElementById('pageUrl');

/** @type {chrome.runtime.Port | null} */
let port = null;
let hasConnectedStatus = false; // hostからのstatusを受信したかどうか
let isRunning = false;

/** @type {boolean} */
let keepSession = true;
/** @type {string} */
let threadId = '';

function safeString(value) {
  return typeof value === 'string' ? value : '';
}

function setStatus(text) {
  statusEl.textContent = text;
}

function updateSessionMeta() {
  if (!keepSession) {
    sessionMetaEl.textContent = 'session: OFF';
    return;
  }
  if (!threadId) {
    sessionMetaEl.textContent = 'session: (new)';
    return;
  }
  sessionMetaEl.textContent = `session: ${threadId.slice(0, 8)}…`;
}

function setConnectedState(connected) {
  connectBtn.disabled = connected;
  disconnectBtn.disabled = !connected;
  askBtn.disabled = !connected || isRunning;
  clearBtn.disabled = isRunning;
  keepSessionEl.disabled = isRunning;
  newSessionBtn.disabled = isRunning;
}

function setRunningState(running) {
  isRunning = running;
  askBtn.disabled = !port || running;
  clearBtn.disabled = running;
  keepSessionEl.disabled = running;
  newSessionBtn.disabled = running;
}

async function saveKeepSession() {
  await chrome.storage.session.set({ [STORAGE_KEY_KEEP_SESSION]: keepSession });
}

async function saveThreadId(nextThreadId) {
  threadId = safeString(nextThreadId);
  if (keepSession && threadId) {
    await chrome.storage.session.set({ [STORAGE_KEY_THREAD_ID]: threadId });
  }
  updateSessionMeta();
}

async function clearThreadId() {
  threadId = '';
  await chrome.storage.session.remove(STORAGE_KEY_THREAD_ID);
  updateSessionMeta();
}

function disconnect() {
  setRunningState(false);
  if (port) {
    try {
      port.disconnect();
    } catch {
      // ignore
    }
  }
  port = null;
  hasConnectedStatus = false;
  setConnectedState(false);
  setStatus('未接続');
}

function resetAnswer() {
  answerEl.textContent = '';
}

function appendAnswer(text) {
  answerEl.textContent += text;
  // keep scroll at bottom
  answerEl.scrollTop = answerEl.scrollHeight;
}

function buildPrompt({ question, selectionText, pageUrl }) {
  const q = safeString(question).trim() || 'なんだこれは？';
  const selection = safeString(selectionText).trim();
  const url = safeString(pageUrl).trim();

  return [
    'あなたは優秀なソフトウェア/ITアシスタントです。',
    'ユーザーがブラウザ上で選択したテキストについて質問します。',
    '日本語で、初心者にも分かるように説明してください。必要なら箇条書きで。',
    '',
    '## 質問',
    q,
    '',
    '## 選択テキスト',
    selection || '（なし）',
    '',
    '## 出典URL',
    url || '（不明）'
  ].join('\n');
}

function handleHostMessage(msg) {
  if (!msg || typeof msg !== 'object') return;

  if (msg.type === 'status' && typeof msg.text === 'string') {
    setStatus(msg.text);
    if (!hasConnectedStatus) {
      hasConnectedStatus = true;
      setConnectedState(true);
    }
    return;
  }

  if (msg.type === 'codex_thread' && typeof msg.id === 'string') {
    if (keepSession && msg.id.trim()) {
      saveThreadId(msg.id.trim()).catch(() => {});
    }
    return;
  }

  if (msg.type === 'codex_chunk' && typeof msg.data === 'string') {
    appendAnswer(msg.data);
    return;
  }

  if (msg.type === 'codex_done') {
    setRunningState(false);
    return;
  }

  if (msg.type === 'codex_error' && typeof msg.text === 'string') {
    appendAnswer(`\n\n[Error]\n${msg.text}\n`);
    setRunningState(false);
  }
}

async function connect() {
  disconnect();
  setStatus('接続中...');

  port = chrome.runtime.connectNative(NATIVE_HOST_NAME);
  hasConnectedStatus = false;

  port.onMessage.addListener(handleHostMessage);

  port.onDisconnect.addListener(() => {
    const err = chrome.runtime.lastError?.message;
    disconnect();
    if (err) setStatus(`切断: ${err}`);
  });

  // 接続完了は status メッセージ受信で更新。
}

async function askCodex({ auto } = {}) {
  if (!port) {
    if (auto) {
      await connect();
    } else {
      setStatus('未接続です（先に「接続」を押してください）');
      return;
    }
  }
  if (!port) return;

  const selectionText = selectionEl.value;
  const question = questionEl.value;
  const pageUrl = pageUrlEl.textContent || '';

  if (!safeString(question).trim() && !safeString(selectionText).trim()) {
    setStatus('質問か選択テキストが必要です');
    return;
  }

  resetAnswer();
  setRunningState(true);
  setStatus('Codexに問い合わせ中...');

  const prompt = buildPrompt({ question, selectionText, pageUrl });
  const payload = { type: 'codex', prompt };
  if (keepSession && threadId) payload.threadId = threadId;
  port.postMessage(payload);
}

async function loadPendingAsk() {
  const { pendingCodexAsk } = await chrome.storage.session.get(STORAGE_KEY_PENDING);
  if (!pendingCodexAsk || typeof pendingCodexAsk !== 'object') return;

  const selectionText =
    typeof pendingCodexAsk.selectionText === 'string' ? pendingCodexAsk.selectionText : '';
  const pageUrl = typeof pendingCodexAsk.pageUrl === 'string' ? pendingCodexAsk.pageUrl : '';
  const question = typeof pendingCodexAsk.question === 'string' ? pendingCodexAsk.question : '';
  const autoAsk = pendingCodexAsk.autoAsk === true;

  // 先に消しておく（sidepanelが再ロードされた時に二重実行しないため）
  await chrome.storage.session.remove(STORAGE_KEY_PENDING);

  selectionEl.value = selectionText;
  pageUrlEl.textContent = pageUrl;
  if (question) questionEl.value = question;

  if (autoAsk && (selectionText.trim() || safeString(question).trim())) {
    await askCodex({ auto: true });
  }
}

keepSessionEl.addEventListener('change', () => {
  keepSession = keepSessionEl.checked;
  updateSessionMeta();
  saveKeepSession().catch(() => {});
  if (!keepSession) {
    clearThreadId().catch(() => {});
  }
});

newSessionBtn.addEventListener('click', () => {
  clearThreadId()
    .then(() => {
      resetAnswer();
      setStatus(port ? '接続中' : '未接続');
    })
    .catch(() => {});
});

connectBtn.addEventListener('click', connect);
disconnectBtn.addEventListener('click', disconnect);

askBtn.addEventListener('click', () => {
  askCodex({ auto: false });
});

clearBtn.addEventListener('click', () => {
  selectionEl.value = '';
  pageUrlEl.textContent = '';
  resetAnswer();
  setStatus(port ? '接続中' : '未接続');
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'pendingCodexAskUpdated') {
    loadPendingAsk();
  }
});

async function init() {
  const data = await chrome.storage.session.get([STORAGE_KEY_KEEP_SESSION, STORAGE_KEY_THREAD_ID]);

  keepSession = data[STORAGE_KEY_KEEP_SESSION] !== false;
  keepSessionEl.checked = keepSession;

  threadId = keepSession ? safeString(data[STORAGE_KEY_THREAD_ID]) : '';
  updateSessionMeta();

  // 初期値
  questionEl.value = 'なんだこれは？';
  setConnectedState(false);

  // sidepanelを開いた時に pending があれば拾う
  await loadPendingAsk();
}

init();

