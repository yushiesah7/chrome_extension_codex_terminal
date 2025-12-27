// Native Messaging host 名（manifest / host manifest と一致させる）
const NATIVE_HOST_NAME = 'com.yushi.chrome_extension_codex_terminal';

const STORAGE_KEY_PENDING = 'pendingCodexAsk';
const STORAGE_KEY_THREAD_ID = 'codexThreadId';
const STORAGE_KEY_PROMPT_TEMPLATE = 'promptTemplate';
const STORAGE_KEY_START_CMD = 'startCommand';
const STORAGE_KEY_CI_START_CMD = 'ciStartCommand';
const STORAGE_KEY_CI_RESTART_CMD = 'ciRestartCommand';

const RAW_CHUNK_SIZE = 256 * 1024; // base64化しても1MB未満に収めやすいサイズ
const MAX_ATTACHMENTS = 4;
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;

const metaEl = document.getElementById('meta');
const statusEl = document.getElementById('status');
const settingsBtn = document.getElementById('settingsBtn');
const settingsMenu = document.getElementById('settingsMenu');
const settingsPanel = document.getElementById('settingsPanel');
const panelOverlay = document.getElementById('panelOverlay');
const panelTitleEl = document.getElementById('panelTitle');
const panelBodyEl = document.getElementById('panelBody');
const panelClose = document.getElementById('panelClose');

const chatEl = document.getElementById('chat');
const attachmentsEl = document.getElementById('attachments');
const dropZone = document.getElementById('dropZone');

const attachBtn = document.getElementById('attachBtn');
const fileInput = document.getElementById('fileInput');

const promptInput = document.getElementById('promptInput');
const clearBtn = document.getElementById('clearBtn');

/** @type {chrome.runtime.Port | null} */
let port = null;
let isConnected = false;
let isConnecting = false;
let isRunning = false;

/** @type {string} */
let threadId = '';

const DEFAULT_PROMPT_TEMPLATE = [
  '# 前提プロンプト',
  '記載された内容に対してわかりやすい説明をしてください。',
  'フローが必要な場合は簡易mermaidでわかりやすく挿入し、用語説明などはシンプルに解説してください。',
  '出力はMarkdownで、初心者にも分かるように日本語で書いてください。',
  '',
  '下記のライン以降がユーザーの質問（テキスト/選択/画像）です。',
  '-----------------------------------------------------------------------------------------------'
].join('\n');

/** @type {string} */
let promptTemplate = DEFAULT_PROMPT_TEMPLATE;

const DEFAULT_CODEX_CMD =
  'codex exec --skip-git-repo-check --sandbox read-only --color never --json -C /tmp/chrome_extension_codex_terminal';
const DEFAULT_CI_RESTART_CMD = 'npm run ci:restart';

/** @type {string} */
let ciStartCommand = DEFAULT_CODEX_CMD;

/** @type {string} */
let ciRestartCommand = DEFAULT_CI_RESTART_CMD;

/** @type {{id:string, file:File, previewUrl:string}[]} */
let attachments = [];

/** @type {{bubble:HTMLElement, buffer:string, hasStarted:boolean} | null} */
let currentAssistant = null;

/** @type {Map<string, {resolve:() => void, reject:(e:Error) => void, timer:number}>} */
const uploadWaiters = new Map();

/** @type {string} */
let pendingSelectionText = '';

/** @type {string} */
let pendingPageUrl = '';

function uploadKey(requestId, imageId) {
  return `${requestId}:${imageId}`;
}

function rejectAllUploadWaiters(reason) {
  for (const [, w] of uploadWaiters) {
    try {
      clearTimeout(w.timer);
    } catch {
      // ignore
    }
    w.reject(new Error(reason));
  }
  uploadWaiters.clear();
}

function safeString(value) {
  return typeof value === 'string' ? value : '';
}

function setStatus(text) {
  statusEl.textContent = text;
}

function toggleSettingsMenu(open) {
  if (!settingsMenu) return;
  const next = open ?? settingsMenu.hidden;
  settingsMenu.hidden = !next;
  settingsBtn?.setAttribute('aria-expanded', String(next));
}

let panelOpen = false;

function setPanelOpen(on) {
  panelOpen = !!on;
  if (settingsPanel) {
    settingsPanel.hidden = !panelOpen;
    // `aria-hidden` は focus が残っていると警告になるため、表示制御は hidden/inert に寄せる
    try {
      settingsPanel.inert = !panelOpen;
    } catch {
      // ignore
    }
  }
  if (panelOverlay) panelOverlay.hidden = !panelOpen;
}

function showPanel(title, buildBody) {
  if (!panelTitleEl || !panelBodyEl) return;
  panelTitleEl.textContent = title;
  panelBodyEl.innerHTML = '';
  buildBody(panelBodyEl);
  setPanelOpen(true);
}

function hidePanel() {
  // focus がパネル内に残ったまま閉じると `Blocked aria-hidden...` 系の警告が出るため、先に退避
  try {
    const active = document.activeElement;
    if (settingsPanel && active instanceof HTMLElement && settingsPanel.contains(active)) {
      (settingsBtn || promptInput)?.focus?.();
    }
  } catch {
    // ignore
  }
  setPanelOpen(false);
}

async function loadPromptTemplate() {
  try {
    const data = await chrome.storage.local.get([STORAGE_KEY_PROMPT_TEMPLATE]);
    const v = safeString(data[STORAGE_KEY_PROMPT_TEMPLATE]).trim();
    promptTemplate = v || DEFAULT_PROMPT_TEMPLATE;
  } catch {
    promptTemplate = DEFAULT_PROMPT_TEMPLATE;
  }
}

async function savePromptTemplate(value) {
  const v = safeString(value).trim() || DEFAULT_PROMPT_TEMPLATE;
  promptTemplate = v;
  try {
    await chrome.storage.local.set({ [STORAGE_KEY_PROMPT_TEMPLATE]: v });
  } catch {
    // ignore
  }
}

async function loadCiCommands() {
  try {
    const data = await chrome.storage.local.get([STORAGE_KEY_CI_START_CMD, STORAGE_KEY_CI_RESTART_CMD]);
    const start = safeString(data[STORAGE_KEY_CI_START_CMD]).trim();
    const restart = safeString(data[STORAGE_KEY_CI_RESTART_CMD]).trim();
    ciStartCommand = start || DEFAULT_CODEX_CMD;
    ciRestartCommand = restart || DEFAULT_CI_RESTART_CMD;
  } catch {
    ciStartCommand = DEFAULT_CODEX_CMD;
    ciRestartCommand = DEFAULT_CI_RESTART_CMD;
  }
}

async function saveCiStartCommand(value) {
  const v = safeString(value).trim() || DEFAULT_CODEX_CMD;
  ciStartCommand = v;
  try {
    await chrome.storage.local.set({ [STORAGE_KEY_START_CMD]: v, [STORAGE_KEY_CI_START_CMD]: v });
  } catch {
    // ignore
  }
}

async function saveCiRestartCommand(value) {
  const v = safeString(value).trim() || DEFAULT_CI_RESTART_CMD;
  ciRestartCommand = v;
  try {
    await chrome.storage.local.set({ [STORAGE_KEY_CI_RESTART_CMD]: v });
  } catch {
    // ignore
  }
}

function updateMeta() {
  const parts = [];
  parts.push(isConnected ? '接続: OK' : isConnecting ? '接続: ...' : '接続: NG');
  parts.push(`session: ${threadId ? threadId.slice(0, 8) + '…' : '(new)'}`);
  metaEl.textContent = parts.join(' / ');
}

function scrollToBottom() {
  chatEl.scrollTop = chatEl.scrollHeight;
}

function setSendEnabled() {
  const hasContent = promptInput.value.trim().length > 0 || attachments.length > 0;
  if (clearBtn) clearBtn.disabled = !hasContent;
}

function autoResizeTextarea() {
  promptInput.style.height = 'auto';
  const max = 180;
  promptInput.style.height = Math.min(promptInput.scrollHeight, max) + 'px';
}

function applyToPromptInput(value) {
  promptInput.value = safeString(value);
  autoResizeTextarea();
  setSendEnabled();
  try {
    promptInput.focus();
  } catch {
    // ignore
  }
}

function insertIntoPromptInput(text) {
  const insert = safeString(text);
  if (!insert) return;

  const v = safeString(promptInput.value);
  const start =
    typeof promptInput.selectionStart === 'number' ? promptInput.selectionStart : v.length;
  const end = typeof promptInput.selectionEnd === 'number' ? promptInput.selectionEnd : start;

  const next = v.slice(0, start) + insert + v.slice(end);
  promptInput.value = next;

  const pos = start + insert.length;
  try {
    promptInput.selectionStart = pos;
    promptInput.selectionEnd = pos;
  } catch {
    // ignore
  }

  autoResizeTextarea();
  setSendEnabled();
  try {
    promptInput.focus();
  } catch {
    // ignore
  }
}

function renderMarkdownToHtml(markdown) {
  const marked = globalThis.marked;
  const DOMPurify = globalThis.DOMPurify;
  if (!marked?.parse || typeof DOMPurify?.sanitize !== 'function') return null;

  try {
    const html = marked.parse(markdown, { mangle: false, headerIds: false });
    return DOMPurify.sanitize(html, { USE_PROFILES: { html: true } });
  } catch {
    return null;
  }
}

function createMessageRow(role) {
  const row = document.createElement('div');
  row.className = `messageRow ${role}`;
  const bubble = document.createElement('div');
  bubble.className = `bubble ${role} markdown`;
  row.appendChild(bubble);
  chatEl.appendChild(row);
  return bubble;
}

function appendImagesToBubble(bubble, previewUrls) {
  if (!Array.isArray(previewUrls) || previewUrls.length === 0) return;

  const grid = document.createElement('div');
  grid.className = 'msgImages';
  for (const src of previewUrls) {
    const img = document.createElement('img');
    img.className = 'msgImg';
    img.src = src;
    img.alt = 'attachment';
    grid.appendChild(img);
  }
  bubble.appendChild(grid);
}

function setBubbleMarkdown(bubble, markdown) {
  const html = renderMarkdownToHtml(markdown);
  if (html) {
    bubble.innerHTML = html;
  } else {
    bubble.textContent = markdown;
  }
}

function addUserMessage({ markdown, imagePreviews }) {
  const bubble = createMessageRow('user');
  setBubbleMarkdown(bubble, markdown);
  appendImagesToBubble(bubble, imagePreviews);
  scrollToBottom();
}

function startAssistantMessage() {
  const bubble = createMessageRow('assistant');
  bubble.innerHTML = '<span class="dots"><span></span><span></span><span></span></span>';
  currentAssistant = { bubble, buffer: '', hasStarted: false };
  scrollToBottom();
}

function appendAssistantText(text) {
  if (!currentAssistant) startAssistantMessage();
  if (!currentAssistant) return;

  currentAssistant.buffer += text;
  if (!currentAssistant.hasStarted) {
    currentAssistant.hasStarted = true;
    currentAssistant.bubble.textContent = '';
  }
  currentAssistant.bubble.textContent = currentAssistant.buffer;
  scrollToBottom();
}

function finishAssistantMarkdown() {
  if (!currentAssistant) return;
  const markdown = currentAssistant.buffer.trimEnd();
  if (markdown) {
    setBubbleMarkdown(currentAssistant.bubble, markdown);
  } else {
    currentAssistant.bubble.textContent = '（応答なし）';
  }
  currentAssistant = null;
  scrollToBottom();
}

function failAssistant(text) {
  if (currentAssistant) {
    currentAssistant.bubble.textContent = text;
    currentAssistant = null;
    scrollToBottom();
    return;
  }
  showAssistantError(text);
}

function showAssistantError(text) {
  const bubble = createMessageRow('assistant');
  bubble.textContent = text;
  scrollToBottom();
}

function disconnect() {
  isConnecting = false;
  isConnected = false;
  rejectAllUploadWaiters('Native Host との接続が切れました');
  if (port) {
    try {
      port.disconnect();
    } catch {
      // ignore
    }
  }
  port = null;
  updateMeta();
}

async function connect() {
  if (isConnected) return;
  if (isConnecting) return;

  disconnect();
  isConnecting = true;
  updateMeta();
  setStatus('接続中...');

  try {
    port = chrome.runtime.connectNative(NATIVE_HOST_NAME);
  } catch (e) {
    isConnecting = false;
    isConnected = false;
    updateMeta();
    setStatus(`接続失敗: ${String(e)}`);
    return;
  }

  port.onMessage.addListener(handleHostMessage);
  port.onDisconnect.addListener(() => {
    const err = chrome.runtime.lastError?.message;
    disconnect();
    setStatus(err ? `切断: ${err}` : '切断');
  });
}

function handleHostMessage(msg) {
  if (!msg || typeof msg !== 'object') return;

  if (msg.type === 'upload_ok' && typeof msg.requestId === 'string' && typeof msg.imageId === 'string') {
    const key = uploadKey(msg.requestId, msg.imageId);
    const w = uploadWaiters.get(key);
    if (w) {
      uploadWaiters.delete(key);
      try {
        clearTimeout(w.timer);
      } catch {
        // ignore
      }
      w.resolve();
    }
    return;
  }

  if (msg.type === 'upload_error' && typeof msg.requestId === 'string' && typeof msg.imageId === 'string') {
    const key = uploadKey(msg.requestId, msg.imageId);
    const w = uploadWaiters.get(key);
    if (w) {
      uploadWaiters.delete(key);
      try {
        clearTimeout(w.timer);
      } catch {
        // ignore
      }
      w.reject(new Error(typeof msg.text === 'string' ? msg.text : '画像アップロードに失敗しました'));
    }
    return;
  }

  if (msg.type === 'status' && typeof msg.text === 'string') {
    // 初回 status をもって接続成功とみなす
    if (!isConnected) {
      isConnected = true;
      isConnecting = false;
      updateMeta();
    }
    setStatus(msg.text);
    return;
  }

  if (msg.type === 'codex_thread' && typeof msg.id === 'string') {
    const id = msg.id.trim();
    if (id) {
      threadId = id;
      chrome.storage.session.set({ [STORAGE_KEY_THREAD_ID]: threadId }).catch(() => {});
      updateMeta();
    }
    return;
  }

  if (msg.type === 'codex_chunk' && typeof msg.data === 'string') {
    appendAssistantText(msg.data);
    return;
  }

  if (msg.type === 'codex_done') {
    isRunning = false;
    setSendEnabled();
    finishAssistantMarkdown();
    return;
  }

  if (msg.type === 'codex_error' && typeof msg.text === 'string') {
    isRunning = false;
    setSendEnabled();
    const t = msg.text.trim();
    if (t) {
      failAssistant(`[Error]\n${t}`);
    } else {
      failAssistant('[Error]');
    }
  }
}

function resetConversation({ clearThread } = {}) {
  // UI
  chatEl.innerHTML = '';
  currentAssistant = null;

  // thread
  if (clearThread) {
    threadId = '';
    chrome.storage.session.remove(STORAGE_KEY_THREAD_ID).catch(() => {});
    updateMeta();
  }

  // attachments/input
  clearAttachments();
  promptInput.value = '';
  autoResizeTextarea();
  setSendEnabled();

  const bubble = createMessageRow('assistant');
  bubble.innerHTML =
    '<p><strong>使い方</strong></p><ul><li>下の入力欄に質問を入力して送信</li><li>「＋」/ 画像貼り付け / ドラッグで画像を添付</li></ul>';
  scrollToBottom();
}

function clearAttachments({ revoke } = {}) {
  const shouldRevoke = revoke !== false;
  if (shouldRevoke) {
    for (const a of attachments) {
      try {
        URL.revokeObjectURL(a.previewUrl);
      } catch {
        // ignore
      }
    }
  }
  attachments = [];
  renderAttachments();
}

function renderAttachments() {
  attachmentsEl.innerHTML = '';
  if (!attachments.length) {
    attachmentsEl.hidden = true;
    return;
  }
  attachmentsEl.hidden = false;

  for (const item of attachments) {
    const card = document.createElement('div');
    card.className = 'attachCard';

    const img = document.createElement('img');
    img.className = 'attachImg';
    img.alt = item.file.name || 'image';
    img.src = item.previewUrl;

    const rm = document.createElement('button');
    rm.className = 'attachRm';
    rm.type = 'button';
    rm.textContent = '×';
    rm.title = '削除';
    rm.addEventListener('click', () => {
      try {
        URL.revokeObjectURL(item.previewUrl);
      } catch {
        // ignore
      }
      attachments = attachments.filter((a) => a.id !== item.id);
      renderAttachments();
      setSendEnabled();
    });

    card.appendChild(img);
    card.appendChild(rm);
    attachmentsEl.appendChild(card);
  }
}

function uid() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return Math.random().toString(16).slice(2) + Date.now().toString(16);
}

async function addFiles(fileList) {
  const files = Array.from(fileList || []);
  const images = files.filter((f) => f && typeof f.type === 'string' && f.type.startsWith('image/'));
  if (!images.length) return;

  for (const f of images) {
    if (attachments.length >= MAX_ATTACHMENTS) break;
    const id = uid();
    const previewUrl = URL.createObjectURL(f);
    attachments.push({ id, file: f, previewUrl });
  }
  renderAttachments();
  setSendEnabled();
}

function bytesToBase64(bytes) {
  let binary = '';
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  return btoa(binary);
}

async function maybeDownscaleImage(file) {
  // 重すぎる場合のみ軽量化（それ以外は元画像のまま送る）
  const isTooLarge = file.size > 3 * 1024 * 1024;
  if (!isTooLarge) return { blob: file, filename: file.name || 'image', mimeType: file.type || 'image/*' };

  try {
    const bmp = await createImageBitmap(file);
    const maxDim = 1600;
    const scale = Math.min(1, maxDim / Math.max(bmp.width, bmp.height));
    if (scale >= 1) return { blob: file, filename: file.name || 'image', mimeType: file.type || 'image/*' };

    const w = Math.max(1, Math.round(bmp.width * scale));
    const h = Math.max(1, Math.round(bmp.height * scale));

    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return { blob: file, filename: file.name || 'image', mimeType: file.type || 'image/*' };

    // 透過png対策: 背景を白で塗る
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(bmp, 0, 0, w, h);

    const wantPng = file.type === 'image/png';
    const mimeType = wantPng ? 'image/png' : 'image/jpeg';
    const quality = wantPng ? undefined : 0.82;

    const blob = await new Promise((resolve) =>
      canvas.toBlob((b) => resolve(b), mimeType, quality)
    );
    if (!blob) return { blob: file, filename: file.name || 'image', mimeType: file.type || 'image/*' };
    return {
      blob,
      filename: wantPng ? 'image.png' : 'image.jpg',
      mimeType
    };
  } catch {
    return { blob: file, filename: file.name || 'image', mimeType: file.type || 'image/*' };
  }
}

async function uploadImage({ requestId, imageId, file }) {
  if (!port) throw new Error('未接続です');

  const normalized = await maybeDownscaleImage(file);
  if (normalized.blob.size > MAX_IMAGE_BYTES) {
    throw new Error(`画像が大きすぎます（${Math.round(normalized.blob.size / 1024 / 1024)}MB）`);
  }

  const key = uploadKey(requestId, imageId);
  if (uploadWaiters.has(key)) throw new Error('upload が重複しています');

  const buf = await normalized.blob.arrayBuffer();
  const bytes = new Uint8Array(buf);

  const done = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      uploadWaiters.delete(key);
      reject(new Error('画像アップロードがタイムアウトしました'));
    }, 60_000);
    uploadWaiters.set(key, { resolve, reject, timer });
  });

  port.postMessage({
    type: 'upload_image_start',
    requestId,
    imageId,
    filename: normalized.filename,
    mimeType: normalized.mimeType,
    size: bytes.length
  });

  let seq = 0;
  for (let offset = 0; offset < bytes.length; offset += RAW_CHUNK_SIZE) {
    const slice = bytes.subarray(offset, offset + RAW_CHUNK_SIZE);
    port.postMessage({
      type: 'upload_image_chunk',
      requestId,
      imageId,
      seq,
      data: bytesToBase64(slice)
    });
    seq++;
  }

  port.postMessage({ type: 'upload_image_end', requestId, imageId, chunks: seq });

  await done;
}

function buildCodexPrompt({ userText, selectionText, pageUrl, hasImages }) {
  const text = safeString(userText).trim();
  const selection = safeString(selectionText).trim();
  const url = safeString(pageUrl).trim();

  const lines = [safeString(promptTemplate).trim() || DEFAULT_PROMPT_TEMPLATE, ''];

  if (hasImages) {
    lines.push('添付画像も参照して回答してください。', '');
  }

  lines.push('## ユーザーの入力', text || '（なし）', '', '## 選択テキスト', selection || '（なし）', '', '## 出典URL', url || '（不明）');
  return lines.join('\n');
}

function buildUserMarkdown({ userText, selectionText, pageUrl, hasImages }) {
  const text = safeString(userText).trim();
  const selection = safeString(selectionText).trim();
  const url = safeString(pageUrl).trim();

  const lines = [];
  if (text) lines.push(text);
  if (!text && hasImages) lines.push('（画像）');
  if (selection) {
    lines.push('', '```text', selection, '```');
  }
  if (url) {
    lines.push('', `URL: ${url}`);
  }
  return lines.join('\n');
}

async function sendMessageToCodex({ userText, selectionText, pageUrl, files }) {
  if (isRunning) return;

  const hasText = safeString(userText).trim().length > 0;
  const hasSelection = safeString(selectionText).trim().length > 0;
  const hasImages = Array.isArray(files) && files.length > 0;
  if (!hasText && !hasSelection && !hasImages) return;

  // UI: user message
  addUserMessage({
    markdown: buildUserMarkdown({ userText, selectionText, pageUrl, hasImages }),
    imagePreviews: files.map((f) => f.previewUrl)
  });

  // UI: start assistant
  startAssistantMessage();

  // connect
  await connect();
  if (!port) {
    isRunning = false;
    setSendEnabled();
    showAssistantError('接続できませんでした');
    return;
  }

  isRunning = true;
  setSendEnabled();

  const requestId = uid();

  // upload images
  const imageIds = [];
  for (const f of files) {
    // eslint-disable-next-line no-await-in-loop
    await uploadImage({ requestId, imageId: f.id, file: f.file });
    imageIds.push(f.id);
  }

  const prompt = buildCodexPrompt({
    userText,
    selectionText,
    pageUrl,
    hasImages: imageIds.length > 0
  });

  const payload = { type: 'codex', requestId, prompt };
  if (threadId) payload.threadId = threadId;
  if (imageIds.length) payload.imageIds = imageIds;

  port.postMessage(payload);
}

async function loadPendingAsk() {
  const { pendingCodexAsk } = await chrome.storage.session.get(STORAGE_KEY_PENDING);
  if (!pendingCodexAsk || typeof pendingCodexAsk !== 'object') return;

  const selectionText =
    typeof pendingCodexAsk.selectionText === 'string' ? pendingCodexAsk.selectionText : '';
  const pageUrl = typeof pendingCodexAsk.pageUrl === 'string' ? pendingCodexAsk.pageUrl : '';
  const question = typeof pendingCodexAsk.question === 'string' ? pendingCodexAsk.question : '';

  await chrome.storage.session.remove(STORAGE_KEY_PENDING);

  // 「Codexに聞く（選択範囲）」は、自動送信せず入力欄に挿入するだけにする
  pendingSelectionText = selectionText;
  pendingPageUrl = pageUrl;

  if (selectionText) {
    // 既存入力がある場合は末尾に追記（最小の挙動で「挿入」）
    if (promptInput.value.trim()) {
      insertIntoPromptInput(`\n\n${selectionText}`);
    } else {
      applyToPromptInput(selectionText);
    }
    return;
  }

  if (question) {
    applyToPromptInput(question);
  }
}

// UI events
attachBtn.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => {
  addFiles(fileInput.files).catch(() => {});
  fileInput.value = '';
});

promptInput.addEventListener('input', () => {
  autoResizeTextarea();
  setSendEnabled();
});

promptInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    // 日本語IMEなどの変換確定Enter中に送信すると、確定文字が送信後に入力欄へ残ることがある
    // (isComposing / keyCode 229 はIME中の代表的なシグナル)
    if (e.isComposing || e.keyCode === 229) return;
    e.preventDefault();
    submitPrompt();
  }
});

promptInput.addEventListener('paste', (e) => {
  const items = e.clipboardData?.items;
  if (!items) return;

  const files = [];
  for (const it of items) {
    if (it.kind === 'file') {
      const f = it.getAsFile();
      if (f) files.push(f);
    }
  }
  if (files.length) addFiles(files).catch(() => {});
});

dropZone.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropZone.classList.add('dragOver');
});
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragOver'));
dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropZone.classList.remove('dragOver');
  if (e.dataTransfer?.files?.length) addFiles(e.dataTransfer.files).catch(() => {});
});

async function submitPrompt() {
  if (isRunning) return;
  const text = promptInput.value;
  const files = attachments.slice();

  const hasText = safeString(text).trim().length > 0;
  const hasImages = files.length > 0;
  if (!hasText && !hasImages) return;

  const selectionTrim = safeString(pendingSelectionText).trim();
  const inputTrim = safeString(text).trim();
  let userText = text;
  let selectionText = '';

  if (selectionTrim) {
    // 入力が「選択範囲そのもの」なら、選択として扱う（重複回避）
    if (inputTrim === selectionTrim) {
      userText = '';
      selectionText = selectionTrim;
    } else if (inputTrim.endsWith(selectionTrim)) {
      // 末尾に選択が残っているなら、先頭を質問として分離する（よくある使い方）
      const before = inputTrim.slice(0, inputTrim.length - selectionTrim.length).trimEnd();
      if (before) {
        userText = before;
        selectionText = selectionTrim;
      } else {
        userText = '';
        selectionText = selectionTrim;
      }
    } else {
      // それ以外は「質問 + 選択」の両方として扱う（多少重複してもOK）
      selectionText = selectionTrim;
    }
  }

  const pageUrl = pendingPageUrl;
  // 1回送ったら pending は消す（次の質問に勝手に混ざらないように）
  pendingSelectionText = '';
  pendingPageUrl = '';

  // clear input/attachments early (UI即応)
  promptInput.value = '';
  autoResizeTextarea();
  // 送信済みメッセージ内でもサムネを表示したいので、ここでは revoke しない
  clearAttachments({ revoke: false });
  setSendEnabled();

  try {
    await sendMessageToCodex({ userText, selectionText, pageUrl, files });
  } catch (e) {
    isRunning = false;
    setSendEnabled();
    failAssistant(`[Error]\n${String(e)}`);
  }
}

clearBtn?.addEventListener('click', () => {
  promptInput.value = '';
  clearAttachments();
  pendingSelectionText = '';
  pendingPageUrl = '';
  autoResizeTextarea();
  setSendEnabled();
});

// settings
settingsBtn?.addEventListener('click', (e) => {
  e.stopPropagation();
  if (panelOpen) {
    hidePanel();
    toggleSettingsMenu(false);
  } else {
    toggleSettingsMenu(settingsMenu?.hidden);
  }
});

document.addEventListener('click', (e) => {
  const target = e.target;
  if (!settingsMenu?.hidden && target instanceof HTMLElement) {
    if (!settingsMenu.contains(target) && target !== settingsBtn) {
      toggleSettingsMenu(false);
    }
  }
  if (!settingsPanel?.hidden && target instanceof HTMLElement) {
    const clickedOutside =
      !settingsPanel.contains(target) && !settingsMenu?.contains(target) && target !== settingsBtn;
    if (clickedOutside) hidePanel();
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    toggleSettingsMenu(false);
    hidePanel();
  }
});

panelClose?.addEventListener('click', () => hidePanel());
panelOverlay?.addEventListener('click', () => hidePanel());

settingsMenu?.addEventListener('click', (e) => {
  e.stopPropagation();
  const target = e.target;
  if (!(target instanceof HTMLElement)) return;
  const action = target.dataset.action;
  if (!action) return;

  toggleSettingsMenu(false);

  if (action === 'prompt') {
    showPanel('プロンプト設定', (container) => {
      const group = document.createElement('div');
      group.className = 'panelGroup';

      const label = document.createElement('label');
      label.className = 'panelLabel';
      label.textContent = 'プロンプト（前提）';

      const textarea = document.createElement('textarea');
      textarea.className = 'panelTextarea';
      textarea.rows = 8;
      textarea.value = promptTemplate;

      const actions = document.createElement('div');
      actions.className = 'panelActions';

      const saveBtn = document.createElement('button');
      saveBtn.className = 'btn';
      saveBtn.type = 'button';
      saveBtn.textContent = '保存';

      const resetBtn = document.createElement('button');
      resetBtn.className = 'btn ghost';
      resetBtn.type = 'button';
      resetBtn.textContent = 'デフォルトに戻す';

      saveBtn.addEventListener('click', () => {
        savePromptTemplate(textarea.value).then(() => {
          container.innerHTML = '';
          const p = document.createElement('p');
          p.className = 'muted';
          p.textContent = '保存しました。';
          container.appendChild(p);
        });
      });

      resetBtn.addEventListener('click', () => {
        textarea.value = DEFAULT_PROMPT_TEMPLATE;
        savePromptTemplate(DEFAULT_PROMPT_TEMPLATE).catch(() => {});
      });

      group.appendChild(label);
      group.appendChild(textarea);
      container.appendChild(group);

      actions.appendChild(saveBtn);
      actions.appendChild(resetBtn);
      container.appendChild(actions);
    });
    return;
  }

  if (action === 'start-ci') {
    showPanel('起動CIコマンド', (container) => {
      const group = document.createElement('div');
      group.className = 'panelGroup';

      const label = document.createElement('label');
      label.className = 'panelLabel';
      label.textContent = '起動CIコマンド';

      const textarea = document.createElement('textarea');
      textarea.className = 'panelTextarea';
      textarea.rows = 3;
      textarea.value = ciStartCommand;

      const actions = document.createElement('div');
      actions.className = 'panelActions';

      const saveBtn = document.createElement('button');
      saveBtn.className = 'btn';
      saveBtn.type = 'button';
      saveBtn.textContent = '保存';

      const resetBtn = document.createElement('button');
      resetBtn.className = 'btn ghost';
      resetBtn.type = 'button';
      resetBtn.textContent = 'デフォルトに戻す';

      saveBtn.addEventListener('click', () => {
        saveCiStartCommand(textarea.value).then(() => {
          container.innerHTML = '';
          const p = document.createElement('p');
          p.className = 'muted';
          p.textContent = '保存しました。';
          container.appendChild(p);
        });
      });

      resetBtn.addEventListener('click', () => {
        textarea.value = DEFAULT_CODEX_CMD;
        saveCiStartCommand(DEFAULT_CODEX_CMD).catch(() => {});
      });

      group.appendChild(label);
      group.appendChild(textarea);
      container.appendChild(group);

      actions.appendChild(saveBtn);
      actions.appendChild(resetBtn);
      container.appendChild(actions);
    });
    return;
  }

  if (action === 'restart-ci') {
    showPanel('CIリスタート', (container) => {
      const group = document.createElement('div');
      group.className = 'panelGroup';

      const label = document.createElement('label');
      label.className = 'panelLabel';
      label.textContent = 'CIリスタートコマンド';

      const textarea = document.createElement('textarea');
      textarea.className = 'panelTextarea';
      textarea.rows = 3;
      textarea.value = ciRestartCommand;

      const actions = document.createElement('div');
      actions.className = 'panelActions';

      const saveBtn = document.createElement('button');
      saveBtn.className = 'btn';
      saveBtn.type = 'button';
      saveBtn.textContent = '保存';

      const useBtn = document.createElement('button');
      useBtn.className = 'btn ghost';
      useBtn.type = 'button';
      useBtn.textContent = '入力欄に反映';

      saveBtn.addEventListener('click', () => {
        saveCiRestartCommand(textarea.value).then(() => {
          container.innerHTML = '';
          const p = document.createElement('p');
          p.className = 'muted';
          p.textContent = '保存しました。';
          container.appendChild(p);
        });
      });

      useBtn.addEventListener('click', () => {
        applyToPromptInput(textarea.value);
      });

      group.appendChild(label);
      group.appendChild(textarea);
      container.appendChild(group);

      actions.appendChild(saveBtn);
      actions.appendChild(useBtn);
      container.appendChild(actions);
    });
    return;
  }

  if (action === 'new-chat') {
    resetConversation({ clearThread: true });
    pendingSelectionText = '';
    pendingPageUrl = '';
    return;
  }
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'pendingCodexAskUpdated') {
    loadPendingAsk();
  }
});

async function init() {
  await loadPromptTemplate();
  await loadCiCommands();
  toggleSettingsMenu(false);
  hidePanel();
  const data = await chrome.storage.session.get([STORAGE_KEY_THREAD_ID]);
  threadId = safeString(data[STORAGE_KEY_THREAD_ID]);
  updateMeta();

  resetConversation({ clearThread: false });
  autoResizeTextarea();
  setSendEnabled();

  // 接続は必要になったら行う（起動時に失敗ログを出さない）
  await loadPendingAsk();
}

init();
