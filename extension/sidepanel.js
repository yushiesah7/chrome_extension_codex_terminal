// Native Messaging host 名（manifest / host manifest と一致させる）
const NATIVE_HOST_NAME = 'com.yushi.chrome_extension_codex_terminal';

const statusEl = document.getElementById('status');
const connectBtn = document.getElementById('connectBtn');
const disconnectBtn = document.getElementById('disconnectBtn');

const questionEl = document.getElementById('question');
const askBtn = document.getElementById('askBtn');
const clearBtn = document.getElementById('clearBtn');

const keepHistoryEl = document.getElementById('keepHistory');
const historyMetaEl = document.getElementById('historyMeta');
const clearHistoryBtn = document.getElementById('clearHistoryBtn');

const selectionEl = document.getElementById('selection');
const answerEl = document.getElementById('answer');
const pageUrlEl = document.getElementById('pageUrl');

const STORAGE_KEY_PENDING = 'pendingCodexAsk';
const STORAGE_KEY_KEEP_HISTORY = 'codexKeepHistory';
const STORAGE_KEY_CONVERSATION = 'codexConversation';

const MAX_HISTORY_TURNS_STORED = 20;
const MAX_HISTORY_TURNS_IN_PROMPT = 4;

/** @type {chrome.runtime.Port | null} */
let port = null;
let hasConnectedStatus = false; // hostからのstatusを受信したかどうか
let isRunning = false;

/** @type {boolean} */
let keepHistory = true;

/** @type {{question:string, selectionText:string, pageUrl:string, answer:string, createdAt:number}[]} */
let conversation = [];

/** @type {{question:string, selectionText:string, pageUrl:string, createdAt:number} | null} */
let currentRequest = null;
let currentAnswer = '';
let currentHadError = false;

function setStatus(text) {
  statusEl.textContent = text;
}

function setConnectedState(connected) {
  connectBtn.disabled = connected;
  disconnectBtn.disabled = !connected;
  askBtn.disabled = !connected || isRunning;
  clearBtn.disabled = isRunning;
  keepHistoryEl.disabled = isRunning;
  clearHistoryBtn.disabled = isRunning;
}

function setRunningState(running) {
  isRunning = running;
  askBtn.disabled = !port || running;
  clearBtn.disabled = running;
  keepHistoryEl.disabled = running;
  clearHistoryBtn.disabled = running;
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
  currentRequest = null;
  currentAnswer = '';
  currentHadError = false;
  setConnectedState(false);
  setStatus('未接続');
}

function safeString(value) {
  return typeof value === 'string' ? value : '';
}

function trimText(text, maxChars) {
  const s = safeString(text);
  if (s.length <= maxChars) return s;
  return s.slice(0, maxChars) + '\n…（省略）';
}

function updateHistoryMeta() {
  historyMetaEl.textContent = keepHistory ? `履歴: ${conversation.length}` : '履歴: OFF';
}

async function saveConversation() {
  if (!keepHistory) return;
  await chrome.storage.session.set({
    [STORAGE_KEY_CONVERSATION]: conversation.slice(-MAX_HISTORY_TURNS_STORED)
  });
}

async function clearConversation() {
  conversation = [];
  await chrome.storage.session.remove(STORAGE_KEY_CONVERSATION);
  updateHistoryMeta();
}

async function loadSettings() {
  const data = await chrome.storage.session.get([STORAGE_KEY_KEEP_HISTORY, STORAGE_KEY_CONVERSATION]);

  keepHistory = data[STORAGE_KEY_KEEP_HISTORY] !== false;
  keepHistoryEl.checked = keepHistory;

  const loaded = data[STORAGE_KEY_CONVERSATION];
  if (Array.isArray(loaded)) {
    conversation = loaded
      .filter((t) => t && typeof t === 'object')
      .map((t) => ({
        question: safeString(t.question),
        selectionText: safeString(t.selectionText),
        pageUrl: safeString(t.pageUrl),
        answer: safeString(t.answer),
        createdAt: Number.isFinite(t.createdAt) ? t.createdAt : Date.now()
      }))
      .slice(-MAX_HISTORY_TURNS_STORED);
  } else {
    conversation = [];
  }

  updateHistoryMeta();
}

function resetAnswer() {
  answerEl.textContent = '';
}

function appendAnswer(text) {
  answerEl.textContent += text;
  // keep scroll at bottom
  answerEl.scrollTop = answerEl.scrollHeight;
}

function formatHistoryForPrompt(history) {
  const turns = history.slice(-MAX_HISTORY_TURNS_IN_PROMPT);
  if (!turns.length) return '';

  return turns
    .map((t, i) => {
      const q = trimText(t.question, 400).trim();
      const a = trimText(t.answer, 3000).trim();
      const selection = trimText(t.selectionText, 1200).trim();
      const url = trimText(t.pageUrl, 300).trim();

      return [
        `### ${i + 1}`,
        '',
        `質問: ${q || '（空）'}`,
        '',
        '回答:',
        a || '（空）',
        '',
        '選択テキスト:',
        selection || '（空）',
        '',
        `URL: ${url || '（不明）'}`
      ].join('\n');
    })
    .join('\n\n---\n\n');
}

function buildPrompt({ question, selectionText, pageUrl, history }) {
  const q = safeString(question).trim() || 'なんだこれは？';
  const selection = safeString(selectionText).trim();
  const url = safeString(pageUrl).trim();

  const historyText = keepHistory ? formatHistoryForPrompt(history) : '';

  const lines = [
    'あなたは優秀なソフトウェア/ITアシスタントです。',
    'ユーザーがブラウザ上で選択したテキストについて質問します。',
    '日本語で、初心者にも分かるように説明してください。必要なら箇条書きで。',
    ''
  ];

  if (historyText) {
    lines.push('## 直近の会話履歴', historyText, '');
  }

  lines.push('## 今回の質問', q, '', '## 今回の選択テキスト', selection || '（なし）', '', '## 出典URL', url || '（不明）');

  return lines.join('\n');
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

  if (msg.type === 'codex_chunk' && typeof msg.data === 'string') {
    appendAnswer(msg.data);
    currentAnswer += msg.data;
    return;
  }

  if (msg.type === 'codex_done') {
    setRunningState(false);

    if (keepHistory && currentRequest && !currentHadError) {
      const answer = currentAnswer.trim();
      if (answer) {
        conversation.push({
          ...currentRequest,
          answer,
          createdAt: currentRequest.createdAt || Date.now()
        });
        conversation = conversation.slice(-MAX_HISTORY_TURNS_STORED);
        saveConversation().catch(() => {});
        updateHistoryMeta();
      }
    }

    currentRequest = null;
    currentAnswer = '';
    currentHadError = false;
    return;
  }

  if (msg.type === 'codex_error' && typeof msg.text === 'string') {
    currentHadError = true;
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
  const hasSelection = Boolean(selectionText.trim());
  const hasHistory = keepHistory && conversation.length > 0;
  const hasQuestion = Boolean(safeString(question).trim());

  if (!hasSelection && !hasHistory) {
    setStatus('選択テキストが空です（または履歴がありません）');
    return;
  }

  if (!hasSelection && !hasQuestion) {
    setStatus('質問が空です（選択テキストが無い場合は質問を入力してください）');
    return;
  }

  const pageUrl = pageUrlEl.textContent || '';

  resetAnswer();
  setRunningState(true);
  setStatus('Codexに問い合わせ中...');

  currentRequest = { question: safeString(question), selectionText, pageUrl, createdAt: Date.now() };
  currentAnswer = '';
  currentHadError = false;

  const prompt = buildPrompt({ question, selectionText, pageUrl, history: conversation });
  port.postMessage({ type: 'codex', prompt });
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

  if (autoAsk && selectionText.trim()) {
    await askCodex({ auto: true });
  }
}

keepHistoryEl.addEventListener('change', () => {
  keepHistory = keepHistoryEl.checked;
  updateHistoryMeta();
  chrome.storage.session.set({ [STORAGE_KEY_KEEP_HISTORY]: keepHistory }).catch(() => {});
  if (!keepHistory) {
    clearConversation().catch(() => {});
  }
});

clearHistoryBtn.addEventListener('click', () => {
  clearConversation().catch(() => {});
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

// 初期値
questionEl.value = 'なんだこれは？';
setConnectedState(false);

async function init() {
  await loadSettings();
  // sidepanelを開いた時に pending があれば拾う
  await loadPendingAsk();
}

init();
