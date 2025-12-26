import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
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

/** @type {import('node-pty').IPty | null} */
let ptyProcess = null;

/** @type {import('node:child_process').ChildProcessWithoutNullStreams | null} */
let codexProcess = null;
let codexTimeout = null;

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

function runCodex(prompt) {
  cancelCodex();

  if (typeof prompt !== 'string' || !prompt.trim()) {
    sendMessage({ type: 'codex_error', text: 'prompt が空です' });
    sendMessage({ type: 'codex_done' });
    return;
  }

  // 安全のため、codex exec の作業ディレクトリは /tmp 配下に固定
  try {
    fs.mkdirSync(DEFAULT_WORKDIR, { recursive: true, mode: 0o700 });
    try {
      fs.chmodSync(DEFAULT_WORKDIR, 0o700);
    } catch {
      // ignore
    }
  } catch {
    // ignore（後でcodex側が失敗したらエラーになる）
  }

  const codexBin = findCodexBin();
  const lastMsgFile = path.join(os.tmpdir(), `codex_last_message_${randomUUID()}.txt`);

  const args = [
    'exec',
    '--skip-git-repo-check',
    '--sandbox',
    'read-only',
    '--color',
    'never',
    '-C',
    DEFAULT_WORKDIR,
    '--output-last-message',
    lastMsgFile,
    '-'
  ];

  sendMessage({ type: 'status', text: 'Codexに問い合わせ中...' });

  const child = spawn(codexBin, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      // ANSI は出さない設定だが、念のため
      TERM: 'dumb'
    }
  });

  codexProcess = child;

  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString('utf8');
    // メモリ肥大防止（ログは最後の方だけ保持）
    if (stderr.length > 200_000) stderr = stderr.slice(-200_000);
  });

  // stdout は最終回答が last message file に出る想定。念のため捨てずに保持。
  let stdout = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk.toString('utf8');
    if (stdout.length > 200_000) stdout = stdout.slice(-200_000);
  });

  child.on('error', (e) => {
    codexProcess = null;
    if (codexTimeout) {
      clearTimeout(codexTimeout);
      codexTimeout = null;
    }
    sendMessage({ type: 'codex_error', text: String(e) });
    sendMessage({ type: 'codex_done' });
  });

  child.on('close', (code, signal) => {
    codexProcess = null;
    if (codexTimeout) {
      clearTimeout(codexTimeout);
      codexTimeout = null;
    }

    let answer = '';
    try {
      answer = fs.readFileSync(lastMsgFile, 'utf8');
    } catch {
      // fallback
      answer = '';
    }

    try {
      fs.unlinkSync(lastMsgFile);
    } catch {
      // ignore
    }

    const output = (answer || stdout || '').trimEnd();
    if (output) sendTextChunks('codex_chunk', output + '\n');

    if (code !== 0) {
      const err = stderr.trim() ? stderr.trim() : `codex exec failed (code=${String(code)}, signal=${String(signal)})`;
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
    runCodex(msg.prompt);
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
sendMessage({ type: 'status', text: 'Native host ready' });
