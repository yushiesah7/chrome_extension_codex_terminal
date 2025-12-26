import fs from 'node:fs';
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

// Native Messaging形式でJSONメッセージを送る（4byte長+UTF-8 JSON）
function sendMessage(obj) {
  const json = JSON.stringify(obj);
  const payload = Buffer.from(json, 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(payload.length, 0);
  process.stdout.write(Buffer.concat([header, payload]));
}

// PTY出力を64KBずつに分割して拡張側へ送る
function sendOutput(data) {
  // Host -> extension has a message size limit; chunk output.
  for (let i = 0; i < data.length; i += MAX_CHUNK) {
    sendMessage({ type: 'output', data: data.slice(i, i + MAX_CHUNK) });
  }
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
    sendMessage({ type: 'status', text: `起動失敗: ${String(e)}` });
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
