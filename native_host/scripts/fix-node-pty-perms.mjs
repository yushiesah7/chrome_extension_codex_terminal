import fs from 'node:fs';
import path from 'node:path';

function ensureExecutable(filePath) {
  let st;
  try {
    st = fs.statSync(filePath);
  } catch (e) {
    if (e && typeof e === 'object' && e.code === 'ENOENT') return;
    throw e;
  }

  // 実行権が付いていなければ追加する（npm配布物のspawn-helperが644になることがある）
  const isExecutable = (st.mode & 0o111) !== 0;
  if (isExecutable) return;

  // 755 に固定（owner/group/other が実行可能）
  fs.chmodSync(filePath, 0o755);
}

function main() {
  // `npm ci`/`npm install` は package.json のあるディレクトリで実行される前提。
  const nodePtyDir = path.join(process.cwd(), 'node_modules', 'node-pty');

  // build/Release or build/Debug を優先
  const buildCandidates = [
    path.join(nodePtyDir, 'build', 'Release', 'spawn-helper'),
    path.join(nodePtyDir, 'build', 'Debug', 'spawn-helper')
  ];
  for (const p of buildCandidates) ensureExecutable(p);

  // prebuilds/darwin-*/spawn-helper
  const prebuildsDir = path.join(nodePtyDir, 'prebuilds');
  let entries = [];
  try {
    entries = fs.readdirSync(prebuildsDir, { withFileTypes: true });
  } catch (e) {
    if (e && typeof e === 'object' && e.code === 'ENOENT') return;
    throw e;
  }

  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    if (!ent.name.startsWith('darwin-')) continue;
    ensureExecutable(path.join(prebuildsDir, ent.name, 'spawn-helper'));
  }
}

main();

