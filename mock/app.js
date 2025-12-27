const chatEl = document.getElementById('chat');
const resetBtn = document.getElementById('resetBtn');
const attachBtn = document.getElementById('attachBtn');
const fileInput = document.getElementById('fileInput');
const promptInput = document.getElementById('promptInput');
const sendBtn = document.getElementById('sendBtn');
const dropZone = document.getElementById('dropZone');
const attachmentsEl = document.getElementById('attachments');

/** @type {{id:string, name:string, type:string, dataUrl:string}[]} */
let attachments = [];

function uid() {
  return Math.random().toString(16).slice(2) + Date.now().toString(16);
}

function scrollToBottom() {
  chatEl.scrollTop = chatEl.scrollHeight;
}

function setSendEnabled() {
  const hasText = promptInput.value.trim().length > 0;
  sendBtn.disabled = !(hasText || attachments.length > 0);
}

function autoResizeTextarea() {
  promptInput.style.height = 'auto';
  const max = 180;
  promptInput.style.height = Math.min(promptInput.scrollHeight, max) + 'px';
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
    if (!sendBtn.disabled) sendBtn.click();
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

sendBtn.addEventListener('click', () => {
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
});

resetBtn.addEventListener('click', () => {
  chatEl.innerHTML = '';
  attachments = [];
  renderAttachments();
  promptInput.value = '';
  setSendEnabled();
  autoResizeTextarea();

  addMessage({
    role: 'assistant',
    html:
      '<p><strong>（モック）</strong> ここでUIを詰めましょう。テキストや画像を入れて送信すると表示の確認ができます。</p>'
  });
});

// initial
autoResizeTextarea();
setSendEnabled();
scrollToBottom();

