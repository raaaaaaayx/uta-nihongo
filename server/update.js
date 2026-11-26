// 检查更新：每次启动时问一次 GitHub「最新发布的版本是哪个」，比本机的新就告诉界面。
// 版本号写在 package.json 的 version 里（发布时和标签一致，比如 1.0.3-netease.9 ↔ 标签 v1.0.3-netease.9），
// 去哪个仓库查写在 package.json 的 uta.repo 里。只读取公开的发布信息，不发送任何本机的数据。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { ROOT } from './store.js';
const run = promisify(execFile);

const pkg = (() => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')); } catch { return {}; } })();
export const CURRENT = pkg.version || '';
const REPO = pkg.uta?.repo || '';
// 这台 Mac 的芯片对应的发布包（App 里打包的 node 是哪种芯片的，process.arch 就是哪种）
const ARCH = process.arch === 'x64' ? 'x64' : 'arm64';
const ASSET = `uta-nihongo-macOS-${ARCH}.zip`;
// 测试用：UTA_UPDATE_FEED 指向一份和 GitHub 发布信息同样格式的 JSON，代替去 GitHub 查
const FEED = process.env.UTA_UPDATE_FEED || `https://api.github.com/repos/${REPO}/releases/latest`;

// 按语义化版本比大小：1.0.3-netease.10 > 1.0.3-netease.9；正式版 1.0.4 > 1.0.3-netease.N
function parse(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(String(v).trim());
  if (!m) return null;
  return { core: [+m[1], +m[2], +m[3]], pre: m[4] ? m[4].split('.') : [] };
}
export function newer(a, b) { // a 比 b 新？
  const x = parse(a), y = parse(b);
  if (!x || !y) return false;
  for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return x.core[i] > y.core[i];
  if (!x.pre.length || !y.pre.length) return !x.pre.length && !!y.pre.length; // 同一个版本号，正式版比预发布版新
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i], q = y.pre[i];
    if (p === undefined) return false;
    if (q === undefined) return true;
    if (p === q) continue;
    const pn = /^\d+$/.test(p), qn = /^\d+$/.test(q);
    if (pn && qn) return +p > +q;
    if (pn !== qn) return !pn; // 数字比字母小
    return p > q;
  }
  return false;
}

let pending = null; // 这次启动只查一次，结果一直用到退出
export function checkUpdate() {
  if (pending) return pending;
  pending = (async () => {
    if (!REPO || !CURRENT) return { current: CURRENT, newer: false };
    try {
      const r = await fetch(FEED, {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'uta-nihongo-update-check' },
        signal: AbortSignal.timeout(10000),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      const latest = String(j.tag_name || '').replace(/^v/, '');
      const assets = j.assets || [];
      // 先找这种芯片的包；以前的发布只有 arm64 一个包、名字也一样，所以 Intel 的 Mac 找不到就不给下载链接
      const asset = assets.find((a) => a.name === ASSET);
      return {
        current: CURRENT, latest, newer: newer(latest, CURRENT),
        title: j.name || '', page: j.html_url || `https://github.com/${REPO}/releases/latest`,
        download: asset?.browser_download_url || '', arch: ARCH, size: asset?.size || 0,
        canInstall: !!(asset && appBundle()),
        install: `curl -fsSL https://raw.githubusercontent.com/${REPO}/main/install.sh | bash`,
      };
    } catch (e) {
      pending = null; // 没网之类：下次打开界面时再试
      return { current: CURRENT, newer: false, error: e.message };
    }
  })();
  return pending;
}

// ---------------- 一键更新（只在 Mac App 里） ----------------
// 下载这种芯片的新版压缩包 → 解压、核对 → 交给一个独立的小脚本：等 App 退出后把旧的换成新的，再打开新的。
// 用程序自己下载的文件不带「来自网上」的隔离标记，换上去以后打开不会再被系统拦。
// App 所在的文件夹写不进去（比如被系统放在临时的只读位置运行）就不提供，界面上改成打开下载页。
function appBundle() {
  if (!process.env.UTA_APP) return '';
  const b = path.resolve(ROOT, '../../..'); // …/唱歌学日语.app/Contents/Resources/app
  if (!b.endsWith('.app') || b.includes('/AppTranslocation/')) return '';
  try { fs.accessSync(path.dirname(b), fs.constants.W_OK); fs.accessSync(b, fs.constants.W_OK); } catch { return ''; }
  return b;
}

export const progress = { phase: 'idle', pct: 0, error: '' }; // phase: idle / download / unpack / restart / error
let installing = false;
export async function installUpdate(quit) {
  if (installing) return;
  const u = await checkUpdate();
  const bundle = appBundle();
  if (!u.newer || !u.download || !bundle) throw new Error('现在没有可以自动安装的新版本');
  installing = true;
  Object.assign(progress, { phase: 'download', pct: 0, error: '' });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uta-update-'));
  try {
    const r = await fetch(u.download, { headers: { 'User-Agent': 'uta-nihongo-update' }, signal: AbortSignal.timeout(15 * 60 * 1000) });
    if (!r.ok || !r.body) throw new Error(`下载失败（HTTP ${r.status}）`);
    const total = Number(r.headers.get('content-length')) || u.size || 0;
    let got = 0;
    const body = Readable.fromWeb(r.body);
    body.on('data', (c) => { got += c.length; if (total) progress.pct = Math.min(99, Math.round((got / total) * 100)); });
    const zip = path.join(dir, ASSET);
    await pipeline(body, fs.createWriteStream(zip));
    if (total && got !== total) throw new Error('下载不完整，请再试一次');
    Object.assign(progress, { phase: 'unpack', pct: 100 });
    const out = path.join(dir, 'new');
    await run('/usr/bin/ditto', ['-x', '-k', zip, out]);
    const app = fs.readdirSync(out).find((n) => n.endsWith('.app'));
    if (!app) throw new Error('压缩包里没有 App');
    const next = path.join(out, app);
    // 核对：版本号对得上、芯片对得上、签名完整，才换
    const plist = path.join(next, 'Contents/Info.plist');
    const read = async (k) => (await run('/usr/bin/plutil', ['-extract', k, 'raw', plist]).catch(() => ({ stdout: '' }))).stdout.trim();
    if ((await read('UtaReleaseVersion')) !== u.latest) throw new Error('下载到的版本号不对');
    if ((await read('UtaArch')) !== ARCH) throw new Error('下载到的不是这台 Mac 芯片的版本');
    await run('/usr/bin/codesign', ['--verify', '--deep', next]).catch(() => { throw new Error('下载到的 App 不完整'); });
    progress.phase = 'restart';
    // 小脚本：等 App（node 的父进程）退出 → 旧的挪开、新的放上 → 成功就删掉旧的，失败就放回旧的 → 打开
    const sh = path.join(dir, 'swap.sh');
    fs.writeFileSync(sh, `#!/bin/bash
PID="$1"; OLD="$2"; NEW="$3"; LOG="$4"; VER="$5"; TMP="$6"
for i in $(seq 1 150); do kill -0 "$PID" 2>/dev/null || break; sleep 0.1; done
BAK="$OLD.updating-$$"
if mv "$OLD" "$BAK" && mv "$NEW" "$OLD"; then
  rm -rf "$BAK"; echo "$(date) 已更新到 $VER" >> "$LOG"
else
  [ -d "$BAK" ] && [ ! -d "$OLD" ] && mv "$BAK" "$OLD"
  echo "$(date) 自动更新失败，还是旧版本" >> "$LOG"
fi
xattr -dr com.apple.quarantine "$OLD" 2>/dev/null
open "$OLD"
case "$TMP" in */uta-update-*) rm -rf "$TMP" ;; esac
`);
    const log = path.join(process.env.UTA_DATA || os.tmpdir(), 'app.log');
    // 版本号、临时目录都当参数传给脚本，不拼进脚本的文字里：版本号来自发布的标签名，拼进去的话标签名里的特殊字符会被当成命令执行
    spawn('/bin/bash', [sh, String(process.ppid), bundle, next, log, u.latest, dir], { detached: true, stdio: 'ignore' }).unref();
    setTimeout(quit, 300); // 先让界面拿到「正在重启」
  } catch (e) {
    installing = false;
    Object.assign(progress, { phase: 'error', error: e.message || String(e) });
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
