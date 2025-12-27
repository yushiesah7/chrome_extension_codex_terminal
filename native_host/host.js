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
const PATH_SEP = process.platform === 'win32' ? ';' : ':';

/** @type {import('node-pty').IPty | null} */
let ptyProcess = null;

/** @type {import('node:child_process').ChildProcessWithoutNullStreams | null} */
let codexProcess = null;
let codexTimeout = null;

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

function cancelCodex() {
  if (!codexProcess) return;

  try {
    codexProcess.kill('SIGTERM');
  } catch {
    // ignore
  }
  codexProcess = null;

  if (codexTimeout) {
    clearTimeout(codexTimeout);
    codexTimeout = null;
  }
}

function runCodex({ prompt, threadId }) {
  cancelCodex();

  if (typeof prompt !== 'string' || !prompt.trim()) {
    sendMessage({ type: 'codex_error', text: 'prompt が空です' });
    sendMessage({ type: 'codex_done' });
    return;
  }

  // 安全のため、codex exec の作業ディレクトリは /tmp 配下に固定
  ensureWorkdir();

  const codexBin = findCodexBin();
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

  const resumeId = typeof threadId === 'string' ? threadId.trim() : '';
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
    `codex spawn: bin=${codexBin} resume=${resumeId ? resumeId.slice(0, 8) + '…' : '(new)'} node=${process.execPath} PATH.head=${env.PATH.split(PATH_SEP).slice(0, 3).join(PATH_SEP)}`
  );

  const child = spawn(codexBin, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    env
  });

  codexProcess = child;

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

  if (msg.type === 'codex' && typeof msg.prompt === 'string') {
    runCodex({
      prompt: msg.prompt,
      threadId: typeof msg.threadId === 'string' ? msg.threadId : undefined
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
logLine(`native host started: node=${process.execPath}`);
sendMessage({ type: 'status', text: 'Native host ready' });
