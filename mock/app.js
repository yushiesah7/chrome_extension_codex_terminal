const chatEl = document.getElementById('chat');
const attachBtn = document.getElementById('attachBtn');
const fileInput = document.getElementById('fileInput');
const promptInput = document.getElementById('promptInput');
const clearBtn = document.getElementById('clearBtn');
const dropZone = document.getElementById('dropZone');
const attachmentsEl = document.getElementById('attachments');
const settingsBtn = document.getElementById('settingsBtn');
const settingsMenu = document.getElementById('settingsMenu');
const settingsPanel = document.getElementById('settingsPanel');
const panelOverlay = document.getElementById('panelOverlay');
const panelTitleEl = document.getElementById('panelTitle');
const panelBodyEl = document.getElementById('panelBody');
const panelClose = document.getElementById('panelClose');

const LS_KEY_START_CMD = 'mock.startCommand';
const LS_KEY_CI_START_CMD = 'mock.ciStartCommand';
const LS_KEY_CI_RESTART_CMD = 'mock.ciRestartCommand';
const DEFAULT_CODEX_CMD =
  'codex exec --skip-git-repo-check --sandbox read-only --color never --json -C /tmp/chrome_extension_codex_terminal';
const LS_KEY_PROMPT = 'mock.promptTemplate';
const DEFAULT_PROMPT = [
  '# 前提プロンプト',
  '記載された内容に対してわかりやすい説明をしてください',
  'フローが必要なものであれば簡易mermaidでわかりやすく挿入し、フローなどの存在しない用語説明などであればシンプルに用語の解説をしてあげてください',
  '',
  '下記のラインは以下に記載されている内容がユーザーの質問事項になります（画像の場合もあります）',
  '-----------------------------------------------------------------------------------------------'
].join('\n');

/** @type {{id:string, name:string, type:string, dataUrl:string}[]} */
let attachments = [];

function uid() {
  return Math.random().toString(16).slice(2) + Date.now().toString(16);
}

if (window.mermaid) {
  window.mermaid.initialize({ startOnLoad: false, theme: 'dark' });
}

function scrollToBottom() {
  chatEl.scrollTop = chatEl.scrollHeight;
}

function toggleSettingsMenu(open) {
  const next = open ?? settingsMenu.hidden;
  settingsMenu.hidden = !next;
  settingsBtn.setAttribute('aria-expanded', String(next));
}

let panelOpen = false;

function setPanelOpen(on) {
  panelOpen = !!on;
  settingsPanel.hidden = !panelOpen;
  settingsPanel.setAttribute('aria-hidden', String(!panelOpen));
  if (panelOverlay) {
    panelOverlay.hidden = !panelOpen;
  }
}

function showPanel(title, bodyHtml) {
  panelTitleEl.textContent = title;
  panelBodyEl.innerHTML = bodyHtml;
  setPanelOpen(true);
}

function hidePanel() {
  setPanelOpen(false);
}

function loadSetting(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    if (typeof v === 'string' && v.length) return v;
  } catch {
  }
  return fallback;
}

function saveSetting(key, value) {
  try {
    localStorage.setItem(key, String(value ?? ''));
  } catch {
  }
}

function applyToPromptInput(value) {
  promptInput.value = String(value ?? '');
  autoResizeTextarea();
  setSendEnabled();
  promptInput.focus();
}

function autoResizeTextarea() {
  promptInput.style.height = 'auto';
  const max = 180;
  promptInput.style.height = Math.min(promptInput.scrollHeight, max) + 'px';
}

function setSendEnabled() {
  const hasText = promptInput.value.trim().length > 0 || attachments.length > 0;
  clearBtn.disabled = !hasText;
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
    img.alt = item.name;
    img.src = item.dataUrl;

    const rm = document.createElement('button');
    rm.className = 'attachRm';
    rm.type = 'button';
    rm.textContent = '×';
    rm.title = '削除';
    rm.addEventListener('click', () => {
      attachments = attachments.filter((a) => a.id !== item.id);
      renderAttachments();
      setSendEnabled();
    });

    card.appendChild(img);
    card.appendChild(rm);
    attachmentsEl.appendChild(card);
  }
}

function addMessage({ role, text, images, html }) {
  const row = document.createElement('div');
  row.className = `messageRow ${role}`;

  const bubble = document.createElement('div');
  bubble.className = `bubble ${role} markdown`;
  if (typeof html === 'string') {
    bubble.innerHTML = html;
  } else {
    bubble.textContent = text || '';
  }

  renderMermaidIn(bubble);

  if (Array.isArray(images) && images.length) {
    const grid = document.createElement('div');
    grid.className = 'msgImages';
    for (const src of images) {
      const img = document.createElement('img');
      img.className = 'msgImg';
      img.src = src;
      img.alt = 'attachment';
      grid.appendChild(img);
    }
    bubble.appendChild(grid);
  }

  row.appendChild(bubble);
  chatEl.appendChild(row);
  scrollToBottom();
}

function renderMermaidIn(container) {
  if (!window.mermaid) return;
  const codeBlocks = container.querySelectorAll('code.language-mermaid');
  if (!codeBlocks.length) return;

  codeBlocks.forEach((codeEl) => {
    const parentPre = codeEl.closest('pre');
    const code = codeEl.textContent || '';
    const id = `mmd-${uid()}`;

    window.mermaid
      .render(id, code)
      .then(({ svg }) => {
        const block = document.createElement('div');
        block.className = 'mermaidBlock';

        const svgWrapper = document.createElement('div');
        svgWrapper.className = 'mermaidWrapper';
        svgWrapper.innerHTML = svg;

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
      })
      .catch(() => {});
  });
}

function setThinking(on) {
  const existing = document.getElementById('thinking');
  if (!on) {
    if (existing) existing.remove();
    return;
  }
  if (existing) return;

  const row = document.createElement('div');
  row.id = 'thinking';
  row.className = 'messageRow assistant';

  const bubble = document.createElement('div');
  bubble.className = 'bubble assistant';
  bubble.innerHTML = '<span class="dots"><span></span><span></span><span></span></span>';

  row.appendChild(bubble);
  chatEl.appendChild(row);
  scrollToBottom();
}

function mockAnswerFor(promptText) {
  const escaped = promptText
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');

  return [
    '<p><strong>（モック回答）</strong></p>',
    `<p>質問: <code>${escaped || '（空）'}</code></p>`,
    '<ul>',
    '<li>ここはデザイン確認用です</li>',
    '<li>実装側ではこの場所にCodexのMarkdown回答が入ります</li>',
    '</ul>',
    '<pre><code>// 例: コードブロック\nconsole.log(\"hello\");</code></pre>'
  ].join('');
}

async function readImageFile(file) {
  const dataUrl = await new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onerror = () => reject(new Error('read failed'));
    r.onload = () => resolve(String(r.result || ''));
    r.readAsDataURL(file);
  });

  attachments.push({
    id: uid(),
    name: file.name || 'image',
    type: file.type || 'image/*',
    dataUrl
  });
}

async function addFiles(fileList) {
  const files = Array.from(fileList || []);
  const images = files.filter((f) => f && typeof f.type === 'string' && f.type.startsWith('image/'));
  for (const f of images) {
    // eslint-disable-next-line no-await-in-loop
    await readImageFile(f);
  }
  renderAttachments();
  setSendEnabled();
}

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

settingsBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  if (panelOpen) {
    hidePanel();
    toggleSettingsMenu(false);
  } else {
    toggleSettingsMenu(settingsMenu.hidden);
  }
});

document.addEventListener('click', (e) => {
  const target = e.target;
  if (!settingsMenu.hidden && !settingsMenu.contains(target) && target !== settingsBtn) {
    toggleSettingsMenu(false);
  }
  if (!settingsPanel.hidden && !settingsPanel.contains(target) && !settingsMenu.contains(target) && target !== settingsBtn) {
    hidePanel();
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    toggleSettingsMenu(false);
    hidePanel();
  }
});

panelClose.addEventListener('click', () => {
  hidePanel();
});

panelOverlay?.addEventListener('click', () => {
  hidePanel();
});

settingsMenu.addEventListener('click', (e) => {
  e.stopPropagation();
  const target = e.target;
  if (!(target instanceof HTMLElement)) return;
  const action = target.dataset.action;
  if (!action) return;

  toggleSettingsMenu(false);

  if (action === 'prompt') {
    const promptValue = loadSetting(LS_KEY_PROMPT, DEFAULT_PROMPT);
    const defaultPrompt = DEFAULT_PROMPT;
    const safeValue = promptValue.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
    showPanel(
      'プロンプト設定',
      [
        '<div class="panelGroup">',
        '<label class="panelLabel" for="promptInputSetting">プロンプト</label>',
        `<textarea id="promptInputSetting" class="panelTextarea" rows="8">${safeValue}</textarea>`,
        '</div>',
        '<div class="panelActions">',
        '<button id="savePrompt" class="btn">保存</button>',
        '<button id="resetPrompt" class="btn ghost">デフォルトに戻す</button>',
        '</div>'
      ].join('')
    );

    const promptSettingInput = panelBodyEl.querySelector('#promptInputSetting');
    const savePromptBtn = panelBodyEl.querySelector('#savePrompt');
    const resetPromptBtn = panelBodyEl.querySelector('#resetPrompt');

    savePromptBtn?.addEventListener('click', () => {
      const next = String(promptSettingInput?.value ?? '').trim() || defaultPrompt;
      saveSetting(LS_KEY_PROMPT, next);
      showPanel('プロンプト設定', '<p class="muted">保存しました。</p>');
    });

    resetPromptBtn?.addEventListener('click', () => {
      if (promptSettingInput) promptSettingInput.value = defaultPrompt;
      saveSetting(LS_KEY_PROMPT, defaultPrompt);
    });
    return;
  }
  if (action === 'start-ci') {
    const ciStartCmd = loadSetting(LS_KEY_CI_START_CMD, DEFAULT_CODEX_CMD);
    const defaultCi = DEFAULT_CODEX_CMD;
    const currentText = ciStartCmd.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
    showPanel(
      '起動CIコマンド',
      [
        '<div class="panelGroup">',
        '<label class="panelLabel" for="ciStartCmdInput">起動CIコマンド</label>',
        `<textarea id="ciStartCmdInput" class="panelTextarea" rows="3">${currentText}</textarea>`,
        '</div>',
        '<div class="panelActions">',
        '<button id="saveCiStart" class="btn">保存</button>',
        '<button id="resetCiStart" class="btn ghost">デフォルトに戻す</button>',
        '</div>'
      ].join('')
    );

    const ciStartCmdInput = panelBodyEl.querySelector('#ciStartCmdInput');
    const saveBtn = panelBodyEl.querySelector('#saveCiStart');
    const resetBtn = panelBodyEl.querySelector('#resetCiStart');

    saveBtn?.addEventListener('click', () => {
      const nextCiStart = String(ciStartCmdInput?.value ?? '').trim() || DEFAULT_CODEX_CMD;
      saveSetting(LS_KEY_START_CMD, nextCiStart);
      saveSetting(LS_KEY_CI_START_CMD, nextCiStart);
      showPanel('起動CIコマンド', '<p class="muted">保存しました。</p>');
    });

    resetBtn?.addEventListener('click', () => {
      if (ciStartCmdInput) ciStartCmdInput.value = defaultCi;
      saveSetting(LS_KEY_START_CMD, defaultCi);
      saveSetting(LS_KEY_CI_START_CMD, defaultCi);
    });
    return;
  }
  if (action === 'restart-ci') {
    const restartCmd = loadSetting(LS_KEY_CI_RESTART_CMD, 'npm run ci:restart');
    showPanel(
      'CIリスタート',
      [
        '<div class="panelGroup">',
        '<label class="panelLabel" for="ciRestartCmdInput">CIリスタートコマンド</label>',
        `<textarea id="ciRestartCmdInput" class="panelTextarea" rows="3">${restartCmd.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')}</textarea>`,
        '</div>',
        '<div class="panelActions">',
        '<button id="saveCiRestart" class="btn">保存</button>',
        '<button id="useCiRestart" class="btn ghost">入力欄に反映</button>',
        '</div>'
      ].join('')
    );

    const ciRestartCmdInput = panelBodyEl.querySelector('#ciRestartCmdInput');
    const saveBtn = panelBodyEl.querySelector('#saveCiRestart');
    const useBtn = panelBodyEl.querySelector('#useCiRestart');

    saveBtn?.addEventListener('click', () => {
      const next = String(ciRestartCmdInput?.value ?? '').trim() || 'npm run ci:restart';
      saveSetting(LS_KEY_CI_RESTART_CMD, next);
      showPanel('CIリスタート', '<p class="muted">保存しました。</p>');
    });

    useBtn?.addEventListener('click', () => {
      applyToPromptInput(String(ciRestartCmdInput?.value ?? ''));
    });
  }
});

clearBtn.addEventListener('click', () => {
  promptInput.value = '';
  attachments = [];
  renderAttachments();
  autoResizeTextarea();
  setSendEnabled();
});

function submitPrompt() {
  const text = promptInput.value.trim();
  const imgs = attachments.map((a) => a.dataUrl);

  if (!text && !imgs.length) return;

  addMessage({ role: 'user', text, images: imgs });
  promptInput.value = '';
  attachments = [];
  renderAttachments();
  setSendEnabled();
  autoResizeTextarea();

  setThinking(true);
  setTimeout(() => {
    setThinking(false);
    addMessage({ role: 'assistant', html: mockAnswerFor(text) });
  }, 650);
}

function seedDemoMessages() {
  addMessage({
    role: 'assistant',
    html:
      '<p><strong>モックです。</strong> ここでUIの見た目だけ先に詰められます。</p><ul><li>テキストを入力して送信</li><li>画像を貼り付け/ドラッグ/「＋」で添付</li></ul>'
  });

  addMessage({
    role: 'user',
    text: 'このツールの処理フローを mermaid で表示してみたい'
  });

  addMessage({
    role: 'assistant',
    html: [
      '<p>例としてフロー図を添付してみます。</p>',
      '<pre><code class="language-mermaid">flowchart TD',
      '  start(["ユーザー操作"]) --> fetch["データ取得"]',
      '  fetch --> decide{条件分岐}',
      '  decide -->|OK| success["結果を表示"]',
      '  decide -->|NG| error["エラー表示"]',
      '</code></pre>'
    ].join('\n')
  });

  scrollToBottom();
}

// initial
autoResizeTextarea();
setSendEnabled();
seedDemoMessages();
// safety: ensure menus/panel are closed on load
toggleSettingsMenu(false);
hidePanel();

