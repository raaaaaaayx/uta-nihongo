// 唱歌学日语 — 前端
import { JA_ARTISTS } from './ja-artists.js';
import { startGuide } from './guide.js';
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
// 输入法正在选字时按下的回车是「确认候选」，不是「提交」。不分开的话，用日文输入法填读音，
// 第一下回车就把小窗关了，输入法手里还没交出去的字会落进下一个得到光标的输入框（比如搜索框）。
// Chrome 用 isComposing，Safari 在确认的那一下只给 keyCode 229，两个都要看。
const composing = (e) => e.isComposing || e.keyCode === 229;
const fmt = (s) => { s = Math.max(0, Math.round(s)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const KANJI = /[㐀-䶿一-鿿々〆]/;
const toHira = (s) => s.replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));

const api = {
  async get(url) { const r = await fetch(url); if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`); return r.json(); },
  async post(url, body) {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
    return j;
  },
};
// 当前用的播放器（启动时从 /api/info 取）：Apple Music 或网易云音乐。网易云模式下没有资料库和程序自己的播放队列
const PLAYER = { id: 'apple', name: 'Apple Music', caps: { library: true, queue: true } };
const SRC_NAME = { apple: 'Apple Music', netease: '网易云音乐' };
const control = (cmd, a, b) => api.post('/api/control', { cmd, a, b }).catch((e) => toast(`${PLAYER.name} 没有响应：${e.message}`));

// ---------------- 偏好（存在浏览器里） ----------------
const DEFAULT_PREFS = {
  view: 'apple', furi: true, zh: true, roma: false, ann: true,
  annStyle: 'chips', annMax: 4, annGrammar: true, annVocab: true, annSource: 'auto',
  levels: { N5: false, N4: true, N3: true, N2: true, N1: true, x: true },
  dictChar: false, dictPause: true, meaningLang: 'zh', autoSense: true,
  fxHold: false, // 实验功能：长音强调（默认关，在设置里打开）
  fxGroup: false, // 实验功能 2：紧凑的几句一起显示（默认关，在设置里打开）
  // 设置里的「减少动画」（默认关）。开了以后：用顶栏按钮、快捷键切换滚动 / 大字时直接切换，只有点封面才播放过渡；
  // KTV 样式的背景不跟着鼠标动。别的动画（换行、标注、开关的过渡…）不受它管
  lessMotion: false,
};
let prefs = { ...DEFAULT_PREFS };
try { const saved = JSON.parse(localStorage.getItem('uta-prefs') || '{}'); prefs = { ...prefs, ...saved, levels: { ...prefs.levels, ...(saved.levels || {}) } }; } catch { /* 无痕模式等 */ }
const savePrefs = () => { try { localStorage.setItem('uta-prefs', JSON.stringify(prefs)); } catch { /* 忽略 */ } };
// 韩语歌的小照顾：罗马音没开的话，放韩语歌时临时打开，换到别的歌再收回去。
// 不改设置本身（prefs.roma），所以放到一半退出也不会留下一个不知道谁打开的罗马音；这期间手动点了开关，就按手动的来。
// 判断从简：流派是 K-Pop / Korean，或者歌名、歌手、专辑里有韩文。
let romaAuto = false;
const HANGUL = /[\u1100-\u11ff\u3130-\u318f\uac00-\ud7af]/;
const isKorean = (t) => /k-?pop|korean/i.test(t.genre || lib.byPid?.get(t.pid)?.genre || '') || HANGUL.test(`${t.name} ${t.artist} ${t.album}`);
function autoRoma(track) {
  const want = !prefs.roma && isKorean(track);
  if (want === romaAuto) return;
  romaAuto = want;
  applyPrefs();
}
// 显示开关现在是不是开着：罗马音除了设置，还有上面的临时打开
const isOn = (k) => (k === 'roma' ? prefs.roma || romaAuto : !!prefs[k]);

// ---------------- 状态 ----------------
const S = {
  player: null, track: null, song: null, lines: [], active: -2, offset: 0,
  dict: {}, loadToken: 0, mode: null, sel: null, fill: null, annByTok: {},
  seekHold: 0, dragging: false, pausedByDict: false, tapAlign: false,
};
const app = $('#app');

// ---------------- 播放时钟：服务端每 250ms 推一次进度，中间用本地时钟插值 ----------------
const clock = { pos: 0, at: performance.now(), playing: false };
const now = () => (clock.playing ? clock.pos + (performance.now() - clock.at) / 1000 : clock.pos);
function setClock(pos, playing = clock.playing) { clock.pos = pos; clock.at = performance.now(); clock.playing = playing; }

function onState(s) {
  if (s.bye && s.updating) { es.close(); return; } // 一键更新：App 马上会关掉、换上新版再打开
  if (s.bye) return showBye();
  if (s.focus) return window.focus(); // 点了程序坞图标：程序把浏览器叫到了前面，这里尽量让这个窗口排到最上
  if (s.close) return window.close(); // 界面换到别的浏览器重新打开了：这个窗口自己关掉
  if ('queue' in s) onQueue(s.queue);
  // 自动模式：现在跟着的是哪个播放器（提示文字里用它的名字）
  if (s.source && PLAYER.id === 'auto') PLAYER.name = SRC_NAME[s.source];
  onOffer(s.offer, s.source);
  S.player = s;
  const playing = s.state === 'playing';
  app.classList.toggle('playing', playing);
  if (typeof s.pos === 'number' && performance.now() > S.seekHold) {
    const reported = s.pos + (playing ? (s.lag || 0) / 1000 : 0);
    const predicted = now();
    const diff = reported - predicted;
    if (!playing || !clock.playing || Math.abs(diff) > 0.15) setClock(reported, playing);
    else setClock(predicted + diff * 0.12, playing); // 小误差慢慢纠正，避免歌词抖动
  } else if (!playing) setClock(now(), false);
  else clock.playing = playing;

  const t = s.track;
  if (t && (!S.track || S.track.pid !== t.pid || S.track.name !== t.name)) loadSong(t);
  else if (!t && S.track) clearSong(s);
  else if (!t) showIdle(s);
}

function showIdle(s) {
  if (PLAYER.id === 'netease') return showIdleNetease(s);
  if (PLAYER.id === 'auto' && !s.running && !s.waiting && !s.errno) return setStatus('在 Apple Music 或网易云音乐里播放一首歌，这里会自动跟上。<br><span class="muted">网易云要由本程序打开才能被读到：在「设置 → 更多设置 → 程序」里选「只用网易云」可以让程序替你打开它。</span>');
  if (s.source === 'netease') return showIdleNetease(s);
  if (s.waiting) setStatus('正在等待 Apple Music 响应…<br>如果系统弹出了「想要控制 Music」的提示，请点「允许」。<br><span class="muted">也可能是 Music 里有未关闭的对话框。</span>');
  else if (!s.running) setStatus('Apple Music 还没有打开。<br>打开它播放一首歌，或者从左上角的「资料库」里选一首。');
  // 第一次的授权询问被点了「不允许」：系统不会再问第二次，要到系统设置里手动打开。打开后这里会自己恢复，不用重启
  else if (s.errno === -1743 || (s.err && /not authori[sz]ed|-1743|授权|不允许/i.test(s.err))) {
    setStatus('还没有允许本程序控制 Apple Music。<br>打开「系统设置 → 隐私与安全性 → 自动化」，找到「唱歌学日语」（从终端启动的话是「终端」），把它下面的「音乐」开关打开。<br><span class="muted">开关打开后这里会自动恢复，不用重启。</span><br><button class="btn" id="btn-privacy">打开系统设置</button>');
  }
  else setStatus('在 Apple Music 里播放一首歌，或者从左上角的「资料库」里选一首。');
}
function showIdleNetease(s) {
  if (s.errno === 'node') setStatus(`${esc(s.err)}。<br><span class="muted">网易云模式要用到 Node.js 自带的 WebSocket，请升级 Node.js 后重启程序。</span>`);
  // 网易云已经开着，但不是带调试端口启动的：连不上它，要重开一次
  else if (s.errno === 'netease-no-port') setStatus('网易云音乐已经打开了，但要由唱歌学日语重新打开一次才能读取播放进度。<br><span class="muted">会先关掉网易云再自动打开，正在放的歌会停一下。</span><br><button class="btn" id="btn-ne-relaunch">重新打开网易云</button>');
  else if (s.waiting || !s.running) setStatus('正在打开 / 连接网易云音乐…');
  else setStatus('在网易云音乐里播放一首歌。');
}
function clearSong(s) {
  S.track = null; S.song = null; S.lines = []; S.active = -2;
  $('#title').textContent = '未在播放';
  $('#artist').textContent = '';
  $('#src-badge').textContent = '';
  $('#scroll').innerHTML = '';
  renderFocus();
  setArt(null);
  showIdle(s);
}
// 状态每秒会来好几次：内容没变就不重画，否则里面的按钮刚按下就被换掉、点不中
let statusHTML = null;
const setStatus = (html) => { if (html === statusHTML) return; statusHTML = html; $('#status').innerHTML = html || ''; };
$('#status').addEventListener('click', (e) => {
  if (e.target.closest('#btn-ne-relaunch')) { setStatus('正在重新打开网易云音乐…'); control('relaunch'); }
  if (e.target.closest('#btn-privacy')) api.post('/api/open-privacy', {}).catch(() => toast('打不开系统设置，请手动打开：系统设置 → 隐私与安全性 → 自动化'));
});

// ---------------- 载入歌曲 ----------------
function songURL(t, extra = '') {
  const q = new URLSearchParams({ pid: t.pid || '', name: t.name || '', artist: t.artist || '', album: t.album || '', duration: t.duration || 0 });
  return `/api/song?${q}${extra}`;
}
async function loadSong(track, { refresh = false, keep = false } = {}) {
  const token = ++S.loadToken;
  S.track = track;
  if (!keep) autoRoma(track);
  $('#title').textContent = track.name;
  $('#artist').textContent = [track.artist, track.album].filter(Boolean).join(' — ');
  if (!keep) {
    S.song = null; S.lines = []; S.active = -2; S.offset = 0; S.sel = null;
    $('#scroll').innerHTML = '';
    $('#src-badge').textContent = '';
    renderFocus();
    setArt(track);
    setStatus('正在匹配歌词…');
    updateDictBar();
  }
  let song;
  try { song = await api.get(songURL(track, refresh ? '&refresh=1' : '')); }
  catch (e) { if (token === S.loadToken) setStatus(`歌词加载失败：${esc(e.message)}`); return; }
  if (token !== S.loadToken) return;

  S.song = song;
  S.offset = song.offset || 0;
  S.hiddenAnn = new Set(song.hiddenAnn || []);
  S.senses = { ...(song.senses || {}) };
  S.lines = withGaps(song.lines);
  markGroups();
  S.active = -2;
  updateOffsetLabel();
  const srcName = { netease: '网易云', qq: 'QQ音乐' }[song.source?.source] || '';
  $('#src-badge').textContent = song.lines.length ? [srcName, song.flags?.words ? '逐字' : '逐行', song.ai ? 'AI' : ''].filter(Boolean).join(' · ') : '';
  if (!song.lines.length) {
    setStatus(`${song.error ? esc(song.error) + '<br>' : ''}没有找到这首歌的歌词（可能是纯音乐）。<br><button class="btn" onclick="document.getElementById('btn-source').click()">手动选择歌词源</button>`);
  } else setStatus('');
  if (song.source?.cover) setArt(track, song.source.cover);
  renderLines();
  renderFocus();
  if (song.flags?.japanese) fetchDict(token);
}
const reloadSong = (opts = {}) => S.track && loadSong(S.track, { keep: true, ...opts });

// ---------------- 实验功能 2：紧凑的几句一起显示 ----------------
// 一句歌词一闪而过、紧跟着就是下一句的时候（「Hey! Hey!」「僕は無力だ」连着三遍…），不再一句一句地换：
// 每一句还是唱到了才亮；但同一组里前面唱过的句子不暗下去，一直亮到整组唱完。
// 这一组停在原地不滚动（对准组里的第一句），整组唱完再一起换到后面。
// 怎样算「紧凑」——两条都要满足：
//   1. 这一句很短：从它开始到下一句开始不超过 GROUP.short 秒
//   2. 中间没有停顿：这一句唱完到下一句开始不超过 GROUP.gap 秒（逐行歌词不知道一句唱到哪，只看第 1 条）
// 只看第 2 条不行：大多数歌的每一句都是紧接着上一句的。一组最多 GROUP.max 句，再多就另起一组。
const GROUP = { gap: 0.2, short: 1.6, max: 4 };
// S.grp[i] = [这一组的第一句, 最后一句]（行号）；不成组的就是它自己
function markGroups() {
  const L = S.lines;
  S.grp = L.map((_, i) => [i, i]);
  if (!prefs.fxGroup) return;
  const sung = (l) => (l.ct?.some(Boolean) ? Math.max(...l.ct.filter(Boolean).map((c) => c[1])) : l.end);
  const tight = (a, b) => !a.gap && !b.gap && b.t - a.t <= GROUP.short && b.t - sung(a) <= GROUP.gap;
  for (let i = 0; i < L.length;) {
    let j = i;
    while (j + 1 < L.length && j - i + 1 < GROUP.max && tight(L[j], L[j + 1])) j++;
    const g = [i, j];
    for (let k = i; k <= j; k++) S.grp[k] = g;
    i = j + 1;
  }
}

// 当前这一组是从哪一句开始亮着的。一句接一句唱下来时是这一组的第一句；
// 要是直接跳到了组中间的某一句（点歌词、拖进度条），就从跳到的那一句算起——前面那几句没有刚被唱过，不该亮着
function groupFrom() {
  const a = S.active, g = a >= 0 && S.grp?.[a];
  return g && S.grpFrom >= g[0] && S.grpFrom <= a ? S.grpFrom : Math.max(a, 0);
}

// 长间奏插入「间奏」占位行（三个点）
function withGaps(lines) {
  const out = [];
  lines.forEach((l, i) => {
    const prevEnd = i ? lines[i - 1].end : 0;
    if (l.t - prevEnd > 6) out.push({ gap: true, t: prevEnd, end: l.t, text: '', tokens: [], grammar: [] });
    out.push(l);
  });
  return out;
}

// ---------------- 背景：从封面取色，几团色块缓慢流动（Apple Music 歌词页那样） ----------------
// 封面缩成 48×48，按颜色分桶统计；挑最多 5 种彼此差得开的主色（偏灰的权重低一些，不然很多封面挑出来一片灰），
// 记下各自占多少。每种颜色一团柔和的圆形渐变，占得越多那团越大；最多的那个颜色同时做底色。
// 色块的漂移、旋转、伸缩全在 CSS 里（只动 transform，交给显卡）；换歌时颜色和大小慢慢过渡过去
async function albumPalette(url) {
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.src = url;
  await img.decode();
  const N = 48, c = document.createElement('canvas');
  c.width = c.height = N;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(img, 0, 0, N, N);
  const px = g.getImageData(0, 0, N, N).data; // 跨域的图在这里会抛错（取不到像素），由调用的地方兜底
  const buckets = new Map();
  for (let i = 0; i < px.length; i += 4) {
    const r = px[i], gg = px[i + 1], b = px[i + 2];
    const key = (r >> 4) << 8 | (gg >> 4) << 4 | (b >> 4);
    const e = buckets.get(key) || { r: 0, g: 0, b: 0, n: 0 };
    e.r += r; e.g += gg; e.b += b; e.n++;
    buckets.set(key, e);
  }
  const total = N * N;
  const cols = [...buckets.values()].map((e) => {
    const r = e.r / e.n, gg = e.g / e.n, b = e.b / e.n;
    const mx = Math.max(r, gg, b), mn = Math.min(r, gg, b);
    const sat = mx ? (mx - mn) / mx : 0;
    return { r, g: gg, b, share: e.n / total, w: e.n * (0.12 + sat * 1.6) }; // 有颜色的比白 / 灰优先：白底封面上那一块蓝才是它的主色调
  }).sort((x, y) => y.w - x.w);
  const picked = [];
  for (const col of cols) {
    if (picked.every((p) => Math.hypot(p.r - col.r, p.g - col.g, p.b - col.b) > 56)) picked.push({ ...col });
    else { // 和已经挑中的颜色很像：它的份额算到最像的那个头上
      const near = picked.reduce((a, p) => (Math.hypot(p.r - col.r, p.g - col.g, p.b - col.b) < Math.hypot(a.r - col.r, a.g - col.g, a.b - col.b) ? p : a));
      near.share += col.share;
    }
    if (picked.length >= 5 && cols.indexOf(col) > 80) break;
  }
  return picked.slice(0, 5);
}
// 太亮的颜色压暗（上面要放白字），色相不变。
// 饱和度不能直接用 HSL 的 s：很亮的颜色哪怕只带一丁点色偏，s 也会算得很高（比如白里透一点青，s 有 36%），
// 压暗之后就成了一片鲜绿。所以按「彩度」（最大和最小通道差多少）来定：近乎白 / 灰的颜色压暗后还是灰的
function meshColor({ r, g, b }) {
  const [h, , l] = rgbToHsl(r, g, b);
  const chroma = (Math.max(r, g, b) - Math.min(r, g, b)) / 255;
  const s = Math.min(0.85, chroma * 1.5);
  return `hsl(${Math.round(h * 360)} ${Math.round(s * 100)}% ${Math.round(Math.min(l, 0.5) * 100)}%)`;
}
function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2;
  if (mx === mn) return [0, 0, l];
  const d = mx - mn, s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
  const h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h / 6, s, l];
}
// 流动背景：设置 →「动画 → 流动背景」里开关，默认关。关着的时候那五团色块整个不显示（连它们一直在跑的动画一起停掉），
// 背景是原来的样子（模糊的封面）
const fxMesh = () => !!prefs.fxMesh;
let meshUrl = '', meshWant = ''; // meshWant：当前封面，开关打开时拿它上色
function setFxMesh(on) {
  const mesh = $('#bg-mesh');
  mesh.hidden = !on;
  meshUrl = '';
  if (on) { if (meshWant) paintMesh(meshWant); } else { mesh.classList.remove('on'); $('#bg').classList.remove('meshed'); }
}
$('#bg-mesh').hidden = !fxMesh();
async function paintMesh(url) {
  meshWant = url;
  if (!fxMesh() || url === meshUrl) return;
  meshUrl = url;
  const mesh = $('#bg-mesh');
  let pal;
  try { pal = await albumPalette(url); } catch { pal = null; }
  if (meshUrl !== url) return; // 这期间又换了歌
  if (!pal || !pal.length) { mesh.classList.remove('on'); $('#bg').classList.remove('meshed'); return; }
  while (pal.length < 5) pal.push(pal[pal.length % Math.max(1, pal.length)]); // 颜色少的封面：重复用
  const blobs = [...mesh.children];
  // 底色：占得多、又有颜色的那个（白底 / 灰底的封面，底色取上面那块主要的颜色，不取白和灰）
  const chroma = (p) => (Math.max(p.r, p.g, p.b) - Math.min(p.r, p.g, p.b)) / 255;
  const base = pal.reduce((a, p) => (p.share * (0.06 + chroma(p)) > a.share * (0.06 + chroma(a)) ? p : a));
  mesh.style.setProperty('--base', meshColor(base));
  // 色块从其余的颜色排起，底色自己放到最后一团（上边那团）
  [...pal.slice(0, pal.indexOf(base)), ...pal.slice(pal.indexOf(base) + 1), base].forEach((p, i) => {
    blobs[i].style.setProperty('--mc', meshColor(p));
    // 占得越多越大：48vmax 起，最大 80vmax（最多的颜色已经是底色，色块不用铺满）
    blobs[i].style.setProperty('--s', `${Math.round(48 + Math.min(1, p.share * 2) * 32)}vmax`);
  });
  // 第一次上色时，每团从自己路线上随机的一点开始，免得每次打开都是同一个样子
  if (!mesh.dataset.seeded) {
    mesh.dataset.seeded = '1';
    blobs.forEach((b) => { b.style.animationDelay = `${-Math.round(Math.random() * 60)}s`; });
  }
  mesh.classList.add('on');
  $('#bg').classList.add('meshed');
}

// 封面：优先用 Apple Music 里的封面，取不到时用歌词源的封面
const art = { track: null, status: '', cover: '' };
function setArt(track, cover) {
  const img = $('#art'), bg = $('#bg-img');
  if (!track) { art.track = null; img.classList.remove('on'); bg.classList.remove('on'); $('#ktv').classList.remove('has-art'); return; }
  const show = (url) => {
    if (art.track !== track) return;
    img.src = url; img.classList.add('on');
    for (const el of $$('.art-copy')) el.src = url; // KTV 样式里的封面、倒影、远处那两张
    $('#ktv').classList.add('has-art');
    bg.style.backgroundImage = `url("${url}")`; bg.classList.add('on');
    paintMesh(url);
  };
  const probe = (url, onOK, onFail) => { const p = new Image(); p.onload = () => { show(url); onOK && onOK(); }; p.onerror = () => onFail && onFail(); p.src = url; };
  if (cover) {
    if (art.track !== track) return;
    art.cover = cover;
    if (art.status === 'fail') probe(cover);
    return;
  }
  art.track = track; art.status = 'loading'; art.cover = '';
  img.classList.remove('on');
  $('#ktv').classList.remove('has-art');
  const fail = () => { if (art.track !== track) return; art.status = 'fail'; if (art.cover) probe(art.cover); };
  if (!track.pid) return fail();
  probe(`/api/artwork?pid=${encodeURIComponent(track.pid)}&current=1`, () => { if (art.track === track) art.status = 'ok'; }, fail);
}

// ---------------- 实验功能：长音强调 ----------------
// 逐字歌词里拖得很长的音，唱到时会放大、发光、往外「冒」一下，再缓缓落回去；拖得越长，冒得越明显。
// 冒到最高点以后最多在上面停 HOLD_TOP 秒：音再长也是到点就落，不陪着它一直撑到唱完（撑太久显得拖）。
// 一、哪个音算长音。看的是「拖了多久」= 这一段的时长 −（音数 − 1）× 平常一个音的时长：
//   - 假名：一个假名一个音，拖了多久就是它自己的时长；小写的ゃゅょ等和前一个假名算同一个音
//   - 带注音的汉字：按读音的音数算（「色褪」いろあ = 3 个音，1.5 秒里有两个音是平常地唱过去的，剩下的 1 秒是拖的）；
//     几个汉字连在一起的（宝物）按字拆开，一个字算一个单位，各用各的读音（たから 3 个音、もの 2 个音），见 kanjiParts；
//     没有读音的汉字按两个音算。（直接用「时长 ÷ 音数」的话，多音的汉字几乎永远够不到门槛）
//   - 英文单词：按音节数算，门槛放宽一些
//   拖得不到 HOLD_MIN 的完全不触发。
// 二、带着两边一起。和长音在同一个短语里（实词 + 后面跟着的词尾）、紧挨着它的字也一起冒：
//   - 左边的：最多 3 个字，各自在唱到的时候冒起来（所以是左边先、右边后，像一道波）
//   - 右边的：最多 3 个字，紧跟在长音后面唱出来的那一小段尾巴（「云フ」的フ、「忘れない」的ない）
//   - 被带的字自己至少要唱 HOLD_SPREAD.min 秒：一闪而过的字冒起来只是抖一下，不好看。
//     碰到这样的字就到此为止，不跳过它接着往外带——中间空一个不动的字，两边各冒各的，看着是散的
//   这里的「字」是能冒起来的最小单位：一个假名（连同后面的小写假名），或者一段带注音的汉字。
//   每个字只在自己被唱着的时候停在上面：下一个字起来时它就很快落下去，所以看上去是一个鼓包从左往右走，
//   走到长音那里停一下（到顶以后最多 HOLD_TOP 秒）再缓缓落下。离长音越远幅度越小。
// 三、独立的助词不参与。は、が、を、に、で、の、も、から、だけ 这类跟在词后面的助词：自己拖得再长也不冒，
//   也不会被旁边的长音带起来，鼓包走到它这里就停（「星座が」只有 星座 冒，が 不动；が 后面的词是另一个短语）。
//   歌里句尾的助词常常是拖着唱的，全算上的话到处都在冒。是不是助词看分词器给的词性，不看字面（「はな」的 は 不是）。
//   两种不算「独立」，照旧参与：
//   - 是词尾、句式的一部分的：走って 的 て、泣いても 的 も、夢じゃない 的 じゃ（tok.f）
//   - 句末的语气词 よ、ね、な、ぜ、さ、わ、ぞ（tok.fin）：它们拖长是在抒情，不是语法上的填充
// 四、变形的词（作って、合ってる、忘れてしまう）不能只有词尾冒、词干不动。两处照顾，细节见 holdPlan：
//   - 促音 っ 并进前一个字，不单独算一个字（它常常只有不到 0.1 秒，会把「带着左边」卡断）
//   - 一段冒起来的字最左边停在词尾上、词干一个都没冒时，把词干补上（最多补 HOLD_STEM.extra 个字）
const HOLD_MORA = 0.25; // 平常唱歌一个音大约多长（秒）
const HOLD_MIN = 0.8;   // 至少拖这么久才算长音
const HOLD_FULL = 1.9;  // 拖到这么久效果就到顶了
const HOLD_LATIN = 1.3; // 英文音节本来就比日语的一个音长，门槛按这个倍数放宽
const HOLD_TOP = 0.95;  // 最多停多久（秒），到点就开始落，哪怕这个音还没唱完
// 这 HOLD_TOP 秒从哪里算起：true = 从冒到最高点算起（在顶上实实在在停这么久）；false = 从唱到这个字算起（升起的时间也算在里面）
const HOLD_FROM_PEAK = true;
// 从唱到这个字到冒到差不多最高（85%）要多久：长音的弹簧 τ = 0.15（见 collectFill），走到 85% 是 3.37τ，再减去提前起步的 HOLD_LEAD（0.06）
const HOLD_RISE = 0.45;
const HOLD_MAX = HOLD_TOP + (HOLD_FROM_PEAK ? HOLD_RISE : 0); // 从唱到这个字算，最晚什么时候开始落
const HOLD_CAP = 4;     // 一个音最多按这么久算：再长多半是歌词时间把间奏也算进去了
const HOLD_SPREAD = { max: 3, within: 1.2, fade: 0.08, floor: 0.6, min: 0.11 }; // 往左带几个字、最多隔多久（秒）、每远一个字弱多少、最弱到多少、被带的字（左右都算）至少唱多久
const HOLD_NEXT = 0.3; // 唱完后这么久以内紧接着又有字冒起来：这个字要快点落，给后面的让位
const HOLD_TAIL = { max: 3, within: 0.8 }; // 往右带几个字、最晚在长音唱完后多久（秒）以内开始唱的
const HOLD_NO_PARTICLE = true; // 独立的助词不参与（见上面第三条）；改成 false 就回到助词也冒的样子
const HOLD_STEM = { extra: 3, within: 2 }; // 只有词尾冒时把词干补上（见 holdPlan 里第四条）：最多补几个字、最多隔多久（秒）。extra 改成 0 就不补
const SMALL_KANA = /[ぁぃぅぇぉゃゅょゎァィゥェォャュョヮ]/;
const SOKUON = /[っッ]/;
const moraCount = (s) => { let n = 0; for (const c of s) if (/[ぁ-ゖァ-ヺー〜～]/.test(c) && !SMALL_KANA.test(c)) n++; return n; };
const syllables = (w) => Math.max(1, (w.toLowerCase().replace(/e$/, '').match(/[aeiouy]+/g) || []).length);
// 几个汉字连在一起、共用一段注音的（宝物 / たからもの）：能不能按字拆开，每个字各自填色、各自抬起。
// 要两样东西都有：服务器把读音按字分好了（seg.rs = ['たから', 'もの']，见 server/kanji-readings.js），而且每个字都有自己的时间。
// 返回 [{ ch 这个字, c 它的字符下标, r 它头上的那几个假名, tm [开始, 结束] }]，拆不了返回 null（那就整段当一个单位）
function kanjiParts(line, seg, c0) {
  const chars = [...seg.t], rs = seg.rs;
  if (!rs || rs.length !== chars.length || rs.join('').length !== seg.r.length) return null;
  const out = [];
  for (let k = 0, c = c0, at = 0; k < chars.length; k++) {
    const tm = line.ct?.[c];
    if (!tm) return null;
    out.push({ ch: chars[k], c, r: seg.r.slice(at, at + rs[k].length), tm });
    c += chars[k].length; at += rs[k].length;
  }
  return out;
}
// 返回 Map：字符下标 → { a: 强度 0–1, t0: 从什么时候冒起来, t1: 什么时候开始落, q: 后面紧跟着别的字（要快点落） }。每句只算一次
function holdPlan(line) {
  if (line._hold) return line._hold;
  const plan = (line._hold = new Map());
  const ct = line.ct;
  if (!ct || !line.tokens) return plan;
  const amp = (dur, m, unit, min) => { const held = dur - (m - 1) * unit; return held >= min ? 0.55 + 0.45 * clamp((held - min) / (HOLD_FULL - HOLD_MIN)) : 0; };
  // units：这一句里能冒起来的最小单位，从左到右。cs = 它占的字符下标；g = 属于第几个短语；own = 它自己是不是长音（强度）
  const units = [];
  let g = 0;
  const push = (cs, m, ti) => {
    const a0 = ct[cs[0]], a1 = ct[cs[cs.length - 1]] || a0;
    const t1 = a0 && Math.min(a1[1], a0[0] + HOLD_CAP);
    if (a0) units.push({ cs, m, ti, t0: a0[0], t1, g, own: m ? amp(t1 - a0[0], m, HOLD_MORA, HOLD_MIN) : 0, a: 0 });
  };
  // 促音（っ）并进前一个字里，不单独算一个字：它本身没有声音，只是前一个音的收尾，
  // 歌词的时间里常常只分给它不到 0.1 秒（前一个字也跟着被切短）。单独算的话它过不了「被带的字至少唱多久」那一关，
  // 鼓包往左走到它就断了——「合ってるよ」只有 てる 冒、合っ 不动，「作って」只有 て 冒
  const glue = (c, ti) => {
    const u = units[units.length - 1], tm = ct[c];
    if (!u || u.ti !== ti || !tm) return false;
    u.cs.push(c);
    u.t1 = Math.min(tm[1], u.t0 + HOLD_CAP);
    // 算不算长音还是各看各的，不把两段时间加起来：促音那一段多半是停顿，加进去的话「なぞった」这种普通的词也成了长音
    u.own = Math.max(u.own, amp(Math.min(tm[1] - tm[0], HOLD_CAP), 1, HOLD_MORA, HOLD_MIN));
    return true;
  };
  line.tokens.forEach((tok, ti) => {
    const latin = /^[A-Za-z'’]+$/.test(tok.s);
    const word = /[぀-ヿ㐀-鿿々〆A-Za-z0-9]/.test(tok.s); // 有字，不是空格和标点
    const lone = tok.s.length === 1 && /[ぁ-ヿ]/.test(tok.s); // 孤零零一个假名被分成了「实词」（云フ 的 フ）：多半是前一个词的词尾，不另起短语
    if (!word || latin || (tok.v && !tok.j && !lone)) g++; // 实词开头是新的短语；空格、标点、英文单词把短语断开
    if (!word) return;
    if (HOLD_NO_PARTICLE && tok.pos === '助' && !tok.f && !tok.fin) { g++; return; } // 独立的助词：不冒，并且把短语断开
    if (latin) {
      // 英文单词：字母本来就是一个接一个冒、到词尾一起落，不参与上面的「带着左边」
      const a0 = ct[tok.i0], a1 = ct[tok.i0 + tok.s.length - 1];
      const a = a0 && a1 ? amp(a1[1] - a0[0], syllables(tok.s), HOLD_MORA * HOLD_LATIN, HOLD_MIN * HOLD_LATIN) : 0;
      if (a) for (let c = tok.i0; c < tok.i0 + tok.s.length; c++) if (ct[c]) plan.set(c, { a, t0: ct[c][0], t1: Math.min(a1[1], ct[c][0] + HOLD_MAX) });
      g++;
      return;
    }
    let ci = tok.i0;
    for (const seg of tok.segs) {
      const c0 = ci, len = seg.t.length;
      ci += len;
      if (KANJI.test(seg.t) && seg.r) {
        const parts = kanjiParts(line, seg, c0);
        if (parts) for (const p of parts) push(Array.from({ length: p.ch.length }, (_, k) => p.c + k), moraCount(p.r) || 2, ti);
        else push(Array.from({ length: len }, (_, k) => c0 + k), moraCount(seg.r) || len * 2, ti);
        continue;
      }
      for (let k = 0; k < len;) {
        if (SOKUON.test(seg.t[k]) && glue(c0 + k, ti)) { k++; continue; }
        let e = k + 1;
        while (e < len && SMALL_KANA.test(seg.t[e])) e++;
        push(Array.from({ length: e - k }, (_, j) => c0 + k + j), KANJI.test(seg.t[k]) ? 2 : moraCount(seg.t[k]), ti);
        k = e;
      }
    }
  });
  const near = (T, n) => T.own * Math.max(HOLD_SPREAD.floor, 1 - HOLD_SPREAD.fade * n);
  units.forEach((T, i) => {
    if (!T.own) return;
    const ok = (u) => u.g === T.g && u.t1 - u.t0 > HOLD_SPREAD.min - 0.005; // 同一个短语里的、不是一闪而过的
    T.a = Math.max(T.a, T.own);
    for (let j = i + 1; j < units.length && j - i <= HOLD_TAIL.max && ok(units[j]) && units[j].t0 - T.t1 <= HOLD_TAIL.within; j++) units[j].a = Math.max(units[j].a, near(T, j - i));
    for (let j = i - 1; j >= 0 && i - j <= HOLD_SPREAD.max && ok(units[j]) && T.t0 - units[j].t0 <= HOLD_SPREAD.within; j--) units[j].a = Math.max(units[j].a, near(T, i - j));
  });
  // 四、变形的词不能只有词尾冒。鼓包往左只带三个字，常常带到一个变形的词中间就停了：
  //   「捨ててしまえ」拖的是 え，带到 てしま 为止——冒的是 てしまえ，词干 捨て 却不动，看着像是冒错了地方。
  //   所以一段冒起来的字，如果最左边停在某个词的词尾上、这个词的词干一个字都没冒，就接着往左把这个词补全。
  //   补的字不受「三个字」「至少唱多久」那两条限制（词干再短也是这个词的主体），但有两个上限：
  //   最多补 HOLD_STEM.extra 个字（再多说明这个词太长，整个带上就又成了「带得太多」）、离这一段开头不超过 HOLD_STEM.within 秒。
  //   补不全的就一个都不补，维持原样。
  if (HOLD_STEM.extra) {
    const stemOf = (ti) => { while (ti > 0 && line.tokens[ti].j) ti--; return ti; }; // 这个词尾接在哪个词干后面
    for (let i = 0; i < units.length; i++) {
      const L = units[i];
      if (!L.a || units[i - 1]?.a || !line.tokens[L.ti].j) continue; // 只看每一段的最左边，而且它得是词尾
      const st = stemOf(L.ti);
      let k = i - 1;
      while (k >= 0 && units[k].g === L.g && units[k].ti >= st && !units[k].a) k--;
      const first = k + 1; // 这个词从哪个字开始（往左数到词干的第一个字，或者碰到已经在冒的字）
      if (first >= i || units[first].ti !== st || (k >= 0 && units[k].ti === st)) continue; // 没碰到词干，或者词干已经有一部分在冒
      if (i - first > HOLD_STEM.extra || L.t0 - units[first].t0 > HOLD_STEM.within) continue;
      for (let j = i - 1; j >= first; j--) units[j].a = L.a * Math.max(HOLD_SPREAD.floor, 1 - HOLD_SPREAD.fade * (i - j));
    }
  }
  units.forEach((u, i) => {
    if (!u.a) return;
    const nx = units[i + 1];
    const t1 = Math.min(u.t1, u.t0 + HOLD_MAX); // 什么时候开始落：唱完，或者停够了
    const h = { a: u.a, t0: u.t0, t1, q: !!nx?.a && nx.t0 - t1 <= HOLD_NEXT };
    for (const c of u.cs) plan.set(c, h);
  });
  return plan;
}
// 强调的包络（0–1）。不是拼出来的「先升后降」两段曲线，而是一根不回弹的弹簧（临界阻尼）跟着一个目标走：
// 唱到这个字时目标变成 1，唱完变回 0。于是起步和收尾都是缓的，中间没有突然加速的地方；
// 音很短的话弹簧还没到顶就往回走，鼓包自然就小一些；落下去是一条越来越缓的尾巴，不会在某个时刻硬停。
// τ（s.tau）是弹簧的快慢：过 3τ 走完八成，5τ 走完 96%。
const HOLD_LEAD = 0.06;
const settle = (x) => (x <= 0 ? 0 : 1 - (1 + x) * Math.exp(-x));
function holdEnv(s, t) {
  if (t <= s.h0 - HOLD_LEAD || t >= s.h1 + 12 * s.tau) return 0;
  return Math.round((settle((t - s.h0 + HOLD_LEAD) / s.tau) - settle((t - s.h1) / s.tau)) * 500) / 500;
}
function paintHold(s, t) {
  const e = holdEnv(s, t);
  if (e === s.e) return;
  s.e = e;
  if (e) {
    s.el.style.setProperty('--e', e); s.rk?.style.setProperty('--e', e);
    if (!s.emon) { s.emon = true; s.el.classList.add('emon'); s.rk?.classList.add('emon'); }
  } else clearHold(s);
}
function clearHold(s) {
  s.e = 0; s.emon = false;
  s.el.classList.remove('emon');
  s.el.style.removeProperty('--e');
  s.rk?.classList.remove('emon');
  s.rk?.style.removeProperty('--e');
}
// 换到下一句时，上一句最后那个长音可能还没落回去：留在这里接着落完
let holdTail = [];

// ---------------- 渲染歌词 ----------------
function jpHTML(line, li) {
  if (line.gap) return '<span class="dots"><span class="dots-g"><i></i><i></i><i></i></span></span>';
  let html = '';
  const hold = holdPlan(line);
  line.tokens.forEach((tok, ti) => {
    let ci = tok.i0, inner = '';
    tok.segs.forEach((seg, si) => {
      const c0 = ci;
      const isK = KANJI.test(seg.t);
      const ruby = isK && !!seg.r;
      // 逐字歌词里的「填充单位」（class="fu"）：按时间填色、唱到时抬起来的最小单位。
      //   - 普通的字：一个字一个单位，于是一个词里的字是一个接一个抬起来的，像一道波
      //   - 带注音的单个汉字（以及读音没法按字分的一段汉字）：汉字连同上面的假名是一个单位
      //   - 几个汉字连在一起的（宝物）按字拆开：每个汉字一个单位，注音里属于它的那几个假名包成一个 .rk，
      //     由 app.js 让它跟着这个汉字一起变亮、抬起（collectFill 里配对）。注音的排版不变，还是整段居中
      // --lt：抬起来的弹簧动画总共多长。弹簧起步慢、收尾长，所以取这个字时长的两倍多，
      // 最短也有 0.75 秒：相邻的字一个还没抬完、下一个已经起步，叠在一起才不显得一格一格的
      const lt = (t0, t1) => `style="--lt:${clamp((t1 - t0) * 2.6, 0.75, 1.6).toFixed(2)}s"`;
      const unit = (t0, t1, c) => {
        const h = hold.get(c);
        return ` data-t0="${t0}" data-t1="${t1}"${h ? ` data-em="${h.a.toFixed(2)},${h.t0},${h.t1},${h.q ? 1 : 0}"` : ''} ${lt(t0, t1)}`;
      };
      const parts = ruby ? kanjiParts(line, seg, c0) : null;
      let chars = '', rks = '';
      if (parts) for (const p of parts) {
        chars += `<span class="ch fu" data-c="${p.c}"${unit(p.tm[0], p.tm[1], p.c)}>${esc(p.ch)}</span>`;
        rks += `<span class="rk" ${lt(p.tm[0], p.tm[1])}>${esc(p.r)}</span>`;
        ci = p.c + p.ch.length;
      }
      else for (const ch of seg.t) {
        const tm = !ruby && line.ct?.[ci];
        chars += `<span class="ch${tm ? ' fu' : ''}" data-c="${ci}"${tm ? unit(tm[0], tm[1], ci) : ''}>${esc(ch)}</span>`;
        ci += ch.length;
      }
      const whole = ruby && !parts && line.ct?.[c0] ? unit(line.ct[c0][0], (line.ct[ci - 1] || line.ct[c0])[1], c0) : '';
      const cls = `seg${isK ? ' k' : ''}${whole ? ' fu' : ''}${seg.src ? ` src-${seg.src}` : ''}`;
      inner += `<span class="${cls}" data-si="${si}"${whole}>${ruby ? `<ruby>${chars}${parts ? `<rt class="rks">${rks}</rt>` : `<rt><span class="rw">${esc(seg.r)}</span></rt>`}</ruby>` : chars}</span>`;
    });
    html += `${ti && phraseStart(line.tokens, ti) ? '<wbr>' : ''}<span class="tok${tok.j ? ' j' : ''}" data-ti="${ti}">${inner}</span>`;
  });
  return html;
}
// 长句折行只在「文节」之间断：样式里不许在日文字之间随便断（word-break: keep-all），这里在每个文节开头放一个 <wbr>，
// 浏览器只能在这些地方换行，再配上 text-wrap: balance 把两行排得差不多长——不会把「…だったらい / い」这样拆开。
// 文节 = 一个实词（名词、动词、形容词、副词…）连同后面跟着的助词、助动词。前一个是接头词、或者前后都是名词（复合词）时不断
const PHRASE_HEAD = new Set(['名', '动', '形', '副', '连体', '接续', '感叹', '接头']);
function phraseStart(toks, ti) {
  const t = toks[ti], p = toks[ti - 1];
  if (t.sp || p.sp) return true;
  if (!PHRASE_HEAD.has(t.pos) || !t.v && t.pos !== '连体' && t.pos !== '接续' && t.pos !== '感叹' && t.pos !== '接头') return false;
  if (p.pos === '接头') return false;
  if (p.pos === '名' && t.pos === '名') return false;
  return true;
}
function lineBody(line, li) {
  return `<div class="jp" lang="ja" data-li="${li}">${jpHTML(line, li)}</div>`
    + (line.roma ? `<div class="roma">${esc(line.roma)}</div>` : '')
    + (line.zh ? `<div class="zh">${esc(line.zh)}</div>` : '');
}
function renderLines() {
  $('#scroll').innerHTML = S.lines.map((line, li) =>
    `<div class="line${line.gap ? ' gap' : ''}${line.ct ? ' timed' : ''}" data-i="${li}">${lineBody(line, li)}<div class="ann"></div></div>`).join('');
  S.active = -2;
  // 每一行是「第几句看得见的歌词」。间奏行平时是收起来的（不占位置），算远近时不能把它算成一行
  let n = 0;
  S.vis = S.lines.map((line) => (line.gap ? n : ++n));
  paintSelection();
}

function renderFocus() {
  const i = S.active;
  const line = S.lines[i];
  const plain = (l) => (l && !l.gap ? esc(l.text) : '');
  const prev = S.lines[i - 1];
  $('#f-prev').innerHTML = plain(prev);
  $('#f-prev').dataset.i = prev && !prev.gap ? i - 1 : '';
  const next = S.lines[i < 0 ? 0 : i + 1];
  $('#f-next').innerHTML = plain(next);
  $('#f-next').dataset.i = next ? S.lines.indexOf(next) : '';
  const cur = $('#f-cur');
  // 大字样式下从歌词进入间奏：原来那句（连同下面的标注）不直接消失，留一份在原地淡出，三个点随后再出现
  const fading = line?.gap && prefs.view === 'focus' && cur.querySelector('.tok') && !noMotion.matches && !document.hidden
    ? [cur, $('#f-ann')].filter((el) => el.childElementCount).map((el) => ({ el, rect: el.getBoundingClientRect(), copy: el.cloneNode(true) })) : [];
  cur.className = `f-cur${line?.ct ? ' timed' : ''}`;
  cur.innerHTML = line ? lineBody(line, i) : (S.lines.length ? '<div class="jp"><span class="dots idle"><span class="dots-g"><i></i><i></i><i></i></span></span></div>' : '');
  cur.style.animation = 'none'; void cur.offsetWidth; cur.style.animation = '';
  paintAnnotations();
  paintSelection();
  for (const { rect, copy } of fading) {
    // 这份拷贝保留原来的 id 和 class（样式才完全一样），放在真身后面，所以按 id 找到的仍然是真身
    copy.style.cssText = `position:fixed;left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px;margin:0;max-width:none;pointer-events:none;animation:none;`;
    copy.setAttribute('aria-hidden', 'true');
    $('#focus-inner').append(copy);
    // Mac App 里淡出时不加模糊：WebKit 的滤镜图层边上会画出紫线（见 style.css 的 .mac-app .line）
    const blurOut = !document.documentElement.classList.contains('mac-app');
    copy.animate([{ opacity: 1, transform: 'none', ...(blurOut && { filter: 'blur(0)' }) }, { opacity: 0, transform: 'translateY(-10px) scale(.985)', ...(blurOut && { filter: 'blur(5px)' }) }],
      { duration: 520, easing: 'cubic-bezier(.3, .1, .3, 1)', fill: 'forwards' }).onfinish = () => copy.remove();
  }
  // 上一句 / 下一句的小字会因为中间变矮而挪到新位置：让它们稍后再淡入，不和正在淡出的大字叠在一起
  if (fading.length) for (const id of ['#f-prev', '#f-next']) $(id).animate([{ opacity: 0 }, { opacity: 1 }], { duration: 450, delay: 220, easing: 'ease-out', fill: 'backwards' });
  renderKtv(); // KTV 样式的两行：和大字一样，当前句变了就要重画，所以挂在这里
}

// ---------------- 同步：当前行 / 逐字填充 / 进度条 ----------------
function findActive(t) {
  const L = S.lines;
  let lo = 0, hi = L.length - 1, ans = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (L[mid].t <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1; }
  return ans;
}
// 弹簧缓动：按弹簧的物理模型算出一条曲线，交给浏览器的 linear() 缓动去跑，
// 这样动画全程在合成器线程上，不需要每帧用 JS 去算位置。
function springEasing(stiffness, damping, mass = 1) {
  if (!globalThis.CSS?.supports?.('animation-timing-function', 'linear(0, 1)')) return { easing: 'cubic-bezier(.2, .9, .25, 1)', ms: 650 };
  const dt = 1 / 480, step = 1 / 40, pts = [0];
  let x = 0, v = 0, t = 0, next = step;
  while (t < 2) {
    v += ((1 - x) * stiffness - v * damping) / mass * dt;
    x += v * dt;
    t += dt;
    if (t >= next) { pts.push(Math.round(x * 1000) / 1000); next += step; if (Math.abs(1 - x) < 0.0015 && Math.abs(v) < 0.02) break; }
  }
  pts[pts.length - 1] = 1;
  return { easing: `linear(${pts.join(', ')})`, ms: Math.round((pts.length - 1) * step * 1000) };
}
const SPRING = springEasing(120, 22); // 临界阻尼：有弹簧的缓急，但到位时不回弹
document.documentElement.style.setProperty('--spring', SPRING.easing);
document.documentElement.style.setProperty('--spring-ms', `${SPRING.ms}ms`);
const noMotion = matchMedia('(prefers-reduced-motion: reduce)');
const elScroll = $('#scroll');

function setActive(i) {
  const first = S.active === -2; // 刚渲染完：直接就位，不做动画
  // 实验功能 2：这一组从哪句开始亮。只有「从同组的上一句接着唱下来」才沿用原来的起点，否则（跳转过来的）从这一句算起
  const prev = S.active, jumped = S.jumped;
  S.jumped = false;
  const g = i >= 0 && S.grp?.[i];
  const carried = g && !jumped && (prev === i - 1 || prev === i) && S.grpFrom >= g[0] && S.grpFrom <= Math.min(prev, i);
  if (!carried) S.grpFrom = i;
  S.active = i;
  hideSensePop();
  const apply = () => {
    const els = elScroll.children, a = Math.max(i, 0);
    const vis = S.vis, inGap = !!S.lines[a]?.gap; // 正在间奏：三个点自己算一行
    const ga = groupFrom(); // 和当前句一起亮着的那几句从哪句开始（实验功能 2）；平时就是当前句自己
    for (let k = 0; k < els.length; k++) {
      const el = els[k];
      // 只改状态真的变了的行：离当前行 6 行以外的样子都一样
      const st = k === i ? 2 : k < i ? 1 : 0;
      const co = k < i && k >= ga; // 同组里前面唱过的句子：继续亮着，和当前句一样清楚。后面还没唱到的不提前亮
      const d = k >= ga && k <= a ? 0 : Math.min((k < ga ? vis[ga] - vis[k] : vis[k] - vis[a]) + (inGap && k < a ? 1 : 0), 6);
      if (el._st !== st) { el._st = st; el.classList.toggle('active', st === 2); el.classList.toggle('past', st === 1); }
      if (el._co !== co) { el._co = co; el.classList.toggle('co', co); }
      if (el._d !== d) { el._d = d; el.style.setProperty('--d', d); }
    }
    renderFocus();
    jumpToActive();
  };
  if (first) apply(); else glide(apply, i);
  collectFill();
}
// 按字拆开的汉字：注音里属于它的那几个假名（rt 里和它同一个位置的 .rk）。不是这种汉字就没有
function rkOf(el) {
  const ruby = el.parentNode.tagName === 'RUBY' ? el.parentNode : null;
  return ruby && ruby.lastElementChild.classList.contains('rks') ? ruby.lastElementChild.children[Array.prototype.indexOf.call(ruby.children, el)] : null;
}
function collectFill() {
  const line = S.lines[S.active];
  // 上一句里还没落回去的长音：还在页面上的留着接着落，其余的直接复位
  const fx = prefs.fxHold && !noMotion.matches;
  for (const s of [...holdTail, ...(S.fill?.segs || [])]) if (s.em && s.e && !(fx && s.el.isConnected)) clearHold(s);
  holdTail = [...holdTail, ...(S.fill?.segs || [])].filter((s) => s.em && s.e);
  S.fill = null;
  if (!line) return;
  const root = prefs.view === 'focus' ? $('#f-cur') : prefs.view === 'ktv' ? ktvRoot(line) : elScroll.children[S.active];
  if (!root) return;
  if (line.gap) S.fill = { gap: true, line, plan: dotsPlan(line), g: $('.dots-g', root), dots: $$('.dots-g i', root).map((el) => ({ el, p: -1 })), s: '', o: '' };
  else if (line.ct) {
    S.fill = { segs: $$('.fu', root).map((el) => {
      el.classList.remove('on');
      // 按字拆开的汉字：注音里属于它的那几个假名（rt 里和它同一个位置的 .rk）跟着它一起动
      const rk = rkOf(el);
      rk?.classList.remove('on');
      const s = { el, rk, t0: +el.dataset.t0, t1: +el.dataset.t1, d: Math.max(0.05, el.dataset.t1 - el.dataset.t0), p: -1, on: false };
      const old = holdTail.find((x) => x.el === el); // 同一句重新收集（切换显示方式等）：接着原来的状态
      if (fx && el.dataset.em) {
        const [a, h0, h1, q] = el.dataset.em.split(',').map(Number), hd = Math.max(0.05, h1 - h0);
        // 弹簧的快慢：短的音快一点，长的慢一点；后面紧跟着别的字的（波浪里的）比这一段的最后一个快，好给后面的让位
        Object.assign(s, { em: true, h0, h1, tau: q ? clamp(hd * 0.3, 0.1, 0.14) : clamp(hd * 0.3, 0.11, 0.15), e: old?.e || 0, emon: !!old?.emon });
        el.style.setProperty('--ea', a);
        rk?.style.setProperty('--ea', a);
      } else if (old) clearHold(old);
      return s;
    }) };
    holdTail = holdTail.filter((x) => !S.fill.segs.some((s) => s.el === x.el));
    // 已经唱过去的字直接就是抬着的，不从头再抬一遍。同一句会被重新收集（切换显示样式、开关实验功能…），
    // 不这样的话每次重新收集，前面唱过的字都会一起落下去再弹上来。正在唱的那个字不算，留给 tick 照常抬
    const t = now() - S.offset, up = S.fill.segs.filter((s) => t >= s.t1 || t >= s.t0 + LIFT_DONE);
    if (up.length) {
      root.classList.add('still'); // 这一下不要过渡（见 style.css）
      for (const s of up) { s.on = true; s.el.classList.add('on'); s.rk?.classList.add('on'); }
      void root.offsetWidth;
      root.classList.remove('still');
    }
  }
}

// ---------------- 滚动：让当前行停在偏上的位置 ----------------
// 滚动位置本身是直接跳过去的；「跳之前」和「跳之后」各量一次看得见的那些行在哪，
// 再让每一行从原来的位置用弹簧动画滑到新位置（FLIP）。下面的行依次晚一点出发，
// 就有了一行带着一行走的感觉。当前行底下的标注出现 / 消失造成的挤动也一起被这个动画吸收。
let freeTimer = 0;
let glideAnims = [];
function jumpToActive() {
  if (prefs.view !== 'apple' || elScroll.classList.contains('free')) return;
  const a = Math.max(S.active, 0);
  const el = elScroll.children[groupFrom()]; // 一组紧凑的句子：对准亮着的第一句，组里换句时不滚动
  if (!el) return;
  const H = elScroll.clientHeight;
  let top = el.offsetTop - H * 0.3;
  // 一组排得太长（四句，或者标注多）：正在唱的那句连同它的标注快到底了，就整体往上让一让。
  //   想要的：它的底边在屏幕 78% 以上；同时组里的第一句不顶出屏幕（最高到 6%）
  //   两头顾不上时：保正在唱的那句完整看得见（底边不过 92%），第一句被顶出去一点也认了
  const cur = elScroll.children[a];
  if (cur && cur !== el) {
    const bottom = cur.offsetTop + cur.offsetHeight;
    top = Math.max(top, Math.min(bottom - H * 0.78, el.offsetTop - H * 0.06), bottom - H * 0.92);
    top = Math.min(top, cur.offsetTop - H * 0.3); // 再怎么让，也不超过「只有这一句时」它该在的位置
  }
  elScroll.scrollTop = top;
}
// 视口上下各多看 pad 像素，返回这一段里的行的下标范围
function visibleRange(pad) {
  const els = elScroll.children, n = els.length;
  if (!n) return [0, -1];
  const top = elScroll.scrollTop - pad, bot = elScroll.scrollTop + elScroll.clientHeight + pad;
  let a = 0, b = n - 1;
  while (a < b) { const m = (a + b) >> 1; if (els[m].offsetTop + els[m].offsetHeight < top) a = m + 1; else b = m; }
  const lo = a;
  b = n - 1;
  while (a < b) { const m = (a + b + 1) >> 1; if (els[m].offsetTop > bot) b = m - 1; else a = m; }
  return [lo, a];
}
function glide(change, pivot = S.active) {
  if (prefs.view !== 'apple' || noMotion.matches || document.hidden || !elScroll.children.length) return change();
  const els = elScroll.children, H = elScroll.clientHeight;
  // 之前：量位置（包含还没播完的上一次动画的位移，所以连续换行时能从半路接着走）
  const [lo1, hi1] = visibleRange(H * 0.6);
  const before = new Map();
  for (let k = lo1; k <= hi1; k++) before.set(k, els[k].getBoundingClientRect().top);
  const scroll0 = elScroll.scrollTop;
  for (const an of glideAnims) an.cancel();
  glideAnims = [];
  change();
  // 之后
  const [lo2, hi2] = visibleRange(H * 0.2);
  const far = clamp(elScroll.scrollTop - scroll0, -H * 0.5, H * 0.5); // 之前不在视野里的行（比如拖了进度）：从不远处滑进来
  const a = Math.max(pivot, 0);
  const up = elScroll.scrollTop >= scroll0;
  const moves = [];
  for (let k = Math.min(lo1, lo2); k <= Math.max(hi1, hi2); k++) {
    if (k > hi2 + 2 || k < lo2 - 2) continue; // 换完以后看不见的行不用动
    const el = els[k];
    const d = before.has(k) ? before.get(k) - el.getBoundingClientRect().top : far;
    if (Math.abs(d) < 0.5) continue;
    // 往上走时，当前行以上的一起先走，下面的行一行比一行晚；往回走时反过来
    moves.push([el, d, Math.min(Math.max(0, up ? k - a : a - k), 9) * 38]);
  }
  // 最早动的那一行不等：要动的行全都离 pivot 很远时（自己划到后面去了），每一行算出来都是最长的那个延迟，
  // 结果是整屏先愣一下才一起动。减掉其中最小的，错开的节奏不变，只是不白等
  const wait = Math.min(...moves.map((m) => m[2]));
  for (const [el, d, lag] of moves) {
    glideAnims.push(el.animate([{ translate: `0 ${d.toFixed(1)}px` }, { translate: '0 0' }], { duration: SPRING.ms, delay: lag - wait, easing: SPRING.easing, fill: 'backwards' }));
  }
}
function scrollToActive(instant) {
  if (prefs.view !== 'apple' || elScroll.classList.contains('free')) return;
  if (instant) { for (const an of glideAnims) an.cancel(); glideAnims = []; jumpToActive(); } else glide(jumpToActive);
}
// 自己划走以后，过一会儿自动回到正在唱的那一句。
// 修改模式下正改到一半（读音小窗或义项卡片开着）时不回去；改完以后从头再等这么久（见 editDone）。
function armReturn() {
  clearTimeout(freeTimer);
  freeTimer = setTimeout(() => {
    if (S.mode === 'edit' && (editing || !sensePop.hidden)) return armReturn();
    elScroll.classList.remove('free');
    scrollToActive();
  }, S.mode ? 8000 : 3500);
}
function editDone() { if (elScroll.classList.contains('free')) armReturn(); }
for (const ev of ['wheel', 'touchmove']) {
  elScroll.addEventListener(ev, () => { elScroll.classList.add('free'); armReturn(); }, { passive: true });
}

// ---------------- 每一帧：进度条、逐字填充、间奏的三个点 ----------------
// 这里每秒跑 60 次，所以只在数值真的变了的时候才去改页面，并且尽量只改不会引起重新排版的属性
const elFill = $('#progress-fill'), elCur = $('#t-cur'), elRem = $('#t-rem');
const shown = { w: -1, cur: '', rem: '' };
function setProgress(frac) {
  const w = Math.round(clamp(frac) * 2000) / 2000;
  if (w !== shown.w) { shown.w = w; elFill.style.transform = `translateX(${(w - 1) * 100}%)`; }
}
// 间奏的三个点。e：间奏已经过了多久；D：间奏总长
//   1. 三个点依次读满；整体一直在慢慢「呼吸」，越接近读满呼吸的幅度越大、个头也越大
//   2. 呼吸不是匀速的正弦：胀到最大、缩到最小时都会停一小会儿，中间缓进缓出
//   3. 呼吸的快慢基本不变，只是开头比后面稍微慢一点点（频率按 1 - e^(-t/τ) 趋近一个稳定值）
//   4. 读满的那一刻正好停在最大处，接着再胀大一点，然后缩小并淡出，在下一句开始前消失
const DOT_BASE = [0.9, 1], DOT_AMP = [0.08, 0.15]; // 个头、呼吸幅度：从间奏开始到读满的变化范围
const BREATH_HOLD = 0.13; // 一次呼吸里，在最大 / 最小处各停留的比例
// x：一次呼吸里走到哪了（0–1，0 是「最大」那段停顿的正中）。返回 -1（最小）到 1（最大）
function breath(x) {
  const h = BREATH_HOLD / 2, m = 0.5 - BREATH_HOLD;
  if (x < h || x >= 1 - h) return 1;
  if (x < 0.5 - h) return Math.cos(Math.PI * (x - h) / m);
  if (x < 0.5 + h) return -1;
  return -Math.cos(Math.PI * (x - 0.5 - h) / m);
}
// 每段间奏算一次：各阶段的时刻，以及「过了 e 秒时呼吸了多少次」的函数
function dotsPlan(line) {
  const D = line.end - line.t;
  const out = Math.min(1.1, D * 0.22);          // 收尾（胀大 → 淡出）用的时间
  const full = Math.max(0.3, D - out - 0.12);   // 读满的时刻
  const tau = clamp(full * 0.3, 1.5, 4);        // 呼吸加快的势头多久平下来
  const f0 = 1 / 5, f1 = 1 / 4.5;               // 呼吸的频率：约 4.5 秒一次，开头稍慢
  // 只保证「读满时正好在最大处」（paintDots 里从读满的时刻往回数）。开头落在呼吸的哪一段不去凑：
  // 那时三个点还没淡入，看不出来；要是硬凑成整数次半，短间奏的快慢就只能在几个固定档位里跳
  const count = (e) => f1 * e - (f1 - f0) * tau * (1 - Math.exp(-e / tau));
  return { out, full, span: full / 3, count, total: count(full) };
}
function paintDots(f, t) {
  const g = f.plan, e = Math.max(0, t - f.line.t);
  for (let k = 0; k < f.dots.length; k++) {
    const dot = f.dots[k], p = Math.round(clamp((e - k * g.span) / g.span) * 100) / 100;
    if (p !== dot.p) { dot.p = p; dot.el.style.setProperty('--p', p); }
  }
  let sc, op = 1;
  if (e <= g.full) {
    const P = e / g.full;
    const cyc = g.count(e) - g.total; // 距离「读满」还差多少次呼吸（负数），0 = 正在最大处
    sc = (DOT_BASE[0] + (DOT_BASE[1] - DOT_BASE[0]) * P) * (1 + (DOT_AMP[0] + (DOT_AMP[1] - DOT_AMP[0]) * P) * breath(cyc - Math.floor(cyc)));
  } else {
    const q = clamp((e - g.full) / g.out), peak = DOT_BASE[1] * (1 + DOT_AMP[1]), top = peak + 0.12;
    if (q < 0.4) sc = peak + (top - peak) * (1 - (1 - q / 0.4) ** 2);
    else { const u = (q - 0.4) / 0.6; sc = top - 0.5 * u * u; op = 1 - u * u * (3 - 2 * u); }
  }
  const s = sc.toFixed(3), o = op.toFixed(2);
  if (s !== f.s) { f.s = s; f.g.style.transform = `scale(${s})`; }
  if (o !== f.o) { f.o = o; f.g.style.opacity = o; }
}
const LIFT_LEAD = 0.06; // 比唱到的时刻早一点点开始抬（弹簧起步慢，提前一点才跟得上）
const LIFT_DONE = 0.3;  // 一个字唱了这么久，就算已经抬到位了（见 collectFill）
function tick() {
  const pos = now();
  const dur = S.track?.duration || 0;
  if (!S.dragging) {
    setProgress(dur ? pos / dur : 0);
    const cur = fmt(pos), rem = `-${fmt(Math.max(0, dur - pos))}`;
    if (cur !== shown.cur) elCur.textContent = shown.cur = cur;
    if (rem !== shown.rem) elRem.textContent = shown.rem = rem;
  }
  if (!S.lines.length) return;
  const t = pos - S.offset;
  // 时间不连续（往回退了，或者一下子跳过去一大截）：是跳转，不是唱过来的。小幅的校准（和 Apple Music 对表）不算
  if (S.lastT !== undefined && (t < S.lastT - 0.6 || t > S.lastT + 1.5)) S.jumped = true;
  S.lastT = t;
  const i = findActive(t);
  if (i !== S.active) setActive(i);
  else if (S.jumped) {
    // 跳转后还在同一句（比如点了正在唱的这一句从头听）：同组里前面亮着的句子也要收起来
    S.jumped = false;
    if (i >= 0 && groupFrom() < i) { S.grpFrom = i; setActive(i); }
  }
  if (holdTail.length) { for (const s of holdTail) paintHold(s, t); holdTail = holdTail.filter((s) => s.e); }
  const f = S.fill;
  if (!f) return;
  if (f.gap) return paintDots(f, t);
  for (const s of f.segs) {
    if (s.em) paintHold(s, t);
    // 填充进度：唱过的和还没唱到的词不会变，实际每帧只会改到正在唱的那一两个
    const p = t <= s.t0 ? 0 : t >= s.t1 ? 1 : Math.round((t - s.t0) / s.d * 200) / 200;
    if (p !== s.p) { s.p = p; s.el.style.setProperty('--p', p); s.rk?.style.setProperty('--p', p); }
    // 唱到了就抬起来：只切一次 class，抬起的过程交给 CSS 过渡
    const on = t >= s.t0 - LIFT_LEAD;
    if (on !== s.on) { s.on = on; s.el.classList.toggle('on', on); s.rk?.classList.toggle('on', on); }
  }
  // 滚动 ⇄ 大字 的过渡里，飞着的那一份：填色、抬起都跟着真的那一句走
  if (morphFus) {
    if (morphFus.a !== S.active || !morphFus.els[0]?.el.isConnected) morphFus = null;
    else f.segs.forEach((s, k) => {
      const g = morphFus.els[k];
      if (!g) return;
      g.el.style.setProperty('--p', s.p); g.el.classList.toggle('on', s.on);
      if (g.rk) { g.rk.style.setProperty('--p', s.p); g.rk.classList.toggle('on', s.on); }
    });
  }
}
// 省电：暂停播放时，流动背景停下来（anim-rest），歌词每 0.25 秒算一次就够（画面基本不变；拖进度条时照常每帧算）。
// 窗口最小化、被别的窗口完全挡住或切到别的桌面时（document.hidden），所有一直循环的动画都停（anim-hidden）
let restOn = null, idleAt = 0;
function frame(ts) {
  requestAnimationFrame(frame);
  const rest = !clock.playing;
  if (rest !== restOn) { restOn = rest; document.documentElement.classList.toggle('anim-rest', rest); }
  if (rest && !S.dragging && ts - idleAt < 250) return;
  idleAt = ts;
  tick();
}
const syncHidden = () => document.documentElement.classList.toggle('anim-hidden', document.hidden);
document.addEventListener('visibilitychange', syncHidden);
syncHidden();

// 词典释义按设置的语言取：中文（有道）/ 英文（Jisho）/ 两者
// 多义词选义项。优先级：
//   1. 这首歌里手动指定的
//   2. 和这一句中文翻译对得上的（context）
//   3. 单汉字词里，有一个小词条正好就是这个汉字的（落ちる →「落」）。只限单汉字词且完全相等，
//      避免被「勉強＝勉强」这类中日同形异义的义项带偏
//   4. 词典默认（前两个义项）
// 假名写的词（ここ、なく）在词典里常有几个同音的词条（此処 / 個々、鳴く / 泣く）：它们的义项也列进可选项里，
// 各带各的写法和级别。自动只在很有把握时才换过去——本来那个词条的义项一个都对不上翻译，同音词条却有一个
// 两个字以上的小词条整个出现在翻译里。
// 返回 { text 显示用, senses 全部可选的中文义项, zh 选中的中文义项, how: 'manual' | 'context' | 'kanji' | '',
//        hom 选中的义项属于哪个同音词条（是本来那条就为 null）, of: Map 义项 → 同音词条 }
const STOPCH = new Set([...'的了是在我你他她它们和与就也都不有这那个着过吧吗呢啊把被让给很还又而及或但其之所以为于']);
const HAN = /[\u4e00-\u9fff]/;
const hanzi = (str) => [...str].filter((c) => HAN.test(c) && !STOPCH.has(c));
// 义项「掉，落；脱落；剥落」→ 小词条 ['掉', '落', '脱落', '剥落']
const glosses = (sense) => sense.replace(/（[^）]*）|\([^)]*\)/g, '').split(/[，；、,;\s]+/).filter(Boolean);
// 一个义项和翻译的贴合度：取各小词条里「有多大比例的字出现在翻译中」的最大值；整词出现在翻译里最高
function senseScore(sense, zhLine, ctx) {
  let max = 0, sum = 0;
  for (const g of glosses(sense)) {
    const chars = hanzi(g);
    if (!chars.length) continue;
    let r = chars.filter((c) => ctx.has(c)).length / chars.length;
    if (chars.length >= 2 && zhLine.includes(g)) r = 2;
    max = Math.max(max, r);
    sum += r;
  }
  return max + sum * 0.01;
}
function chooseMeaning(d, line, key) {
  if (!d) return { text: '', senses: [], zh: '', how: '', hom: null, of: new Map() };
  const own = d.zhs?.length ? d.zhs : d.zh ? [d.zh] : [];
  const of = new Map();
  for (const h of d.homs || []) for (const x of (h.zhs?.length ? h.zhs : h.zh ? [h.zh] : []).slice(0, 2)) if (!own.includes(x) && !of.has(x)) of.set(x, h);
  const senses = [...own, ...of.keys()];
  let zh = d.zh || '', how = '';
  const manual = key && S.senses?.[key];
  if (manual && senses.includes(manual)) { zh = manual; how = 'manual'; }
  else if (senses.length > 1 && prefs.autoSense !== false) {
    if (line?.zh) {
      const ctx = new Set(hanzi(line.zh));
      let best = 0.49; // 至少要有半个小词条对得上
      for (const sense of own) {
        const sc = senseScore(sense, line.zh, ctx);
        if (sc > best) { best = sc; zh = sense; how = 'context'; }
      }
      if (!how) {
        best = 1.99;
        for (const sense of of.keys()) {
          const sc = senseScore(sense, line.zh, ctx);
          if (sc > best) { best = sc; zh = sense; how = 'context'; }
        }
      }
    }
    if (!how) {
      const kanji = [...(d.w || '')].filter((c) => HAN.test(c));
      const self = kanji.length === 1 && own.find((sense) => glosses(sense).includes(kanji[0]));
      if (self) { zh = self; how = 'kanji'; }
    }
  }
  const hom = of.get(zh) || null;
  const en = (hom || d).en?.[0] || '';
  const lang = prefs.meaningLang;
  const text = lang === 'en' ? (en || zh) : lang === 'both' ? [zh, en].filter(Boolean).join(' / ') : (zh || en);
  return { text, senses: lang === 'en' ? [] : senses, zh, how, hom, of };
}

// ---------------- 语法 / 词汇标注 ----------------
const RANK = { N1: 5, N2: 4, N3: 3, N4: 2, N5: 1 };
const levelOK = (lv) => prefs.levels[lv || 'x'] !== false;
// 词汇书里从这首歌记下的词：在歌词里也生成一张单词卡，用的是记的时候填的单词、读音和释义。
// 分词分错了、自动标注标成了别的词的地方（つまづく 被拆成 つま + づく），记一次就纠正过来了：
// 它盖住的那几个词上原来的自动标注不再出现。同一首歌里别的句子出现同样的写法，也一起标上。
function vocabCards(line) {
  const pid = S.track?.pid, out = [];
  if (!pid || !S.vocab?.length) return out;
  for (const v of S.vocab) {
    if (v.song?.pid !== pid || !v.surface || !v.word) continue;
    const same = v.line === line.text;
    for (let at = line.text.indexOf(v.surface); at >= 0; at = line.text.indexOf(v.surface, at + 1)) {
      const end = at + v.surface.length;
      const toks = [];
      line.tokens.forEach((t, ti) => { if (t.i0 + t.s.length > at && t.i0 < end) toks.push(ti); });
      if (!toks.length) continue;
      const first = line.tokens[toks[0]], last = line.tokens[toks[toks.length - 1]];
      // 记的那一句怎么选的都算；别的句子里要正好是完整的几个词，免得一两个假名撞进别的词里
      if (!same && !(first.i0 === at && last.i0 + last.s.length === end)) continue;
      out.push({ type: 'v', title: v.word, rd: v.reading || '', lv: v.level || '', desc: v.meaning || '', start: toks[0], end: toks[toks.length - 1] + 1, mine: true });
      break;
    }
  }
  return out;
}
function annotationsFor(line) {
  if (!line || line.gap) return [];
  const items = [];
  const useAI = line.ai && prefs.annSource !== 'builtin';
  if (prefs.annGrammar) {
    for (const g of (useAI ? line.ai.grammar : line.grammar)) {
      if (levelOK(g.lv)) items.push({ type: 'g', title: g.n, lv: g.lv, desc: g.zh, start: g.start, end: g.end });
    }
  }
  if (prefs.annVocab) {
    const mine = vocabCards(line);
    const taken = (a, b) => mine.some((m) => a < m.end && b > m.start);
    items.push(...mine);
    if (useAI) {
      for (const v of line.ai.vocab) if (levelOK(v.lv) && !taken(v.start, v.end)) items.push({ type: 'v', title: v.b, rd: v.r, lv: v.lv, desc: v.zh, start: v.start, end: v.end });
    } else {
      line.tokens.forEach((tok, ti) => {
        if (!tok.v || taken(ti, ti + 1)) return;
        const d = S.dict[dictKey(tok)];
        if (!d || d.miss) return;
        // 分词器不认识的词，查到的词条读音又和实际唱的对不上：多半是拆错后撞上了别的词（騒 → そう・骚体），不标
        if (tok.u && d.fit === false) return;
        // 既没有级别、也不是常用词、中文词典里也查不到：多半是撞上了不相干的冷僻词条（如 イイ → Iran-Iraq）
        if (!d.lv && !d.common && !d.zh) return;
        // 纯假名写的动词（如可能形「なれる」）在词典里常对到别的词，宁可不标
        if (tok.pos === '动' && !KANJI.test(tok.b) && d.w !== tok.b) return;
        // 可能形 / 使役形（許せる、歌わす）：词典给回的是原形的词条（許す、歌う），标注也用原形
        const title = d.via ? d.w : tok.b;
        const m = chooseMeaning(d, line, `v:${title}`);
        const e = m.hom || d; // 选中的义项属于同音的另一个词条时，级别和写法跟着它走
        if (!levelOK(e.lv)) return;
        items.push({ type: 'v', title, rd: d.r, lv: e.lv, hw: m.hom ? m.hom.w : '', desc: m.text, senses: m.senses, pick: m.zh, how: m.how, senseOf: m.of, mainLv: d.lv, mainW: d.w, start: ti, end: ti + 1 });
      });
    }
  }
  const seen = new Set();
  const uniq = items.filter((a) => { a.key = `${a.type}:${a.title}`; if (seen.has(a.key)) return false; seen.add(a.key); return true; });
  const hidden = S.hiddenAnn || new Set();
  const rank = (a) => (a.mine ? 9 : RANK[a.lv] ?? 2.5); // 自己记的词排最前，不会被「每句最多显示几个」挤掉
  const byPlace = (x, y) => x.a.start - y.a.start || x.k - y.k;
  const all = uniq.map((a, k) => ({ a, k }));
  const shown = all.filter((x) => !hidden.has(x.a.key)).sort((x, y) => rank(y.a) - rank(x.a) || x.k - y.k).slice(0, prefs.annMax);
  // 这首歌里被关掉的标注：平时不出现；修改模式下以虚线框留在原来的位置，方便加回来
  const off = S.mode === 'edit' ? all.filter((x) => hidden.has(x.a.key)).map((x) => ({ a: { ...x.a, off: true }, k: x.k })) : [];
  return [...shown, ...off].sort(byPlace).map((x) => x.a);
}
function chipHTML(a) {
  const multi = !a.off && a.senses?.length > 1; // 多义词：修改模式下悬停可展开全部义项来挑
  return `<span class="chip ${a.type}${a.off ? ' off' : ''}${multi ? ' multi' : ''}" data-key="${esc(a.key)}"><b>${esc(a.title)}</b>${a.rd && a.rd !== a.title ? `<span class="rd">${esc(a.rd)}</span>` : ''}${a.hw && a.hw !== a.title ? `<span class="rd">${esc(a.hw)}</span>` : ''}${a.lv ? `<span class="lv">${a.lv}</span>` : ''}<span class="ds">${esc(a.desc)}</span>${multi ? `<span class="more">+${a.senses.filter((x) => x !== a.pick).length}</span>` : ''}</span>`;
}
// 除了当前句，还有哪些行要列出标注（只在滚动样式下）：
//   修改模式：前后各两句——这句唱过去了还来得及改
//   记词模式：整首歌——挑词的时候每一句的释义都在眼前
const EDIT_NEAR = 2;
function annLines() {
  const out = new Set();
  if (prefs.view !== 'apple' || !prefs.ann || S.active === -2) return out;
  // 实验功能 2：一组紧凑的句子一起显示时，组里上面已经唱过的那几句的标注留着，不收起来
  if (S.active >= 0) for (let k = groupFrom(); k < S.active; k++) out.add(k);
  if (!S.mode) return out;
  if (S.mode === 'dict') {
    S.lines.forEach((l, k) => { if (!l.gap && k !== S.active) out.add(k); });
    return out;
  }
  for (const dir of [-1, 1]) {
    for (let k = Math.max(S.active, -1) + dir, n = 0; k >= 0 && k < S.lines.length && n < EDIT_NEAR; k += dir) {
      if (!S.lines[k].gap) { out.add(k); n++; }
    }
  }
  return out;
}
// 往一行的标注框里放内容。内容没变就不动它：记词模式下每换一句都要过一遍整首歌的标注
function setAnn(box, html) {
  const cls = `ann ${prefs.annStyle}`;
  if (box.className !== cls) box.className = cls;
  if (box.style.width) box.style.width = '';
  if (box._html !== html) { box._html = html; box.innerHTML = html; }
}
// 一行的标注收起来：不是直接消失，原地淡出（同时不再占位置，下面的行可以马上往上合拢）。w = 收起前的宽度
function annLeave(box, w) {
  if (!box.childElementCount) return;
  box.style.width = `${w}px`;
  box.classList.add('leaving');
  const done = () => { if (!box.classList.contains('leaving')) return; box.classList.remove('leaving'); setAnn(box, ''); };
  box.addEventListener('animationend', done, { once: true });
  setTimeout(done, 400);
}
function paintAnnotations() {
  const line = S.lines[S.active];
  const anns = prefs.ann ? annotationsFor(line) : [];
  S.anns = anns;
  S.annsByLine = new Map([[S.active, anns]]);
  S.annByTok = {};
  for (const a of anns) if (!a.off) for (let k = a.start; k < a.end; k++) (S.annByTok[k] ||= []).push(a);
  // 修改 / 记词模式下总是列出标签（即使平时选的是「仅下划线」）：一个要能点，一个要能看
  const html = prefs.annStyle === 'underline' && !S.mode ? '' : anns.map(chipHTML).join('');
  const roots = [$('#f-cur')];
  const els = $('#scroll').children;
  const el = els[S.active];
  if (el) roots.push(el);
  for (const root of roots) {
    $$('.tok', root).forEach((tokEl) => {
      const list = S.annByTok[tokEl.dataset.ti] || [];
      tokEl.classList.toggle('hg', list.some((a) => a.type === 'g'));
      tokEl.classList.toggle('hv', list.some((a) => a.type === 'v'));
    });
  }
  const show = annLines();
  // 要收起的行：先一次量完（宽度、在不在视野里），再动手改，免得改一行量一行
  const still = noMotion.matches || document.hidden || prefs.view !== 'apple';
  const H = innerHeight;
  const leaving = $$('#scroll .line.ann-on').filter((old) => !show.has(+old.dataset.i)).map((old) => {
    const box = $('.ann', old);
    const r = still ? null : box.getBoundingClientRect();
    return { old, box, w: r ? r.width : 0, seen: !!r && r.bottom > 0 && r.top < H };
  });
  if (el) setAnn($('.ann', el), html);
  const fa = $('#f-ann'); fa.className = `f-ann ${prefs.annStyle}`; fa.innerHTML = html;
  for (const k of show) {
    const nel = els[k];
    if (!nel) continue;
    const list = annotationsFor(S.lines[k]);
    S.annsByLine.set(k, list);
    const box = $('.ann', nel);
    if (box.classList.contains('leaving')) { box.classList.remove('leaving'); box._html = null; }
    setAnn(box, prefs.annStyle === 'underline' && !S.mode ? '' : list.map(chipHTML).join(''));
    if (!nel.classList.contains('ann-on')) nel.classList.add('ann-on');
  }
  for (const { old, box, w, seen } of leaving) {
    if (+old.dataset.i !== S.active) { if (seen) annLeave(box, w); else setAnn(box, ''); }
    old.classList.remove('ann-on');
  }
}

// 查词典用的键：带汉字的词连同「实际唱的读音」一起查（辛い|つら），同一个写法有几个词条时才选得对
const dictKey = (tok) => (tok.h ? `${tok.b}|${tok.h}` : tok.b);
// 词典数据（Jisho + 有道）。歌词先显示，词典在后面补，不拖慢歌词：
//   1. 本地缓存里有的一次全取回来（不联网），听过的歌立刻就有标注
//   2. 剩下的联网分批查，每一批都先查离现在唱到的地方最近的词——中途拖动进度，下一批就跟着换地方
async function fetchDict(token) {
  const where = new Map(); // 键 → 它出现在哪几行
  S.song.lines.forEach((l, li) => {
    for (const t of l.tokens) if (t.v) { const k = dictKey(t); if (!where.has(k)) where.set(k, []); where.get(k).push(li); }
  });
  try {
    Object.assign(S.dict, await api.post('/api/dict', { words: [...where.keys()], cachedOnly: true }));
  } catch { /* 离线时没有词汇标注，其余功能不受影响 */ }
  if (token !== S.loadToken) return;
  // 修改 / 记词模式下别的行也列着标注，新查到的词会让它们变高：各行顺着滑到新位置，当前句不跳走
  const repaint = () => (S.mode ? glide(() => { paintAnnotations(); jumpToActive(); }) : paintAnnotations());
  repaint();
  const todo = new Set([...where.keys()].filter((k) => !S.dict[k] || S.dict[k].stale));
  while (todo.size) {
    const cur = Math.max(S.active, 0);
    // 还没唱到的行按远近排，已经唱过的排在最后
    const dist = (k) => Math.min(...where.get(k).map((li) => (li >= cur ? li - cur : 10000 + cur - li)));
    const batch = [...todo].map((k) => [k, dist(k)]).sort((a, b) => a[1] - b[1]).slice(0, 12).map((x) => x[0]);
    let got;
    try { got = await api.post('/api/dict', { words: batch }); } catch { return; }
    if (token !== S.loadToken) return;
    for (const k of batch) todo.delete(k); // 这次没查成的（网络问题）不反复重试，下次打开这首歌再查
    Object.assign(S.dict, got);
    repaint();
  }
}

// 悬停在带标注的词上时显示说明
const tip = $('#tip');
document.addEventListener('mouseover', (e) => {
  const tokEl = e.target.closest?.('.line.active .tok, #f-cur .tok');
  const list = tokEl && prefs.ann && !S.mode ? S.annByTok[tokEl.dataset.ti] : null;
  if (!list) { tip.hidden = true; return; }
  tip.innerHTML = list.map((a) => `<div><b>${esc(a.title)}</b>${a.rd ? `（${esc(a.rd)}）` : ''} ${a.lv || ''}<br>${esc(a.desc)}${a.senses?.length > 1 ? `<div class="muted">其他义项：${esc(a.senses.filter((x) => x !== a.pick).join(' ｜ '))}</div>` : ''}</div>`).join('<hr style="border:0;border-top:1px solid var(--line)">');
  tip.hidden = false;
  const r = tokEl.getBoundingClientRect();
  tip.style.left = `${clamp(r.left, 8, innerWidth - tip.offsetWidth - 8)}px`;
  tip.style.top = `${r.bottom + 8 + tip.offsetHeight > innerHeight ? r.top - tip.offsetHeight - 8 : r.bottom + 8}px`;
});

// ---------------- 点击歌词：跳转 / 敲击对齐 / 辞书选择 / 改读音 ----------------
let popClosedAt = -1e9; // 上一次因为点到外面而关掉读音小窗的时刻
let dismissClick = false; // 刚按下的这一下鼠标把资料库 / 词汇书收起来了
let dismissSeek = false; // 刚按下的这一下把资料库 / 词汇书 / 菜单 / 时间对齐的面板收起来了：它只管收起，不算点了底下的歌词
function seekTo(sec) {
  sec = Math.max(0, sec);
  S.jumped = true; // 自己跳的：哪怕只跳了一点点（点了紧挨着的下一句），也不算「唱过来的」
  setClock(sec);
  S.seekHold = performance.now() + 700;
  control('seek', sec);
}
document.addEventListener('click', (e) => {
  const lineEl = e.target.closest('.line');
  const inFocus = e.target.closest('#f-cur');
  // 记词模式：点在词上是选词；点在这一行的其他地方（空白、翻译）和平时一样，跳到这一句
  if (S.mode === 'dict' && (inFocus || (lineEl && e.target.closest('.tok, .chip')))) return dictClick(e);
  // 修改模式同理：点在词或标注上是修改；点在这一行的其他地方跳到这一句
  if (S.mode === 'edit' && (inFocus || e.target.closest('#f-ann') || (lineEl && e.target.closest('.tok, .chip')))) return editClick(e);
  if (performance.now() - popClosedAt < 400) return; // 这一下是为了关掉读音小窗，不算点歌词
  if (dismissSeek) return; // 这一下是为了收起资料库 / 词汇书 / 菜单这些，不跳到点中的那一句
  const near = e.target.closest('#f-prev, #f-next, .k-line'); // 大字视图里的上一句 / 下一句；KTV 样式里的两行
  // 敲击对齐时，大字样式里中间那句大字也能点（= 正在显示的这一句现在开始唱）；平时点它没有反应
  const i = lineEl ? +lineEl.dataset.i : near && near.dataset.i !== '' ? +near.dataset.i : inFocus && S.tapAlign ? S.active : -1;
  const line = S.lines[i];
  if (!line || line.gap) return;
  if (S.tapAlign) {
    setOffset(now() - line.t);
    toast(`已对齐：这句从现在开始（偏移 ${S.offset.toFixed(1)}s）`);
    return;
  }
  $('#scroll').classList.remove('free');
  seekTo(line.t + S.offset + 0.02);
});

// ---------------- 时间对齐 ----------------
let offsetTimer = 0;
function updateOffsetLabel() {
  const o = S.offset;
  $('#offset-val').textContent = Math.abs(o) < 0.05 ? '0.0s' : `${o > 0 ? '延后' : '提前'} ${Math.abs(o).toFixed(1)}s`;
  $('#offset-badge').textContent = Math.abs(o) < 0.05 ? '' : `${o > 0 ? '+' : '−'}${Math.abs(o).toFixed(1)}s`;
}
function setOffset(v) {
  if (!S.song) return;
  S.offset = Math.round(v * 100) / 100;
  updateOffsetLabel();
  clearTimeout(offsetTimer);
  const key = S.song.key, offset = S.offset;
  offsetTimer = setTimeout(() => api.post('/api/song/offset', { key, offset }).catch(() => {}), 500);
}
$$('#offset-pop [data-off]').forEach((b) => b.addEventListener('click', () => setOffset(S.offset + Number(b.dataset.off))));
$('#offset-reset').addEventListener('click', () => setOffset(0));
$('#offset-tap').addEventListener('change', (e) => { S.tapAlign = e.target.checked; app.classList.toggle('tap-align', S.tapAlign); });
// 时间对齐的面板一关（不管怎么关的），敲击对齐就跟着关掉，免得之后点歌词还在改时间
new MutationObserver(() => {
  if ($('#offset-pop').hidden && S.tapAlign) { S.tapAlign = false; $('#offset-tap').checked = false; app.classList.remove('tap-align'); }
}).observe($('#offset-pop'), { attributes: true, attributeFilter: ['hidden'] });

// ---------------- 辞书模式 ----------------
function setMode(mode) {
  if (prefs.view === 'ktv' && S.mode !== mode) return toast('KTV 样式下不能记词 / 修改，先换回「滚动」或「大字」');
  S.mode = S.mode === mode ? null : mode;
  $('#btn-dict').classList.toggle('on', S.mode === 'dict');
  $('#btn-edit').classList.toggle('on', S.mode === 'edit');
  $('#btn-edit').setAttribute('aria-pressed', S.mode === 'edit');
  $('#dictbar').hidden = S.mode !== 'dict';
  $('#reading-pop').hidden = true;
  tip.hidden = true;
  hideSensePop();
  // 进出模式时各行的高矮全变了（记词模式下整首歌的标注都展开），滚动位置的那个数字已经对不上原来的内容，
  // 不能原样留着（会停在一个不相干的地方）。分两种情况：
  //   - 进入模式、而且刚自己划走过（想记的那句不是正在唱的）：认准眼前的那一句，让它留在屏幕上原来的位置，
  //     周围的行在它上下展开；仍然算「自己划走了」，过一会儿才回到正在唱的那句
  //   - 其余情况（退出模式，或者没划走过）：回到正在唱的那一句。所以退出再马上进来，不会带着上次在模式里划到的位置
  let anchor = null;
  if (S.mode && prefs.view === 'apple' && elScroll.classList.contains('free')) {
    const box = elScroll.getBoundingClientRect(), y = box.top + box.height * 0.4;
    const [lo, hi] = visibleRange(0);
    let best = Infinity;
    for (let k = lo; k <= hi; k++) {
      const el = elScroll.children[k], r = el.getBoundingClientRect();
      if (S.lines[k]?.gap || !r.height) continue;
      const d = y < r.top ? r.top - y : y > r.bottom ? y - r.bottom : 0; // 离屏幕四成高的那条线最近的一句
      if (d < best) { best = d; anchor = { el, top: r.top, i: k }; }
    }
  }
  if (anchor) armReturn();
  else { clearTimeout(freeTimer); elScroll.classList.remove('free'); }
  // 进出模式会改变各行的高矮（修改模式下前后几句的标注展开 / 收起）：
  // 这些变化都放在 glide 里做，各行从原来的位置顺着滑到新位置，而不是跳过去
  glide(() => {
    app.classList.toggle('dict-mode', S.mode === 'dict');
    app.classList.toggle('edit-mode', S.mode === 'edit');
    app.classList.toggle('by-char', S.mode === 'dict' && prefs.dictChar);
    if (S.mode !== 'dict') { S.sel = null; paintSelection(); resumeIfPausedByDict(); }
    updateDictBar();
    paintAnnotations();
    if (anchor) elScroll.scrollTop += anchor.el.getBoundingClientRect().top - anchor.top;
    else jumpToActive();
  }, anchor ? anchor.i : S.active); // 认准了眼前的一句时，周围的行以它为中心错开，而不是以（可能离得很远的）正在唱的那句
}
function resumeIfPausedByDict() {
  if (S.pausedByDict) { S.pausedByDict = false; control('play'); }
}
function dictClick(e) {
  const ch = e.target.closest('.ch');
  const jp = e.target.closest('.jp');
  if (!ch || !jp) return;
  const li = +jp.dataset.li;
  const line = S.lines[li];
  const c = +ch.dataset.c;
  const tok = line.tokens.find((t) => c >= t.i0 && c < t.i0 + t.s.length);
  if (!tok || tok.sp) return;
  const [u0, u1] = prefs.dictChar ? [c, c + ch.textContent.length] : unitRange(line, line.tokens.indexOf(tok));
  const s = S.sel;
  if (!s || s.li !== li) S.sel = { li, a: u0, b: u1 };
  else if (u0 >= s.a && u1 <= s.b) {
    // 点已选中的部分：在两端则收缩，在中间则只保留它
    if (u0 === s.a && u1 === s.b) S.sel = null;
    else if (u0 === s.a) s.a = u1;
    else if (u1 === s.b) s.b = u0;
    else S.sel = { li, a: u0, b: u1 };
  } else { s.a = Math.min(s.a, u0); s.b = Math.max(s.b, u1); }
  // 两端不留空格：空格不是词，自己点不掉，留在选区边上就成了去不掉的一块
  if (S.sel) {
    const t = S.sel;
    while (t.a < t.b && /\s/.test(line.text[t.a])) t.a++;
    while (t.b > t.a && /\s/.test(line.text[t.b - 1])) t.b--;
    if (t.a >= t.b) S.sel = null;
  }
  // 再点一次把选中的词取消掉：如果是选词时自动暂停的，接着放
  if (!S.sel) resumeIfPausedByDict();
  else if (prefs.dictPause && S.player?.state === 'playing') { S.pausedByDict = true; control('pause'); }
  paintSelection();
  updateDictBar(true);
}
// 记词模式下点一下选中的范围：这个词所在的「一个单位」——词干连同它的变形尾巴（走って、走らなかった、勉強した）
function unitRange(line, ti) {
  let a = ti, b = ti;
  while (a > 0 && line.tokens[a].j) a--;
  while (line.tokens[b + 1]?.j) b++;
  return [line.tokens[a].i0, line.tokens[b].i0 + line.tokens[b].s.length];
}
// 鼠标移到一个词上：整个单位一起亮，看得出点下去会选中哪一段
let unitHover = [];
document.addEventListener('mouseover', (e) => {
  const tokEl = S.mode === 'dict' && !prefs.dictChar ? e.target.closest?.('.jp .tok') : null;
  if (tokEl && unitHover.includes(tokEl)) return;
  for (const el of unitHover) el.classList.remove('uh');
  unitHover = [];
  if (!tokEl) return;
  let head = tokEl;
  while (head.classList.contains('j') && head.previousElementSibling) head = head.previousElementSibling;
  for (let el = head; el && (el === head || el.classList.contains('j')); el = el.nextElementSibling) { unitHover.push(el); el.classList.add('uh'); }
});
function paintSelection() {
  $$('.ch.sel').forEach((el) => el.classList.remove('sel'));
  const s = S.sel;
  if (!s) return;
  $$(`.jp[data-li="${s.li}"] .ch`).forEach((el) => { const c = +el.dataset.c; if (c >= s.a && c < s.b) el.classList.add('sel'); });
}
// 一个词在歌词里的读音（汉字用标注的假名，其余转成平假名）
function tokReading(tok) {
  return tok.segs.map((seg) => (seg.r !== undefined && KANJI.test(seg.t) ? seg.r : toHira(seg.t))).join('');
}
// 一个词还原成原形以后怎么读：歌词里的读音去掉变形的那截假名，换上原形的那截
//   許せ（ゆるせ）→ 許せる（ゆるせる）、走っ（はしっ）→ 走る（はしる）、良かっ → 良い
// 推不出来（变的不是假名）就返回空，读音留给词典或用户自己填。
function baseReading(tok) {
  if (!tok.b || tok.b === tok.s) return tokReading(tok);
  if (tok.b === '来る') return 'くる'; // 来（き / こ）→ 来る：变的是汉字自己的读音
  let p = 0;
  while (p < tok.s.length && tok.s[p] === tok.b[p]) p++;
  const cut = toHira(tok.s.slice(p)), add = toHira(tok.b.slice(p)), r = tokReading(tok);
  if (KANJI.test(cut + add) || !r.endsWith(cut)) return '';
  return r.slice(0, r.length - cut.length) + add;
}
// 歌词里隔开短句的空格不记进词里（要空格自己加）；英文单词之间的空格留着
function squash(text) {
  return text.replace(/\s+/g, (m, i, all) => (/[A-Za-z0-9'’.,!?]$/.test(all.slice(0, i)) && /^[A-Za-z0-9]/.test(all.slice(i + m.length)) ? ' ' : ''));
}
function selectionInfo() {
  const s = S.sel;
  const line = S.lines[s.li];
  let reading = '';
  const toks = [];
  for (const tok of line.tokens) {
    if (tok.i0 >= s.b || tok.i0 + tok.s.length <= s.a) continue;
    toks.push(tok);
    let ci = tok.i0;
    for (const seg of tok.segs) {
      const s0 = ci, s1 = ci + seg.t.length;
      ci = s1;
      if (s0 >= s.b || s1 <= s.a) continue;
      if (seg.r !== undefined && KANJI.test(seg.t)) reading += seg.r;
      else reading += toHira(seg.t.slice(Math.max(s.a, s0) - s0, Math.min(s.b, s1) - s0));
    }
  }
  const raw = line.text.slice(s.a, s.b);
  const form = dictForm(toks, s, raw);
  // 原形的读音：前面照原样的词 + 还原的那个词的原形读音
  let baseR = reading;
  if (form.base !== raw) {
    const tail = form.stem ? baseReading(form.stem) : '';
    baseR = form.stem && !tail ? '' : toks.slice(0, form.cut).map(tokReading).join('') + tail;
  }
  return { line, text: squash(raw), reading: squash(reading), base: squash(form.base), head: form.head, baseReading: squash(baseR) };
}
// 选中的这一段该记成什么：
//   走って / 走らなかった / 走っている → 走る（词干后面跟着的都是变形的尾巴，见服务端的 tailFlags）
//   走り続けた → 走り続ける（最后一个不是尾巴的词还原成原形，前面的照原样）
//   勉強した → 勉強（する 前面是名词：词典里收的是名词）
// 返回 { base: 原形, head: 原形完全来自这一个词时是它（查词典时带上它的读音）,
//         cut: 前面照原样的词有几个, stem: 还原成原形的那个词（没有就是空） }；没选在词的边界上就不还原。
function dictForm(toks, s, text) {
  const none = { base: text, head: null, cut: 0, stem: null };
  if (!toks.length || toks[0].i0 !== s.a) return none;
  const lastTok = toks[toks.length - 1];
  if (lastTok.i0 + lastTok.s.length !== s.b) return none;
  let k = toks.length - 1;
  while (k > 0 && toks[k].f) k--;
  const stem = toks[k];
  if (toks.length > 1 && stem.f) return none; // 选中的全是尾巴
  const before = toks.slice(0, k).map((t) => t.s).join('');
  if ((stem.b === 'する' || (stem.b === 'できる' && stem.j)) && k > 0 && toks[k - 1].pos === '名') return { base: before, head: k === 1 ? toks[0] : null, cut: k, stem: null };
  return { base: before + stem.b, head: k === 0 ? stem : null, cut: k, stem };
}
// 可能形 / 使役形还原成原形以后的读音：ゆるせる → ゆるす、うたわす → うたう（推不出来就用词典的）
const E2U = { え: 'う', け: 'く', げ: 'ぐ', せ: 'す', て: 'つ', ね: 'ぬ', べ: 'ぶ', め: 'む', れ: 'る' };
const A2U = { わ: 'う', か: 'く', が: 'ぐ', さ: 'す', た: 'つ', な: 'ぬ', ば: 'ぶ', ま: 'む', ら: 'る' };
function viaReading(r, d) {
  if (!r || d.w.endsWith('来る')) return d.r;
  const m = d.via === 'pot' ? r.match(/^(.*)([えけげせてねべめれ])る$/) : r.match(/^(.*)([わかがさたなばまら])(?:せる|す)$/);
  return m ? m[1] + (d.via === 'pot' ? E2U : A2U)[m[2]] : d.r;
}
const VIA_NAME = { pot: '可能形', caus: '使役形' };
let dictSeq = 0;
let dictHit = null; // 底栏里现在这个词查到的词条（加入词汇书时取它的级别）
function updateDictBar(fresh) {
  const has = !!S.sel;
  $('#db-hint').hidden = has;
  $('#db-form').hidden = !has;
  if (!has) { $('#db-info').innerHTML = ''; return; }
  const info = selectionInfo();
  const w = $('#db-word'), r = $('#db-reading'), m = $('#db-meaning');
  if (fresh) { w.dataset.dirty = r.dataset.dirty = m.dataset.dirty = ''; }
  const canBase = info.base !== info.text;
  const useBase = canBase && S.sel.form !== 'surface';
  let word = useBase ? info.base : info.text;
  // 原形来自一个带汉字的词：连同歌词里实际唱的读音一起查（辛い 是 からい 还是 つらい）
  const key = useBase && info.head?.h && info.head.b === word ? dictKey(info.head) : word;
  if (!w.dataset.dirty) w.value = word;
  if (!r.dataset.dirty) r.value = useBase ? info.baseReading : info.reading; // 记原形就填原形的读音，记歌词里的形式就填歌词里的
  if (!m.dataset.dirty) m.value = '';
  const ai = info.line.ai?.vocab.find((v) => v.b === word || v.text === info.text);
  if (ai && !m.dataset.dirty) m.value = ai.zh;
  if (ai && useBase && !r.dataset.dirty) r.value = ai.r;
  // 原形本身是可能形 / 使役形时（許せる），「原形」说的是再还原一步的那个词（許す）
  const baseD = S.dict[info.head?.h && info.head.b === info.base ? dictKey(info.head) : info.base];
  const baseName = baseD?.via && baseD.from === info.base ? baseD.w : info.base;
  let swap = canBase
    ? `　<a data-form="${useBase ? 'surface' : 'base'}">改用${useBase ? `歌词里的形式「${esc(info.text)}」` : `原形「${esc(baseName)}」`}</a>` : '';
  $('#db-info').innerHTML = `查询中…${swap}`;
  const seq = ++dictSeq;
  dictHit = null;
  lookup(key).then((d) => {
    if (seq !== dictSeq) return;
    // 这个词本身是可能形 / 使役形（許せる、歌わす）：再还原一步，记成 許す、歌う
    let viaNote = '';
    if (d?.via && !d.miss && word === d.from) {
      if (S.sel.form === 'surface') { // 用户要照歌词里的样子记：只告诉他这是谁的什么形，不替他填
        const zh = (d.zhs?.length ? d.zhs : [d.zh || d.en?.[0] || '']).join(' ｜ ');
        $('#db-info').innerHTML = `「${esc(word)}」是「${esc(d.w)}」的${VIA_NAME[d.via]}：${esc(zh)}　<a data-form="base">改用原形「${esc(d.w)}」</a>`;
        return;
      }
      viaNote = `　<span class="muted">歌词里是它的${VIA_NAME[d.via]}「${esc(d.from)}」</span>`;
      if (!canBase) swap = `　<a data-form="surface">改用歌词里的形式「${esc(info.text)}」</a>`;
      word = d.w;
      if (!w.dataset.dirty) w.value = word;
      if (!r.dataset.dirty) r.value = viaReading(useBase ? info.baseReading : info.reading, d);
    }
    if (d && !d.miss) dictHit = { word, d };
    if (!d || d.miss) {
      $('#db-info').innerHTML = `词典里没有查到「${esc(word)}」，可以自己填写释义。${swap}`;
      return;
    }
    if (!r.dataset.dirty && !r.value && d.r) r.value = d.r; // 自己推不出读音时才用词典的
    const picked = chooseMeaning(d, info.line, `v:${word}`);
    if (!m.dataset.dirty && !m.value) m.value = picked.text;
    // 有好几个义项：每个都能点，点哪个「释义」就填哪个
    const lang = prefs.meaningLang;
    const zhs = (d.zhs?.length ? d.zhs : [d.zh]).filter(Boolean), ens = d.en || [];
    const pickable = (list, val) => (list.length > 1
      ? list.map((x) => `<button class="db-sense" data-val="${esc(val(x))}" title="用这个意思">${esc(x)}</button>`).join('')
      : esc(list.join('')));
    const zhHTML = pickable(zhs, (x) => (lang === 'both' ? [x, ens[0]].filter(Boolean).join(' / ') : x));
    const showEn = lang !== 'zh' || !zhs.length;
    const enHTML = !showEn ? '' : lang === 'en' ? pickable(ens, (x) => x) : esc(ens.join('; '));
    const detail = [lang === 'en' ? esc(zhs.join(' ｜ ')) : zhHTML, enHTML].filter(Boolean).join('　');
    $('#db-info').innerHTML = `${d.lv ? `<span class="lv">${d.lv}</span>` : ''}${esc(d.w)}【${esc(d.r)}】 ${detail}${viaNote}${swap}`;
    markSense();
  });
}
// 「释义」里现在填的是哪个义项，就把哪个标亮
function markSense() {
  const v = $('#db-meaning').value;
  for (const b of $$('#db-info .db-sense')) b.classList.toggle('on', b.dataset.val === v);
}
async function lookup(word) {
  if (S.dict[word]) return S.dict[word];
  try { Object.assign(S.dict, await api.post('/api/dict', { words: [word] })); } catch { return null; }
  return S.dict[word] || { miss: 1 };
}
for (const id of ['db-word', 'db-reading', 'db-meaning']) $(`#${id}`).addEventListener('input', (e) => { e.target.dataset.dirty = '1'; });
$('#db-meaning').addEventListener('input', markSense);
$('#db-info').addEventListener('click', (e) => {
  const sense = e.target.closest('.db-sense');
  if (sense) { const m = $('#db-meaning'); m.value = sense.dataset.val; m.dataset.dirty = '1'; return markSense(); }
  const a = e.target.closest('a[data-form]');
  if (!a || !S.sel) return;
  S.sel.form = a.dataset.form;
  updateDictBar(true);
});
$('#db-cancel').addEventListener('click', () => { S.sel = null; paintSelection(); updateDictBar(); resumeIfPausedByDict(); });
$('#db-done').addEventListener('click', addVocab);
$('#db-form').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !composing(e)) addVocab(); });
async function addVocab() {
  if (!S.sel) return;
  const info = selectionInfo();
  const word = $('#db-word').value.trim();
  if (!word) return;
  const entry = {
    word, reading: $('#db-reading').value.trim(), meaning: $('#db-meaning').value.trim(),
    surface: info.text, level: (dictHit?.word === word ? dictHit.d.lv : S.dict[word]?.lv) || '',
    line: info.line.text, zh: info.line.zh || '', lineTime: info.line.t,
    song: { pid: S.track.pid, name: S.track.name, artist: S.track.artist },
  };
  try { await api.post('/api/vocab', entry); } catch (e) { return toast(`保存失败：${e.message}`); }
  toast(`已加入词汇书：${word}`);
  S.sel = null; paintSelection(); updateDictBar();
  resumeIfPausedByDict();
  loadVocab(); // 词汇书和歌词里的单词卡都要更新
}
$('#db-char').addEventListener('change', (e) => { prefs.dictChar = e.target.checked; savePrefs(); app.classList.toggle('by-char', S.mode === 'dict' && prefs.dictChar); });
$('#db-pause').addEventListener('change', (e) => { prefs.dictPause = e.target.checked; savePrefs(); });

// ---------------- 修改读音 ----------------
let editing = null;
// 修改模式下，鼠标停在多义词的标注上：其他义项以同款小卡叠在它下面，
// 点其中一张就换上它（这首歌里固定用它），原来那张弹出后排到最下面。
const sensePop = $('#sense-pop');
const sense = { ann: null, box: null, li: null, order: [], timer: 0, busy: false, mute: null };
// 一张标注属于哪一行：滚动样式里看它在哪一行（修改模式下前后几句也有标注），大字样式里就是当前句
const annsAt = (li) => (li === null ? S.anns : S.annsByLine?.get(li)) || [];
function hideSensePop() { clearTimeout(sense.timer); sensePop.hidden = true; sense.ann = null; }
// 每张义项卡带的是它自己那个词条的写法和级别（ここ：此処 N5 / 個々 N1），不是现在选中的那条的
const altCardHTML = (a, text, i, animate) => {
  const h = a.senseOf?.get(text);
  const lv = h ? h.lv : a.mainLv ?? a.lv;
  const hw = h ? h.w : (a.senseOf?.size && a.mainW !== a.title ? a.mainW : '');
  return `<span class="chip v alt${animate ? ' in' : ''}" data-i="${i}" style="--i:${i}"><b>${esc(a.title)}</b>${a.rd && a.rd !== a.title ? `<span class="rd">${esc(a.rd)}</span>` : ''}${hw ? `<span class="rd">${esc(hw)}</span>` : ''}${lv ? `<span class="lv">${lv}</span>` : ''}<span class="ds">${esc(text)}</span></span>`;
};
const currentSenseChip = () => sense.box?.querySelector(`.chip.multi[data-key="${CSS.escape(sense.ann.key)}"]`);
function renderSensePop(animate) {
  const a = sense.ann;
  sensePop.className = `sense-stack ${prefs.annStyle}${sense.box?.id === 'f-ann' ? ' big' : ''}`;
  sensePop.innerHTML = sense.order.map((text, i) => altCardHTML(a, text, i, animate)).join('');
  const chip = currentSenseChip();
  if (!chip) return hideSensePop();
  sensePop.hidden = false;
  const r = chip.getBoundingClientRect();
  sensePop.style.left = `${clamp(r.left, 8, Math.max(8, innerWidth - sensePop.offsetWidth - 8))}px`;
  const below = r.bottom + 6 + sensePop.offsetHeight <= innerHeight - 8;
  sensePop.style.top = `${below ? r.bottom + 6 : Math.max(8, r.top - sensePop.offsetHeight - 6)}px`;
}
function openSensePop(chip) {
  const lineEl = chip.closest('.line');
  const li = lineEl ? +lineEl.dataset.i : null;
  const a = annsAt(li).find((x) => x.key === chip.dataset.key && !x.off);
  if (!a || !(a.senses?.length > 1)) return;
  sense.ann = a;
  sense.li = li;
  sense.box = chip.closest('.ann, #f-ann');
  sense.order = a.senses.filter((x) => x !== a.pick);
  renderSensePop(true);
}
document.addEventListener('mouseover', (e) => {
  if (sense.busy) return;
  const chip = S.mode === 'edit' ? e.target.closest?.('.chip.multi') : null;
  // 刚点回来的那张标注：鼠标还停在上面，不马上弹出义项；移开以后再放上来才弹
  if (sense.mute) {
    if (chip && chip.dataset.key === sense.mute.key && chip.closest('.ann, #f-ann') === sense.mute.box) return;
    sense.mute = null;
  }
  if (chip || e.target.closest?.('#sense-pop')) {
    clearTimeout(sense.timer);
    if (chip && (sensePop.hidden || sense.ann?.key !== chip.dataset.key || sense.box !== chip.closest('.ann, #f-ann'))) openSensePop(chip);
  }
});
// 收起要跟手：鼠标一离开「标注、义项卡、两者之间那道缝」就收，不等
document.addEventListener('mousemove', (e) => {
  if (sensePop.hidden || sense.busy || !sense.ann) return;
  const hit = (r, pad = 3) => e.clientX >= r.left - pad && e.clientX <= r.right + pad && e.clientY >= r.top - pad && e.clientY <= r.bottom + pad;
  const p = sensePop.getBoundingClientRect(), c = currentSenseChip()?.getBoundingClientRect();
  if (hit(p) || (c && hit(c))) return;
  if (c && hit({ left: Math.min(c.left, p.left), right: Math.max(c.right, p.right), top: Math.min(c.bottom, p.bottom), bottom: Math.max(c.top, p.top) })) return;
  hideSensePop();
});
document.documentElement.addEventListener('mouseleave', hideSensePop);
// 换义项的动画用的替身：歌词区有裁切和层级限制，所以在最上层放一张一模一样的卡来飞
function ghostChip(el, rect, hostClass) {
  const host = document.createElement('div');
  host.className = `edit-mode ${hostClass}`; // 沿用原容器的类名，卡片样式才一致
  host.style.cssText = `position:fixed;left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px;margin:0;padding:0;min-height:0;max-width:none;display:flex;flex-flow:row nowrap;align-items:flex-start;justify-content:flex-start;gap:0;pointer-events:none;z-index:40;`;
  const g = el.cloneNode(true);
  g.classList.add('ghost');
  g.style.cssText = `width:${rect.width}px;height:${rect.height}px;`;
  host.append(g);
  document.body.append(host);
  return { host, g };
}
const CARD_BG = 'rgba(34, 30, 44, .88)';
const SWAP_MS = 300, SWAP_DELAY = 60;
sensePop.addEventListener('click', (e) => {
  const card = e.target.closest('.chip.alt');
  const a = sense.ann;
  if (!card || !a || !S.song || sense.busy) return;
  const i = +card.dataset.i;
  const next = sense.order[i], prev = a.pick;
  const cur = currentSenseChip();
  if (!cur) return;
  api.post('/api/song/sense', { key: S.song.key, ann: a.key, sense: next }).catch((err) => {
    toast(`保存失败：${err.message}`);
    if (S.senses[a.key] === next) { delete S.senses[a.key]; paintAnnotations(); hideSensePop(); }
  });

  // 先记下换之前各张卡的位置，再直接换成最终状态，动画只负责把「之前」过渡到「之后」
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const box = sense.box;
  const rc = cur.getBoundingClientRect(), ra = card.getBoundingClientRect();
  const curBg = getComputedStyle(cur).backgroundColor;
  const out = still ? null : ghostChip(cur, rc, box.className);   // 被换下的那张
  const before = new Map();
  for (const el of box.querySelectorAll('.chip[data-key]')) before.set(`k:${el.dataset.key}`, el.getBoundingClientRect());
  for (const el of sensePop.querySelectorAll('.chip.alt')) before.set(`s:${sense.order[+el.dataset.i]}`, el.getBoundingClientRect());

  S.senses[a.key] = next;
  editDone();
  sense.order = [...sense.order.filter((_, k) => k !== i), prev];  // 被换下的义项排到最下面
  paintAnnotations();
  sense.ann = annsAt(sense.li).find((x) => x.key === a.key && !x.off) || null;
  if (!sense.ann) { out?.host.remove(); return hideSensePop(); }
  renderSensePop(false);
  const fresh = currentSenseChip();
  if (still || !fresh) { out?.host.remove(); return; }

  sense.busy = true;
  setTimeout(() => { sense.busy = false; }, SWAP_DELAY + SWAP_MS + 30);
  const ease = 'cubic-bezier(.3, .75, .2, 1)';
  const slide = (el, from) => {
    const to = el.getBoundingClientRect();
    const dx = from.left - to.left, dy = from.top - to.top;
    if (Math.abs(dx) > .5 || Math.abs(dy) > .5) el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], { duration: SWAP_MS, easing: ease });
  };

  // 1. 退弹：旧义项从卡位向右上弹出，转着落下并淡出（横向匀速 + 纵向先升后落 = 抛物线）
  const spin = clamp(2600 / rc.width, 7, 24);
  out.host.animate([{ transform: 'translateX(0)' }, { transform: 'translateX(76px)' }], { duration: 600, easing: 'cubic-bezier(.25, .6, .6, 1)', fill: 'forwards' });
  out.g.animate([
    { transform: 'translateY(0) rotate(0deg)', opacity: 1, backgroundColor: curBg, easing: 'cubic-bezier(.15, .7, .4, 1)' },
    { offset: .36, transform: `translateY(-30px) rotate(${spin * .4}deg)`, opacity: 1, backgroundColor: CARD_BG, easing: 'cubic-bezier(.55, 0, .9, .55)' },
    { transform: `translateY(72px) rotate(${spin}deg)`, opacity: 0, backgroundColor: CARD_BG },
  ], { duration: 600, fill: 'forwards' }).onfinish = () => out.host.remove();

  // 2. 上膛：被点的那张飞进卡位，一路把宽度和「+N」平滑过渡到位，落定后换回真正的标注
  const rn = fresh.getBoundingClientRect();
  const inn = ghostChip(fresh, rn, box.className);
  const opt = { duration: SWAP_MS, delay: SWAP_DELAY, fill: 'both' };
  fresh.animate([{ opacity: 0 }, { opacity: 0 }], { duration: SWAP_DELAY + SWAP_MS });
  inn.host.animate([{ transform: `translate(${ra.left - rn.left}px, ${ra.top - rn.top}px)` }, { transform: 'none' }], { ...opt, easing: 'cubic-bezier(.3, 1.3, .5, 1)' })
    .onfinish = () => inn.host.remove();
  inn.g.animate([
    { width: `${ra.width}px`, height: `${ra.height}px`, backgroundColor: CARD_BG },
    { width: `${rn.width}px`, height: `${rn.height}px`, backgroundColor: getComputedStyle(fresh).backgroundColor },
  ], { ...opt, easing: ease });
  inn.g.querySelector('.more')?.animate([{ opacity: 0 }, { opacity: 0, offset: .4 }, { opacity: 1 }], opt);

  // 3. 补位：同一行的其他标注、列表里剩下的小卡滑到新位置
  for (const el of box.querySelectorAll('.chip[data-key]')) {
    const from = el !== fresh && before.get(`k:${el.dataset.key}`);
    if (from) slide(el, from);
  }
  const cards = [...sensePop.querySelectorAll('.chip.alt')];
  for (const el of cards.slice(0, -1)) {
    const from = before.get(`s:${sense.order[+el.dataset.i]}`);
    if (from) slide(el, from);
  }
  // 4. 回仓：旧义项在最下面由左到右浮现
  const back = cards[cards.length - 1];
  back.classList.add('back');
  back.addEventListener('animationend', () => back.classList.remove('back'), { once: true });
});

// 修改模式下点标注：在这首歌里隐藏 / 恢复它
async function toggleAnnotation(chip) {
  if (!S.song) return;
  hideSensePop();
  editDone();
  const key = chip.dataset.key;
  const hide = !S.hiddenAnn.has(key);
  try { await api.post('/api/song/annotation', { key: S.song.key, ann: key, hidden: hide }); }
  catch (e) { return toast(`保存失败：${e.message}`); }
  if (hide) S.hiddenAnn.add(key); else S.hiddenAnn.delete(key);
  sense.mute = hide ? null : { key, box: chip.closest('.ann, #f-ann') };
  paintAnnotations();
  const name = chip.querySelector('b')?.textContent || '';
  toast(hide ? `这首歌里不再显示「${name}」（修改模式下可点回来）` : `已恢复「${name}」`);
}
function editClick(e) {
  const chip = e.target.closest('.chip[data-key]');
  if (chip) return toggleAnnotation(chip);
  const segEl = e.target.closest('.seg.k');
  const jp = e.target.closest('.jp');
  if (!segEl || !jp) return;
  const li = +jp.dataset.li, ti = +segEl.closest('.tok').dataset.ti, si = +segEl.dataset.si;
  const line = S.lines[li];
  const seg = line.tokens[ti].segs[si];
  endReading(); // 上一个还开着：先把它的预览还原
  editing = { line, li, ti, si, seg, orig: seg.r || '', live: null };
  $('#rp-seg').textContent = seg.t;
  $('#rp-input').value = seg.r || '';
  const from = { roma: '已按歌词源的罗马音自动纠正', qq: '已按 QQ 音乐的注音自动纠正', user: '你修改过这个读音' }[seg.src];
  // 词典读音可以点：自动纠正纠错了的时候，点一下就改回词典的读音（按下面选的范围保存）
  const dict = seg.auto && seg.auto !== seg.r ? `词典读音：<button class="rp-auto" data-r="${esc(seg.auto)}" title="点一下改用词典读音">${esc(seg.auto)}</button>` : '';
  $('#rp-info').innerHTML = [from ? esc(from) : '', dict].filter(Boolean).join('　') || '词典自动标注';
  $('#rp-reset').hidden = seg.src !== 'user';
  $('input[name=rp-scope][value=here]').checked = true;
  $('#reading-pop').hidden = false;
  stepReading();
  if (!readingLoop) { readingLoop = true; requestAnimationFrame(watchReading); }
  $('#rp-input').focus(); $('#rp-input').select();
}
// 正在改的那个汉字现在在页面上的哪里（滚动样式里在它那一行，大字样式里在当前句）
function readingSegEl() {
  if (!editing) return null;
  const root = prefs.view === 'focus' ? $('#f-cur') : elScroll;
  return root.querySelector(`.jp[data-li="${editing.li}"] .tok[data-ti="${editing.ti}"] .seg[data-si="${editing.si}"]`);
}
// 把字上面的假名临时换成 r（边输入边看效果；没保存就关掉的话会换回去）
function previewReading(r) {
  const segEl = readingSegEl();
  if (!segEl) return;
  let rt = segEl.querySelector('rt');
  if (!rt) {
    if (!r) return;
    const ruby = document.createElement('ruby');
    ruby.append(...segEl.childNodes);
    rt = document.createElement('rt');
    ruby.append(rt);
    segEl.append(ruby);
  }
  if (rt.textContent !== r) rt.textContent = r;
}
// 关掉小窗；没保存的话，字上面的假名变回打开前的样子
function endReading() {
  if (!editing) return;
  previewReading(editing.orig);
  readingSegEl()?.classList.remove('editing');
  editing = null;
  $('#rp-input').blur();
  $('#reading-pop').hidden = true;
  editDone();
}
// 小窗开着的时候每一帧做的事：跟着那个字走；那一句滚出页面了就关掉
function stepReading() {
  if (!editing) return false;
  const pop = $('#reading-pop');
  if (pop.hidden) { endReading(); return false; } // 被别处关掉了（Esc、点到外面）
  const segEl = readingSegEl();
  const view = $(prefs.view === 'focus' ? '#focus' : '#lyrics').getBoundingClientRect();
  const lr = segEl?.closest('.line, #f-cur')?.getBoundingClientRect();
  if (!lr || !lr.height || lr.bottom <= Math.max(0, view.top) || lr.top >= Math.min(innerHeight, view.bottom)) { endReading(); return false; }
  segEl.classList.add('editing');
  previewReading(editing.live || editing.orig); // 歌词重画过的话把预览补回去
  const r = segEl.getBoundingClientRect();
  const tx = clamp(r.left - 20, 8, innerWidth - pop.offsetWidth - 8);
  const ty = r.bottom + 10 + pop.offsetHeight > innerHeight ? Math.max(8, r.top - pop.offsetHeight - 10) : r.bottom + 10;
  // 不死死贴着那个字（滚动和换行的弹簧动画会带着它一抖一抖），而是稍微缓一点地跟过去；停稳以后落在整像素上
  const t = performance.now();
  let p = editing.pos;
  if (!p || noMotion.matches) p = editing.pos = { x: tx, y: ty, t };
  else {
    const k = 1 - Math.exp(-(t - p.t) / 80);
    p.x += (tx - p.x) * k; p.y += (ty - p.y) * k; p.t = t;
    if (Math.abs(tx - p.x) < 0.4 && Math.abs(ty - p.y) < 0.4) { p.x = tx; p.y = ty; }
  }
  const still = p.x === tx && p.y === ty;
  const tr = still ? `${Math.round(p.x)}px ${Math.round(p.y)}px` : `${p.x.toFixed(2)}px ${p.y.toFixed(2)}px`;
  if (pop.style.translate !== tr) pop.style.translate = tr;
  return true;
}
let readingLoop = false;
function watchReading() {
  if (!stepReading()) { readingLoop = false; return; }
  requestAnimationFrame(watchReading);
}
async function saveReading(reading) {
  if (!editing) return;
  const { line, ti, si, seg } = editing;
  const scope = $('input[name=rp-scope]:checked').value;
  try {
    await api.post('/api/song/reading', { key: S.song.key, scope, lineText: line.text, ti, si, seg: seg.t, reading });
  } catch (e) { return toast(`保存失败：${e.message}`); }
  $('#rp-input').blur();
  $('#reading-pop').hidden = true;
  editing = null;
  editDone();
  await reloadSong();
  toast(reading === null ? '已恢复自动读音' : '读音已保存');
}
$('#rp-save').addEventListener('click', () => {
  const v = toHira($('#rp-input').value.trim());
  if (!v) return endReading(); // 什么都没填就确认：当作没改，回到打开前的读音
  saveReading(v);
});
$('#rp-reset').addEventListener('click', () => saveReading(null));
$('#rp-info').addEventListener('click', (e) => { const b = e.target.closest('.rp-auto'); if (b) saveReading(b.dataset.r); });
$('#rp-cancel').addEventListener('click', endReading);
// 边输入，字上面的假名边跟着变
$('#rp-input').addEventListener('input', () => {
  if (!editing) return;
  editing.live = toHira($('#rp-input').value.trim());
  previewReading(editing.live || editing.orig);
});
$('#rp-input').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !composing(e)) $('#rp-save').click(); });

// ---------------- 资料库 ----------------
// all = 整个资料库；tracks = 现在这份列表的来源（整个资料库，或某个播放列表）
// view = 列表里现在放的是什么：'tracks' 歌曲 / 'albums' 专辑；album = 点进去的那张专辑
const lib = { all: null, tracks: null, byPid: null, loading: false, shown: 0, filtered: [], view: 'tracks', album: null, back: null, marks: {}, top: 0 };
// 「仅日文」的判断。元数据里没有语言字段，只能靠线索推断：
//   1. 流派是日本的（Anime、J-Pop、歌謡曲…）
//   2. 歌名 / 歌手名里有假名
//   3. 专辑名里有假名——合辑除外（日区的「ベストセラー」之类合辑里什么歌都有）
//   4. 同一位歌手只要有一首符合上面任意一条，他的其他歌也算（歌名被译成英文 / 罗马字的那些）
// 流派明确是其他语种的（Mandopop、K-Pop…）一律不算，免得被第 4 条带进来。
//   5. 歌手在内置的日本歌手名单里（ja-artists.js）——元数据全是英文、流派又是 Rock 之类的歌手靠这一条
//   6. 用户手动标为日文的歌手（lib.marks，存在服务端）——上面的规则漏掉的靠这一条补
//      只能补，不能反过来：自动认出来的日文歌不提供「标为不是日文」
const JA_GENRE = /^(anime|j-|kayokyoku|enka|japan)|vocaloid/i;
const NOT_JA_GENRE = /mandopop|cantopop|c-pop|k-pop|chinese|korean|taiwan/i;
const KANA = /[぀-ヿ]/;
// 名单比对：忽略大小写、空格和标点；合作曲（A & B、A feat. B、A, B…）里有一位在名单上就算
const normName = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
const JA_LISTED = new Set(JA_ARTISTS.map(normName));
const ARTIST_SPLIT = /\s*(?:,|&|\/|×|・|、|\bfeat\.?|\bft\.?|\bwith\b|\bvs\.?)\s*/i;
const listedCache = new Map();
function listedArtist(artist) {
  let hit = listedCache.get(artist);
  if (hit === undefined) {
    hit = JA_LISTED.has(normName(artist)) || artist.split(ARTIST_SPLIT).some((part) => part && JA_LISTED.has(normName(part)));
    listedCache.set(artist, hit);
  }
  return hit;
}
const artistKey = (t) => t.artist.trim().toLowerCase();
function markJapanese(tracks) {
  const jaArtists = new Set();
  for (const t of tracks) {
    const g = t.genre || '';
    t.ja = !NOT_JA_GENRE.test(g) && (JA_GENRE.test(g) || KANA.test(t.name + t.artist) || (!t.comp && KANA.test(t.album)) || listedArtist(t.artist));
    if (t.ja && artistKey(t)) jaArtists.add(artistKey(t));
  }
  for (const t of tracks) {
    if (!t.ja && !NOT_JA_GENRE.test(t.genre || '') && jaArtists.has(artistKey(t))) t.ja = true;
    t.manual = !!lib.marks[artistKey(t)]?.ja;
    if (t.manual) t.ja = true;
  }
  return tracks;
}
// 重新判断一遍（刚读完资料库、或手动标记变了之后）。
// 播放列表里的歌以整个资料库的判断为准：只看列表自己那几首的话线索不够
// （比如整张专辑的歌名都是英文译名，要靠同一位歌手的其他歌才认得出来）
function applyJa() {
  if (lib.all) { markJapanese(lib.all); lib.byPid = new Map(lib.all.map((t) => [t.pid, t])); }
  if (lib.tracks && lib.tracks !== lib.all) {
    markJapanese(lib.tracks);
    for (const t of lib.tracks) { const known = lib.byPid?.get(t.pid); if (known) { t.ja = known.ja; t.manual = known.manual; } }
  }
}

async function openLibrary() {
  if (!PLAYER.caps.library) return toast(`${PLAYER.name}模式下没有资料库，请在${PLAYER.name}里选歌`);
  $('#library').hidden = false;
  $('#lib-search').focus();
  // 再次打开：回到上次划到的位置（抽屉收起时浏览器不会替我们记着滚动位置，所以自己记在 lib.top 里）
  if (lib.tracks || lib.loading) { const top = lib.top; renderLibrary(true); $('#lib-list').scrollTop = top; return; }
  lib.loading = true;
  $('#lib-list').innerHTML = '<div class="empty">正在读取 Apple Music 资料库…</div>';
  try {
    const [tracks, playlists, marks] = await Promise.all([api.get('/api/library'), api.get('/api/playlists').catch(() => []), api.get('/api/marks').catch(() => ({}))]);
    lib.marks = marks;
    lib.all = lib.tracks = tracks;
    applyJa();
    $('#lib-playlist').innerHTML = '<option value="">全部歌曲</option><option value="@albums">全部专辑</option>'
      + (playlists.length ? `<optgroup label="播放列表">${playlists.map((p) => `<option value="${esc(p.pid)}">${esc(p.name)}</option>`).join('')}</optgroup>` : '');
    renderLibrary();
  } catch (e) {
    $('#lib-list').innerHTML = `<div class="empty">读取资料库失败：${esc(e.message)}<br><br>请确认已允许本程序控制「音乐」（系统设置 → 隐私与安全性 → 自动化）。</div>`;
  }
  lib.loading = false;
}

// ---- 专辑 ----
// 同一张专辑 = 专辑名相同 + 专辑歌手相同。没填专辑歌手时：合辑算一张；否则按第一位歌手算
// （「A feat. B」的那首不会被拆出去，不同歌手的同名专辑——Best 之类——也不会混在一起）
const primaryArtist = (a) => a.split(ARTIST_SPLIT)[0].trim();
const albumKey = (t) => (t.album ? `${t.album}\n${(t.albumArtist || (t.comp ? '' : primaryArtist(t.artist))).toLowerCase()}` : '');
const byTrackNo = (a, b) => (a.disc || 1) - (b.disc || 1) || (a.no || 9999) - (b.no || 9999);
const collate = new Intl.Collator('ja', { sensitivity: 'base', numeric: true }).compare;
function groupAlbums(tracks, q, recent) {
  const map = new Map();
  for (const t of tracks) {
    const key = albumKey(t);
    if (!key) continue; // 没有专辑名的歌只在「全部歌曲」里
    let al = map.get(key);
    if (!al) map.set(key, al = { key, name: t.album, artist: t.albumArtist || (t.comp ? '群星' : primaryArtist(t.artist)), tracks: [], added: 0, year: 0 });
    al.tracks.push(t);
    al.added = Math.max(al.added, t.added || 0);
    al.year = al.year || t.year || 0;
  }
  let list = [...map.values()];
  // 搜索：专辑名、歌手、里面任何一首歌的歌名都算
  if (q) list = list.filter((al) => `${al.name}\n${al.artist}\n${al.tracks.map((t) => `${t.name}\n${t.artist}`).join('\n')}`.toLowerCase().includes(q));
  list.sort(recent ? (a, b) => b.added - a.added : (a, b) => collate(a.artist, b.artist) || a.year - b.year || collate(a.name, b.name));
  for (const al of list) {
    al.tracks.sort(byTrackNo);
    al.cover = al.tracks[0].pid;
    // 没填专辑歌手的：用这张专辑里最短的那个歌手名（不带 feat. 的那个），而不是把「A & B」这种组合名拆开
    if (!al.tracks[0].albumArtist && !al.tracks[0].comp) al.artist = al.tracks.reduce((a, t) => (t.artist && t.artist.length < a.length ? t.artist : a), al.tracks[0].artist || al.artist);
  }
  return list;
}
// 封面要一张一张向 Apple Music 要：滚到眼前的才取，同时最多取 3 张，滚走了还没轮到的就先不取
const covers = { wait: [], busy: 0 };
const coverIO = new IntersectionObserver((entries) => {
  for (const e of entries) {
    const img = e.target;
    img._vis = e.isIntersecting;
    if (img._vis && !img._queued) { img._queued = true; covers.wait.push(img); }
  }
  pumpCovers();
}, { root: $('#lib-list'), rootMargin: '300px 0px' });
function pumpCovers() {
  while (covers.busy < 3 && covers.wait.length) {
    const img = covers.wait.pop(); // 后来的先取：刚滚到眼前的最要紧
    if (!img.isConnected) continue;
    if (!img._vis) { img._queued = false; continue; }
    covers.busy++;
    const done = (ok) => { covers.busy--; coverIO.unobserve(img); if (ok) img.classList.add('ok'); else img.remove(); pumpCovers(); };
    img.onload = () => done(true);
    img.onerror = () => done(false);
    img.src = `/api/artwork?pid=${encodeURIComponent(img.dataset.pid)}&thumb=1`;
  }
}

const jaTitle = (t) => (t.manual ? `手动标为日文歌手。点一下取消` : `把「${t.artist}」标为日文歌手`);
function trackRow(t, inAlbum, prev) {
  const sub = inAlbum ? (t.artist !== lib.album.artist ? t.artist : '') : [t.artist, t.album].filter(Boolean).join(' — ');
  // 多碟的专辑：每张碟开头加一行小标题（曲序是每张碟各自从 1 数的）
  const disc = inAlbum && lib.album.discs && (!prev || (prev.disc || 1) !== (t.disc || 1)) ? `<div class="queue-sec">第 ${t.disc || 1} 张</div>` : '';
  return `${disc}<div class="track lib${inAlbum ? ' num' : ''}${sub ? '' : ' one'}${S.track?.pid === t.pid ? ' cur' : ''}" data-pid="${esc(t.pid)}">`
    + (inAlbum ? `<div class="no">${t.no || ''}</div>` : '')
    + `<div class="n">${esc(t.name)}</div>`
    // 「日」只出现在没被认成日文的歌上（点了标为日文），和手动标过的歌上（点了取消）；自动认出来的日文歌没有这个按钮
    + (t.artist.trim() && (t.manual || !t.ja) ? `<button class="ja-btn${t.manual ? ' manual' : ''}" data-act="ja" title="${esc(jaTitle(t))}" aria-pressed="${t.manual}">日</button>` : '')
    + `<div class="d">${fmt(t.duration)}</div>`
    + (sub ? `<div class="a">${esc(sub)}</div>` : '')
    + '</div>';
}
const albumRow = (al, i) => `<div class="album" data-album="${i}"><div class="cover"><img data-pid="${esc(al.cover)}" alt=""></div><div class="n">${esc(al.name)}</div><div class="a">${esc(al.artist)} · ${al.tracks.length} 首</div><div class="go">›</div></div>`;

// keep = 保持现在滚到的位置（手动标记之后重画时用）
function renderLibrary(keep) {
  if (!lib.tracks) return;
  const box = $('#lib-list');
  const top = keep === true ? box.scrollTop : 0, want = keep === true ? lib.shown : 0;
  const q = $('#lib-search').value.trim().toLowerCase();
  const ja = $('#lib-ja').checked, recent = $('#lib-recent').checked;
  const hit = (t) => !q || `${t.name}\n${t.artist}\n${t.album}`.toLowerCase().includes(q);
  let list, empty = '没有匹配的歌曲';
  if (lib.album) {
    list = lib.tracks.filter((t) => albumKey(t) === lib.album.key && (!ja || t.ja) && hit(t)).sort(byTrackNo);
    const al = lib.album;
    al.discs = new Set(list.map((t) => t.disc || 1)).size > 1;
    $('#lib-album').innerHTML = `<button class="back" data-act="back" aria-label="返回全部专辑" title="返回全部专辑">‹</button><div class="cover"><img class="ok" src="/api/artwork?pid=${encodeURIComponent(al.cover)}&thumb=1" alt="" onerror="this.remove()"></div><div class="tx"><div class="n">${esc(al.name)}</div><div class="a">${esc([al.artist, al.year || '', `${list.length} 首`].filter(Boolean).join(' · '))}</div></div>`;
  } else if (lib.view === 'albums') {
    list = groupAlbums(lib.tracks.filter((t) => !ja || t.ja), q, recent);
    empty = '没有匹配的专辑';
  } else {
    list = lib.tracks.filter((t) => hit(t) && (!ja || t.ja));
    if (recent) list = [...list].sort((a, b) => b.added - a.added);
  }
  $('#lib-album').hidden = !lib.album;
  box.classList.toggle('ja-only', ja);
  setNear(null);
  lib.filtered = list;
  lib.shown = 0;
  coverIO.disconnect();
  covers.wait.length = 0;
  box.innerHTML = list.length ? '' : `<div class="empty">${empty}</div>`;
  do moreLibrary(); while (lib.shown < want && lib.shown < list.length);
  box.scrollTop = top;
}
function moreLibrary() {
  const part = lib.filtered.slice(lib.shown, lib.shown + 150);
  const box = $('#lib-list');
  if (lib.view === 'albums' && !lib.album) {
    box.insertAdjacentHTML('beforeend', part.map((al, i) => albumRow(al, lib.shown + i)).join(''));
    for (const img of $$('.cover img:not([src])', box)) if (!img._seen) { img._seen = true; coverIO.observe(img); }
  } else {
    box.insertAdjacentHTML('beforeend', part.map((t, i) => trackRow(t, !!lib.album, lib.filtered[lib.shown + i - 1])).join(''));
  }
  lib.shown += part.length;
}
// 进出专辑时给列表一个方向感：进去从右边滑入，返回从左边滑入
function navAnim(dir) {
  for (const el of [$('#lib-list'), $('#lib-album')]) {
    el.classList.remove('nav-in', 'nav-out');
    void el.offsetWidth;
    el.classList.add(el.id === 'lib-list' ? dir : 'nav-in');
  }
}
function openAlbum(al) {
  const box = $('#lib-list');
  // 记下专辑列表现在的样子（搜索词、滚到哪），返回时原样回去；进到专辑里搜索框清空，改成搜这张专辑里的歌
  lib.back = { q: $('#lib-search').value, top: box.scrollTop, shown: lib.shown };
  lib.album = { key: al.key, name: al.name, artist: al.artist, year: al.year, cover: al.cover };
  $('#lib-search').value = '';
  $('#lib-search').placeholder = '在这张专辑里搜索';
  renderLibrary();
  navAnim('nav-in');
}
function closeAlbum(anim = true) {
  if (!lib.album) return;
  const back = lib.back || { q: '', top: 0, shown: 0 };
  lib.album = null; lib.back = null;
  $('#lib-search').value = back.q;
  $('#lib-search').placeholder = '搜索歌曲 / 歌手 / 专辑';
  renderLibrary();
  while (lib.shown < back.shown && lib.shown < lib.filtered.length) moreLibrary();
  $('#lib-list').scrollTop = back.top;
  if (anim) navAnim('nav-out');
}
$('#lib-album').addEventListener('click', (e) => { if (e.target.closest('[data-act="back"]')) closeAlbum(); });

// ---- 手动标记：把这位歌手标为日文歌手 ----
// ja: true = 标为日文，null = 去掉标记、恢复自动判断
async function setMark(artist, ja, undo = true) {
  const name = artist.trim();
  const prev = lib.marks[name.toLowerCase()];
  try { lib.marks = await api.post('/api/marks', { artist: name, ja }); } catch (e) { return toast(`保存失败：${e.message}`); }
  applyJa();
  renderLibrary(true);
  renderMarks();
  if (!undo) return;
  const n = lib.all ? lib.all.filter((t) => artistKey(t) === name.toLowerCase()).length : 0;
  const what = ja ? `已把「${name}」标为日文歌手${n > 1 ? `（${n} 首）` : ''}` : `已取消「${name}」的标记`;
  toast(what, { label: '撤销', run: () => setMark(name, prev ? true : null, false).then(() => toast('已撤销')) });
}
// 设置里的名单：看得到标过谁，可以逐个去掉或全部清除
function renderMarks() {
  const list = Object.values(lib.marks).sort((a, b) => b.at - a.at);
  for (const el of $$('.set-lib')) el.hidden = !list.length; // 一个都没标过：设置里不出现这一节
  $('#set-marks-info').textContent = `手动标为日文歌手的有 ${list.length} 位，点 × 取消`;
  $('#set-marks-clear').hidden = !list.length;
  $('#set-marks').innerHTML = list.map((m) => `<span class="mark-chip"><b>${esc(m.name)}</b><button data-artist="${esc(m.name)}" aria-label="取消标记" title="取消标记">×</button></span>`).join('');
}
async function replaceMarks(all) {
  try { lib.marks = await api.post('/api/marks', { all }); } catch (e) { return toast(`保存失败：${e.message}`); }
  applyJa();
  renderLibrary(true);
  renderMarks();
}
$('#set-marks').addEventListener('click', (e) => { const b = e.target.closest('button[data-artist]'); if (b) setMark(b.dataset.artist, null); });
$('#set-marks-clear').addEventListener('click', async () => {
  const prev = lib.marks;
  await replaceMarks({});
  toast('已清除全部手动标记', { label: '撤销', run: () => replaceMarks(prev).then(() => toast('已撤销')) });
});

// 「仅日文」时列表里只剩手动标过的歌还带着「日」，一直亮着太抢眼：
// 平时收起来，鼠标移到这一行右端（图标那一带）才出现
let nearRow = null;
function setNear(row) {
  if (row === nearRow) return;
  nearRow?.classList.remove('near');
  nearRow = row;
  row?.classList.add('near');
}
$('#lib-list').addEventListener('mousemove', (e) => {
  const row = e.target.closest?.('.track');
  const btn = row?.querySelector('.ja-btn');
  setNear(btn && e.clientX >= btn.getBoundingClientRect().left - 28 ? row : null);
});
$('#lib-list').addEventListener('mouseleave', () => setNear(null));
$('#lib-list').addEventListener('scroll', () => setNear(null), { passive: true }); // 滚动时鼠标底下换了一行
$('#lib-list').addEventListener('scroll', (e) => { const el = e.target; if (!$('#library').hidden) lib.top = el.scrollTop; if (el.scrollTop + el.clientHeight > el.scrollHeight - 400 && lib.shown < lib.filtered.length) moreLibrary(); });
$('#lib-list').addEventListener('click', (e) => {
  const al = e.target.closest('.album');
  if (al) return openAlbum(lib.filtered[+al.dataset.album]);
  const row = e.target.closest('.track');
  if (!row) return;
  if (e.target.closest('.ja-btn')) {
    const t = lib.filtered.find((x) => x.pid === row.dataset.pid);
    if (t) setMark(t.artist, t.manual ? null : true);
    return;
  }
  // 现在筛选出来的这份列表就是播放列表：从点的这首开始，播完自动接下一首
  const sel = $('#lib-playlist');
  const q = $('#lib-search').value.trim();
  const label = [lib.album ? `专辑「${lib.album.name}」` : sel.selectedOptions[0]?.textContent || '全部歌曲', $('#lib-ja').checked && '仅日文', !lib.album && $('#lib-recent').checked && '最近添加', q && `搜索「${q}」`].filter(Boolean).join(' · ');
  api.post('/api/queue/play', { items: lib.filtered.map((t) => [t.pid, t.name, t.artist, t.duration]), start: row.dataset.pid, label })
    .then(onQueue, (err) => toast(`Apple Music 没有响应：${err.message}`));
  $$('#lib-list .cur').forEach((el) => el.classList.remove('cur'));
  row.classList.add('cur');
});
$('#lib-search').addEventListener('input', () => renderLibrary());
// 默认只看日文歌；取消勾选后会记住
$('#lib-ja').checked = prefs.libJa !== false;
$('#lib-ja').addEventListener('change', (e) => { prefs.libJa = e.target.checked; savePrefs(); renderLibrary(); });
$('#lib-recent').checked = !!prefs.libRecent;
$('#lib-recent').addEventListener('change', (e) => { prefs.libRecent = e.target.checked; savePrefs(); renderLibrary(); });
$('#lib-playlist').addEventListener('change', async (e) => {
  const v = e.target.value;
  closeAlbum(false);
  lib.view = v === '@albums' ? 'albums' : 'tracks';
  $('#lib-list').innerHTML = '<div class="empty">读取中…</div>';
  try {
    const playlist = v && v !== '@albums' ? v : '';
    const tracks = await api.get(`/api/library?playlist=${encodeURIComponent(playlist)}`);
    if (!playlist) lib.all = tracks;
    lib.tracks = tracks;
    applyJa();
    renderLibrary();
  }
  catch (err) { $('#lib-list').innerHTML = `<div class="empty">${esc(err.message)}</div>`; }
});

// ---------------- 播放列表（内置队列，逻辑在服务端的 queue.js） ----------------
const queue = { sum: null, n: 150, list: [] };
const queueKey = (x) => (x ? [x.active, x.pid, x.at, x.total, x.shuffle, x.repeat, x.label].join('|') : '');
// 服务端每次推送状态都带着队列的概况；有变化时才更新界面
function onQueue(sum) {
  const changed = queueKey(queue.sum) !== queueKey(sum);
  queue.sum = sum;
  if (!changed) return;
  for (const [sel, on] of [['#btn-shuffle', sum.shuffle], ['#queue-shuffle', sum.shuffle], ['#queue-repeat', sum.repeat]]) {
    $(sel).classList.toggle('on', !!on);
    $(sel).setAttribute('aria-pressed', !!on);
  }
  $('#btn-next').title = sum.active && sum.next ? `下一首：${sum.next.name}` : '';
  if (!$('#queue').hidden) loadQueue();
}
async function loadQueue() {
  let v;
  try { v = await api.get(`/api/queue?n=${queue.n}`); } catch { return; }
  queue.list = v.list;
  $('#queue-count').textContent = v.total ? `· ${Math.max(v.at, 0) + 1} / ${v.total}` : '';
  $('#queue-label').textContent = v.label ? `来自：${v.label}` : '';
  const row = (t, cur) => `<div class="track${cur ? ' cur' : ''}" data-pid="${esc(t.pid)}"><div class="n">${esc(t.name)}</div><div class="d">${fmt(t.duration)}</div><div class="a">${esc(t.artist)}</div></div>`;
  if (!v.total) {
    $('#queue-list').innerHTML = '<div class="empty">还没有播放列表。<br>在「资料库」里点一首歌，就会从它开始按当前筛选出的列表播放，播完自动接下一首。</div>';
    return;
  }
  const [cur, ...rest] = v.list;
  const more = Math.max(v.at, 0) + v.list.length < v.total;
  $('#queue-list').innerHTML =
    (v.active ? '' : '<div class="empty" style="padding:14px 10px 4px">你在 Apple Music 里换了别的歌，或列表已经播完，所以没有在接着播。点下面任意一首继续。</div>') +
    `<div class="queue-sec">${v.active ? '正在播放' : '停在'}</div>${cur ? row(cur, v.active) : ''}` +
    (rest.length ? `<div class="queue-sec">接下来${v.shuffle ? '（随机）' : ''}</div>${rest.map((t) => row(t)).join('')}` : `<div class="queue-sec">${v.repeat ? '之后从头再来' : '这是最后一首'}</div>`) +
    (more ? `<div class="empty" style="padding:12px"><button class="btn small" id="queue-more">显示更多（还有 ${v.total - Math.max(v.at, 0) - v.list.length} 首）</button></div>` : '');
}
// 播放列表按钮：点一下打开，再点一下收起；抽屉开着时按钮保持选中的样子（不管是怎么关掉的）
$('#btn-queue').addEventListener('click', () => {
  const open = $('#queue').hidden;
  $('#queue').hidden = !open;
  if (open) { queue.n = 150; $('#vocab').hidden = true; loadQueue(); }
});
new MutationObserver(() => {
  const open = !$('#queue').hidden;
  $('#btn-queue').classList.toggle('on', open);
  $('#btn-queue').setAttribute('aria-pressed', open);
}).observe($('#queue'), { attributes: true, attributeFilter: ['hidden'] });
$('#queue-list').addEventListener('click', (e) => {
  if (e.target.closest('#queue-more')) { queue.n += 300; return loadQueue(); }
  const row = e.target.closest('.track');
  if (row) api.post('/api/queue/jump', { pid: row.dataset.pid }).then(onQueue, (err) => toast(err.message));
});
const toggleShuffle = () => api.post('/api/queue/shuffle', { on: !queue.sum?.shuffle }).then(onQueue, () => {});
$('#btn-shuffle').addEventListener('click', toggleShuffle);
$('#queue-shuffle').addEventListener('click', toggleShuffle);
$('#queue-repeat').addEventListener('click', () => api.post('/api/queue/repeat', { on: !queue.sum?.repeat }).then(onQueue, () => {}));

// ---------------- 词汇书 ----------------
let vocabList = [];
// order：打乱后的顺序（词条 id 的数组）；null = 默认顺序，也就是按添加时间，新的在前
// memory：记忆模式（打乱 + 遮住读音和释义）；revealed：记忆模式下已经点开看过的词
const vocab = { order: null, memory: false, revealed: new Set() };
async function loadVocab() {
  try { vocabList = await api.get('/api/vocab'); } catch { vocabList = []; }
  renderVocab();
  syncVocabCards();
}
// 词汇书变了（加了、删了、改了释义）：歌词里的单词卡跟着变
function syncVocabCards() {
  S.vocab = vocabList;
  if (S.lines.length && S.active > -2) paintAnnotations();
}
api.get('/api/vocab').then((list) => { vocabList = list; syncVocabCards(); }, () => {});
// 当前应该显示哪些词、按什么顺序
function vocabShown() {
  const q = $('#vocab-search').value.trim().toLowerCase();
  const list = vocabList.filter((v) => !q || [v.word, v.reading, v.meaning, v.line, v.song?.name].join('\n').toLowerCase().includes(q));
  if (!vocab.order) return list;
  const rank = new Map(vocab.order.map((id, i) => [id, i]));
  return [...list].sort((x, y) => (rank.get(x.id) ?? -1) - (rank.get(y.id) ?? -1)); // 打乱之后才加进来的词排最前
}
const veiled = (id) => vocab.memory && !vocab.revealed.has(id);
function renderVocab() {
  const list = vocabShown();
  $('#vocab-count').textContent = vocabList.length ? `· ${vocabList.length}` : '';
  $('#vocab-list').innerHTML = list.length ? list.map((v) => {
    const sentence = v.surface && v.line?.includes(v.surface) ? esc(v.line).replace(esc(v.surface), `<mark>${esc(v.surface)}</mark>`) : esc(v.line);
    return `<div class="vcard${veiled(v.id) ? ' veil' : ''}" data-id="${esc(v.id)}">
      <div class="vdel-zone"><button class="vdel" data-act="del" aria-label="删除这个词" title="删除"><span class="x">✕</span><span class="ext"><span>删除</span></span></button></div>
      <div class="w" lang="ja"><ruby>${esc(v.word)}<rt>${esc(v.reading !== v.word ? v.reading : '')}</rt></ruby><small>${esc(v.level || '')}</small></div>
      <div class="vwrap"><div class="vbody">
        <div class="m" contenteditable="plaintext-only" spellcheck="false">${esc(v.meaning)}</div>
        <div class="s" lang="ja">${sentence}</div>${v.zh ? `<div class="z">${esc(v.zh)}</div>` : ''}
      </div><button class="btn small vreveal" data-act="reveal">展示释义</button></div>
      <div class="f"><span>${esc([v.song?.name, v.song?.artist].filter(Boolean).join(' — '))}</span>
        <button class="btn small" data-act="play" title="播放这一句">▶ 听这句</button></div>
    </div>`;
  }).join('') : `<div class="empty">${vocabList.length ? '没有匹配的单词' : '词汇书还是空的。<br>打开「记词」模式，点选歌词里的词就能添加。'}</div>`;
}
// 只换顺序 / 遮挡状态、词条本身没变时：挪动现有的卡片而不是重画，
// 这样卡片能从原位置滑到新位置，释义的模糊也能渐变
function reorderVocab() {
  const box = $('#vocab-list');
  const cards = new Map([...box.children].filter((el) => el.dataset.id).map((el) => [el.dataset.id, el]));
  const list = vocabShown();
  if (cards.size !== list.length || list.some((v) => !cards.has(v.id))) return renderVocab();
  const still = noMotion.matches;
  const before = new Map();
  if (!still) for (const [id, el] of cards) before.set(id, el.getBoundingClientRect().top);
  for (const an of box.getAnimations({ subtree: true })) if (an.id === 'vmove') an.cancel();
  box.append(...list.map((v) => cards.get(v.id)));
  for (const [id, el] of cards) el.classList.toggle('veil', veiled(id));
  if (still) return;
  // 只给换完之后看得见的那几张做动画（一屏最多四张，上下各多带一张，一共不超过 VMOVE_MAX 张）。
  // 词多了以后要是每张都滑，几十张玻璃卡片一起横穿整个列表，又乱又卡；
  // 换走的那些不滑出去（它们的新位置在看不见的地方），直接到位
  const view = box.getBoundingClientRect();
  let n = 0;
  for (const v of list) {
    const el = cards.get(v.id), r = el.getBoundingClientRect();
    if (r.bottom <= view.top - 80) continue;
    if (r.top >= view.bottom + 80 || n >= VMOVE_MAX) break; // 卡片是从上往下排的，再往后都在更下面
    // 原来在很远的地方的：从列表边缘外面一点滑进来，不用真的从几千像素外飞过来
    const from = Math.max(view.top - r.height - 40, Math.min(view.bottom + 40, before.get(v.id)));
    if (Math.abs(from - r.top) < 1) continue;
    el.animate([{ translate: `0 ${(from - r.top).toFixed(1)}px` }, { translate: '0 0' }],
      { id: 'vmove', duration: SPRING.ms, easing: SPRING.easing, delay: n++ * 22, fill: 'backwards' });
  }
}
const VMOVE_MAX = 6;
const shuffledIds = () => {
  const ids = vocabList.map((v) => v.id);
  for (let i = ids.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [ids[i], ids[j]] = [ids[j], ids[i]]; }
  // 只有两三个词时，洗出来碰巧和原来一样就再换一下，免得点了像没反应
  if (ids.length > 1 && ids.every((id, i) => id === (vocab.order || vocabList.map((v) => v.id))[i])) ids.push(ids.shift());
  return ids;
};
function syncVocabButtons() {
  for (const [sel, on] of [['#vocab-memory', vocab.memory], ['#vocab-shuffle', !!vocab.order]]) {
    $(sel).classList.toggle('on', on);
    $(sel).setAttribute('aria-pressed', on);
  }
}
// 记忆模式：打开 = 打乱 + 遮住所有释义；关闭 = 全部显示，回到默认顺序
$('#vocab-memory').addEventListener('click', () => {
  vocab.memory = !vocab.memory;
  vocab.revealed.clear();
  vocab.order = vocab.memory ? shuffledIds() : null;
  syncVocabButtons();
  reorderVocab();
});
// 随机顺序：打开 = 打乱一次；关闭 = 回到默认顺序（不影响记忆模式的遮挡）
$('#vocab-shuffle').addEventListener('click', () => {
  vocab.order = vocab.order ? null : shuffledIds();
  syncVocabButtons();
  reorderVocab();
});
$('#vocab-search').addEventListener('input', renderVocab);
// 鼠标离开卡片：还没确认的「删除」收回成 ×
$('#vocab-list').addEventListener('mouseleave', (e) => {
  if (!e.target.matches?.('.vcard')) return;
  const b = e.target.querySelector('.vdel.armed');
  if (b && !b.disabled) { b.classList.remove('armed'); b.title = '删除'; }
}, true);
$('#vocab-list').addEventListener('focusout', (e) => {
  const m = e.target.closest('.m');
  if (!m) return;
  const id = m.closest('.vcard').dataset.id;
  const v = vocabList.find((x) => x.id === id);
  const meaning = m.textContent.trim();
  if (v && v.meaning !== meaning) { v.meaning = meaning; syncVocabCards(); api.post('/api/vocab/update', { id, meaning }).catch(() => toast('保存失败')); }
});
$('#vocab-list').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const id = btn.closest('.vcard').dataset.id;
  const v = vocabList.find((x) => x.id === id);
  if (btn.dataset.act === 'reveal') {
    vocab.revealed.add(id);
    btn.closest('.vcard').classList.remove('veil');
    return;
  }
  if (btn.dataset.act === 'del') {
    // 第一次点：× 展开成「删除」；再点一次才真的删
    if (!btn.classList.contains('armed')) {
      btn.classList.add('armed');
      btn.title = '再点一次确认删除';
      return;
    }
    const card = btn.closest('.vcard');
    btn.disabled = true;
    try { await api.post('/api/vocab/delete', { id }); } catch (err) { btn.disabled = false; return toast(`删除失败：${err.message}`); }
    vocabList = vocabList.filter((x) => x.id !== id);
    syncVocabCards();
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return renderVocab();
    // 卡片淡出并收起，下面的卡片顺势上移
    const cs = getComputedStyle(card);
    card.style.overflow = 'hidden';
    card.animate([
      { opacity: 1, height: `${card.offsetHeight}px`, marginTop: cs.marginTop, marginBottom: cs.marginBottom, paddingTop: cs.paddingTop, paddingBottom: cs.paddingBottom },
      { opacity: 0, height: '0px', marginTop: '0px', marginBottom: '0px', paddingTop: '0px', paddingBottom: '0px', borderWidth: '0px' },
    ], { duration: 240, easing: 'cubic-bezier(.3, .75, .2, 1)', fill: 'forwards' }).onfinish = renderVocab;
  } else if (v) {
    const pid = v.song?.pid || '', ne = pid.startsWith('ne-');
    if (S.track?.pid !== pid) {
      if (!pid) return toast('这首歌不在资料库里，无法直接播放');
      // 只连着一个播放器的模式下，另一个播放器里记的词没法从这里播
      if (PLAYER.id !== 'auto' && ne !== (PLAYER.id === 'netease')) return toast(`这个词是在${ne ? '网易云音乐' : ' Apple Music '}里记的，现在的播放器设置下不能从这里播放`);
      // 网易云的歌：点播和「跳到这一句」一起交给它，它要等真的换到这首歌才能跳（见 netease.js 的 playTrack）
      if (ne) return api.post('/api/control', { cmd: 'playTrack', a: pid, b: v.lineTime || 0 }).catch((err) => toast(err.message));
      await control('playTrack', pid);
      await new Promise((r) => setTimeout(r, 900));
    } else if (S.player?.state !== 'playing') control('play');
    seekTo((v.lineTime || 0) + S.offset);
  }
});

// ---------------- 歌词源 ----------------
async function openSource(q = '') {
  $('#source-modal').hidden = false;
  $('#src-q').value = q; // 从菜单打开时清空上次搜的词；点「搜索」进来的保持原样
  if (!S.track) { $('#src-list').innerHTML = '<div class="empty">先播放一首歌</div>'; return; }
  $('#src-list').innerHTML = '<div class="empty">搜索中…</div>';
  const p = new URLSearchParams({ name: S.track.name, artist: S.track.artist || '', duration: S.track.duration || 0, q });
  let list;
  try { list = await api.get(`/api/candidates?${p}`); } catch (e) { $('#src-list').innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
  const cur = S.song?.source;
  $('#src-list').innerHTML = list.length ? list.map((c, i) => {
    const f = c.flags;
    const tags = f ? (f.lines ? [f.trans && '翻译', f.words && '逐字', f.roma && '注音'].filter(Boolean).map((x) => `<b>${x}</b>`).join('') || '<span>仅原文</span>' : '<span>无歌词</span>') : '';
    return `<div class="cand${cur && cur.source === c.source && cur.id === c.id ? ' cur' : ''}" data-i="${i}">
      <span class="src">${c.source === 'qq' ? 'QQ音乐' : '网易云'}</span><div class="t">${esc(c.title)}</div>
      <div class="x">${fmt(c.duration)}${tags}</div><div class="a">${esc(c.artists.join(' / '))}${c.album ? ' — ' + esc(c.album) : ''}</div></div>`;
  }).join('') : '<div class="empty">没有找到候选歌词，试试手动搜索日文原名。</div>';
  $('#src-list').onclick = async (e) => {
    const row = e.target.closest('.cand');
    if (!row) return;
    await api.post('/api/song/source', { key: S.song.key, cand: list[+row.dataset.i] });
    $('#source-modal').hidden = true;
    reloadSong();
  };
}
$('#src-search').addEventListener('click', () => openSource($('#src-q').value.trim()));
$('#src-q').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !composing(e)) openSource($('#src-q').value.trim()); });
$('#src-auto').addEventListener('click', async () => {
  if (!S.song) return;
  await api.post('/api/song/source', { key: S.song.key, cand: null });
  $('#source-modal').hidden = true;
  reloadSong({ refresh: true });
});

// ---------------- 设置 ----------------
async function openSettings() {
  $('#settings-modal').hidden = false;
  $('#settings-modal .modal-body').scrollTop = 0; // 每次打开都从头看起，不停在上次划到的地方
  $('#set-style').value = prefs.annStyle;
  $('#set-max').value = prefs.annMax; $('#set-max-val').textContent = `${prefs.annMax} 个`;
  $('#set-grammar').checked = prefs.annGrammar; $('#set-vocabs').checked = prefs.annVocab;
  $('#set-source').value = prefs.annSource;
  $('#set-lang').value = prefs.meaningLang;
  $('#set-autosense').checked = prefs.autoSense !== false;
  $('#set-fx-hold').checked = !!prefs.fxHold;
  $('#set-fx-group').checked = !!prefs.fxGroup;
  $('#set-less-motion').checked = !!prefs.lessMotion;
  $('#set-fx-mesh').checked = !!prefs.fxMesh;
  const picked = Object.keys(S.senses || {}).length;
  $('#set-clear-senses').hidden = !picked;
  $('#set-clear-senses').textContent = `清除这首歌里手动选的 ${picked} 个`;
  $('#set-levels').innerHTML = ['N5', 'N4', 'N3', 'N2', 'N1', 'x'].map((k) => `<label class="chk"><input type="checkbox" data-lv="${k}" ${prefs.levels[k] !== false ? 'checked' : ''}> ${k === 'x' ? '未分级' : k}</label>`).join(' ');
  $('#set-ai-state').textContent = S.song?.ai ? '当前歌曲已有 AI 讲解' : '';
  setFold(false); // AI 讲解那一节每次打开设置时都是收起的
  keyRec = null;
  renderKeys();
  disarmCache();
  refreshCacheInfo();
  renderMarks();
  api.get('/api/marks').then((m) => { lib.marks = m; renderMarks(); }).catch(() => {});
  api.get('/api/info').then((i) => { $('#about-version').textContent = `版本 ${i.version || '未知'}　程序位置 ${i.root}`; }).catch(() => {});
  try {
    const s = await api.get('/api/settings');
    $('#set-model').value = s.model;
    $('#set-key').value = '';
    $('#set-key-state').textContent = s.hasKey ? `已保存（…${s.keyTail}）` : s.envKey ? '使用环境变量里的 Key' : '未设置';
    const auto = s.browsers[0] ? `自动（${s.browsers[0]}）` : '自动（系统默认浏览器）';
    $('#set-browser').innerHTML = `<option value="auto">${esc(auto)}</option>` + s.browsers.map((b) => `<option value="${esc(b)}">${esc(b)}</option>`).join('') + '<option value="default">系统默认浏览器（普通标签页）</option>';
    $('#set-browser').value = s.browser;
    $('#set-browser-apply').hidden = true;
    $('#set-player').value = s.player;
    $('#set-player-apply').hidden = s.player === s.playerInUse;
  } catch { /* 忽略 */ }
}
function onAnnPrefChange() {
  prefs.annStyle = $('#set-style').value;
  prefs.annMax = +$('#set-max').value; $('#set-max-val').textContent = `${prefs.annMax} 个`;
  prefs.annGrammar = $('#set-grammar').checked; prefs.annVocab = $('#set-vocabs').checked;
  prefs.annSource = $('#set-source').value;
  prefs.meaningLang = $('#set-lang').value;
  prefs.autoSense = $('#set-autosense').checked;
  $$('#set-levels input').forEach((el) => { prefs.levels[el.dataset.lv] = el.checked; });
  savePrefs();
  paintAnnotations();
}
$('#set-clear-senses').addEventListener('click', async () => {
  if (!S.song) return;
  try { await api.post('/api/song/sense', { key: S.song.key, clear: true }); } catch (e) { return toast(`清除失败：${e.message}`); }
  S.senses = {};
  $('#set-clear-senses').hidden = true;
  paintAnnotations();
  toast('已清除，这首歌的多义词恢复自动选义');
});
$('#set-fx-hold').addEventListener('change', (e) => { prefs.fxHold = e.target.checked; savePrefs(); collectFill(); });
$('#set-fx-mesh').addEventListener('change', (e) => { prefs.fxMesh = e.target.checked; savePrefs(); setFxMesh(prefs.fxMesh); });
$('#set-less-motion').addEventListener('change', (e) => { prefs.lessMotion = e.target.checked; savePrefs(); if (prefs.lessMotion) ktvTilt(0, 0, true); });
$('#set-fx-group').addEventListener('change', (e) => { prefs.fxGroup = e.target.checked; savePrefs(); markGroups(); if (S.lines.length && S.active > -2) setActive(S.active); });
for (const id of ['set-style', 'set-max', 'set-grammar', 'set-vocabs', 'set-source', 'set-lang', 'set-autosense', 'set-levels']) $(`#${id}`).addEventListener('input', onAnnPrefChange);
async function saveSettings() {
  const body = { model: $('#set-model').value.trim() };
  const key = $('#set-key').value.trim();
  if (key) body.apiKey = key;
  await api.post('/api/settings', body);
  $('#set-key').value = '';
  if (key) $('#set-key-state').textContent = `已保存（…${key.slice(-4)}）`;
}
$('#set-save').addEventListener('click', () => saveSettings().then(() => toast('设置已保存')).catch((e) => toast(e.message)));
// AI 讲解一节：默认收起，点标题展开
function setFold(open) {
  $('#set-ai-body').hidden = !open;
  $('#set-ai-toggle').setAttribute('aria-expanded', open);
}
$('#set-ai-toggle').addEventListener('click', () => setFold($('#set-ai-body').hidden));
// 清除缓存：第一次点只是变成红色的确认，再点一次才真的清
const fmtBytes = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(n ? 1 : 0, Math.round(n / 1024))} KB`);
let cacheTimer = 0;
async function refreshCacheInfo() {
  try { const c = await api.get('/api/cache'); $('#set-cache-info').textContent = c.files ? `现在有 ${c.files} 个文件，共 ${fmtBytes(c.bytes)}` : '现在没有缓存'; $('#set-cache').disabled = !c.files; }
  catch { $('#set-cache-info').textContent = ''; }
}
function disarmCache() {
  clearTimeout(cacheTimer);
  const b = $('#set-cache');
  b.classList.remove('danger');
  b.textContent = '清除缓存';
}
$('#set-cache').addEventListener('click', async () => {
  const b = $('#set-cache');
  if (!b.classList.contains('danger')) {
    b.classList.add('danger');
    b.textContent = '再点一次确认清除';
    cacheTimer = setTimeout(disarmCache, 5000); // 几秒没确认就收回
    return;
  }
  disarmCache();
  try {
    const r = await api.post('/api/cache/clear', {});
    toast(`已清除缓存：${r.files} 个文件，${fmtBytes(r.bytes)}`);
  } catch (e) { toast(`清除失败：${e.message}`); }
  refreshCacheInfo();
});
$('#set-cache').addEventListener('mouseleave', () => { if ($('#set-cache').classList.contains('danger')) { clearTimeout(cacheTimer); cacheTimer = setTimeout(disarmCache, 1500); } });
// 界面窗口用哪个浏览器：选了就保存，下次打开界面时生效；也可以点「现在就换」马上用它重新打开
$('#set-browser').addEventListener('change', async (e) => {
  try { await api.post('/api/settings', { browser: e.target.value }); } catch (err) { return toast(`保存失败：${err.message}`); }
  $('#set-browser-apply').hidden = false;
  toast('已保存，下次打开界面时生效');
});
// 播放器：Apple Music / 网易云音乐。换了要重启程序才生效（界面会自动刷新）
$('#set-player').addEventListener('change', async (e) => {
  try { await api.post('/api/settings', { player: e.target.value }); } catch (err) { return toast(`保存失败：${err.message}`); }
  $('#set-player-apply').hidden = e.target.value === PLAYER.id;
  if (e.target.value !== PLAYER.id) toast('已保存，点「现在重启」后生效');
});
$('#set-player-apply').addEventListener('click', () => { api.post('/api/restart', {}).catch(() => {}); toast('正在重启…'); });
$('#set-browser-apply').addEventListener('click', async () => {
  try { await api.post('/api/show', { fresh: true }); } catch (err) { return toast(`打开失败：${err.message}`); }
  $('#set-browser-apply').hidden = true; // 新窗口出来后，服务端会通知原来的界面窗口自己关掉
});
$('#set-ai-run').addEventListener('click', async () => {
  if (!S.song?.lines.length || !S.song.flags?.japanese) return toast('先播放一首有日语歌词的歌');
  const btn = $('#set-ai-run'), state = $('#set-ai-state');
  btn.disabled = true;
  state.textContent = '生成中，通常需要半分钟到一两分钟…';
  try {
    await saveSettings();
    await api.post('/api/ai/annotate', { source: S.song.source, lines: S.song.lines.map((l) => ({ text: l.text, zh: l.zh })) });
    await reloadSong();
    state.textContent = '完成，已应用到当前歌曲';
  } catch (e) { state.textContent = `失败：${e.message}`; }
  btn.disabled = false;
});

// ---------------- 顶栏 / 浮层 / 快捷键 ----------------
function applyPrefs() {
  app.classList.toggle('view-apple', prefs.view === 'apple');
  app.classList.toggle('view-focus', prefs.view === 'focus');
  app.classList.toggle('view-ktv', prefs.view === 'ktv');
  for (const k of ['furi', 'zh', 'roma', 'ann']) {
    app.classList.toggle(`no-${k}`, !isOn(k));
    $(`[data-toggle=${k}]`).classList.toggle('on', isOn(k));
  }
  $$('[data-view]').forEach((b) => b.classList.toggle('on', b.dataset.view === prefs.view));
  $('#db-char').checked = prefs.dictChar; $('#db-pause').checked = prefs.dictPause;
}
function setView(v) {
  if (v === 'ktv' && S.mode) setMode(S.mode); // KTV 样式下没有记词 / 修改：先退出来
  prefs.view = v; savePrefs(); applyPrefs();
  if (v === 'ktv') { for (const el of ktv.lines) el._line = undefined; renderKtv(true); }
  collectFill();
  requestAnimationFrame(() => scrollToActive(true));
}
// 滚动 ⇄ 大字 之间带过渡动画（见 morphView），其余的直接切换；设置里开了「减少动画」的话都直接切换
const switchView = (v) => (prefs.lessMotion ? setView : morphView)(v);
$$('[data-view]').forEach((b) => b.addEventListener('click', () => switchView(b.dataset.view)));
// 显示开关（假名 / 中文翻译 / 罗马音 / 标注）切换时的过渡：
//   关：屏幕上看得见的那些先原地淡出（这时还占着位置），淡完再真的收起，其余各行滑到新位置
//   开：各行先滑开腾出位置，新出现的跟着淡入
const TOGGLE_SEL = { furi: 'rt', zh: '.zh', roma: '.roma', ann: '.ann, #f-ann' };
function animateToggle(k) {
  const on = isOn(k);
  $(`[data-toggle=${k}]`).classList.toggle('on', on); // 菜单里的勾马上变，不等动画
  const place = () => {
    applyPrefs(); paintAnnotations();
    if (prefs.view === 'apple' && !elScroll.classList.contains('free')) jumpToActive();
    fitKtv();
  };
  if (noMotion.matches || document.hidden || !S.lines.length) return place();
  const targets = () => {
    if (prefs.view !== 'apple') return $$(TOGGLE_SEL[k], $(prefs.view === 'ktv' ? '#k-lines' : '#focus-inner'));
    const [lo, hi] = visibleRange(0), out = [];
    for (let i = lo; i <= hi; i++) out.push(...$$(TOGGLE_SEL[k], elScroll.children[i]));
    return out;
  };
  if (on) {
    glide(place);
    for (const el of targets()) el.animate([{ opacity: 0 }, {}], { duration: 420, delay: 140, easing: 'ease-out', fill: 'backwards' });
  } else {
    const fades = targets().map((el) => el.animate([{}, { opacity: 0 }], { duration: 200, easing: 'ease-in', fill: 'forwards' }));
    setTimeout(() => { glide(place); for (const a of fades) a.cancel(); }, 200);
  }
}
$$('[data-toggle]').forEach((b) => b.addEventListener('click', () => {
  const k = b.dataset.toggle, on = !isOn(k);
  if (k === 'roma') romaAuto = false; // 手动点了：按手动的来，不再算临时打开
  prefs[k] = on; savePrefs();
  animateToggle(k);
}));
// 二级菜单：显示开关留在菜单里可连续切换；工具项点了就收起菜单
function placeUnderMenuButton(pop) {
  const r = $('#btn-menu').getBoundingClientRect();
  pop.style.top = `${r.bottom + 8}px`;
  pop.style.left = `${clamp(r.right - pop.offsetWidth, 8, innerWidth - pop.offsetWidth - 8)}px`;
}
function toggleMenu(open = $('#menu').hidden) {
  $('#menu').hidden = !open;
  $('#btn-menu').classList.toggle('on', open);
  if (open) placeUnderMenuButton($('#menu'));
}
$('#btn-menu').addEventListener('click', () => toggleMenu());
$('#btn-dict').addEventListener('click', () => setMode('dict'));
$('#btn-edit').addEventListener('click', () => { toggleMenu(false); setMode('edit'); });
// 资料库按钮是开关：开着的时候再点一下收起（和词汇书按钮一样）
$('#btn-library').addEventListener('click', () => { if ($('#library').hidden) openLibrary(); else $('#library').hidden = true; });
// 词汇书按钮和「记词」一样是开关：点一下打开（按钮亮起），再点一下关上
$('#btn-vocab').addEventListener('click', () => {
  if (!$('#vocab').hidden) { $('#vocab').hidden = true; return; }
  $('#queue').hidden = true; $('#vocab').hidden = false; loadVocab();
});
// 按钮亮不亮跟着抽屉走：不管是点按钮、点抽屉的 ✕、按快捷键还是被别的抽屉顶掉，都对得上
// （'uta:toggle' 由下面的 animateHidden 发出：抽屉一开始收起就熄灭，不用等收起的动画放完）
$('#vocab').addEventListener('uta:toggle', () => {
  const open = !$('#vocab').hidden;
  $('#btn-vocab').classList.toggle('on', open);
  $('#btn-vocab').setAttribute('aria-pressed', open);
});
$('#btn-source').addEventListener('click', () => { toggleMenu(false); openSource(); });
$('#btn-settings').addEventListener('click', () => { toggleMenu(false); openSettings(); });
$('#btn-offset').addEventListener('click', () => {
  toggleMenu(false);
  const pop = $('#offset-pop');
  pop.hidden = false;
  placeUnderMenuButton(pop);
});
$$('[data-close]').forEach((b) => b.addEventListener('click', () => { b.closest('.drawer, .modal').hidden = true; }));
$$('.modal').forEach((m) => m.addEventListener('mousedown', (e) => { if (e.target === m) m.hidden = true; }));
document.addEventListener('mousedown', (e) => {
  dismissSeek = false;
  dismissClick = false; // 这一下是不是只用来收起什么东西（或者根本不该有反应），而不算点了底下的封面：见封面的点击
  if (!$('#offset-pop').hidden && !e.target.closest('#offset-pop, #btn-offset')) {
    // 时间对齐的面板开着时点到封面：不切换样式。和记词 / 修改模式一个道理，正对着歌词敲，手一滑点到封面不该把样式换了
    if (e.target.closest('#art-wrap')) dismissClick = true;
    // 敲击对齐开着时，点歌词是在对齐，不算「点到面板外面」，面板留着方便多敲几次；点到封面也不算，什么都不发生
    if (!(S.tapAlign && e.target.closest('#lyrics, #focus, #ktv, #art-wrap'))) { $('#offset-pop').hidden = true; dismissSeek = true; }
  }
  if (!$('#menu').hidden && !e.target.closest('#menu, #btn-menu')) { toggleMenu(false); dismissSeek = true; }
  if (!$('#reading-pop').hidden && !e.target.closest('#reading-pop, .seg.k')) { $('#reading-pop').hidden = true; popClosedAt = performance.now(); }
  // 这一下是用来收起资料库 / 词汇书的：它只管收起
  for (const id of ['library', 'vocab']) if (!$(`#${id}`).hidden && !e.target.closest(`#${id}, #topbar, #toast`)) { $(`#${id}`).hidden = true; dismissClick = dismissSeek = true; }
});

$('#btn-play').addEventListener('click', () => control('playpause'));
$('#btn-prev').addEventListener('click', () => control('prev'));
$('#btn-next').addEventListener('click', () => control('next'));
const seek = $('#seek');
seek.addEventListener('input', () => {
  S.dragging = true;
  const dur = S.track?.duration || 0;
  setProgress(seek.value / 1000);
  $('#t-cur').textContent = fmt((seek.value / 1000) * dur);
});
seek.addEventListener('change', () => { S.dragging = false; if (S.track) seekTo((seek.value / 1000) * S.track.duration); });

function stepLine(dir) {
  let i = clamp(S.active + dir, 0, S.lines.length - 1);
  while (S.lines[i]?.gap && i + dir >= 0 && i + dir < S.lines.length) i += dir;
  if (S.lines[i]) seekTo(S.lines[i].t + S.offset + 0.02);
}
// ---------------- 快捷键（可以在设置里改） ----------------
// [编号, 名称, 默认按键, 做什么]。默认按键为空 = 默认不设，想用的话自己指定
const KEY_ACTIONS = [
  ['playpause', '播放 / 暂停', ' ', () => control('playpause')],
  ['view', '切换 滚动 / 大字', 'f', () => switchView(prefs.view === 'apple' ? 'focus' : 'apple')],
  ['prevLine', '上一句', 'ArrowLeft', () => stepLine(-1)],
  ['nextLine', '下一句', 'ArrowRight', () => stepLine(1)],
  ['dict', '记词模式', 'd', () => setMode('dict')],
  ['edit', '修改模式', 'e', () => setMode('edit')],
  ['offsetMinus', '歌词提前 0.1 秒', '[', () => setOffset(S.offset - 0.1)],
  ['offsetPlus', '歌词延后 0.1 秒', ']', () => setOffset(S.offset + 0.1)],
  ['prevTrack', '上一首', '', () => control('prev')],
  ['nextTrack', '下一首', '', () => control('next')],
  ['shuffle', '随机播放', '', () => $('#btn-shuffle').click()],
  ['queue', '播放列表', '', () => $('#btn-queue').click()],
  ['library', '资料库', '', () => ($('#library').hidden ? openLibrary() : ($('#library').hidden = true))],
  ['vocab', '词汇书', '', () => ($('#vocab').hidden ? $('#btn-vocab').click() : ($('#vocab').hidden = true))],
].map(([id, label, def, run]) => ({ id, label, def, run }));
// 字母不分大小写；其余按键用浏览器给的名字（' '、'ArrowLeft'、'['…）
const normKey = (e) => (e.key.length === 1 ? e.key.toLowerCase() : e.key);
const keyOf = (a) => prefs.keys?.[a.id] ?? a.def;
const KEY_NAMES = { ' ': '空格', ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓', Enter: '回车', Tab: 'Tab' };
const keyLabel = (k) => (!k ? '未设置' : KEY_NAMES[k] || (k.length === 1 ? k.toUpperCase() : k));
let keyMap = new Map();
function applyKeys() {
  keyMap = new Map(KEY_ACTIONS.filter((a) => keyOf(a)).map((a) => [keyOf(a), a]));
  // 按钮上的提示也跟着当前的按键走
  const hint = (id) => { const k = keyOf(KEY_ACTIONS.find((a) => a.id === id)); return k ? `（${keyLabel(k)}）` : ''; };
  $('[data-view=apple]').title = `滚动歌词${hint('view')}`;
  $('[data-view=focus]').title = `大字单句${hint('view')}`;
  $('#btn-dict').title = `记词模式：点选歌词片段加入词汇书${hint('dict')}`;
  $('#btn-edit').title = `修改模式：改读音、隐藏或恢复标注、换多义词的义项${hint('edit')}；再点一次退出`;
  const m = keyOf(KEY_ACTIONS.find((a) => a.id === 'offsetMinus')), pl = keyOf(KEY_ACTIONS.find((a) => a.id === 'offsetPlus'));
  $('#offset-keys').textContent = [m && `${keyLabel(m)} 提前`, pl && `${keyLabel(pl)} 延后`].filter(Boolean).join('　') + (m || pl ? '，' : '') + '按歌曲分别保存';
}
function renderKeys() {
  $('#set-keys').innerHTML = KEY_ACTIONS.map((a) => {
    const k = keyOf(a);
    return `<div class="key-row"><span>${esc(a.label)}</span><button class="btn small key-btn${k ? '' : ' none'}" data-key="${a.id}">${esc(keyLabel(k))}</button></div>`;
  }).join('');
}
function setKey(id, key) {
  const a = KEY_ACTIONS.find((x) => x.id === id);
  prefs.keys = { ...(prefs.keys || {}) };
  // 这个键已经给了别的动作：让给新的，原来那个变成未设置
  const other = key && KEY_ACTIONS.find((x) => x !== a && keyOf(x) === key);
  if (other) { prefs.keys[other.id] = ''; toast(`「${other.label}」原来也用 ${keyLabel(key)}，已取消`); }
  if (key === a.def) delete prefs.keys[id]; else prefs.keys[id] = key;
  savePrefs();
  applyKeys();
  renderKeys();
}
// 改按键：点了某个按键按钮之后，下一次按键就是新的设定
let keyRec = null;
function stopKeyRec() { keyRec = null; renderKeys(); }
$('#set-keys').addEventListener('click', (e) => {
  const btn = e.target.closest('.key-btn');
  if (!btn) return;
  if (keyRec === btn.dataset.key) return stopKeyRec();
  keyRec = btn.dataset.key;
  renderKeys();
  const now = $(`.key-btn[data-key="${keyRec}"]`);
  now.classList.add('rec');
  now.textContent = '按下按键…';
});
document.addEventListener('keydown', (e) => {
  if (!keyRec) return;
  e.preventDefault();
  e.stopImmediatePropagation(); // 这次按键只用来设定，不触发它原来的功能（包括 Esc 关闭设置）
  if (['Shift', 'Meta', 'Control', 'Alt', 'CapsLock'].includes(e.key)) return;
  if (e.key === 'Escape') return stopKeyRec();
  if (e.metaKey || e.ctrlKey || e.altKey) return toast('只能用单个按键，不支持组合键');
  const id = keyRec;
  keyRec = null;
  setKey(id, e.key === 'Backspace' || e.key === 'Delete' ? '' : normKey(e));
}, true);
$('#set-keys-reset').addEventListener('click', () => { delete prefs.keys; savePrefs(); applyKeys(); stopKeyRec(); toast('快捷键已恢复默认'); });
applyKeys();

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (!$('#follow-pop').hidden) return answerOffer(false);
    hideSensePop();
    const open = $$('.modal, .drawer, .popover').filter((el) => !el.hidden);
    if (open.length) { open.forEach((el) => { el.hidden = true; }); $('#btn-menu').classList.remove('on'); }
    else if (S.sel) $('#db-cancel').click();
    else if (S.mode) setMode(S.mode);
    return;
  }
  if (e.target.closest('input, select, textarea, [contenteditable]') || e.metaKey || e.ctrlKey || e.altKey) return;
  const act = keyMap.get(normKey(e));
  if (act) { e.preventDefault(); act.run(); }
});
addEventListener('resize', () => { scrollToActive(true); fitKtv(); });

let toastTimer = 0;
// action = { label, run }：提示后面带一个按钮（比如「撤销」），这时提示多留几秒
// 自动模式：界面跟着一个播放器时另一个开始播放，程序不自己换过去，而是带一条 offer 过来，这里弹窗问。
// 同一条只弹一次（答过之后、程序收到回答之前，还会有带着它的状态推过来）；对方停了，这一条撤回，弹窗跟着收起
let offerKey = '';
const withName = (pre, name, post = '') => `${pre}${/^[\w]/.test(name) && pre ? ' ' : ''}${name}${/[\w]$/.test(name) && post ? ' ' : ''}${post}`;
function onOffer(o, cur) {
  const el = $('#follow-pop');
  if (!o) { offerKey = ''; el.hidden = true; return; }
  $('#fp-track').textContent = [o.name, o.artist].filter(Boolean).join(' · '); // 对方换歌了，歌名跟着换
  const key = `${o.source}|${o.at}`;
  if (key === offerKey) return;
  offerKey = key;
  $('#fp-title').textContent = withName('', SRC_NAME[o.source], '正在播放');
  $('#fp-go').textContent = withName('切换到', SRC_NAME[o.source]);
  $('#fp-go').dataset.src = o.source;
  $('#fp-stay').textContent = withName('留在', SRC_NAME[cur] || PLAYER.name);
  el.hidden = false;
}
function answerOffer(go) {
  $('#follow-pop').hidden = true;
  control(go ? 'follow' : 'stay', go ? $('#fp-go').dataset.src : '');
}
$('#fp-go').addEventListener('click', () => answerOffer(true));
$('#fp-stay').addEventListener('click', () => answerOffer(false));

function toast(msg, action) {
  const el = $('#toast');
  el.textContent = msg;
  if (action) {
    const b = document.createElement('button');
    b.className = 'toast-act';
    b.textContent = action.label;
    b.addEventListener('click', () => { el.hidden = true; action.run(); });
    el.append(b);
  }
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, action ? 7000 : 2600);
}

// ---------------- 彩蛋：KTV 样式 ----------------
// 入口：在资料库或词汇书的搜索框里输入「KTV Mode」回车。顶栏「大字」右边会多出一个 KTV 按钮；
// 换回「滚动」/「大字」后按钮收起，要再输入一次才回得来。
// 画面：中间是隔着一段距离的封面（纯 CSS，见 style.css），下面两行歌词，一行靠左、一行靠右：
//   第 1、3、5… 句在左边那一行，第 2、4、6… 句在右边那一行（间奏不算句）。
//   屏幕上总是「正在唱的这一句」和「下一句」；这一句唱完、轮到另一行唱时，这一行就换成下下句。
// 间奏的三个点总是在上面那一行：
//   - 马上要唱的是上面那行：点挂在那一句的上方，中间那个点对着第一个字的正中
//   - 马上要唱的是下面那行（间奏前唱的是上面那句）：上面那句唱完后原地换成三个点，
//     等间奏结束、下面那行开唱了，上面再换成下下句
//   间奏期间马上要唱的那一句不提前变亮，唱到了才亮。
// 这个样式下没有标注，也不能记词 / 修改。
const ktv = { lines: $$('#k-lines .k-line') };
const DOTS_HTML = '<span class="dots"><span class="dots-g"><i></i><i></i><i></i></span></span>';
const nextLyric = (i) => { for (let k = Math.max(i, -1) + 1; k < S.lines.length; k++) if (!S.lines[k].gap) return k; return -1; };
function renderKtv(instant) {
  if (prefs.view !== 'ktv') return;
  if (S.active === -2 && S.lines.length) return; // 刚载入、还不知道唱到哪：等下一帧定了当前句再画，免得先闪一下开头两句
  const a = S.active, gapLine = S.lines[a]?.gap ? S.lines[a] : null;
  const cur = a >= 0 && !gapLine ? a : nextLyric(a); // 间奏里、开唱之前：马上要唱的那一句
  const row = (i) => (S.vis[i] - 1) % 2; // 这一句在哪一行：0 上面（靠左），1 下面（靠右）
  const solo = !!gapLine && cur >= 0 && row(cur) === 1; // 间奏、马上要唱的在下面：上面那行只放三个点
  const want = [null, null];
  if (cur >= 0) want[row(cur)] = cur;
  const nx = cur >= 0 ? nextLyric(cur) : -1;
  if (nx >= 0 && !solo) want[row(nx)] = nx;
  const has = { roma: S.lines.some((l) => l.roma), zh: S.lines.some((l) => l.zh) };
  const still = instant || noMotion.matches || document.hidden;
  const changed = [];
  ktv.lines.forEach((el, k) => {
    const i = want[k] ?? -1, alone = solo && k === 0;
    const line = alone ? gapLine : i >= 0 ? S.lines[i] : null; // 这一行放的东西：一句歌词，或者（alone）这段间奏的三个点
    if (el._line !== line) {
      const slot = el.parentNode;
      for (const g of $$('.k-ghost', slot)) g.remove();
      // 换下去的那一句：留一份在原地淡出
      if (!still && el._line) {
        const g = el.cloneNode(true);
        g.classList.add('k-ghost');
        g.style.width = `${el.offsetWidth}px`;
        $(':scope > .dots', g)?.remove();
        slot.append(g);
        g.animate([{ opacity: 1 }, { opacity: 0, transform: 'translateY(-10px)', filter: 'blur(4px)' }], { duration: 300, easing: 'ease-in', fill: 'forwards' }).onfinish = () => g.remove();
      }
      el._line = line; el._i = i;
      el.dataset.i = i >= 0 ? i : '';
      // 没有罗马音 / 翻译的句子、空着的那一行、只有三个点的那一行，也留出同样高的空位：两行的高矮一直不变，换词时不会上下跳
      el.innerHTML = (alone ? `<div class="jp">${DOTS_HTML}</div>` : line ? lineBody(line, i) : '<div class="jp">&nbsp;</div>')
        + (has.roma && !(!alone && line?.roma) ? '<div class="roma">&nbsp;</div>' : '') + (has.zh && !(!alone && line?.zh) ? '<div class="zh">&nbsp;</div>' : '');
      changed.push(el);
      if (!still && line && !alone) el.animate([{ opacity: 0, transform: 'translateY(12px)' }, {}], { duration: 460, delay: 220, easing: 'cubic-bezier(.2, .8, .2, 1)', fill: 'backwards' }); // 等旧的那句淡得差不多了再出来，两句不叠在一起
    }
    const cls = `k-line${!alone && line?.ct ? ' timed' : ''}${i >= 0 && i === a ? ' active' : ''}${alone ? ' solo' : ''}`;
    if (el.className !== cls) el.className = cls;
    // 马上要唱的是上面这一行：三个点挂在这一句的上方
    const dots = $(':scope > .dots', el), over = !!gapLine && !solo && i === cur;
    if (over && !dots) el.insertAdjacentHTML('beforeend', DOTS_HTML);
    else if (!over && dots) dots.remove();
  });
  fitKtv(changed);
}
// 一句固定排成一排：比这一行能用的宽度长的，整句按比例缩小（--k）。行高是按没缩小的字号定的，所以缩小了也不变矮
function fitKtv(list = ktv.lines) {
  if (prefs.view !== 'ktv') return;
  for (const el of list) el.style.setProperty('--k', 1);
  const fit = list.map((el) => { const jp = $('.jp', el); return jp ? el.parentNode.clientWidth * 0.94 / jp.scrollWidth : 1; });
  list.forEach((el, k) => { if (fit[k] < 1) el.style.setProperty('--k', Math.max(0.4, fit[k]).toFixed(3)); });
  // 挂在句子上方的三个点：中间那个点对着第一个字的正中（--dx）
  for (const el of ktv.lines) {
    const ch = $(':scope > .dots', el) && $('.jp .ch', el);
    if (ch) { const r = ch.getBoundingClientRect(); el.style.setProperty('--dx', `${(r.left + r.width / 2 - el.getBoundingClientRect().left).toFixed(1)}px`); }
  }
}
// 正在唱的那一句（间奏时：有三个点的那一行）在哪一行
const ktvRoot = (line) => ktv.lines.find((el) => (line.gap ? $('.dots-g', el) : el._i === S.active));
// 鼠标移动时整个场景跟着偏一点：封面离得远、挪得少，歌词离得近、往反方向挪一点，就有了前后的层次。
// 鼠标 KTV_REST 毫秒没动：非常慢地转回正面（封面完全不歪的样子），慢到不容易察觉；鼠标一动又跟上
// 设置里开了「减少动画」：不跟着鼠标动，场景一直是正面的
const KTV_REST = 5000;
// ktvTilt(x, y, quick)：让场景偏到 (x, y)（各自 -1 到 1，0 是正面）。quick = 用平常的快慢过去，而不是「慢慢转回正面」那种慢
const ktvTilt = (() => {
  const el = $('#ktv');
  let raf = 0, mx = 0, my = 0, rest = 0, lx = -1, ly = -1;
  const put = () => { raf = 0; el.style.setProperty('--mx', mx.toFixed(3)); el.style.setProperty('--my', my.toFixed(3)); };
  const move = (x, y, quick) => {
    if (quick) { clearTimeout(rest); el.classList.remove('rest'); }
    if (x === mx && y === my) return;
    mx = x; my = y; raf ||= requestAnimationFrame(put);
  };
  document.addEventListener('mousemove', (e) => {
    if (prefs.view !== 'ktv' || prefs.lessMotion || noMotion.matches) return;
    if (e.clientX === lx && e.clientY === ly) return; // 鼠标没动、只是底下的东西变了，浏览器也会发这个事件：不算
    lx = e.clientX; ly = e.clientY;
    move(clamp(lx / innerWidth * 2 - 1, -1, 1), clamp(ly / innerHeight * 2 - 1, -1, 1), true);
    rest = setTimeout(() => { el.classList.add('rest'); move(0, 0); }, KTV_REST);
  });
  return move;
})();
// 口令。回车时先把搜索框清空（列表回到没搜索的样子，这次输入不留痕迹），再换样式
const KTV_WORD = /^ktv\s*mode$/i;
for (const id of ['#lib-search', '#vocab-search']) {
  $(id).addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || composing(e) || !KTV_WORD.test(e.target.value.trim())) return;
    e.preventDefault();
    e.target.value = '';
    e.target.dispatchEvent(new Event('input'));
    e.target.blur();
    $('#library').hidden = true; $('#vocab').hidden = true;
    if (prefs.view !== 'ktv') setView('ktv');
  });
}

// ---------------- 实验：滚动 ⇄ 大字 的过渡，封面飞过去 ----------------
// 触发：大字样式下点底栏的小封面 → 滚动；滚动样式下点大封面 → 大字；顶栏的「滚动 / 大字」按钮和快捷键也走这里。
// 做法是 FLIP：先记下各样东西现在在哪，直接换成另一个样式，再让它们从原来的位置用弹簧动画走到新位置。
//   - 封面：平移 + 放大 / 缩小（圆角和阴影按比例折算，飞的途中看着是同一块东西）
//   - 歌名 / 歌手：跟着平移、缩放一点
//   - 正在唱的那一句：每个字各飞各的，从它原来的位置飞到它在新样式里的位置。
//       两个样式的字号、每行能放几个字都不一样，同一句常常在不同的地方折行；整句当一块飞的话，折行不同时就落不到位。
//       飞的是照着新样式里这一句抄的一份（不在滚动歌词的框里，不会被裁），真的那一句先藏着；
//       落地时这一份和真的那一句完全重合，直接换过去，看不出来。罗马音、翻译各自整行飞
//   - 进度条和按钮、其余的歌词：不飞，旧的淡出、新的淡入
const FX_MORPH = true; // 实验性的，不想要了改成 false：点封面没有反应，按钮和快捷键回到直接切换
// 过渡用的弹簧：临界阻尼，到位时一点都不过头。封面、歌名、歌词都用这一条。
// 试过略微过头一点（约 0.2%）的：歌词是一个个字各飞各的，飞得远的过头得多、近的过头得少，
// 整句看上去会先挤一下再松开（还带着缩放），哪怕只有一两个像素也显得「弹」；封面单独留着回弹也不协调，就都去掉了
const MORPH = springEasing(230, 30.4);
let morphFus = null; // 飞着的那一份里的填色单位：飞的这半秒里逐字填色照常走（见 tick）
let morphHover = null; // 封面飞完以后等鼠标动一下、好恢复悬停效果的那个监听
const flatView = (v) => v === 'apple' || v === 'focus';
$('#art-wrap').classList.toggle('go', FX_MORPH);
// 资料库 / 词汇书开着的时候点到封面：那一下只是把抽屉收起来（mousedown 时已经收了），不切换样式
// 记词 / 修改模式下点封面没有反应：这时是在歌词上点来点去，手一滑点到封面就把样式换了很烦人（顶栏的按钮和快捷键照常能切）
$('#art-wrap').addEventListener('click', () => { if (FX_MORPH && !dismissClick && !S.mode && flatView(prefs.view)) morphView(prefs.view === 'focus' ? 'apple' : 'focus'); });
function morphView(to) {
  const from = prefs.view;
  if (from === to) return;
  if (!FX_MORPH || !flatView(from) || !flatView(to) || S.mode || noMotion.matches || document.hidden) return setView(to);
  const toScroll = to === 'apple';
  const rect = (el) => el.getBoundingClientRect();
  const textRect = (el) => { const r = document.createRange(); r.selectNodeContents(el); return r.getBoundingClientRect(); };
  const px = (el, prop) => parseFloat(getComputedStyle(el)[prop]) || 0;
  const scalePx = (str, k) => str.replace(/(-?[\d.]+)px/g, (_, n) => `${(n / k).toFixed(2)}px`);
  const artEl = $('#art-wrap'), metaEl = $('#meta'), cur = $('#f-cur'), a = S.active;
  // 当前句的三样（日文、罗马音、翻译）各记各的：大字里是居中的，滚动样式里靠左，字号的比例也不一样，得分开飞
  const PARTS = ['.jp', '.roma', '.zh'];
  const measure = (root) => PARTS.map((sel) => { const el = $(sel, root); return el && el.offsetWidth ? { r: textRect(el), box: rect(el), fs: px(el, 'fontSize') } : null; });
  // 日文那一行里各飞各的「字」：普通的字一个字一个；带注音的汉字连同注音是一个（拆不开）
  const unitsOf = (root) => { const jp = $('.jp', root); return jp ? $$('.seg', jp).flatMap((seg) => (seg.firstElementChild?.tagName === 'RUBY' ? [seg] : $$('.ch', seg))) : []; };
  // 一个字在哪：量字本身（带注音的量第一个汉字），不量外面的框——框的高矮在两个样式里不一样，字本身才对得上
  const at = (u) => textRect(u.classList.contains('ch') ? u : $('.ch', u) || u);
  const seen = (r) => r.width > 0 || r.height > 0; // 折行处被吃掉的空格量出来是空的
  // 罗马音、翻译这两行是整段文字，没有按字包起来：直接量文字里每个字在哪（不用改页面）。不是单纯一段文字就返回 null
  const charRects = (el) => {
    const node = el?.childNodes.length === 1 && el.firstChild.nodeType === 3 ? el.firstChild : null;
    if (!node) return null;
    const rg = document.createRange();
    return Array.from({ length: node.length }, (_, i) => { rg.setStart(node, i); rg.setEnd(node, i + 1); return rg.getBoundingClientRect(); });
  };
  // 把一行文字切成几段，每一段在两个样式里都各自落在同一排上：这样的一段可以整段平移过去，不会变形。
  // 两个样式折行的地方一样（或者都没折行）时就只有一段
  const rowsOf = (rs) => { let row = 0, top = null; return rs.map((r) => { if (seen(r)) { if (top !== null && r.top > top + r.height * 0.5) row++; top = r.top; } return row; }); };
  const splitRuns = (a, b) => {
    const ra = rowsOf(a), rb = rowsOf(b), out = [];
    for (let i = 1, from = 0; i <= a.length; i++) if (i === a.length || ra[i] !== ra[from] || rb[i] !== rb[from]) { out.push([from, i]); from = i; }
    return out;
  };
  // 这个字所在的词的标注线画在多高：词的框的下沿。不能直接用字的下沿——逐字歌词里唱到的字是抬起来的，线却不跟着抬。
  // 词折成两行时框也分成两段，取字所在的那一段
  const lineY = (u, c) => {
    const hit = [...(u.closest('.tok')?.getClientRects() || [])].filter((r) => c.left >= r.left - 1 && c.right <= r.right + 1);
    return hit.length ? hit.reduce((a, b) => (Math.abs(b.bottom - c.bottom) < Math.abs(a.bottom - c.bottom) ? b : a)).bottom : c.bottom;
  };
  // 之前
  const a0 = rect(artEl), rad0 = px(artEl, 'borderTopLeftRadius'), sh0 = getComputedStyle(artEl).boxShadow, m0 = rect(metaEl), f0 = px($('#title'), 'fontSize');
  // 封面自己可能带着缩放：滚动样式下暂停时它会缩小（style.css 里写在 transform 上），大字样式下鼠标悬停时会放大。
  // k0 = 它现在看上去是排版尺寸的多少倍，折算圆角和阴影时要用
  const k0 = a0.width / (artEl.offsetWidth || a0.width);
  const oldLine = toScroll ? cur : elScroll.children[a];
  let t0 = S.lines[a] && !S.lines[a].gap && oldLine ? measure(oldLine) : null;
  if (t0?.[0] && !toScroll) { const box = rect($('#lyrics')); if (t0[0].r.bottom < box.top || t0[0].r.top > box.bottom) t0 = null; } // 自己划走了、当前句不在屏幕上：这一句不飞
  const u0 = t0?.[0] ? unitsOf(oldLine).map(at) : [];
  const y0 = t0?.[0] ? unitsOf(oldLine).map((u, k) => lineY(u, u0[k])) : [];
  const c0 = t0?.[0] ? PARTS.map((sel, k) => (k && t0[k] ? charRects($(sel, oldLine)) : null)) : [];
  // 原来的播放器和歌词各留一份替身，盖在原处（样式靠 id 和外层的 class 对上，所以外层抄一份 #app 的 class）
  $('#morph-ghost')?.remove();
  const ghost = document.createElement('div');
  ghost.id = 'morph-ghost'; ghost.className = app.className; ghost.setAttribute('aria-hidden', 'true');
  for (const id of ['#player', toScroll ? '#focus' : '#lyrics']) {
    const src = $(id), r = rect(src), c = src.cloneNode(true);
    c.style.cssText = `left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px;`;
    ghost.append(c);
  }
  const scroll0 = elScroll.scrollTop;
  // 换样式
  // 封面飞的这一会儿不认鼠标悬停（原因见 style.css 的 .nohover）；飞完以后鼠标一动就恢复
  artEl.classList.add('nohover');
  document.removeEventListener('mousemove', morphHover);
  morphHover = () => {
    if (performance.now() < landed) return;
    artEl.classList.remove('nohover');
    document.removeEventListener('mousemove', morphHover);
  };
  const landed = performance.now() + MORPH.ms;
  document.addEventListener('mousemove', morphHover);
  // 换样式的这一下，封面自带的那个缩放直接到位，不走它自己的过渡（滚动样式下 transform 上挂着 0.7 秒带回弹的过渡）：
  // 不然量到的是过渡刚起步时的位置，飞到那里以后它还要再缩一截
  artEl.style.transition = 'none';
  prefs.view = to; savePrefs(); applyPrefs();
  clearTimeout(freeTimer); elScroll.classList.remove('free');
  for (const an of glideAnims) an.cancel();
  glideAnims = [];
  collectFill();
  jumpToActive();
  cur.style.animation = 'none'; // 大字那句自带的「浮上来」这次不要，会和飞行打架（下次换句时 renderFocus 会把它恢复）
  document.body.append(ghost);
  if (!toScroll) $('#scroll', ghost).scrollTop = scroll0; // 复制出来的滚动框不带滚动位置
  // 之后
  const a1 = rect(artEl), m1 = rect(metaEl), f1 = px($('#title'), 'fontSize'), s = a0.width / a1.width;
  const opt = { duration: MORPH.ms, easing: MORPH.easing };
  const optT = { ...opt, fill: 'both' }; // 飞着的字、标注线：飞完停在落点上，等真的那一句换上来
  requestAnimationFrame(() => { artEl.style.transition = ''; }); // 位置量完了（上面那行已经按「直接到位」算过样式），过渡还回去
  artEl.style.zIndex = 3;
  // 用 translate / scale，不碰 transform：封面自带的缩放写在 transform 上，两样叠在一起，落地时正好就是它该有的样子。
  // 两样都是绕着封面的中心缩放的，所以平移按中心点算。f = 起步时封面一共被放大 / 缩小了多少倍，圆角和阴影按它折算回去
  const w1 = artEl.offsetWidth || a1.width, f = a0.width / w1 / k0;
  artEl.animate([
    { translate: `${a0.left + a0.width / 2 - a1.left - a1.width / 2}px ${a0.top + a0.height / 2 - a1.top - a1.height / 2}px`, scale: s, borderRadius: `${rad0 / f}px`, boxShadow: scalePx(sh0, f) },
    { translate: '0 0', scale: 1, borderRadius: `${px(artEl, 'borderTopLeftRadius')}px`, boxShadow: getComputedStyle(artEl).boxShadow },
  ], opt).onfinish = () => { artEl.style.zIndex = ''; };
  metaEl.animate([{ transformOrigin: '0 0', transform: `translate(${m0.left - m1.left}px, ${m0.top - m1.top}px) scale(${f0 / f1})` }, { transformOrigin: '0 0', transform: 'none' }], opt);
  const fadeOut = (el) => el.animate([{}, { opacity: 0 }], { duration: 220, easing: 'ease-in', fill: 'forwards' });
  const fadeIn = (el, delay = 180) => el.animate([{ opacity: 0 }, {}], { duration: 420, delay, easing: 'ease-out', fill: 'backwards' });
  fadeOut(ghost.children[0]);
  fadeIn($('#transport'));
  const newLine = toScroll ? elScroll.children[a] : cur;
  const t1 = t0?.[0] && newLine ? measure(newLine) : null;
  const units1 = t1?.[0] ? unitsOf(newLine) : [];
  const fly = units1.length > 0 && units1.length === u0.length;
  if (fly) {
    const u1 = units1.map(at);
    // 飞的那一份：照着新样式里的这一句抄一份，摆在同一个地方
    const F = newLine.cloneNode(true), r = rect(newLine);
    F.style.cssText = `left:${r.left}px;top:${r.top}px;width:${r.width}px;text-align:${getComputedStyle(newLine).textAlign};`;
    $('.ann', F)?.remove();
    ghost.append(F);
    const flying = [F]; // 飞的这一份连同它带着的标注线：落地时一起撤
    // 每个字要能单独挪动、缩放，得是 inline-block。这会让这一份的排版和真的那句有一点出入（比如折行的地方不同），
    // 所以不指望它，改完以后再量一遍每个字实际在哪（rest），起点和终点都按这个折算
    const us = unitsOf(F);
    for (const u of us) { u.style.display = 'inline-block'; u.style.whiteSpace = 'pre'; }
    // m：这个字自己身上的位移（唱到的字是抬着的）。它排在缩放的里面，起步时会跟着被放大 / 缩小 k 倍，要把多出来的那截扣掉
    const lift = (u) => { const tr = getComputedStyle(u).transform; return tr && tr !== 'none' ? new DOMMatrix(tr) : null; };
    const rest = us.map((u) => ({ box: rect(u), r: at(u), m: lift(u) }));
    const move = (L, from, to, k) => {
      const o = `${L.r.left - L.box.left}px ${L.r.top - L.box.top}px`;
      const mx = (L.m?.e || 0) * (1 - k), my = (L.m?.f || 0) * (1 - k);
      return [{ transformOrigin: o, translate: `${from.left - L.r.left + mx}px ${from.top - L.r.top + my}px`, scale: k }, { transformOrigin: o, translate: `${to.left - L.r.left}px ${to.top - L.r.top}px`, scale: 1 }];
    };
    // 用 translate / scale，不用 transform：逐字歌词里唱到的字靠 transform 抬着，两样叠在一起才和真的那句一模一样
    us.forEach((u, k) => { if (seen(u0[k]) && seen(u1[k]) && seen(rest[k].r)) u.animate(move(rest[k], u0[k], u1[k], t0[0].fs / t1[0].fs), optT); });
    // 罗马音、翻译：两个样式里折行的地方一样就整行飞；不一样（长句子常这样）就按折行切成几段，各段各飞各的。
    // 整行飞的话，起步时它已经是新样式的折法，和原来的形状对不上，看上去是先跳了一下再飞
    for (const k of [1, 2]) {
      const el = $(PARTS[k], F), p = t0[k], q = t1[k];
      if (!el || !q) continue;
      if (!p) { fadeIn(el); continue; } // 原来的样式里没有这一行：到了新样式才淡入
      const a0 = c0[k], a1 = charRects($(PARTS[k], newLine)), text = el.firstChild?.data;
      const runs = a0 && a1 && a0.length === a1.length && text?.length === a0.length && el.childNodes.length === 1 ? splitRuns(a0, a1) : [];
      if (runs.length < 2) { el.animate(move({ box: rect(el), r: textRect(el) }, p.r, q.r, p.fs / q.fs), optT); continue; }
      el.textContent = '';
      const spans = runs.map(([from, to]) => {
        const sp = document.createElement('span');
        sp.style.cssText = 'display:inline-block;white-space:pre;';
        sp.textContent = text.slice(from, to);
        el.append(sp);
        return sp;
      });
      // 每一段认准一个字来对位置：这一段里第一个在两个样式里都量得到的字（段首可能是折行处被吃掉的空格）
      const rg = document.createRange();
      const pin = spans.map((sp, n) => {
        const [from, to] = runs[n];
        let j = from;
        while (j < to - 1 && !(seen(a0[j]) && seen(a1[j]))) j++;
        rg.setStart(sp.firstChild, j - from); rg.setEnd(sp.firstChild, j - from + 1);
        return { j, box: rect(sp), r: rg.getBoundingClientRect() };
      });
      spans.forEach((sp, n) => { const L = pin[n]; if (seen(a0[L.j]) && seen(a1[L.j]) && seen(L.r)) sp.animate(move(L, a0[L.j], a1[L.j], p.fs / q.fs), optT); });
    }
    // 词下面的标注线：跟着字一起飞。线本来是画在整个词上的，而这一份的排版和真的那句会有出入（见上），
    // 照原样画的话线会落在错的地方，落地换成真的那句时再跳一下。所以这一份里词上的线不画，
    // 改成每个字底下各带一小段，和字走同一条路；落地时一段挨一段，正好拼成真的那句的线
    if (!app.classList.contains('no-ann')) {
      const box1 = units1.map(rect), y1 = units1.map((u, k) => lineY(u, u1[k])), k0 = t0[0].fs / t1[0].fs;
      for (const tok of $$('.tok.hg, .tok.hv', F)) tok.style.boxShadow = 'none';
      us.forEach((u, k) => {
        const tok = u.closest('.tok'), g = tok?.classList.contains('hg'), v = tok?.classList.contains('hv');
        const p = u0[k], q = u1[k], b = box1[k];
        if ((!g && !v) || !seen(p) || !seen(q)) return;
        // 线贴着词的框的下沿，2 像素粗；语法和词汇都有时词汇的在下、语法的叠在它上面
        [v ? 'vocab' : 'grammar', g && v ? 'grammar' : ''].forEach((color, up) => {
          if (!color) return;
          const bar = document.createElement('i'), top = y1[k] - 2 * (up + 1);
          bar.className = 'ul';
          bar.style.cssText = `left:${b.left - 0.3}px;top:${top}px;width:${b.width + 0.6}px;background:var(--${color});`;
          ghost.append(bar); // 挂在最外层：那一句自己带着滤镜，里面的东西没法按屏幕坐标定位
          flying.push(bar);
          // 起点：原来那个字底下同样的位置（那时字是现在的 k0 倍大，线也按这个倍数算）
          bar.animate([
            { transformOrigin: '0 0', translate: `${p.left + (b.left - q.left) * k0 - b.left}px ${y0[k] - 2 * (up + 1) * k0 - top}px`, scale: k0 },
            { transformOrigin: '0 0', translate: '0 0', scale: 1 },
          ], optT);
        });
      });
    }
    // 真的那一句（日文、罗马音、翻译）藏到落地为止；替身里原来那一句也藏起来，字正从那里飞走
    const gOld = toScroll ? $('#f-cur', ghost) : $('#scroll', ghost).children[a];
    let hide = null;
    for (const sel of PARTS) {
      hide = $(sel, newLine)?.animate([{ opacity: 0 }, { opacity: 0 }], { duration: MORPH.ms }) || hide;
      const g = gOld && $(sel, gOld);
      if (g) g.style.visibility = 'hidden';
    }
    // 落地：真的那一句现出来的同一帧，把飞的这一份撤掉。两样不能同时在屏幕上——还没唱到的字、注音、翻译都是半透明的，
    // 叠两层就亮了一截，撤掉一层又暗回去，看上去是整句闪了一下；实心的字叠两层边缘也会变粗一下。
    // 「藏着」的动画结束时浏览器先发这个事件、再画这一帧，所以在这里撤正好是同一帧
    if (hide) hide.onfinish = () => { for (const el of flying) el.remove(); };
    morphFus = { a, els: $$('.fu', F).map((el) => ({ el, rk: rkOf(el) })) };
  }
  if (toScroll) {
    for (const el of $$('#f-prev, #f-ann, #f-next', ghost)) fadeOut(el);
    if (!fly) fadeOut($('#f-cur', ghost));
    else if ($('.ann', newLine)) fadeIn($('.ann', newLine), 260);
    // 其余的歌词：离当前句越远的越晚一点浮现
    const [lo, hi] = visibleRange(0);
    for (let k = lo; k <= hi; k++) {
      if (fly && k === a) continue;
      elScroll.children[k].animate([{ opacity: 0, translate: '0 14px' }, {}], { duration: 520, delay: 140 + Math.min(Math.abs(k - a), 8) * 45, easing: 'cubic-bezier(.2, .8, .2, 1)', fill: 'backwards' });
    }
  } else {
    if (!fly) fadeIn(cur, 120);
    fadeOut(ghost.children[1]);
    for (const id of ['#f-prev', '#f-ann', '#f-next']) fadeIn($(id), 240);
  }
  // 收尾：别的替身这时早就淡完了，连同外层一起撤掉（飞的那一份在落地的那一帧已经自己撤了，见上）
  setTimeout(() => { ghost.remove(); if (morphFus?.els[0] && !morphFus.els[0].el.isConnected) morphFus = null; }, MORPH.ms + 60);
}

// ---------------- 使用指引 ----------------
// 第一次打开时自动放一遍；看完或跳过就记在偏好里（prefs.guide），以后只在设置里点「再看一遍」才出现。
// 它只认这一个记号，和词汇书、读音修正这些数据没有关系。
function showGuide() {
  if (prefs.view === 'ktv') setView('apple'); // 指引讲的是滚动 / 大字两个样式，KTV 样式下没有它要指的东西
  $$('.modal, .drawer, .popover').forEach((el) => { el.hidden = true; });
  $('#btn-menu').classList.remove('on');
  hideSensePop();
  startGuide(() => { prefs.guide = 1; savePrefs(); });
}
$('#set-guide').addEventListener('click', showGuide);

// ---------------- 弹出 / 收起的动效 ----------------
// 抽屉、弹窗、菜单、记词栏原来都是直接 hidden = true / false，出现有动画、消失是一下子没了。
// 这里接管这几个元素的 hidden：设成显示时照常显示（出现的动画写在 CSS 里）；
// 设成隐藏时先加 .leaving 放收起的动画，放完再真的藏起来。
// 读 hidden 拿到的是「要变成的样子」，所以别处的 if (!$('#vocab').hidden) 这类判断不受影响
const HIDDEN = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'hidden');
// 布局变化时让元素从旧位置滑到新位置（FLIP）：先记下位置，做改动，再从旧位置弹回新位置
function flip(els, mutate) {
  const items = els.map((el) => [el, el.getBoundingClientRect()]).filter(([, r]) => r.width > 0);
  mutate();
  if (noMotion.matches) return;
  for (const [el, a] of items) {
    const b = el.getBoundingClientRect();
    if (!b.width) continue;
    const dx = a.left - b.left, dy = a.top - b.top;
    if (Math.abs(dx) < .5 && Math.abs(dy) < .5) continue;
    // 用 translate 属性而不是 transform：封面暂停时的缩小用的是 transform，两样叠在一起互不干扰
    el.animate([{ translate: `${dx}px ${dy}px` }, { translate: '0 0' }], { duration: 560, easing: 'cubic-bezier(.34, 1.25, .5, 1)' });
  }
}
// 记词栏占着窗口底部的位置：它出现 / 收起时播放器那块变矮 / 变高，封面和歌名会重新居中。让它们滑过去而不是跳过去
const playerParts = () => ['#art-wrap', '#meta', '#transport'].map((q) => $(q));
function animateHidden(el, leaveMs, wrap = (f) => f()) {
  let target = HIDDEN.get.call(el), timer = 0;
  Object.defineProperty(el, 'hidden', {
    configurable: true,
    get: () => target,
    set(v) {
      v = !!v;
      if (v === target) return;
      target = v;
      clearTimeout(timer);
      if (!v) { el.classList.remove('leaving'); wrap(() => HIDDEN.set.call(el, false)); }
      else if (noMotion.matches || HIDDEN.get.call(el)) HIDDEN.set.call(el, true);
      else {
        el.classList.add('leaving');
        timer = setTimeout(() => { el.classList.remove('leaving'); wrap(() => HIDDEN.set.call(el, true)); }, leaveMs);
      }
      el.dispatchEvent(new Event('uta:toggle'));
    },
  });
}
for (const [sel, ms] of [['#vocab', 280], ['#queue', 280], ['#library', 280], ['#settings-modal', 240], ['#source-modal', 240], ['#menu', 180], ['#follow-pop', 200]]) animateHidden($(sel), ms);
animateHidden($('#dictbar'), 260, (change) => flip(playerParts(), change));

// ---------------- 启动 ----------------
applyPrefs();
updateOffsetLabel();
setStatus('正在连接播放器…');
// 播放器是哪个：改掉界面上写着 Apple Music 的地方；网易云模式下藏起资料库、随机播放和播放列表
api.get('/api/info').then((i) => {
  if (!i.player) return;
  Object.assign(PLAYER, { id: i.player, name: i.playerName, caps: i.caps });
  // 在 macOS App 里运行：界面就是 App 自己的窗口，「用哪个浏览器打开」的设置用不上
  if (i.app) {
    const row = $('#set-browser').closest('.form-row');
    row.hidden = true;
    if (row.nextElementSibling?.matches('p.muted')) row.nextElementSibling.hidden = true;
  }
  if (!S.track && !S.player) setStatus(`正在连接 ${PLAYER.name}…`);
  $('#btn-library').title = `${PLAYER.name} 资料库`;
  for (const sel of ['#btn-library', '#btn-shuffle', '#btn-queue']) $(sel).hidden = sel === '#btn-library' ? !PLAYER.caps.library : !PLAYER.caps.queue;
  if (S.player) onState(S.player);
}).catch(() => {});
// 程序退出了（在设置里点了退出，或从程序坞退出）：盖上提示，不再重连
function showBye() {
  es.close();
  $$('.modal, .drawer, .popover').forEach((el) => { el.hidden = true; });
  $('#bye').hidden = false;
  setTimeout(() => window.close(), 600); // 独立窗口能直接关掉；普通标签页关不了，就留着提示
}
$('#set-quit').addEventListener('click', async () => {
  $('#set-quit').disabled = true;
  try { await api.post('/api/quit', {}); } catch (e) { $('#set-quit').disabled = false; return toast(`退出失败：${e.message}`); }
  showBye();
});
// ---------- 逐字歌词的注音高度 ----------
// 逐字歌词里汉字和注音都摆成 inline-block（各自填色、各自抬起，见 jpHTML 和 style.css 的 .timed ruby），
// 浏览器照盒子而不是照字形来贴注音，注音会比普通歌词里的高出一小截，高多少取决于字体和浏览器。
// 这里各摆一个量出差值，交给样式收回来（style.css 的 .timed rt）：先用 --rks-fix 把注音往下收（连带把被撑高的这一行收回去），
// 收不完的零头再用 --rks-top 挪。逐字歌词里所有注音结构相同、收的量也相同，所以彼此总是对齐的。
function calibrateRuby() {
  const root = document.documentElement;
  root.style.removeProperty('--rks-fix');
  root.style.removeProperty('--rks-top');
  // 用很大的字来量：差值只有几个像素，浏览器摆的时候会取整，字小了量不准
  // 结构照着真的歌词行来（.jp > .tok > .seg），外面那几层的行高也会影响注音摆在哪
  const sample = '<span class="jp"><span class="tok"><span class="seg k fu" style="font-size:120px"><ruby><span class="ch">漢</span><span class="ch">字</span><rt><span class="rw">かんじ</span></rt></ruby></span></span></span>';
  const make = (cls) => {
    const box = document.createElement('div');
    box.className = cls;
    box.lang = 'ja';
    box.setAttribute('aria-hidden', 'true');
    box.style.cssText = 'position:absolute;left:-9999px;top:0;visibility:hidden;pointer-events:none;white-space:nowrap;animation:none;transition:none';
    box.innerHTML = sample;
    ($('#lyrics') || document.body).appendChild(box);
    return box;
  };
  const timed = make('line active timed'), plain = make('line active');
  const top = (el) => { const r = document.createRange(); r.selectNodeContents(el); return r.getBoundingClientRect().top; };
  const dist = (box) => top(box.querySelector('.ch')) - top(box.querySelector('rt')); // 注音离汉字多远
  const gap = () => dist(timed) - dist(plain);
  const fs = parseFloat(getComputedStyle(timed.querySelector('rt')).fontSize) || 0;
  const d = fs ? gap() : 0;
  if (Math.abs(d) >= 0.25 && Math.abs(d) < fs) {
    root.style.setProperty('--rks-fix', (d / fs).toFixed(3));
    const rest = gap();
    if (Math.abs(rest) >= 0.25 && Math.abs(rest) < fs) root.style.setProperty('--rks-top', (rest / fs).toFixed(3));
  }
  timed.remove();
  plain.remove();
}
calibrateRuby();
document.fonts?.ready.then(calibrateRuby); // 字体换成真正要用的那个以后再量一次

// 地址里带 ?app=1 的是程序自己打开的界面窗口：告诉服务端，它才知道界面窗口还在不在
const es = new EventSource(`/api/events${new URLSearchParams(location.search).has('app') ? '?app=1' : ''}`);
es.onmessage = (e) => onState(JSON.parse(e.data));
es.onerror = () => { if (!S.track) setStatus('和本地服务的连接断开了，请确认程序仍在运行。'); };
// 服务重启过（比如更新到了新版）：重新连上后自动刷新页面，换上新界面
let bootId = 0;
es.onopen = () => api.get('/api/info').then((i) => {
  if (bootId && i.boot && i.boot !== bootId) location.reload();
  bootId = i.boot || bootId;
}).catch(() => {});
requestAnimationFrame(frame);
// 还没看过指引：等界面先出来再放。地址加 ?guide 可以强制放一遍；调试入口（?debug）默认不放，免得挡住测试
{
  const q = new URLSearchParams(location.search);
  if (q.has('guide') || (!prefs.guide && !q.has('debug'))) setTimeout(showGuide, 900);
}
// 调试入口：地址加 ?debug 后可在控制台用 __uta.onState(...) 模拟播放状态
if (new URLSearchParams(location.search).has('debug')) { es.close(); window.__uta = { onState, S, clock, prefs, tick, stepReading, setView }; }

// 不让拖动歌词、图片：选中的歌词一拖就成了「拖放」，WebKit 会在页面上画插入光标（Mac App 里像一条紫线）
document.addEventListener('dragstart', (e) => {
  const el = e.target.nodeType === 1 ? e.target : e.target.parentElement;
  if (!el?.closest('input, textarea, [contenteditable]')) e.preventDefault();
});
// ⌘A 只在输入框里全选：别处按下去不再把整个界面选中（按钮、顶部栏的字会出现选中时的灰底）
document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && (e.key === 'a' || e.key === 'A')
    && !e.target.closest?.('input, textarea, [contenteditable]')) e.preventDefault();
});

// 检查更新：每次打开界面问一次本地服务（服务每次启动只去 GitHub 查一次）。有新版本就在顶上露一条，
// 点「以后再说」就不再提醒这个版本（下一个新版本还会提醒）
let isApp = false;
function showUpdate(u) {
  if (!u?.newer || !u.latest) return;
  try { if (localStorage.getItem('uta-skip-update') === u.latest) return; } catch {}
  $('#update-bar')?.remove();
  const bar = document.createElement('div');
  bar.id = 'update-bar';
  bar.setAttribute('role', 'status');
  const link = `<a class="ub-go" href="${esc(u.page)}" target="_blank" rel="noopener">下载新版</a>`;
  // Mac App：能自己换上新版就给「立即更新」，不能（比如 App 放在写不进去的地方）就打开下载页；浏览器里用的：复制更新命令
  const act = isApp && u.canInstall ? '<button class="ub-go ub-install" type="button">立即更新</button>'
    : isApp && (u.download || u.page) ? link
    : '<button class="ub-go" type="button">复制更新命令</button>';
  bar.innerHTML = `<span class="ub-text">有新版本 <b>v${esc(u.latest)}</b>（当前 v${esc(u.current)}）</span>${act}<button class="ub-later" type="button">以后再说</button>`;
  document.body.append(bar);
  const close = () => { bar.classList.add('leaving'); setTimeout(() => bar.remove(), 220); };
  bar.querySelector('.ub-later').addEventListener('click', () => { try { localStorage.setItem('uta-skip-update', u.latest); } catch {} close(); });
  const go = bar.querySelector('.ub-go');
  const text = bar.querySelector('.ub-text');
  if (go.classList.contains('ub-install')) go.addEventListener('click', async () => {
    go.disabled = true; bar.querySelector('.ub-later').hidden = true;
    bar.classList.add('busy');
    text.textContent = '正在下载新版…';
    const failed = (msg) => {
      bar.classList.remove('busy');
      text.textContent = `自动更新没成功：${msg}`;
      go.outerHTML = link;
      bar.querySelector('.ub-go').addEventListener('click', () => toast('下载后解压，替换「应用程序」里的旧版即可'));
      bar.querySelector('.ub-later').hidden = false;
    };
    try { await api.post('/api/update/install', {}); } catch (e) { return failed(e.message); }
    const tick = async () => {
      let p;
      try { p = await api.get('/api/update/progress'); } catch { text.textContent = '正在重启…'; return; } // 服务已经退出：在换新版了
      if (p.phase === 'error') return failed(p.error);
      text.textContent = p.phase === 'download' ? `正在下载新版 ${p.pct}%` : p.phase === 'unpack' ? '正在核对新版…' : p.phase === 'restart' ? '正在重启…' : '正在准备…';
      if (p.phase !== 'restart') setTimeout(tick, 400);
    };
    tick();
  });
  else if (go.tagName === 'BUTTON') go.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(u.install); toast('已复制：粘贴到「终端」里运行，词汇书和设置会保留'); }
    catch { toast(u.install); }
  });
  else go.addEventListener('click', () => toast('下载后解压，替换「应用程序」里的旧版即可'));
}
api.get('/api/info').then((i) => { isApp = !!i.app; return api.get('/api/update'); }).then(showUpdate).catch(() => {});
