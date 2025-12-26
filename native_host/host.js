import fs from 'node:fs';
import path from 'node:path';
import pty from 'node-pty';

import {
  DEFAULT_WORKDIR,
  isAllowedCwd,
  resolveCwd as resolveCwdCore
} from './host_core.js';

const MAX_CHUNK = 64 * 1024;
const MAX_MSG_LEN = 1024 * 1024; // 1MB safeguard

/** @type {import('node-pty').IPty | null} */
let ptyProcess = null;

function sendMessage(obj) {
  const json = JSON.stringify(obj);
  const payload = Buffer.from(json, 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(payload.length, 0);
  process.stdout.write(Buffer.concat([header, payload]));
}

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
      // ignore
    }
    ptyProcess = null;
  }

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

  ptyProcess.onData((data) => {
    sendOutput(data);
  });

  ptyProcess.onExit(({ exitCode }) => {
    sendMessage({ type: 'exit', code: exitCode });
    ptyProcess = null;
  });
}

function handleMessage(msg) {
  if (!msg || typeof msg !== 'object') return;

  if (msg.type === 'start') {
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

// Read Native Messaging messages from stdin.
let inputBuffer = Buffer.alloc(0);
process.stdin.on('data', (chunk) => {
  inputBuffer = Buffer.concat([inputBuffer, chunk]);

  while (inputBuffer.length >= 4) {
    const msgLen = inputBuffer.readUInt32LE(0);
    if (msgLen > MAX_MSG_LEN) {
      sendMessage({ type: 'status', text: 'メッセージサイズが大きすぎます' });
      inputBuffer = Buffer.alloc(0);
      break;
    }
    if (inputBuffer.length < 4 + msgLen) break;

    const msgBuf = inputBuffer.slice(4, 4 + msgLen);
    inputBuffer = inputBuffer.slice(4 + msgLen);

    try {
      const msg = JSON.parse(msgBuf.toString('utf8'));
      handleMessage(msg);
    } catch (e) {
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
