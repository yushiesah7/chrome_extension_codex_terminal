import fs from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import pty from 'node-pty';

import {
  DEFAULT_WORKDIR,
  isAllowedCwd,
  resolveCwd as resolveCwdCore
} from './host_core.js';

// ネイティブメッセージング: Host→拡張は1MB上限。出力チャンクは64KBで分割。
const MAX_CHUNK = 64 * 1024;
const MAX_MSG_LEN = 1024 * 1024; // 1MB safeguard

const LOG_FILE = path.join(DEFAULT_WORKDIR, 'native_host.log');
const UPLOAD_ROOT = path.join(DEFAULT_WORKDIR, 'uploads');
const PATH_SEP = process.platform === 'win32' ? ';' : ':';
const UPLOAD_TTL_MS = 10 * 60 * 1000;
const MAX_UPLOAD_IMAGES = 4;
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;

/** @type {import('node-pty').IPty | null} */
let ptyProcess = null;

/** @type {import('node:child_process').ChildProcessWithoutNullStreams | null} */
let codexProcess = null;
let codexTimeout = null;
let codexRequestId = null;

/**
 * requestId -> { dir, createdAt, images: Map<imageId, { path, expectedSize, bytes, nextSeq, done }> }
 * @type {Map<string, {dir:string, createdAt:number, images: Map<string, {path:string, expectedSize:number, bytes:number, nextSeq:number, done:boolean}>}>}
 */
const uploads = new Map();

function logLine(line) {
  try {
    const ts = new Date().toISOString();
    fs.appendFileSync(LOG_FILE, `[${ts}] ${line}\n`, { encoding: 'utf8' });
  } catch {
    // ignore
  }
}

function ensureWorkdir() {
  try {
    fs.mkdirSync(DEFAULT_WORKDIR, { recursive: true, mode: 0o700 });
    try {
      fs.chmodSync(DEFAULT_WORKDIR, 0o700);
    } catch {
      // ignore
    }
  } catch {
    // ignore
  }

  try {
    fs.mkdirSync(UPLOAD_ROOT, { recursive: true, mode: 0o700 });
    try {
      fs.chmodSync(UPLOAD_ROOT, 0o700);
    } catch {
      // ignore
    }
  } catch {
    // ignore
  }
}

function augmentPath(dir, currentPath) {
  const p = typeof currentPath === 'string' ? currentPath : '';
  if (!dir) return p;
  const parts = p.split(PATH_SEP).filter(Boolean);
  if (!parts.includes(dir)) parts.unshift(dir);
  return parts.join(PATH_SEP);
}

// Native Messaging形式でJSONメッセージを送る（4byte長+UTF-8 JSON）
function sendMessage(obj) {
  const json = JSON.stringify(obj);
  const payload = Buffer.from(json, 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(payload.length, 0);
  process.stdout.write(Buffer.concat([header, payload]));
}

function sendTextChunks(type, text) {
  // 1 message <= 1MB 制限対策でチャンク分割（UTF-8のバイト長ベース）
  let chunk = '';
  let chunkBytes = 0;

  for (const cp of text) {
    const cpBytes = Buffer.byteLength(cp, 'utf8');
    if (chunk && chunkBytes + cpBytes > MAX_CHUNK) {
      sendMessage({ type, data: chunk });
      chunk = '';
      chunkBytes = 0;
    }
    chunk += cp;
    chunkBytes += cpBytes;
  }

  if (chunk) sendMessage({ type, data: chunk });
}

// PTY出力を64KBずつに分割して拡張側へ送る
function sendOutput(data) {
  sendTextChunks('output', data);
}

function findCodexBin() {
  // Chrome（GUI）経由だと PATH が最小構成になり、`codex` が見つからないことがある。
  // まずは host を起動している node の隣（nvm 等）を優先する。
  const binDir = path.dirname(process.execPath);
  const candidate = path.join(binDir, 'codex');
  if (fs.existsSync(candidate)) return candidate;

  // Homebrew の典型パス
  if (fs.existsSync('/opt/homebrew/bin/codex')) return '/opt/homebrew/bin/codex';
  if (fs.existsSync('/usr/local/bin/codex')) return '/usr/local/bin/codex';

  // 最後に PATH に頼る（失敗時は spawn の error で拾う）
  return 'codex';
}

function parseSafeId(raw, label) {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!value) throw new Error(`${label} が空です`);
  if (value.length > 128) throw new Error(`${label} が長すぎます`);
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error(`${label} に不正な文字が含まれます`);
  return value;
}

function extForMime(mimeType) {
  const t = typeof mimeType === 'string' ? mimeType.toLowerCase() : '';
  if (t === 'image/png') return '.png';
  if (t === 'image/jpeg' || t === 'image/jpg') return '.jpg';
  if (t === 'image/webp') return '.webp';
  if (t === 'image/gif') return '.gif';
  return '.bin';
}

function cleanupUpload(requestId) {
  const state = uploads.get(requestId);
  if (!state) return;
  uploads.delete(requestId);

  try {
    fs.rmSync(state.dir, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

function cleanupExpiredUploads() {
  const now = Date.now();
  for (const [requestId, state] of uploads.entries()) {
    if (now - state.createdAt > UPLOAD_TTL_MS) cleanupUpload(requestId);
  }
}

function getOrCreateUploadState(requestId) {
  cleanupExpiredUploads();

  const existing = uploads.get(requestId);
  if (existing) return existing;

  ensureWorkdir();

  const dir = path.join(UPLOAD_ROOT, requestId);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    // ignore
  }

  const state = { dir, createdAt: Date.now(), images: new Map() };
  uploads.set(requestId, state);
  return state;
}

function shouldRunScriptViaNode(filePath) {
  if (!path.isAbsolute(filePath)) return false;
  try {
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(96);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    const head = buf.slice(0, n).toString('utf8');
    return head.startsWith('#!') && head.toLowerCase().includes('node');
  } catch {
    return false;
  }
}

function cancelCodex() {
  if (codexProcess) {
    try {
      codexProcess.kill('SIGTERM');
    } catch {
      // ignore
    }
    codexProcess = null;
  }

  if (codexTimeout) {
    clearTimeout(codexTimeout);
    codexTimeout = null;
  }

  if (codexRequestId) {
    cleanupUpload(codexRequestId);
    codexRequestId = null;
  }
}

function runCodex({ prompt, threadId, imagePaths, requestId }) {
  cancelCodex();

  if (typeof prompt !== 'string' || !prompt.trim()) {
    sendMessage({ type: 'codex_error', text: 'prompt が空です' });
    sendMessage({ type: 'codex_done' });
    return;
  }

  // 安全のため、codex exec の作業ディレクトリは /tmp 配下に固定
  ensureWorkdir();

  const codexBin = findCodexBin();
  const images = Array.isArray(imagePaths) ? imagePaths.filter((p) => typeof p === 'string' && p) : [];
  /** @type {string[]} */
  const args = [
    'exec',
    '--skip-git-repo-check',
    '--sandbox',
    'read-only',
    '--color',
    'never',
    '--json',
    '-C',
    DEFAULT_WORKDIR
  ];

  let resumeId = typeof threadId === 'string' ? threadId.trim() : '';

  if (resumeId && images.length) {
    // `codex exec resume` は --image を受け付けないため、画像がある場合は新規セッション扱いにする。
    logLine('codex: images+resume requested -> start new session');
    sendMessage({ type: 'status', text: '画像付きの質問は新しいセッションで実行します（codex resume は画像に未対応）' });
    resumeId = '';
  }

  if (images.length) args.push('--image', ...images);
  if (resumeId) args.push('resume', resumeId);

  // prompt は stdin から渡す（引数は '-'）
  args.push('-');

  sendMessage({
    type: 'status',
    text: resumeId ? 'Codexセッションを再開...' : 'Codexに問い合わせ中...'
  });

  const nodeBinDir = path.dirname(process.execPath);
  const env = {
    ...process.env,
    // `codex` は shebang (`/usr/bin/env node`) で起動されるため、Chrome(GUI)の薄いPATHだと失敗しやすい。
    // host を動かしている node の bin を PATH 先頭に足しておく。
    PATH: augmentPath(nodeBinDir, process.env.PATH),
    // JSON出力のため ANSI は不要だが、念のため
    TERM: 'dumb'
  };

  logLine(
    `codex spawn: req=${requestId ? String(requestId).slice(0, 8) + '…' : '(none)'} images=${images.length} bin=${codexBin} resume=${resumeId ? resumeId.slice(0, 8) + '…' : '(new)'} node=${process.execPath} PATH.head=${env.PATH.split(PATH_SEP).slice(0, 3).join(PATH_SEP)}`
  );

  const runViaNode = shouldRunScriptViaNode(codexBin);
  const spawnBin = runViaNode ? process.execPath : codexBin;
  const spawnArgs = runViaNode ? [codexBin, ...args] : args;

  if (runViaNode) {
    logLine(`codex spawn: run via node (bypass shebang)`);
  }

  const child = spawn(spawnBin, spawnArgs, {
    stdio: ['pipe', 'pipe', 'pipe'],
    env
  });

  codexProcess = child;
  codexRequestId = typeof requestId === 'string' ? requestId : null;

  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString('utf8');
    // メモリ肥大防止（ログは最後の方だけ保持）
    if (stderr.length > 200_000) stderr = stderr.slice(-200_000);
  });

  // --json の JSONL を逐次解析して、thread_id と回答を拾う
  let stdoutBuf = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdoutBuf += chunk;
    if (stdoutBuf.length > 500_000) stdoutBuf = stdoutBuf.slice(-500_000);

    let newlineIdx;
    while ((newlineIdx = stdoutBuf.indexOf('\n')) >= 0) {
      const line = stdoutBuf.slice(0, newlineIdx).trim();
      stdoutBuf = stdoutBuf.slice(newlineIdx + 1);
      if (!line) continue;

      let evt;
      try {
        evt = JSON.parse(line);
      } catch {
        continue;
      }

      if (evt?.type === 'thread.started' && typeof evt.thread_id === 'string') {
        sendMessage({ type: 'codex_thread', id: evt.thread_id });
        continue;
      }

      if (evt?.type === 'item.completed') {
        const item = evt.item;
        if (item?.type === 'agent_message' && typeof item.text === 'string' && item.text) {
          // UI側のスクロールを崩さないよう、最後に改行を付与
          sendTextChunks('codex_chunk', item.text.trimEnd() + '\n');
        }
      }
    }
  });

  child.on('error', (e) => {
    codexProcess = null;
    if (codexTimeout) {
      clearTimeout(codexTimeout);
      codexTimeout = null;
    }
    if (codexRequestId) {
      cleanupUpload(codexRequestId);
      codexRequestId = null;
    }
    logLine(`codex error: ${String(e)}`);
    sendMessage({ type: 'codex_error', text: String(e) });
    sendMessage({ type: 'codex_done' });
  });

  child.on('close', (code, signal) => {
    codexProcess = null;
    if (codexTimeout) {
      clearTimeout(codexTimeout);
      codexTimeout = null;
    }
    if (codexRequestId) {
      cleanupUpload(codexRequestId);
      codexRequestId = null;
    }

    // 最後が改行で終わらない場合に備えて、残りを1行として処理する
    const tail = stdoutBuf.trim();
    if (tail) {
      try {
        const evt = JSON.parse(tail);
        if (evt?.type === 'thread.started' && typeof evt.thread_id === 'string') {
          sendMessage({ type: 'codex_thread', id: evt.thread_id });
        } else if (evt?.type === 'item.completed') {
          const item = evt.item;
          if (item?.type === 'agent_message' && typeof item.text === 'string' && item.text) {
            sendTextChunks('codex_chunk', item.text.trimEnd() + '\n');
          }
        }
      } catch {
        // ignore
      }
    }

    if (code !== 0) {
      const err = stderr.trim() ? stderr.trim() : `codex exec failed (code=${String(code)}, signal=${String(signal)})`;
      logLine(`codex exit: code=${String(code)} signal=${String(signal)} stderr.tail=${err.slice(-500)}`);
      sendMessage({ type: 'codex_error', text: err });
    }

    sendMessage({ type: 'codex_done' });
  });

  // prompt を stdin で渡す
  try {
    child.stdin.write(prompt);
    child.stdin.end();
  } catch (e) {
    sendMessage({ type: 'codex_error', text: String(e) });
    sendMessage({ type: 'codex_done' });
    cancelCodex();
    return;
  }

  // タイムアウト（長時間ぶら下がるのを防止）
  codexTimeout = setTimeout(() => {
    const stillRunning = Boolean(codexProcess);
    cancelCodex();
    if (stillRunning) {
      sendMessage({ type: 'codex_error', text: 'Codex の実行がタイムアウトしました' });
      sendMessage({ type: 'codex_done' });
    }
  }, 180_000);
}

function startShell({ cwd }) {
  if (ptyProcess) {
    try {
      ptyProcess.kill();
    } catch {
    }
    ptyProcess = null;
  }

  // 受信cwdを正規化し、許可リスト外なら起動しない。
  const resolvedCwd = resolveCwdCore(cwd);

  if (!isAllowedCwd(resolvedCwd)) {
    sendMessage({ type: 'status', text: `許可されないcwd: ${String(resolvedCwd)}` });
    return;
  }

  // Ensure working directory exists.
  try {
    const isTmpWorkdir =
      resolvedCwd === DEFAULT_WORKDIR || resolvedCwd.startsWith(DEFAULT_WORKDIR + path.sep);
    if (isTmpWorkdir) {
      // /tmp 配下は権限を絞って作成
      fs.mkdirSync(resolvedCwd, { recursive: true, mode: 0o700 });
      try {
        fs.chmodSync(resolvedCwd, 0o700);
      } catch {
        // ignore
      }
    } else {
      fs.mkdirSync(resolvedCwd, { recursive: true });
    }
  } catch (e) {
    sendMessage({ type: 'status', text: `ディレクトリ作成失敗: ${resolvedCwd}` });
    return;
  }

  // ついでにログ先ディレクトリも確保
  ensureWorkdir();

  const SHELL_CANDIDATES = [process.env.SHELL, '/bin/zsh', '/bin/bash', '/bin/sh'];
  const shell = SHELL_CANDIDATES.find((s) => s && fs.existsSync(s)) || '/bin/sh';

  try {
    ptyProcess = pty.spawn(shell, ['-l'], {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: resolvedCwd,
      env: {
        ...process.env,
        TERM: 'xterm-256color'
      }
    });
  } catch (e) {
    const errText = String(e);
    const hint =
      errText.includes('posix_spawnp failed')
        ? '（node-pty の spawn-helper に実行権がない可能性。native_host で npm run postinstall（または npm ci））'
        : '';
    sendMessage({ type: 'status', text: `起動失敗: ${errText}${hint}` });
    ptyProcess = null;
    return;
  }

  sendMessage({ type: 'status', text: `起動: ${shell} (${resolvedCwd})` });

  // PTY -> メッセージで拡張へ中継
  ptyProcess.onData((data) => {
    sendOutput(data);
  });

  // シェル終了時に通知して状態をリセット
  ptyProcess.onExit(({ exitCode }) => {
    sendMessage({ type: 'exit', code: exitCode });
    ptyProcess = null;
  });
}

function handleMessage(msg) {
  if (!msg || typeof msg !== 'object') return;

  if (msg.type === 'upload_image_start') {
    try {
      const requestId = parseSafeId(msg.requestId, 'requestId');
      const imageId = parseSafeId(msg.imageId, 'imageId');
      const size = Number(msg.size);
      if (!Number.isFinite(size) || size <= 0) throw new Error('size が不正です');
      if (size > MAX_IMAGE_BYTES) throw new Error('画像が大きすぎます');

      const state = getOrCreateUploadState(requestId);
      if (state.images.size >= MAX_UPLOAD_IMAGES && !state.images.has(imageId)) {
        throw new Error(`画像は最大${MAX_UPLOAD_IMAGES}枚までです`);
      }

      const ext = extForMime(msg.mimeType);
      const filePath = path.join(state.dir, `${imageId}${ext}`);

      // 既存ファイルがあれば消す（同じimageIdの再送に備える）
      try {
        fs.rmSync(filePath, { force: true });
      } catch {
        // ignore
      }

      fs.writeFileSync(filePath, Buffer.alloc(0), { mode: 0o600 });

      state.images.set(imageId, {
        path: filePath,
        expectedSize: size,
        bytes: 0,
        nextSeq: 0,
        done: false
      });

      logLine(`upload start: req=${requestId.slice(0, 8)}… img=${imageId.slice(0, 8)}… size=${size} path=${filePath}`);
    } catch (e) {
      logLine(`upload start error: ${String(e)}`);
      sendMessage({ type: 'upload_error', requestId: msg.requestId, imageId: msg.imageId, text: String(e) });
    }
    return;
  }

  if (msg.type === 'upload_image_chunk') {
    try {
      const requestId = parseSafeId(msg.requestId, 'requestId');
      const imageId = parseSafeId(msg.imageId, 'imageId');
      const seq = Number(msg.seq);
      const data = typeof msg.data === 'string' ? msg.data : '';
      if (!Number.isFinite(seq) || seq < 0) throw new Error('seq が不正です');
      if (!data) throw new Error('data が空です');

      const state = uploads.get(requestId);
      const img = state?.images.get(imageId);
      if (!state || !img) throw new Error('upload が開始されていません');
      if (img.done) throw new Error('upload はすでに完了しています');
      if (seq !== img.nextSeq) throw new Error(`chunk の順序が不正です（expected=${img.nextSeq}, got=${seq}）`);

      const buf = Buffer.from(data, 'base64');
      if (!buf.length) throw new Error('chunk のデコードに失敗しました');
      if (img.bytes + buf.length > img.expectedSize) throw new Error('画像サイズが不正です（expected を超過）');
      if (img.bytes + buf.length > MAX_IMAGE_BYTES) throw new Error('画像が大きすぎます');

      fs.appendFileSync(img.path, buf);
      img.bytes += buf.length;
      img.nextSeq += 1;
    } catch (e) {
      logLine(`upload chunk error: ${String(e)}`);
      sendMessage({ type: 'upload_error', requestId: msg.requestId, imageId: msg.imageId, text: String(e) });
    }
    return;
  }

  if (msg.type === 'upload_image_end') {
    try {
      const requestId = parseSafeId(msg.requestId, 'requestId');
      const imageId = parseSafeId(msg.imageId, 'imageId');
      const chunks = Number(msg.chunks);
      if (!Number.isFinite(chunks) || chunks < 0) throw new Error('chunks が不正です');

      const state = uploads.get(requestId);
      const img = state?.images.get(imageId);
      if (!state || !img) throw new Error('upload が開始されていません');
      if (img.done) throw new Error('upload はすでに完了しています');
      if (chunks !== img.nextSeq) throw new Error(`chunks 数が不正です（expected=${img.nextSeq}, got=${chunks}）`);
      if (img.bytes !== img.expectedSize) {
        throw new Error(`画像サイズが一致しません（expected=${img.expectedSize}, got=${img.bytes}）`);
      }

      img.done = true;
      logLine(`upload done: req=${requestId.slice(0, 8)}… img=${imageId.slice(0, 8)}… bytes=${img.bytes} path=${img.path}`);
      sendMessage({ type: 'upload_ok', requestId, imageId });
    } catch (e) {
      logLine(`upload end error: ${String(e)}`);
      sendMessage({ type: 'upload_error', requestId: msg.requestId, imageId: msg.imageId, text: String(e) });
    }
    return;
  }

  if (msg.type === 'codex' && typeof msg.prompt === 'string') {
    /** @type {string[]} */
    const imagePaths = [];
    try {
      const imageIds = Array.isArray(msg.imageIds) ? msg.imageIds : [];
      if (imageIds.length) {
        const requestId = parseSafeId(msg.requestId, 'requestId');
        const state = uploads.get(requestId);
        if (!state) throw new Error('画像が見つかりません（upload state がありません）');

        for (const rawId of imageIds) {
          const imageId = parseSafeId(rawId, 'imageId');
          const img = state.images.get(imageId);
          if (!img) throw new Error(`画像が見つかりません（imageId=${imageId}）`);
          if (!img.done) throw new Error(`画像の受信が完了していません（imageId=${imageId}）`);
          imagePaths.push(img.path);
        }
      }
    } catch (e) {
      sendMessage({ type: 'codex_error', text: String(e) });
      sendMessage({ type: 'codex_done' });
      return;
    }

    runCodex({
      prompt: msg.prompt,
      threadId: typeof msg.threadId === 'string' ? msg.threadId : undefined,
      imagePaths,
      requestId: typeof msg.requestId === 'string' ? msg.requestId : undefined
    });
    return;
  }

  if (msg.type === 'cancel_codex') {
    cancelCodex();
    return;
  }

  if (msg.type === 'start') {
    // cwdはUI側で許可リストから選択。ここでもisAllowedCwdで再確認。
    startShell({ cwd: msg.cwd });
    return;
  }

  if (msg.type === 'input' && typeof msg.data === 'string') {
    if (!ptyProcess) {
      sendMessage({ type: 'status', text: '未起動: start が必要です' });
      return;
    }
    ptyProcess.write(msg.data);
  }
}

// stdinからNative Messagingメッセージを読み取り、長さ(4byte LE)に従って復元する
let inputBuffer = Buffer.alloc(0);
process.stdin.on('data', (chunk) => {
  inputBuffer = Buffer.concat([inputBuffer, chunk]);

  while (inputBuffer.length >= 4) {
    const msgLen = inputBuffer.readUInt32LE(0);
    if (msgLen > MAX_MSG_LEN) {
      // ChromeのNative Messaging仕様：Host->拡張 1MB上限のため防御
      sendMessage({ type: 'status', text: 'メッセージサイズが大きすぎます' });
      inputBuffer = Buffer.alloc(0);
      // 以降の悪意ある送信を抑止するため、ホストプロセスを終了して接続を落とす
      process.exit(1);
    }
    if (inputBuffer.length < 4 + msgLen) break;

    const msgBuf = inputBuffer.slice(4, 4 + msgLen);
    inputBuffer = inputBuffer.slice(4 + msgLen);

    try {
      const msg = JSON.parse(msgBuf.toString('utf8'));
      handleMessage(msg);
    } catch (e) {
      // JSONが壊れている場合もstatusで通知
      sendMessage({ type: 'status', text: `JSON parse error: ${String(e)}` });
    }
  }
});

process.stdin.on('end', () => {
  cancelCodex();
  if (ptyProcess) {
    try {
      ptyProcess.kill();
    } catch {
      // ignore
    }
  }
});

// Initial status
ensureWorkdir();
const startupCodexBin = findCodexBin();
logLine(
  `native host started: node=${process.execPath} codex=${startupCodexBin} PATH.head=${(typeof process.env.PATH === 'string' ? process.env.PATH : '').split(PATH_SEP).slice(0, 5).join(PATH_SEP)}`
);
sendMessage({ type: 'status', text: `Native host ready (log: ${LOG_FILE})` });
