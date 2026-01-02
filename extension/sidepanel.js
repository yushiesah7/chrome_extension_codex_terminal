// Native Messaging host 名（manifest / host manifest と一致させる）
const NATIVE_HOST_NAME = 'com.yushi.chrome_extension_codex_terminal';

const STORAGE_KEY_PENDING = 'pendingCodexAsk';
const STORAGE_KEY_THREAD_ID = 'codexThreadId';
const STORAGE_KEY_PROMPT_TEMPLATE = 'promptTemplate';
const STORAGE_KEY_CI_START_CMD = 'ciStartCommand';
const STORAGE_KEY_CI_RESTART_CMD = 'ciRestartCommand';
const STORAGE_KEY_SHOW_ADVANCED = 'showAdvancedActions';
const STORAGE_KEY_CODEX_MODEL = 'codexModel';
const STORAGE_KEY_CODEX_EFFORT = 'codexReasoningEffort';
const STORAGE_KEY_CODEX_EFFORT_CAPS = 'codexEffortCapsByModel';

const MODEL_PRESETS = [
  { value: '', label: 'デフォルト（config.toml）' },
  { value: 'gpt-5.2-codex', label: 'gpt-5.2-codex' },
  { value: 'gpt-5.1-codex-max', label: 'gpt-5.1-codex-max' },
  { value: 'gpt-5.1-codex-mini', label: 'gpt-5.1-codex-mini' },
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
const sendBtn = document.getElementById('sendBtn');
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

/** @type {{bubble:HTMLElement, buffer:string, hasStarted:boolean, renderTimer:number, lastRenderAt:number, lastRenderedLen:number} | null} */
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

let showAdvancedActions = false;

function setAdvancedMenuVisible(on) {
  showAdvancedActions = !!on;
  try {
    document.querySelectorAll('[data-advanced]')?.forEach((el) => {
      if (el instanceof HTMLElement) el.hidden = !showAdvancedActions;
    });
  } catch {
    // ignore
  }
  try {
    chrome.storage.local.set({ [STORAGE_KEY_SHOW_ADVANCED]: showAdvancedActions }).catch(() => {});
  } catch {
    // ignore
  }
}

async function loadAdvancedMenuVisible() {
  try {
    const data = await chrome.storage.local.get([STORAGE_KEY_SHOW_ADVANCED]);
    showAdvancedActions = !!data[STORAGE_KEY_SHOW_ADVANCED];
  } catch {
    showAdvancedActions = false;
  }
  setAdvancedMenuVisible(showAdvancedActions);
}

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

const DIAG_LOG_MAX = 240;
let diagLogs = [];

function diagSafeJson(value) {
  try {
    return JSON.stringify(
      value,
      (_k, v) => {
        if (typeof v === 'string' && v.length > 600) return `${v.slice(0, 600)}…`;
        return v;
      },
      0
    );
  } catch {
    try {
      return String(value);
    } catch {
      return '';
    }
  }
}

function diagLog(level, event, data) {
  const now = new Date();
  const line = {
    t: now.toISOString(),
    level: safeString(level) || 'info',
    event: safeString(event) || 'event',
    data
  };
  diagLogs.push(line);
  if (diagLogs.length > DIAG_LOG_MAX) diagLogs = diagLogs.slice(diagLogs.length - DIAG_LOG_MAX);
}

function diagDumpText() {
  const now = new Date();
  let manifestVersion = '';
  try {
    manifestVersion = safeString(chrome?.runtime?.getManifest?.()?.version);
  } catch {
    manifestVersion = '';
  }
  const header = {
    generatedAt: now.toISOString(),
    extensionVersion: manifestVersion,
    userAgent: safeString(navigator.userAgent),
    href: safeString(location.href)
  };
  const lines = [];
  lines.push('### diag header');
  lines.push(diagSafeJson(header));
  lines.push('');
  lines.push('### diag logs');
  for (const row of diagLogs) {
    lines.push(`${row.t}\t${row.level}\t${row.event}\t${diagSafeJson(row.data)}`);
  }
  return lines.join('\n');
}

window.addEventListener('error', (e) => {
  try {
    diagLog('error', 'window_error', {
      message: safeString(e?.message),
      filename: safeString(e?.filename),
      lineno: e?.lineno,
      colno: e?.colno
    });
  } catch {
    // ignore
  }
});

window.addEventListener('unhandledrejection', (e) => {
  try {
    diagLog('error', 'unhandledrejection', { reason: String(e?.reason) });
  } catch {
    // ignore
  }
});

window.addEventListener('securitypolicyviolation', (e) => {
  try {
    diagLog('error', 'csp_violation', {
      blockedURI: safeString(e?.blockedURI),
      violatedDirective: safeString(e?.violatedDirective),
      effectiveDirective: safeString(e?.effectiveDirective),
      originalPolicy: safeString(e?.originalPolicy),
      sourceFile: safeString(e?.sourceFile),
      lineNumber: e?.lineNumber,
      columnNumber: e?.columnNumber
    });
  } catch {
    // ignore
  }
});

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
    await chrome.storage.local.set({ [STORAGE_KEY_CI_START_CMD]: v });
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
    const v = safeString(data[STORAGE_KEY_CODEX_MODEL]).trim();
    // 互換性: 古い値の移行（Codex CLIのモデル名に合わせる）
    if (v === 'gpt-5.2') {
      codexModel = 'gpt-5.2-codex';
      chrome.storage.local.set({ [STORAGE_KEY_CODEX_MODEL]: codexModel }).catch(() => {});
    } else {
      codexModel = v;
    }
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
  if (!metaEl) return;

  const sessionLabel = threadId ? threadId.slice(0, 8) + '…' : 'new';
  const connectionState = isConnected ? 'ok' : isConnecting ? 'connecting' : 'ng';
  const connectionText = isConnected ? '接続 OK' : isConnecting ? '接続 中' : '接続 NG';

  metaEl.textContent = '';
  metaEl.classList.toggle('isConnecting', connectionState === 'connecting');
  metaEl.classList.toggle('isConnected', connectionState === 'ok');
  metaEl.classList.toggle('isDisconnected', connectionState === 'ng');

  const makeChip = (text, kind) => {
    const el = document.createElement('span');
    el.className = `metaChip${kind ? ` ${kind}` : ''}`;
    el.textContent = text;
    return el;
  };

  metaEl.appendChild(makeChip(connectionText, `state ${connectionState}`));
  metaEl.appendChild(makeChip(`会話 ${sessionLabel}`, 'kv'));
  if (codexModel) metaEl.appendChild(makeChip(`モデル ${formatModelForMeta(codexModel)}`, 'kv'));
  if (codexReasoningEffort) metaEl.appendChild(makeChip(`推論 ${codexReasoningEffort}`, 'kv'));
}

function scrollToBottom() {
  chatEl.scrollTop = chatEl.scrollHeight;
}

let composerResizeObserver = null;
let composerHeightRaf = 0;
let lastComposerHeightPx = 0;

function updateComposerHeightVar() {
  const composer = document.querySelector('.composer');
  if (!(composer instanceof HTMLElement)) return;
  const rect = composer.getBoundingClientRect();
  const next = Math.max(0, Math.ceil(rect.height));
  if (!next || next === lastComposerHeightPx) return;
  lastComposerHeightPx = next;
  try {
    document.documentElement.style.setProperty('--composer-height', `${next}px`);
  } catch {
    // ignore
  }
}

function scheduleComposerHeightUpdate() {
  if (composerHeightRaf) return;
  composerHeightRaf = requestAnimationFrame(() => {
    composerHeightRaf = 0;
    updateComposerHeightVar();
  });
}

function installComposerHeightObserver() {
  scheduleComposerHeightUpdate();
  if (composerResizeObserver) return;
  const composer = document.querySelector('.composer');
  if (!(composer instanceof HTMLElement)) return;
  if (typeof ResizeObserver !== 'function') return;
  composerResizeObserver = new ResizeObserver(() => scheduleComposerHeightUpdate());
  composerResizeObserver.observe(composer);
  window.addEventListener(
    'resize',
    () => {
      scheduleComposerHeightUpdate();
    },
    { passive: true }
  );
}

function setSendEnabled() {
  const hasContent = promptInput.value.trim().length > 0 || attachments.length > 0;
  if (clearBtn) clearBtn.disabled = !hasContent;
  if (sendBtn) sendBtn.disabled = !hasContent || isRunning;
}

function autoResizeTextarea() {
  promptInput.style.height = 'auto';
  const max = 180;
  promptInput.style.height = Math.min(promptInput.scrollHeight, max) + 'px';
  scheduleComposerHeightUpdate();
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
    return DOMPurify.sanitize(html, {
      USE_PROFILES: { html: true },
      ADD_ATTR: ['class'],
      // 追跡/外部リクエストやUI崩しを避ける（添付画像は別DOMで描画するため影響なし）
      FORBID_TAGS: ['img', 'style'],
      FORBID_ATTR: ['style']
    });
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
  const msg = event.data;
  if (!msg || typeof msg !== 'object') return;
  if (msg.__from !== 'mermaid_sandbox') return;

  try {
    diagLog('info', 'mermaid_sandbox_message', {
      type: safeString(msg.type),
      id: safeString(msg.id),
      svgLen: typeof msg.svg === 'string' ? msg.svg.length : undefined,
      error: typeof msg.error === 'string' ? msg.error : undefined
    });
  } catch {
    // ignore
  }

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
    frame.src = chrome?.runtime?.getURL ? chrome.runtime.getURL('mermaid_sandbox.html') : 'mermaid_sandbox.html';
    frame.style.position = 'fixed';
    frame.style.left = '-10000px';
    frame.style.top = '0';
    frame.style.width = '1024px';
    frame.style.height = '768px';
    frame.style.opacity = '0';
    frame.style.pointerEvents = 'none';
    frame.style.border = '0';
    frame.setAttribute('title', 'mermaid sandbox');
    document.body.appendChild(frame);
    mermaidSandboxFrame = frame;

    try {
      diagLog('info', 'mermaid_sandbox_create', { src: frame.src });
    } catch {
      // ignore
    }

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

  try {
    diagLog('info', 'mermaid_render_request', { id, codeLen: src.length });
  } catch {
    // ignore
  }

  const done = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      mermaidWaiters.delete(id);
      reject(new Error('Mermaid render timeout'));
    }, 15_000);
    mermaidWaiters.set(id, { resolve, reject, timer });
  });

  let sandboxOrigin = '';
  try {
    sandboxOrigin = new URL(mermaidSandboxFrame.src, location.href).origin;
  } catch {
    sandboxOrigin = '';
  }
  if (!sandboxOrigin) throw new Error('Mermaid sandbox origin を特定できません');
  mermaidSandboxFrame.contentWindow.postMessage({ type: 'render_mermaid', id, code: src }, sandboxOrigin);
  return done;
}

function inspectSvgForDiag(svgHtml) {
  const s = safeString(svgHtml);
  const result = { svgLen: s.length, hasSvgTag: s.includes('<svg') };
  try {
    const doc = new DOMParser().parseFromString(s, 'image/svg+xml');
    const svgEl = doc.querySelector('svg');
    if (svgEl) {
      result.viewBox = safeString(svgEl.getAttribute('viewBox'));
      result.width = safeString(svgEl.getAttribute('width'));
      result.height = safeString(svgEl.getAttribute('height'));
      result.preserveAspectRatio = safeString(svgEl.getAttribute('preserveAspectRatio'));
    }
    const parseError = doc.querySelector('parsererror');
    if (parseError) result.parseError = safeString(parseError.textContent).slice(0, 180);
  } catch (e) {
    result.inspectError = String(e);
  }
  return result;
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

    try {
      diagLog('info', 'mermaid_detected', {
        codeLen: code.length,
        hasParentPre: !!parentPre,
        containerTag: safeString(container.tagName)
      });
    } catch {
      // ignore
    }

    renderMermaidSvg(code)
      .then((svg) => {
        try {
          diagLog('info', 'mermaid_render_result_raw', inspectSvgForDiag(svg));
        } catch {
          // ignore
        }

        const svgHtml =
          typeof DOMPurify?.sanitize === 'function'
            ? DOMPurify.sanitize(svg, {
                USE_PROFILES: { svg: true, svgFilters: true },
                // Mermaid のSVGは <style> と class に依存するため許可する（securityLevel=strict で生成）
                ADD_TAGS: ['style', 'foreignObject'],
                ADD_ATTR: [
                  'class',
                  'style',
                  'xmlns',
                  'viewBox',
                  'width',
                  'height',
                  'preserveAspectRatio',
                  'href',
                  'xlink:href'
                ]
              })
            : svg;

        try {
          diagLog('info', 'mermaid_render_result_sanitized', inspectSvgForDiag(svgHtml));
        } catch {
          // ignore
        }

        const block = document.createElement('div');
        block.className = 'mermaidBlock';

        const svgWrapper = document.createElement('div');
        svgWrapper.className = 'mermaidWrapper';
        svgWrapper.innerHTML = svgHtml;

        const footer = document.createElement('div');
        footer.className = 'mermaidFooter';
        const copyBtn = document.createElement('button');
        copyBtn.className = 'miniIconBtn ghost copyBtn';
        copyBtn.type = 'button';
        copyBtn.title = 'Mermaidコードをコピー';
        copyBtn.setAttribute('aria-label', 'Mermaidコードをコピー');
        copyBtn.setAttribute('data-tooltip', 'Mermaidコードをコピー');
        copyBtn.innerHTML =
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
          '<path d="M8 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-2" />' +
          '<rect x="8" y="2" width="12" height="16" rx="2" ry="2" />' +
          '</svg>';
        const copyStatus = document.createElement('span');
        copyStatus.className = 'copyStatus';
        copyBtn.addEventListener('click', () => {
          navigator.clipboard
            ?.writeText(code)
            .then(() => {
              copyStatus.textContent = 'Mermaidコードをコピーしました';
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
      .catch((e) => {
        try {
          console.warn('Mermaid render failed', e);
        } catch {
          // ignore
        }

        try {
          diagLog('error', 'mermaid_render_failed', { message: String(e) });
        } catch {
          // ignore
        }
      });
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

function ensureBubbleCopyAction(bubble) {
  if (!(bubble instanceof HTMLElement)) return;
  if (bubble.querySelector('.msgActions')) return;

  const actions = document.createElement('div');
  actions.className = 'msgActions';

  const copyBtn = document.createElement('button');
  copyBtn.className = 'miniIconBtn ghost';
  copyBtn.type = 'button';
  copyBtn.title = 'コメント全文をコピー';
  copyBtn.setAttribute('aria-label', 'コメント全文をコピー');
  copyBtn.setAttribute('data-tooltip', 'コメント全文をコピー');
  copyBtn.innerHTML =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M8 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-2" />' +
    '<rect x="8" y="2" width="12" height="16" rx="2" ry="2" />' +
    '</svg>';

  copyBtn.addEventListener('click', () => {
    const text = safeString(bubble.dataset.rawMarkdown || bubble.textContent);
    copyTextToClipboard(text)
      .then(() => {
        setStatus('コメント全文をコピーしました');
      })
      .catch((e) => {
        try {
          setStatus(`コピー失敗: ${String(e?.message || e)}`);
        } catch {
          setStatus('コピー失敗');
        }
      });
  });

  actions.appendChild(copyBtn);
  bubble.appendChild(actions);
}

function setBubbleMarkdown(bubble, markdown, { renderMermaid = true } = {}) {
  const html = renderMarkdownToHtml(markdown);
  try {
    bubble.dataset.rawMarkdown = safeString(markdown);
  } catch {
    // ignore
  }

  const actionsNode = bubble.querySelector('.msgActions');
  if (actionsNode) {
    try {
      actionsNode.remove();
    } catch {
      // ignore
    }
  }

  const imagesNode = bubble.querySelector('.msgImages');
  if (imagesNode) {
    try {
      imagesNode.remove();
    } catch {
      // ignore
    }
  }

  if (html) {
    bubble.innerHTML = html;
    if (renderMermaid) renderMermaidIn(bubble);
  } else {
    bubble.textContent = markdown;
  }

  if (imagesNode) bubble.appendChild(imagesNode);
  if (actionsNode) bubble.appendChild(actionsNode);

  ensureBubbleCopyAction(bubble);
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
  currentAssistant = {
    bubble,
    buffer: '',
    hasStarted: false,
    renderTimer: 0,
    lastRenderAt: 0,
    lastRenderedLen: 0
  };
  scrollToBottom();
}

const STREAM_RENDER_INTERVAL_MS = 120;

function scheduleAssistantStreamingRender() {
  if (!currentAssistant) return;

  const assistant = currentAssistant;
  const bubble = assistant.bubble;
  const buffer = assistant.buffer;
  if (!buffer) return;

  if (assistant.renderTimer) return;

  const now = typeof performance?.now === 'function' ? performance.now() : Date.now();
  const since = now - (assistant.lastRenderAt || 0);
  const dueIn = since >= STREAM_RENDER_INTERVAL_MS ? 0 : STREAM_RENDER_INTERVAL_MS - since;

  assistant.renderTimer = window.setTimeout(() => {
    if (!currentAssistant || currentAssistant !== assistant) return;
    assistant.renderTimer = 0;
    const t = typeof performance?.now === 'function' ? performance.now() : Date.now();
    assistant.lastRenderAt = t;

    const md = assistant.buffer;
    assistant.lastRenderedLen = md.length;
    setBubbleMarkdown(bubble, md, { renderMermaid: false });
    scrollToBottom();

    // 描画中にさらに追記されていたら次回描画を予約
    if (currentAssistant && currentAssistant === assistant && assistant.buffer.length !== assistant.lastRenderedLen) {
      scheduleAssistantStreamingRender();
    }
  }, dueIn);
}

function appendAssistantText(text) {
  if (!currentAssistant) startAssistantMessage();
  if (!currentAssistant) return;

  currentAssistant.buffer += text;
  if (!currentAssistant.hasStarted) {
    currentAssistant.hasStarted = true;
  }
  scheduleAssistantStreamingRender();
}

function finishAssistantMarkdown() {
  if (!currentAssistant) return;
  if (currentAssistant.renderTimer) {
    try {
      clearTimeout(currentAssistant.renderTimer);
    } catch {
      // ignore
    }
    currentAssistant.renderTimer = 0;
  }
  const markdown = currentAssistant.buffer.trimEnd();
  if (markdown) {
    setBubbleMarkdown(currentAssistant.bubble, markdown, { renderMermaid: true });
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
    if (currentAssistant.renderTimer) {
      try {
        clearTimeout(currentAssistant.renderTimer);
      } catch {
        // ignore
      }
      currentAssistant.renderTimer = 0;
    }
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
  if (currentAssistant?.renderTimer) {
    try {
      clearTimeout(currentAssistant.renderTimer);
    } catch {
      // ignore
    }
  }
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
    '<p><strong>はじめに</strong></p><ul><li>下の入力欄に質問を書いて送信</li><li>画像は「添付」ボタン / 貼り付け / ドロップで追加</li><li>設定からモデル・推論レベル・エクスポートを変更</li></ul>';
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
    scheduleComposerHeightUpdate();
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
  scheduleComposerHeightUpdate();
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

  const clearWaiter = () => {
    const w = uploadWaiters.get(key);
    if (w) {
      uploadWaiters.delete(key);
      try {
        clearTimeout(w.timer);
      } catch {
        // ignore
      }
    }
  };

  const mustHavePort = () => {
    if (!port) throw new Error('アップロード中に接続が切断されました');
    return port;
  };

  try {
    mustHavePort().postMessage({
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
      mustHavePort().postMessage({
        type: 'upload_image_chunk',
        requestId,
        imageId,
        seq,
        data: bytesToBase64(slice)
      });
      seq++;
    }

    mustHavePort().postMessage({ type: 'upload_image_end', requestId, imageId, chunks: seq });
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    clearWaiter();
    throw err;
  }

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

  const safeFiles = Array.isArray(files) ? files : [];
  const hasText = safeString(userText).trim().length > 0;
  const hasSelection = safeString(selectionText).trim().length > 0;
  const hasImages = safeFiles.length > 0;
  if (!hasText && !hasSelection && !hasImages) return;

  // UI: user message
  addUserMessage({
    markdown: buildUserMarkdown({ userText, selectionText, pageUrl, hasImages }),
    imagePreviews: safeFiles.map((f) => f.previewUrl)
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
  try {
    for (const f of safeFiles) {
      // eslint-disable-next-line no-await-in-loop
      await uploadImage({ requestId, imageId: f.id, file: f.file });
      imageIds.push(f.id);
    }
  } catch (e) {
    isRunning = false;
    setSendEnabled();
    failAssistant(`[Error] 画像アップロード失敗:\n${String(e?.message || e)}`);
    return;
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
sendBtn?.addEventListener('click', () => submitPrompt());
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
  const item = target.closest('.menuItem');
  if (!(item instanceof HTMLElement)) return;
  const action = item.dataset.action;
  if (!action) return;

  toggleSettingsMenu(false);

  if (action === 'copy-all') {
    const md = buildConversationMarkdown({ mode: 'all', count: 1, turnNumber: 1, assistantOnly: false });
    copyTextToClipboard(md)
      .then(() => {
        setStatus('会話をコピーしました');
      })
      .catch((e) => {
        try {
          setStatus(`コピー失敗: ${String(e?.message || e)}`);
        } catch {
          setStatus('コピー失敗');
        }
      });
    return;
  }

  if (action === 'prompt') {
    showPanel('前提プロンプト', (container) => {
      const group = document.createElement('div');
      group.className = 'panelGroup';

      const intro = document.createElement('p');
      intro.className = 'panelHelp';
      intro.textContent = '毎回の送信前に付与する前提プロンプトです。よく使うルールや口調をここに入れます。';
      container.appendChild(intro);

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
    showPanel('モデル / 推論', (container) => {
      const group = document.createElement('div');
      group.className = 'panelGroup';

      const intro = document.createElement('p');
      intro.className = 'panelHelp';
      intro.textContent = '使用するモデルと推論レベルを切り替えます。空欄なら codex の設定（~/.codex/config.toml）を使用します。';
      container.appendChild(intro);

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

      const intro = document.createElement('p');
      intro.className = 'panelHelp';
      intro.textContent = 'ローカルで `codex` を起動するコマンドです。環境に合わせて編集します。';
      container.appendChild(intro);

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
    showPanel('CI再起動（コマンド）', (container) => {
      const group = document.createElement('div');
      group.className = 'panelGroup';

      const intro = document.createElement('p');
      intro.className = 'panelHelp';
      intro.textContent = 'CIを再起動するためのコマンドを保存します（会話のリセットではありません）。「入力欄に反映」でそのまま送信できます。';
      container.appendChild(intro);

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

      const intro = document.createElement('p');
      intro.className = 'panelHelp';
      intro.textContent = '会話ログをMarkdownとしてコピー/保存します。共有や貼り付け用。';
      container.appendChild(intro);

      const scopeLabel = document.createElement('label');
      scopeLabel.className = 'panelLabel';
      scopeLabel.textContent = '範囲';

      const scope = document.createElement('select');
      scope.className = 'panelSelect';
      for (const opt of [
        { value: 'all', label: '全て（全往復）' },
        { value: 'last', label: '最新（1往復）' },
        { value: 'lastN', label: '最新N（N往復）' },
        { value: 'turn', label: '指定（番号）' }
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
        '※ 画像そのものは埋め込まず、枚数だけメモします。コピー/保存はユーザー操作で実行します。';

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
        status.textContent = `会話: ${conversationTurns.length}往復`;

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
    setStatus('新しい会話を開始します。');
    resetConversation({ clearThread: true });
    pendingSelectionText = '';
    pendingPageUrl = '';
    return;
  }

  if (action === 'help') {
    showPanel('ヘルプ / 仕様', (container) => {
      const intro = document.createElement('p');
      intro.className = 'panelHelp';
      intro.textContent = 'この拡張の使い方、設定、よくある問題の解決方法をまとめています。';
      container.appendChild(intro);

      try {
        diagLog('info', 'help_open', { showAdvancedActions });
      } catch {
        // ignore
      }

      const advancedWrap = document.createElement('label');
      advancedWrap.className = 'panelToggle';

      const advancedToggle = document.createElement('input');
      advancedToggle.type = 'checkbox';
      advancedToggle.checked = showAdvancedActions;

      const advancedText = document.createElement('span');
      advancedText.textContent = '開発者向けメニューを表示（CI/起動コマンド）';

      advancedWrap.appendChild(advancedToggle);
      advancedWrap.appendChild(advancedText);
      container.appendChild(advancedWrap);

      const advancedHint = document.createElement('p');
      advancedHint.className = 'muted';
      advancedHint.textContent =
        'CI系は開発/運用のための補助です。通常の利用（質問→回答）には不要なので、必要な場合だけ表示してください。';
      container.appendChild(advancedHint);

      advancedToggle.addEventListener('change', () => {
        setAdvancedMenuVisible(advancedToggle.checked);
      });

      const s1 = document.createElement('div');
      s1.className = 'panelGroup';

      const h1 = document.createElement('p');
      h1.className = 'panelLabel';
      h1.textContent = '基本の使い方';

      const p1 = document.createElement('p');
      p1.className = 'muted';
      p1.textContent = '下の入力欄に質問を書いて送信します。画像は添付ボタン/貼り付け/ドロップで追加できます。';

      const h2 = document.createElement('p');
      h2.className = 'panelLabel';
      h2.textContent = '設定の意味';

      const p2 = document.createElement('p');
      p2.className = 'muted';
      p2.textContent = '前提プロンプト: 毎回のルール。モデル/推論: 出力の傾向。起動コマンド: `codex` 実行。';

      const h3 = document.createElement('p');
      h3.className = 'panelLabel';
      h3.textContent = 'トラブルシュート';

      const p3 = document.createElement('p');
      p3.className = 'muted';
      p3.textContent = '接続NGのときは Native Host のセットアップやホスト名一致を確認してください。';

      s1.appendChild(h1);
      s1.appendChild(p1);
      s1.appendChild(h2);
      s1.appendChild(p2);
      s1.appendChild(h3);
      s1.appendChild(p3);
      container.appendChild(s1);

      const diagGroup = document.createElement('div');
      diagGroup.className = 'panelGroup';

      const diagTitle = document.createElement('p');
      diagTitle.className = 'panelLabel';
      diagTitle.textContent = '診断ログ（Mermaid / CSP）';

      const diagDesc = document.createElement('p');
      diagDesc.className = 'muted';
      diagDesc.textContent =
        'Mermaid図が出ない等のトラブル解析用ログです。コピーして貼り付けるか、ファイル保存して共有できます。';

      const diagTextarea = document.createElement('textarea');
      diagTextarea.className = 'panelTextarea';
      diagTextarea.rows = 7;
      diagTextarea.readOnly = true;
      diagTextarea.value = diagDumpText();

      const diagActions = document.createElement('div');
      diagActions.className = 'panelActions';

      const diagRefreshBtn = document.createElement('button');
      diagRefreshBtn.className = 'btn ghost';
      diagRefreshBtn.type = 'button';
      diagRefreshBtn.textContent = '更新';

      const diagCopyBtn = document.createElement('button');
      diagCopyBtn.className = 'btn';
      diagCopyBtn.type = 'button';
      diagCopyBtn.textContent = 'ログをコピー';

      const diagDlBtn = document.createElement('button');
      diagDlBtn.className = 'btn ghost';
      diagDlBtn.type = 'button';
      diagDlBtn.textContent = 'ログを保存';

      const diagClearBtn = document.createElement('button');
      diagClearBtn.className = 'btn ghost';
      diagClearBtn.type = 'button';
      diagClearBtn.textContent = 'ログをクリア';

      const diagStatus = document.createElement('p');
      diagStatus.className = 'muted';
      diagStatus.textContent = '';

      const refreshDiag = () => {
        diagTextarea.value = diagDumpText();
      };

      diagRefreshBtn.addEventListener('click', () => {
        refreshDiag();
        diagStatus.textContent = '更新しました。';
      });

      diagCopyBtn.addEventListener('click', () => {
        refreshDiag();
        copyTextToClipboard(diagTextarea.value)
          .then(() => {
            diagStatus.textContent = 'コピーしました。';
          })
          .catch((err) => {
            diagStatus.textContent = `コピーできませんでした: ${String(err)}`;
          });
      });

      diagDlBtn.addEventListener('click', () => {
        refreshDiag();
        const now = new Date();
        const stamp = now.toISOString().replaceAll(':', '').replaceAll('.', '');
        const name = `codex_terminal_diag_${stamp}.txt`;
        try {
          downloadTextAsFile(diagTextarea.value, name);
          diagStatus.textContent = `保存しました: ${name}`;
        } catch (err) {
          diagStatus.textContent = `保存できませんでした: ${String(err)}`;
        }
      });

      diagClearBtn.addEventListener('click', () => {
        diagLogs = [];
        try {
          diagLog('info', 'diag_cleared');
        } catch {
          // ignore
        }
        refreshDiag();
        diagStatus.textContent = 'クリアしました。';
      });

      diagGroup.appendChild(diagTitle);
      diagGroup.appendChild(diagDesc);
      diagGroup.appendChild(diagTextarea);

      diagActions.appendChild(diagRefreshBtn);
      diagActions.appendChild(diagCopyBtn);
      diagActions.appendChild(diagDlBtn);
      diagActions.appendChild(diagClearBtn);
      diagGroup.appendChild(diagActions);
      diagGroup.appendChild(diagStatus);
      container.appendChild(diagGroup);

      const actions = document.createElement('div');
      actions.className = 'panelActions';

      const copyBtn = document.createElement('button');
      copyBtn.className = 'btn';
      copyBtn.type = 'button';
      copyBtn.textContent = '仕様をコピー';

      const status = document.createElement('p');
      status.className = 'muted';
      status.textContent = '';

      const specText = [
        '# Codex Terminal（Chrome拡張）',
        '',
        'この拡張は、サイドパネルからローカルの `codex` を実行して対話するためのUIです。',
        '',
        '## 操作',
        '- Enter: 送信',
        '- Shift+Enter: 改行',
        '- 画像: 添付/貼り付け/ドロップ',
        '',
        '## 設定',
        '- 前提プロンプト: 毎回の指示テンプレ',
        '- モデル/推論: 出力の傾向を調整',
        '- 起動コマンド: `codex` 実行コマンド',
        '',
        '## エクスポート',
        '- 会話ログをMarkdownでコピー/保存',
        ''
      ].join('\n');

      copyBtn.addEventListener('click', () => {
        copyTextToClipboard(specText)
          .then(() => {
            status.textContent = 'コピーしました。';
          })
          .catch((err) => {
            status.textContent = `コピーできませんでした: ${String(err)}`;
          });
      });

      actions.appendChild(copyBtn);
      container.appendChild(actions);
      container.appendChild(status);
    });
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
  await loadAdvancedMenuVisible();
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
  installComposerHeightObserver();
  setSendEnabled();

  // 接続は必要になったら行う（起動時に失敗ログを出さない）
  await loadPendingAsk();
}

init();
