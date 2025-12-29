// Native Messaging host 名（manifest / host manifest と一致させる）
const NATIVE_HOST_NAME = 'com.yushi.chrome_extension_codex_terminal';

const STORAGE_KEY_PENDING = 'pendingCodexAsk';
const STORAGE_KEY_THREAD_ID = 'codexThreadId';
const STORAGE_KEY_PROMPT_TEMPLATE = 'promptTemplate';
const STORAGE_KEY_START_CMD = 'startCommand';
const STORAGE_KEY_CI_START_CMD = 'ciStartCommand';
const STORAGE_KEY_CI_RESTART_CMD = 'ciRestartCommand';
const STORAGE_KEY_CODEX_MODEL = 'codexModel';
const STORAGE_KEY_CODEX_EFFORT = 'codexReasoningEffort';
const STORAGE_KEY_CODEX_EFFORT_CAPS = 'codexEffortCapsByModel';

const MODEL_PRESETS = [
  { value: '', label: 'デフォルト（config.toml）' },
  { value: 'gpt-5.2-codex', label: 'gpt-5.2-codex' },
  { value: 'gpt-5.1-codex-max', label: 'gpt-5.1-codex-max' },
  { value: 'gpt-5.1-codex-mini', label: 'gpt-5.1-codex-mini' },
  { value: 'gpt-5.2', label: 'gpt-5.2' }
];

const EFFORT_PRESETS = [
  { value: '', label: 'デフォルト（modelごと）' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'Extra high' }
];

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
  '翻訳・校正などWeb調査が不要なタスク以外は、可能な場合は念の為Web調査も行い、根拠となるURLを併記してください（Web調査できない場合はその旨を明記）。',
  'フローが必要な場合は簡易mermaidでわかりやすく挿入し、用語説明などはシンプルに解説してください。',
  '出力はMarkdownで、初心者にも分かるように日本語で書いてください。',
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

/** @type {string} */
let codexModel = '';

/** @type {string} */
let codexReasoningEffort = '';

/** @type {Record<string, string[]>} */
let effortCapsByModel = {};

/** @type {{id:string, file:File, previewUrl:string}[]} */
let attachments = [];

/** @type {{bubble:HTMLElement, buffer:string, hasStarted:boolean} | null} */
let currentAssistant = null;

let conversationTurns = [];
let activeTurnId = '';

/** @type {Map<string, {resolve:() => void, reject:(e:Error) => void, timer:number}>} */
const uploadWaiters = new Map();

/** @type {string} */
let pendingSelectionText = '';

/** @type {string} */
let pendingPageUrl = '';

let submitSeq = 0;

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

function isValidCodexModel(value) {
  const v = safeString(value).trim();
  if (!v) return true;
  // codex CLI のモデル名は英数字/._- で扱えるものに限定（不正値はそのまま弾く）
  return /^[A-Za-z0-9._-]+$/.test(v) && v.length <= 64;
}

function isValidReasoningEffort(value) {
  const v = safeString(value).trim();
  return EFFORT_PRESETS.some((e) => e.value === v);
}

function allowedEffortValuesForModel(model) {
  const m = safeString(model).trim();
  const caps = effortCapsByModel?.[m];
  if (m && Array.isArray(caps) && caps.length) {
    const allowed = new Set(['']);
    for (const raw of caps) {
      const v = safeString(raw).trim();
      if (isValidReasoningEffort(v)) allowed.add(v);
    }
    return allowed;
  }
  // 現状のCodex UIに合わせて、miniは Medium/High のみ（Low/Extra high は出ない）
  if (m === 'gpt-5.1-codex-mini') return new Set(['', 'medium', 'high']);
  // 不明なモデルは一旦フル（codex側で弾かれる可能性はあるため、困ったらデフォルト推奨）
  return new Set(EFFORT_PRESETS.map((e) => e.value));
}

function normalizeEffortForModel({ model, effort }) {
  const v = safeString(effort).trim();
  const allowed = allowedEffortValuesForModel(model);
  return allowed.has(v) ? v : '';
}

function populateEffortSelect(selectEl, model) {
  if (!(selectEl instanceof HTMLSelectElement)) return;
  const allowed = allowedEffortValuesForModel(model);
  selectEl.innerHTML = '';
  for (const opt of EFFORT_PRESETS) {
    if (!allowed.has(opt.value)) continue;
    const o = document.createElement('option');
    o.value = opt.value;
    o.textContent = opt.label;
    selectEl.appendChild(o);
  }
}

function formatModelForMeta(value) {
  const v = safeString(value).trim();
  if (!v) return '';
  if (v.length <= 18) return v;
  return v.slice(0, 18) + '…';
}

function toModelPreset(value) {
  const v = safeString(value).trim();
  if (MODEL_PRESETS.some((m) => m.value === v)) return v;
  return '__custom__';
}

async function loadCodexModel() {
  try {
    const data = await chrome.storage.local.get([STORAGE_KEY_CODEX_MODEL]);
    codexModel = safeString(data[STORAGE_KEY_CODEX_MODEL]).trim();
  } catch {
    codexModel = '';
  }
}

async function loadCodexEffort() {
  try {
    const data = await chrome.storage.local.get([STORAGE_KEY_CODEX_EFFORT]);
    const v = safeString(data[STORAGE_KEY_CODEX_EFFORT]).trim();
    codexReasoningEffort = isValidReasoningEffort(v) ? v : '';
  } catch {
    codexReasoningEffort = '';
  }
}

async function loadEffortCapsByModel() {
  try {
    const data = await chrome.storage.local.get([STORAGE_KEY_CODEX_EFFORT_CAPS]);
    const v = data[STORAGE_KEY_CODEX_EFFORT_CAPS];
    if (!v || typeof v !== 'object') {
      effortCapsByModel = {};
      return;
    }

    /** @type {Record<string, string[]>} */
    const next = {};
    for (const [k, raw] of Object.entries(v)) {
      if (typeof k !== 'string') continue;
      if (!Array.isArray(raw)) continue;
      next[k] = raw.filter((s) => typeof s === 'string');
    }
    effortCapsByModel = next;
  } catch {
    effortCapsByModel = {};
  }
}

async function saveEffortCapsForModel(model, efforts) {
  const m = safeString(model).trim();
  if (!m) return;

  const list = Array.isArray(efforts) ? efforts : [];
  const normalized = Array.from(
    new Set(list.map((s) => safeString(s).trim()).filter((v) => v && isValidReasoningEffort(v)))
  );

  effortCapsByModel = { ...(effortCapsByModel || {}) };
  effortCapsByModel[m] = normalized;
  try {
    await chrome.storage.local.set({ [STORAGE_KEY_CODEX_EFFORT_CAPS]: effortCapsByModel });
  } catch {
    // ignore
  }
}

async function saveCodexModel(value) {
  const v = safeString(value).trim();
  if (!isValidCodexModel(v)) throw new Error('モデル名が不正です（英数字/._- のみ、最大64文字）');
  codexModel = v;
  try {
    await chrome.storage.local.set({ [STORAGE_KEY_CODEX_MODEL]: v });
  } catch {
    // ignore
  }
  updateMeta();
}

async function saveCodexEffort(value) {
  const v = safeString(value).trim();
  if (!isValidReasoningEffort(v)) throw new Error('推論レベルが不正です');
  codexReasoningEffort = v;
  try {
    await chrome.storage.local.set({ [STORAGE_KEY_CODEX_EFFORT]: v });
  } catch {
    // ignore
  }
  updateMeta();
}

function updateMeta() {
  const parts = [];
  parts.push(isConnected ? '接続: OK' : isConnecting ? '接続: ...' : '接続: NG');
  parts.push(`session: ${threadId ? threadId.slice(0, 8) + '…' : '(new)'}`);
  if (codexModel) parts.push(`model: ${formatModelForMeta(codexModel)}`);
  if (codexReasoningEffort) parts.push(`effort: ${codexReasoningEffort}`);
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

/** @type {HTMLIFrameElement | null} */
let mermaidSandboxFrame = null;
/** @type {Promise<void> | null} */
let mermaidSandboxReadyPromise = null;
/** @type {{resolve:() => void, reject:(e:Error) => void, timer:number} | null} */
let mermaidSandboxReadyWaiter = null;
/** @type {Map<string, {resolve:(svg:string) => void, reject:(e:Error) => void, timer:number}>} */
const mermaidWaiters = new Map();

function handleMermaidSandboxMessage(event) {
  if (!mermaidSandboxFrame?.contentWindow) return;
  if (event.source !== mermaidSandboxFrame.contentWindow) return;

  const msg = event.data;
  if (!msg || typeof msg !== 'object') return;

  if (msg.type === 'mermaid_ready') {
    const waiter = mermaidSandboxReadyWaiter;
    if (waiter) {
      mermaidSandboxReadyWaiter = null;
      try {
        clearTimeout(waiter.timer);
      } catch {
        // ignore
      }
      waiter.resolve();
    }
    return;
  }

  if (msg.type === 'render_mermaid_result' && typeof msg.id === 'string' && typeof msg.svg === 'string') {
    const w = mermaidWaiters.get(msg.id);
    if (!w) return;
    mermaidWaiters.delete(msg.id);
    try {
      clearTimeout(w.timer);
    } catch {
      // ignore
    }
    w.resolve(msg.svg);
    return;
  }

  if (msg.type === 'render_mermaid_error' && typeof msg.id === 'string') {
    const w = mermaidWaiters.get(msg.id);
    if (!w) return;
    mermaidWaiters.delete(msg.id);
    try {
      clearTimeout(w.timer);
    } catch {
      // ignore
    }
    w.reject(new Error(typeof msg.error === 'string' ? msg.error : 'Mermaid render failed'));
  }
}

window.addEventListener('message', handleMermaidSandboxMessage);

function ensureMermaidSandboxReady() {
  if (mermaidSandboxReadyPromise) return mermaidSandboxReadyPromise;

  mermaidSandboxReadyPromise = new Promise((resolve, reject) => {
    const frame = document.createElement('iframe');
    frame.src = 'mermaid_sandbox.html';
    frame.style.display = 'none';
    frame.setAttribute('title', 'mermaid sandbox');
    document.body.appendChild(frame);
    mermaidSandboxFrame = frame;

    const timer = setTimeout(() => {
      const waiter = mermaidSandboxReadyWaiter;
      mermaidSandboxReadyWaiter = null;
      reject(new Error('Mermaid sandbox が起動しませんでした'));
      if (waiter) {
        try {
          clearTimeout(waiter.timer);
        } catch {
          // ignore
        }
      }
    }, 2500);
    mermaidSandboxReadyWaiter = { resolve, reject, timer };
  });

  return mermaidSandboxReadyPromise;
}

async function renderMermaidSvg(code) {
  const src = safeString(code);
  if (!src.trim()) throw new Error('empty mermaid code');

  await ensureMermaidSandboxReady();
  if (!mermaidSandboxFrame?.contentWindow) throw new Error('Mermaid sandbox が利用できません');

  const id = `mmd-${uid()}`;
  const done = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      mermaidWaiters.delete(id);
      reject(new Error('Mermaid render timeout'));
    }, 15_000);
    mermaidWaiters.set(id, { resolve, reject, timer });
  });

  mermaidSandboxFrame.contentWindow.postMessage({ type: 'render_mermaid', id, code: src }, '*');
  return done;
}

function renderMermaidIn(container) {
  const DOMPurify = globalThis.DOMPurify;
  if (!(container instanceof HTMLElement)) return;

  const codeBlocks = container.querySelectorAll('code.language-mermaid');
  if (!codeBlocks.length) return;

  codeBlocks.forEach((codeEl) => {
    const parentPre = codeEl.closest('pre');
    const code = codeEl.textContent || '';
    if (!code.trim()) return;
    renderMermaidSvg(code)
      .then((svg) => {
        const svgHtml =
          typeof DOMPurify?.sanitize === 'function'
            ? DOMPurify.sanitize(svg, {
                USE_PROFILES: { svg: true, svgFilters: true },
                // Mermaid のSVGは <style> と class に依存するため許可する（securityLevel=strict で生成）
                ADD_TAGS: ['style'],
                ADD_ATTR: ['class', 'style']
              })
            : svg;

        const block = document.createElement('div');
        block.className = 'mermaidBlock';

        const svgWrapper = document.createElement('div');
        svgWrapper.className = 'mermaidWrapper';
        svgWrapper.innerHTML = svgHtml;

        const footer = document.createElement('div');
        footer.className = 'mermaidFooter';
        const copyBtn = document.createElement('button');
        copyBtn.className = 'btn ghost copyBtn';
        copyBtn.type = 'button';
        copyBtn.textContent = 'コピー';
        const copyStatus = document.createElement('span');
        copyStatus.className = 'copyStatus';
        copyBtn.addEventListener('click', () => {
          navigator.clipboard
            ?.writeText(code)
            .then(() => {
              copyStatus.textContent = 'コピーしました';
              setTimeout(() => {
                copyStatus.textContent = '';
              }, 1200);
            })
            .catch(() => {
              copyStatus.textContent = 'コピー失敗';
              setTimeout(() => {
                copyStatus.textContent = '';
              }, 1200);
            });
        });
        footer.appendChild(copyBtn);
        footer.appendChild(copyStatus);

        const codeBlock = document.createElement('pre');
        const codeNode = document.createElement('code');
        codeNode.className = 'language-mermaid';
        codeNode.textContent = code;
        codeBlock.appendChild(codeNode);

        block.appendChild(svgWrapper);
        block.appendChild(codeBlock);
        block.appendChild(footer);

        if (parentPre) {
          parentPre.replaceWith(block);
        } else {
          codeEl.replaceWith(block);
        }

        scrollToBottom();
      })
      .catch(() => {});
  });
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
    renderMermaidIn(bubble);
  } else {
    bubble.textContent = markdown;
  }
}

function addUserMessage({ markdown, imagePreviews }) {
  const turnId = uid();
  activeTurnId = turnId;
  const imageCount = Array.isArray(imagePreviews) ? imagePreviews.length : 0;
  const userMarkdown = imageCount ? `${safeString(markdown)}\n\n（添付画像: ${imageCount}枚）` : safeString(markdown);
  conversationTurns.push({ id: turnId, userMarkdown, assistantMarkdown: '' });

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

  if (activeTurnId) {
    const last = conversationTurns.length ? conversationTurns[conversationTurns.length - 1] : null;
    if (last && last.id === activeTurnId) {
      last.assistantMarkdown = markdown || '（応答なし）';
    }
  }

  currentAssistant = null;
  scrollToBottom();
}

function failAssistant(text) {
  if (currentAssistant) {
    currentAssistant.bubble.textContent = text;

    if (activeTurnId) {
      const last = conversationTurns.length ? conversationTurns[conversationTurns.length - 1] : null;
      if (last && last.id === activeTurnId) {
        last.assistantMarkdown = safeString(text) || '（応答なし）';
      }
    }

    currentAssistant = null;
    scrollToBottom();
    return;
  }
  showAssistantError(text);
}

function showAssistantError(text) {
  const bubble = createMessageRow('assistant');
  bubble.textContent = text;

  if (activeTurnId) {
    const last = conversationTurns.length ? conversationTurns[conversationTurns.length - 1] : null;
    if (last && last.id === activeTurnId) {
      last.assistantMarkdown = safeString(text) || '（応答なし）';
    }
  }

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

  if (msg.type === 'codex_effort_caps' && typeof msg.model === 'string' && Array.isArray(msg.supportedEfforts)) {
    saveEffortCapsForModel(msg.model, msg.supportedEfforts).catch(() => {});
    return;
  }

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
  conversationTurns = [];
  activeTurnId = '';

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

 function buildConversationMarkdown({ mode, count, turnNumber, assistantOnly }) {
   const total = conversationTurns.length;

   let list = conversationTurns.slice();
   if (mode === 'last') {
     list = total ? [conversationTurns[total - 1]] : [];
   }
   if (mode === 'lastN') {
     const n = Math.max(1, Math.min(total, Number.isFinite(count) ? count : 1));
     list = total ? conversationTurns.slice(Math.max(0, total - n)) : [];
   }
   if (mode === 'turn') {
     const idx = Math.max(1, Math.min(total, Number.isFinite(turnNumber) ? turnNumber : 1));
     list = total ? [conversationTurns[idx - 1]] : [];
   }

   const now = new Date();
   const exportedAt = `${now.toLocaleString('ja-JP')} (local) / ${now.toISOString()} (UTC)`;

   const lines = [];
   lines.push('# Codex Terminal Export');
   lines.push('');
   lines.push(`ExportedAt: ${exportedAt}`);
   lines.push(`Thread: ${threadId || '(new)'}`);
   lines.push(`Turns: ${list.length}/${total}`);
   lines.push('');

   let i = 0;
   for (const t of list) {
     i++;
     const assistantMarkdown =
       t.assistantMarkdown ||
       (activeTurnId && t.id === activeTurnId && currentAssistant
         ? safeString(currentAssistant.buffer).trimEnd()
         : '') ||
       '（応答なし）';

     if (!assistantOnly) {
       lines.push(`## Turn ${i}`);
       lines.push('');
       lines.push('### User');
       lines.push('');
       lines.push(safeString(t.userMarkdown) || '（なし）');
       lines.push('');
       lines.push('### Assistant');
       lines.push('');
       lines.push(safeString(assistantMarkdown) || '（応答なし）');
       lines.push('');
       lines.push('---');
       lines.push('');
     } else {
       lines.push(`## Turn ${i} (Assistant)`);
       lines.push('');
       lines.push(safeString(assistantMarkdown) || '（応答なし）');
       lines.push('');
       lines.push('---');
       lines.push('');
     }
   }

   return lines.join('\n').trimEnd() + '\n';
 }

 async function copyTextToClipboard(text) {
   const v = safeString(text);
   if (!v) throw new Error('コピーする内容がありません');

   if (navigator?.clipboard?.writeText) {
     await navigator.clipboard.writeText(v);
     return;
   }

   const ta = document.createElement('textarea');
   ta.value = v;
   ta.style.position = 'fixed';
   ta.style.left = '-9999px';
   ta.style.top = '-9999px';
   document.body.appendChild(ta);
   ta.focus();
   ta.select();
   const ok = document.execCommand('copy');
   try {
     document.body.removeChild(ta);
   } catch {
     // ignore
   }
   if (!ok) throw new Error('コピーに失敗しました');
 }

 function downloadTextAsFile(text, filename) {
   const v = safeString(text);
   if (!v) throw new Error('保存する内容がありません');

   const name = safeString(filename).trim() || 'codex_terminal_export.md';
   const blob = new Blob([v], { type: 'text/markdown;charset=utf-8' });
   const url = URL.createObjectURL(blob);

   const a = document.createElement('a');
   a.href = url;
   a.download = name;
   a.click();

   setTimeout(() => {
     try {
       URL.revokeObjectURL(url);
     } catch {
       // ignore
     }
   }, 10_000);
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

function buildEffectiveQuestion({ userText, selectionText }) {
  const text = safeString(userText).trim();
  const selection = safeString(selectionText).trim();

  if (!selection) return text;
  if (!text) return `「${selection}」について教えてください。`;

  if (text.includes('{selection}')) return text.split('{selection}').join(selection);
  if (text.includes(selection)) return text;

  // 「って何？」「とは？」など、選択語に続けて自然に読める入力はそのまま連結する
  if (/^(って|とは|は|が|の|を|に|で|について)/u.test(text)) return `${selection}${text}`;
  return `「${selection}」について、${text}`;
}

function buildCodexPrompt({ userText, selectionText, pageUrl, hasImages }) {
  const text = safeString(userText).trim();
  const selection = safeString(selectionText).trim();
  const url = safeString(pageUrl).trim();
  const question = buildEffectiveQuestion({ userText: text, selectionText: selection });

  const lines = [safeString(promptTemplate).trim() || DEFAULT_PROMPT_TEMPLATE, ''];

  if (hasImages) {
    lines.push('添付画像も参照して回答してください。', '');
  }

  lines.push(
    '## 質問',
    question || '（なし）',
    '',
    '## 選択テキスト',
    selection || '（なし）',
    '',
    '## 出典URL',
    url || '（不明）'
  );
  return lines.join('\n');
}

function buildUserMarkdown({ userText, selectionText, pageUrl, hasImages }) {
  const text = safeString(userText).trim();
  const selection = safeString(selectionText).trim();
  const url = safeString(pageUrl).trim();
  const question = buildEffectiveQuestion({ userText: text, selectionText: selection });

  const lines = [];
  if (question) lines.push(question);
  if (!question && hasImages) lines.push('（画像）');

  const alreadyIncludesSelection = Boolean(selection && question && question.includes(selection));
  if (selection && !alreadyIncludesSelection) {
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
  if (codexModel) payload.model = codexModel;
  const effortToSend = codexModel
    ? normalizeEffortForModel({ model: codexModel, effort: codexReasoningEffort })
    : codexReasoningEffort;
  if (effortToSend) payload.reasoningEffort = effortToSend;
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

  // 「Codexに聞く（選択範囲）」は、自動送信せず入力欄へ挿入する
  pendingSelectionText = selectionText;
  pendingPageUrl = pageUrl;

  if (selectionText) {
    if (safeString(promptInput.value).trim()) {
      insertIntoPromptInput(selectionText);
    } else {
      applyToPromptInput(selectionText);
    }
  }

  if (question) {
    if (safeString(promptInput.value).trim()) {
      insertIntoPromptInput(question);
    } else {
      applyToPromptInput(question);
    }
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
  const selectionText = pendingSelectionText;
  const pageUrl = pendingPageUrl;
  const hasSelection = safeString(selectionText).trim().length > 0;
  if (!hasText && !hasImages && !hasSelection) return;

  const userText = text;

  // 選択範囲は「次の送信」だけに紐づける（次の入力へ持ち越さない）
  pendingSelectionText = '';
  pendingPageUrl = '';

  // clear input/attachments early (UI即応)
  const seq = ++submitSeq;
  promptInput.value = '';
  autoResizeTextarea();
  // 送信済みメッセージ内でもサムネを表示したいので、ここでは revoke しない
  clearAttachments({ revoke: false });
  setSendEnabled();
  // IMEなどで送信直後に文字が戻ることがあるため、次tickでもう一度消す
  setTimeout(() => {
    if (submitSeq !== seq) return;
    if (!promptInput.value) return;
    promptInput.value = '';
    autoResizeTextarea();
    setSendEnabled();
  }, 0);

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

  if (action === 'model') {
    showPanel('モデル', (container) => {
      const group = document.createElement('div');
      group.className = 'panelGroup';

      const label = document.createElement('label');
      label.className = 'panelLabel';
      label.textContent = 'Codexモデル';

      const select = document.createElement('select');
      select.className = 'panelSelect';

      for (const opt of MODEL_PRESETS) {
        const o = document.createElement('option');
        o.value = opt.value;
        o.textContent = opt.label;
        select.appendChild(o);
      }

      const customOpt = document.createElement('option');
      customOpt.value = '__custom__';
      customOpt.textContent = codexModel ? `カスタム（現在: ${formatModelForMeta(codexModel)}）` : 'カスタム';
      select.appendChild(customOpt);
      select.value = toModelPreset(codexModel);

      const input = document.createElement('input');
      input.className = 'panelInput';
      input.type = 'text';
      input.placeholder = 'カスタムモデル名（任意）';
      input.value = codexModel;

      const effortLabel = document.createElement('label');
      effortLabel.className = 'panelLabel';
      effortLabel.textContent = '推論レベル（Reasoning Effort）';

      const effortSelect = document.createElement('select');
      effortSelect.className = 'panelSelect';
      populateEffortSelect(effortSelect, input.value);
      effortSelect.value = normalizeEffortForModel({ model: input.value, effort: codexReasoningEffort });

      const hint = document.createElement('p');
      hint.className = 'muted';
      hint.textContent =
        'プリセットから選ぶか、カスタムで手入力できます。空欄なら ~/.codex/config.toml の model / effort を使用します。切り替えたら「新しい会話」推奨。';

      select.addEventListener('change', () => {
        if (select.value === '__custom__') return;
        input.value = select.value;
        const prev = effortSelect.value;
        populateEffortSelect(effortSelect, input.value);
        effortSelect.value = normalizeEffortForModel({ model: input.value, effort: prev });
      });

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
        Promise.all([saveCodexModel(input.value), saveCodexEffort(effortSelect.value)])
          .then(() => {
            container.innerHTML = '';
            const p = document.createElement('p');
            p.className = 'muted';
            const modelText = codexModel ? `model: ${codexModel}` : 'model: (default)';
            const effortText = codexReasoningEffort ? `effort: ${codexReasoningEffort}` : 'effort: (default)';
            p.textContent = `保存しました（${modelText}, ${effortText}）`;
            container.appendChild(p);
          })
          .catch((e) => {
            const p = document.createElement('p');
            p.className = 'muted';
            p.textContent = `保存できませんでした: ${String(e)}`;
            container.appendChild(p);
          });
      });

      resetBtn.addEventListener('click', () => {
        select.value = '';
        input.value = '';
        effortSelect.value = '';
        Promise.all([saveCodexModel(''), saveCodexEffort('')]).catch(() => {});
      });

      group.appendChild(label);
      group.appendChild(select);
      group.appendChild(input);
      group.appendChild(effortLabel);
      group.appendChild(effortSelect);
      group.appendChild(hint);
      container.appendChild(group);

      actions.appendChild(saveBtn);
      actions.appendChild(resetBtn);
      container.appendChild(actions);

      try {
        input.focus();
      } catch {
        // ignore
      }
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

  if (action === 'export-md') {
    showPanel('Markdownエクスポート', (container) => {
      const group = document.createElement('div');
      group.className = 'panelGroup';

      const scopeLabel = document.createElement('label');
      scopeLabel.className = 'panelLabel';
      scopeLabel.textContent = '範囲';

      const scope = document.createElement('select');
      scope.className = 'panelSelect';
      for (const opt of [
        { value: 'all', label: '全ての会話（全往復）' },
        { value: 'last', label: '最新の会話（1往復）' },
        { value: 'lastN', label: '最新からN往復' },
        { value: 'turn', label: '指定の1往復（番号）' }
      ]) {
        const o = document.createElement('option');
        o.value = opt.value;
        o.textContent = opt.label;
        scope.appendChild(o);
      }
      scope.value = 'all';

      const countLabel = document.createElement('label');
      countLabel.className = 'panelLabel';
      countLabel.textContent = 'N（最新からN往復）';

      const countInput = document.createElement('input');
      countInput.className = 'panelInput';
      countInput.type = 'number';
      countInput.min = '1';
      countInput.step = '1';
      countInput.value = '5';

      const turnLabel = document.createElement('label');
      turnLabel.className = 'panelLabel';
      turnLabel.textContent = '番号（指定の1往復）';

      const turnInput = document.createElement('input');
      turnInput.className = 'panelInput';
      turnInput.type = 'number';
      turnInput.min = '1';
      turnInput.step = '1';
      turnInput.value = String(Math.max(1, conversationTurns.length));

      const assistantOnlyWrap = document.createElement('label');
      assistantOnlyWrap.className = 'panelLabel';
      assistantOnlyWrap.style.display = 'flex';
      assistantOnlyWrap.style.alignItems = 'center';
      assistantOnlyWrap.style.gap = '8px';

      const assistantOnly = document.createElement('input');
      assistantOnly.type = 'checkbox';
      assistantOnly.checked = false;

      const assistantOnlyText = document.createElement('span');
      assistantOnlyText.textContent = 'アシスタント（LLM）出力のみ';

      assistantOnlyWrap.appendChild(assistantOnly);
      assistantOnlyWrap.appendChild(assistantOnlyText);

      const outLabel = document.createElement('label');
      outLabel.className = 'panelLabel';
      outLabel.textContent = '出力（Markdown）';

      const textarea = document.createElement('textarea');
      textarea.className = 'panelTextarea';
      textarea.rows = 10;
      textarea.readOnly = true;

      const hint = document.createElement('p');
      hint.className = 'muted';
      hint.textContent =
        '※ 画像はファイルとして埋め込まず、枚数だけメモします。コピー/保存はボタン操作（ユーザー操作）で実行します。';

      const status = document.createElement('p');
      status.className = 'muted';
      status.textContent = '';

      function refresh() {
        const mode = scope.value;
        const n = Math.max(1, parseInt(countInput.value || '1', 10));
        const t = Math.max(1, parseInt(turnInput.value || '1', 10));
        const md = buildConversationMarkdown({
          mode,
          count: n,
          turnNumber: t,
          assistantOnly: assistantOnly.checked
        });
        textarea.value = md;
        status.textContent = `現在: ${conversationTurns.length}往復`;

        const useN = mode === 'lastN';
        countLabel.hidden = !useN;
        countInput.hidden = !useN;
        const useTurn = mode === 'turn';
        turnLabel.hidden = !useTurn;
        turnInput.hidden = !useTurn;
      }

      scope.addEventListener('change', refresh);
      countInput.addEventListener('input', refresh);
      turnInput.addEventListener('input', refresh);
      assistantOnly.addEventListener('change', refresh);
      refresh();

      const actions = document.createElement('div');
      actions.className = 'panelActions';

      const copyBtn = document.createElement('button');
      copyBtn.className = 'btn';
      copyBtn.type = 'button';
      copyBtn.textContent = 'コピー';

      const dlBtn = document.createElement('button');
      dlBtn.className = 'btn ghost';
      dlBtn.type = 'button';
      dlBtn.textContent = 'ダウンロード';

      copyBtn.addEventListener('click', () => {
        copyTextToClipboard(textarea.value)
          .then(() => {
            status.textContent = 'コピーしました。';
          })
          .catch((err) => {
            status.textContent = `コピーできませんでした: ${String(err)}`;
          });
      });

      dlBtn.addEventListener('click', () => {
        const now = new Date();
        const stamp = now.toISOString().replaceAll(':', '').replaceAll('.', '');
        const base = threadId ? `codex_terminal_${threadId.slice(0, 8)}` : 'codex_terminal';
        const name = `${base}_${stamp}.md`;
        try {
          downloadTextAsFile(textarea.value, name);
          status.textContent = `保存しました: ${name}`;
        } catch (err) {
          status.textContent = `保存できませんでした: ${String(err)}`;
        }
      });

      group.appendChild(scopeLabel);
      group.appendChild(scope);
      group.appendChild(countLabel);
      group.appendChild(countInput);
      group.appendChild(turnLabel);
      group.appendChild(turnInput);
      group.appendChild(assistantOnlyWrap);
      group.appendChild(outLabel);
      group.appendChild(textarea);
      container.appendChild(group);
      container.appendChild(hint);

      actions.appendChild(copyBtn);
      actions.appendChild(dlBtn);
      container.appendChild(actions);
      container.appendChild(status);
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
  await loadCodexModel();
  await loadCodexEffort();
  await loadEffortCapsByModel();
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
