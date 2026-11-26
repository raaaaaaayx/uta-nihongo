// 唱歌学日语 — 本地服务：静态页面 + API（只监听本机）
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, execFile } from 'node:child_process';
import {
  ROOT, getSettings, saveSettings, getSongMeta, saveSongMeta,
  getUserDict, saveUserDict, getVocab, saveVocab, getMarks, saveMarks, readJSON, writeJSON, dataPath,
} from './store.js';
import * as appleMusic from './music.js';
import * as netease from './netease.js';
import * as auto from './auto.js';
import { findCandidates, pickBest, fetchLyrics, withQrc, lyricFlags } from './lyrics.js';
import { analyzeLyrics, getTokenizer } from './japanese.js';
import { ensureDesktopShortcut } from './shortcut.js';
import { createQueue } from './queue.js';
import { showUI, installedBrowsers, pickBrowser } from './window.js';
import { notoCSS, notoFile } from './fonts.js';
import { checkUpdate, installUpdate, progress as updateProgress } from './update.js';
import { lookupWords, annotateWithAI, getAICache, aiAvailable, describeAIError, resetDictCache } from './annotate.js';

const PORT = Number(process.env.PORT) || 3939;
// 用哪个播放器：自动（默认：Apple Music 和网易云哪个在播跟哪个）、只用 Apple Music、只用网易云。
// 设置里改了以后重启程序生效；环境变量 UTA_PLAYER 优先
const PLAYERS = { auto, apple: appleMusic, netease };
const wanted = process.env.UTA_PLAYER || getSettings().player || 'auto';
const PLAYER = wanted in PLAYERS ? wanted : 'auto';
const music = PLAYERS[PLAYER];

// 版本信息：电脑上可能有不止一份程序，界面和启动脚本靠它分辨正在运行的是哪一份
function readVersion() {
  try {
    const git = (...args) => execFileSync('git', ['-C', ROOT, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const tags = git('tag', '--points-at', 'HEAD').split('\n').filter(Boolean).join(' '); // 打在这个版本上的标记（v1.0.0、ob-…）
    return git('log', '-1', '--format=%h · %cs') + (tags ? ` · ${tags}` : '');
  } catch {
    try { return 'v' + JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version; } catch { return ''; }
  }
}
const VERSION = readVersion();
const BOOT = Date.now(); // 每次启动都不同：界面靠它发现「服务已换成新版」并自动刷新
const RESTART_CODE = 75; // 启动脚本看到这个退出码会立刻重新启动（即换上磁盘里的新代码）
const PUBLIC = path.join(ROOT, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json' };

// ---------------- 小工具 ----------------
function send(res, status, body, type = 'application/json; charset=utf-8') {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(data);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', (c) => { buf += c; if (buf.length > 8e6) req.destroy(); });
    req.on('end', () => { try { resolve(buf ? JSON.parse(buf) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}
const songKey = (track) => track.pid || 'h' + crypto.createHash('sha1').update(`${track.name}|${track.artist}`).digest('hex').slice(0, 16);
const slimCand = (c) => c && { source: c.source, id: c.id, songId: c.songId, title: c.title, artists: c.artists, album: c.album, duration: c.duration, cover: c.cover, score: c.score, flags: c.flags, auto: c.auto };

// ---------------- 歌曲载入：歌词 → 分词注音 → 语法/AI 标注 ----------------
function attachAI(lines, ai) {
  if (!ai) return;
  for (const line of lines) {
    const a = ai.byText[line.text];
    if (!a) continue;
    const range = (text) => {
      const at = line.text.indexOf(text);
      if (at < 0) return null;
      let start = -1, end = -1;
      line.tokens.forEach((tok, ti) => {
        if (tok.i0 < at + text.length && tok.i0 + tok.s.length > at) { if (start < 0) start = ti; end = ti + 1; }
      });
      return start < 0 ? null : { start, end };
    };
    line.ai = {
      grammar: a.grammar.map((g) => ({ n: g.pattern, lv: g.level, zh: g.explanation, text: g.text, ...range(g.text) })).filter((g) => g.start !== undefined),
      vocab: a.vocab.map((v) => ({ text: v.text, b: v.base, r: v.reading, lv: v.level, zh: v.meaning, ...range(v.text) })).filter((v) => v.start !== undefined),
    };
  }
}

async function loadSong(track, { refresh = false } = {}) {
  const key = songKey(track);
  const meta = getSongMeta(key);
  let cand = meta.source;
  let lyrics = null;
  let error = null;
  let qqPool = null; // 这次自动找歌词时搜到的 QQ 条目（补逐字时用，省得再搜一遍）
  try {
    if (!cand || refresh) {
      const cands = await findCandidates(track);
      qqPool = cands.filter((c) => c.source === 'qq');
      // 网易云模式下知道正在播的这首在网易云里的 ID：直接用它的歌词，不靠搜索去猜
      if (track.neteaseId) {
        const exact = cands.find((c) => c.source === 'netease' && c.id === track.neteaseId);
        if (exact) exact.score = 999;
        else cands.unshift({ source: 'netease', id: track.neteaseId, title: track.name, artists: track.artist ? track.artist.split(' / ') : [], album: track.album || '', duration: track.duration || 0, cover: '', score: 999 });
      }
      const best = await pickBest(cands);
      if (best) { cand = { ...slimCand(best), auto: true }; saveSongMeta(key, { source: cand }); }
      else cand = null;
    }
    if (cand) lyrics = await fetchLyrics(cand, refresh);
    // 没有逐字时间的：用 QQ 音乐的逐字歌词补上（设置 → 更多 → 解析 QRC；补不了就还是原来那份）
    if (cand && lyrics) lyrics = await withQrc(lyrics, cand, track, { refresh, pool: qqPool, onLate: () => broadcast({ lyrics: key }) });
  } catch (e) { error = e.message; }

  const out = { key, track, source: cand, offset: meta.offset || 0, hiddenAnn: meta.hiddenAnn || [], senses: meta.senses || {}, lines: [], error, aiAvailable: aiAvailable(), ai: false };
  if (!lyrics || !lyrics.lines.length) return out;
  out.flags = lyricFlags(cand, lyrics);
  if (lyrics.flags.japanese) {
    const res = await analyzeLyrics(lyrics.lines, { kana: lyrics.kana, meta, userDict: getUserDict() });
    out.lines = res.lines;
    out.stats = res.stats;
    const ai = getAICache(`${cand.source}-${cand.id}`);
    if (ai) { attachAI(out.lines, ai); out.ai = true; }
  } else {
    out.lines = lyrics.lines.map((l) => ({ ...l, tokens: [{ s: l.text, i0: 0, b: l.text, pos: '', segs: [{ t: l.text }] }], grammar: [] }));
  }
  return out;
}

// ---------------- API 路由 ----------------
// UTA_NO_MUSIC=1（调试界面用）：不碰真正的 Apple Music，也不读写磁盘上的队列
const NO_MUSIC = !!process.env.UTA_NO_MUSIC;
const control = (...args) => (NO_MUSIC ? Promise.resolve('ok') : music.control(...args));
// 内置播放队列：一首播完后由它接着播下一首（见 queue.js）
const queue = createQueue({
  player: music.player,
  play: (pid) => control('playTrack', pid),
  seek: (sec) => control('seek', sec),
  load: () => (NO_MUSIC ? null : readJSON('queue.json', null)),
  save: (q) => { if (!NO_MUSIC) writeJSON('queue.json', q); },
});

// 缓存：能自动重新取回来的东西——歌词、封面、词典查询结果。
// 不算缓存（清除时不动）：词汇书、每首歌的读音修正 / 时间偏移 / 歌词源选择、设置、AI 讲解（重新生成要花钱）
const CACHE_DIRS = ['lyrics', 'artwork'];
const CACHE_FILES = ['dict-cache-v2.json'];
function cacheFiles() {
  const out = [];
  for (const d of CACHE_DIRS) {
    let names = [];
    try { names = fs.readdirSync(dataPath(d)); } catch { /* 还没有这个文件夹 */ }
    for (const n of names) out.push(dataPath(d, n));
  }
  for (const f of CACHE_FILES) out.push(dataPath(f));
  return out.flatMap((file) => { try { const st = fs.statSync(file); return st.isFile() ? [{ file, size: st.size }] : []; } catch { return []; } });
}

const sseClients = new Set();
// 给所有开着的界面发一条消息
const broadcast = (msg) => { for (const c of sseClients) c.write(`data: ${JSON.stringify(msg)}\n\n`); };
// 其中由程序自己打开的界面窗口（地址带 ?app=1）。别的页面（比如另外在浏览器里手动打开的）不算，
// 否则窗口明明关了，程序还以为它开着
const appClients = new Set();
music.player.on('state', (s) => {
  if (!sseClients.size) return;
  const msg = `data: ${JSON.stringify({ ...s, lag: Date.now() - s.ts, queue: queue.summary() })}\n\n`;
  for (const res of sseClients) res.write(msg);
});

const routes = {
  'GET /api/events': (req, res, q) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    res.write(`data: ${JSON.stringify({ ...music.player.state, queue: queue.summary() })}\n\n`);
    sseClients.add(res);
    if (q.has('app')) appClients.add(res);
    req.on('close', () => { sseClients.delete(res); appClients.delete(res); });
  },
  // 显示界面（双击桌面图标、点程序坞图标时由启动脚本调用）：界面窗口还开着就把它叫到前面，
  // 没有就用设置里选的浏览器开一个。fresh=true：不管有没有都新开一个（换浏览器时用）
  'POST /api/show': async (req, res) => {
    const { fresh } = await readBody(req);
    const old = [...appClients];
    const action = await showUI({ url: `http://localhost:${PORT}`, setting: getSettings().browser, hasWindow: appClients.size > 0, fresh: !!fresh });
    if (action === 'focused') for (const c of appClients) c.write(`data: ${JSON.stringify({ focus: true })}\n\n`);
    // 换浏览器重新打开时：等新窗口出来，让原来的界面窗口自己关掉
    else if (fresh) setTimeout(() => { for (const c of old) c.write(`data: ${JSON.stringify({ close: true })}\n\n`); }, 1500);
    send(res, 200, { ok: true, action });
  },
  'GET /api/library': async (req, res, q) => send(res, 200, await music.getLibrary(q.get('playlist') || '', q.has('refresh'))),
  'GET /api/playlists': async (req, res) => send(res, 200, await music.getPlaylists()),
  'GET /api/artwork': async (req, res, q) => {
    // 调试时（UTA_NO_MUSIC）当前曲目是假的，没有封面可取；按编号取资料库里的封面只是读，不受影响
    if (process.env.UTA_NO_MUSIC && q.has('current')) return send(res, 404, { error: 'no music' });
    const art = q.has('thumb') ? await music.getThumb(q.get('pid') || '') : await music.getArtwork(q.get('pid') || '', q.has('current'));
    if (!art) return send(res, 404, { error: 'no artwork' });
    res.writeHead(200, { 'Content-Type': art.type, 'Cache-Control': 'max-age=86400' });
    fs.createReadStream(art.file).pipe(res);
  },
  // 「仅日文」的手动标记（按歌手）。ja: true = 标为日文，其他 = 去掉标记、恢复自动判断；all = 整份替换
  'GET /api/marks': (req, res) => send(res, 200, getMarks()),
  'POST /api/marks': async (req, res) => {
    const { artist, ja, all } = await readBody(req);
    let marks = getMarks();
    if (all && typeof all === 'object') {
      marks = {};
      for (const m of Object.values(all)) {
        const name = String(m?.name || '').trim();
        if (name && m.ja) marks[name.toLowerCase()] = { name, ja: true, at: Number(m.at) || Date.now() };
      }
    } else {
      const name = String(artist || '').trim();
      if (!name) return send(res, 400, { error: '缺少歌手名' });
      if (ja) marks[name.toLowerCase()] = { name, ja: true, at: Date.now() };
      else delete marks[name.toLowerCase()];
    }
    saveMarks(marks);
    send(res, 200, marks);
  },
  'POST /api/control': async (req, res) => {
    const { cmd, a, b } = await readBody(req);
    // 有播放队列时，上一首 / 下一首走队列；否则交给 Apple Music 自己
    if (cmd === 'next' && queue.active()) await queue.next();
    else if (cmd === 'prev' && queue.active()) await queue.prev(music.player.state.pos || 0);
    else await control(cmd, a ?? '', b ?? '');
    send(res, 200, { ok: true });
  },
  // 播放队列
  'GET /api/queue': (req, res, q) => send(res, 200, queue.view(Math.min(Number(q.get('n')) || 150, 5000))),
  'POST /api/queue/play': async (req, res) => {
    if (!music.caps.queue) return send(res, 400, { error: `${music.NAME}模式下不能从这里点歌，请在${music.NAME}里选歌` });
    const ok = await queue.playList(await readBody(req));
    send(res, ok ? 200 : 400, ok ? queue.summary() : { error: '这份列表里没有能播放的歌' });
  },
  'POST /api/queue/jump': async (req, res) => {
    const ok = await queue.jump((await readBody(req)).pid);
    send(res, ok ? 200 : 400, ok ? queue.summary() : { error: '这首歌不在播放列表里' });
  },
  'POST /api/queue/shuffle': async (req, res) => { queue.setShuffle(!!(await readBody(req)).on); send(res, 200, queue.summary()); },
  'POST /api/queue/repeat': async (req, res) => { queue.setRepeat(!!(await readBody(req)).on); send(res, 200, queue.summary()); },

  'GET /api/song': async (req, res, q) => {
    const track = { pid: q.get('pid') || '', name: q.get('name') || '', artist: q.get('artist') || '', album: q.get('album') || '', duration: Number(q.get('duration')) || 0 };
    const ne = /^ne-(\d+)$/.exec(track.pid);
    if (ne) track.neteaseId = ne[1];
    send(res, 200, await loadSong(track, { refresh: q.has('refresh') }));
  },
  'GET /api/candidates': async (req, res, q) => {
    const track = { name: q.get('name') || '', artist: q.get('artist') || '', duration: Number(q.get('duration')) || 0 };
    const cands = await findCandidates(track, q.get('q') || '');
    await Promise.all(cands.slice(0, 8).map(async (c) => {
      try { c.flags = lyricFlags(c, await fetchLyrics(c)); } catch { /* 忽略单个失败 */ }
    }));
    send(res, 200, cands.map(slimCand));
  },
  'POST /api/song/source': async (req, res) => {
    const { key, cand } = await readBody(req);
    saveSongMeta(key, { source: cand ? { ...cand, auto: false } : null });
    send(res, 200, { ok: true });
  },
  'POST /api/song/annotation': async (req, res) => {
    // 在这首歌里隐藏 / 恢复某个标注；ann 形如 'v:イイ'、'g:〜てみる'
    const { key, ann, hidden } = await readBody(req);
    const set = new Set(getSongMeta(key).hiddenAnn || []);
    if (hidden) set.add(String(ann)); else set.delete(String(ann));
    saveSongMeta(key, { hiddenAnn: [...set] });
    send(res, 200, { ok: true, hiddenAnn: [...set] });
  },
  'POST /api/song/sense': async (req, res) => {
    // 在这首歌里给某个词手动指定义项；sense 为 null 表示恢复自动；clear 为 true 表示清掉这首歌的全部手动选择
    const { key, ann, sense, clear } = await readBody(req);
    const senses = clear ? {} : { ...(getSongMeta(key).senses || {}) };
    if (clear) { /* 已清空 */ } else if (sense === null || sense === undefined) delete senses[ann]; else senses[ann] = String(sense);
    saveSongMeta(key, { senses });
    send(res, 200, { ok: true, senses });
  },
  'POST /api/song/offset': async (req, res) => {
    const { key, offset } = await readBody(req);
    saveSongMeta(key, { offset: Math.round(Number(offset) * 100) / 100 || 0 });
    send(res, 200, { ok: true });
  },
  'POST /api/song/reading': async (req, res) => {
    // scope: here（仅此处）/ song（本曲全部）/ global（所有歌曲）；reading 为 null 表示恢复自动
    const { key, scope, lineText, ti, si, seg, reading } = await readBody(req);
    const meta = getSongMeta(key);
    const posKey = `${lineText}#${ti}#${si}`;
    const readings = { ...meta.readings };
    const wordReadings = { ...meta.wordReadings };
    if (reading === null) {
      delete readings[posKey];
      delete wordReadings[seg];
      const d = getUserDict();
      if (seg in d) { delete d[seg]; saveUserDict(d); }
    } else if (scope === 'global') {
      saveUserDict({ ...getUserDict(), [seg]: reading });
      delete readings[posKey];
      delete wordReadings[seg];
    } else if (scope === 'song') {
      wordReadings[seg] = reading;
      delete readings[posKey];
    } else readings[posKey] = reading;
    saveSongMeta(key, { readings, wordReadings });
    send(res, 200, { ok: true });
  },

  'POST /api/dict': async (req, res) => {
    const { words, cachedOnly } = await readBody(req);
    // 只读本地缓存时不联网，一次可以把整首歌的词都问了
    send(res, 200, await lookupWords((words || []).slice(0, cachedOnly ? 5000 : 40), !!cachedOnly));
  },
  'POST /api/ai/annotate': async (req, res) => {
    const { source, lines } = await readBody(req);
    if (!aiAvailable()) return send(res, 400, { error: '还没有配置 Claude API Key（设置 → AI 讲解）' });
    try {
      await annotateWithAI(`${source.source}-${source.id}`, lines);
      send(res, 200, { ok: true });
    } catch (e) {
      send(res, 502, { error: describeAIError(e) });
    }
  },

  'GET /api/vocab': (req, res) => send(res, 200, getVocab()),
  'POST /api/vocab': async (req, res) => {
    const entry = await readBody(req);
    const list = getVocab();
    const item = { id: crypto.randomUUID(), addedAt: Date.now(), ...entry };
    list.unshift(item);
    saveVocab(list);
    send(res, 200, item);
  },
  'POST /api/vocab/update': async (req, res) => {
    const { id, ...patch } = await readBody(req);
    const list = getVocab().map((v) => (v.id === id ? { ...v, ...patch } : v));
    saveVocab(list);
    send(res, 200, { ok: true });
  },
  'POST /api/vocab/delete': async (req, res) => {
    const { id } = await readBody(req);
    saveVocab(getVocab().filter((v) => v.id !== id));
    send(res, 200, { ok: true });
  },
  'GET /api/vocab.csv': (req, res) => {
    const esc = (s) => `"${String(s ?? '').replace(/"/g, '""')}"`;
    const rows = [['单词', '读音', '释义', '例句（歌词）', '例句翻译', '歌曲', '歌手'].map(esc).join(',')];
    for (const v of getVocab()) rows.push([v.word, v.reading, v.meaning, v.line, v.zh, v.song?.name, v.song?.artist].map(esc).join(','));
    res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="vocab.csv"' });
    res.end('﻿' + rows.join('\n'));
  },

  'GET /api/update': async (req, res) => send(res, 200, await checkUpdate()),
  'GET /api/update/progress': (req, res) => send(res, 200, updateProgress),
  // 一键更新：马上回话，下载在后台进行，界面轮询进度；装好后整个 App 退出、由小脚本换上新版再打开
  'POST /api/update/install': (req, res) => {
    installUpdate(() => { for (const c of sseClients) c.write(`data: ${JSON.stringify({ bye: true, updating: true })}\n\n`); music.stopWatcher(); process.exit(0); })
      .catch((e) => Object.assign(updateProgress, { phase: 'error', error: e.message }));
    send(res, 200, { ok: true });
  },
  'GET /api/info': (req, res) => send(res, 200, { app: !!process.env.UTA_APP, player: PLAYER, playerName: music.NAME, caps: music.caps, root: ROOT, version: VERSION, boot: BOOT, clients: sseClients.size, windows: appClients.size }),
  // 更新代码后原地重启：退出并让启动脚本重新拉起。不是由启动脚本启动的（如 npm start）则只会退出。
  'POST /api/restart': (req, res) => {
    send(res, 200, { ok: true });
    setTimeout(() => { music.stopWatcher(); process.exit(RESTART_CODE); }, 150);
  },
  // 退出程序（设置里的按钮、程序坞图标的「退出」）：先告诉界面，再结束；启动脚本看到正常退出就不再重启
  'POST /api/quit': (req, res) => {
    send(res, 200, { ok: true });
    for (const c of sseClients) c.write(`data: ${JSON.stringify({ bye: true })}\n\n`);
    setTimeout(() => { music.stopWatcher(); process.exit(0); }, 200);
  },
  // 打开「系统设置 → 隐私与安全性 → 自动化」（第一次的授权询问被点了「不允许」之后，只能到这里手动打开）
  'POST /api/open-privacy': (req, res) => {
    execFile('open', ['x-apple.systempreferences:com.apple.preference.security?Privacy_Automation'], () => {});
    send(res, 200, { ok: true });
  },
  'GET /api/cache': (req, res) => {
    const files = cacheFiles();
    send(res, 200, { files: files.length, bytes: files.reduce((n, f) => n + f.size, 0) });
  },
  'POST /api/cache/clear': (req, res) => {
    const files = cacheFiles();
    let bytes = 0, removed = 0;
    for (const f of files) { try { fs.unlinkSync(f.file); bytes += f.size; removed++; } catch { /* 删不掉的跳过 */ } }
    resetDictCache();
    send(res, 200, { ok: true, files: removed, bytes });
  },
  'GET /api/settings': (req, res) => {
    const s = getSettings();
    send(res, 200, {
      model: s.model, hasKey: !!s.apiKey, keyTail: s.apiKey ? s.apiKey.slice(-4) : '', envKey: !!process.env.ANTHROPIC_API_KEY,
      player: ['apple', 'netease'].includes(s.player) ? s.player : 'auto', playerInUse: PLAYER,
      browser: s.browser || 'auto', browsers: installedBrowsers(), browserInUse: pickBrowser(s.browser),
      qrc: s.qrc !== false,
    });
  },
  'POST /api/settings': async (req, res) => {
    const body = await readBody(req);
    const patch = {};
    if (typeof body.apiKey === 'string') patch.apiKey = body.apiKey.trim();
    if (typeof body.model === 'string' && body.model.trim()) patch.model = body.model.trim();
    if (['auto', 'apple', 'netease'].includes(body.player)) patch.player = body.player;
    if (typeof body.qrc === 'boolean') patch.qrc = body.qrc;
    if (typeof body.browser === 'string' && (['auto', 'default'].includes(body.browser) || installedBrowsers().includes(body.browser))) patch.browser = body.browser;
    saveSettings(patch);
    send(res, 200, { ok: true });
  },
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const handler = routes[`${req.method} ${url.pathname}`];
  // 只接受本机页面发来的写操作，避免别的网站借浏览器向本地服务发请求
  const origin = req.headers.origin;
  if (req.method !== 'GET' && origin && !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return send(res, 403, { error: 'forbidden' });
  if (handler) {
    try { await handler(req, res, url.searchParams); }
    catch (e) { if (!res.headersSent) send(res, 500, { error: e.message }); else res.end(); }
    return;
  }
  if (req.method !== 'GET') return send(res, 404, { error: 'not found' });
  // 随程序带的日文字体（见 fonts.js）：样式表是现改现发的，字体文件按名字去包里取
  if (url.pathname === '/fonts/noto-sans-jp.css') return send(res, 200, notoCSS(), 'text/css; charset=utf-8');
  const font = /^\/fonts\/noto-sans-jp\/([^/]+)$/.exec(url.pathname);
  if (font) {
    const file = notoFile(font[1]);
    if (!file) return send(res, 404, 'Not found', 'text/plain');
    res.writeHead(200, { 'Content-Type': 'font/woff2', 'Cache-Control': 'public, max-age=86400' });
    return void fs.createReadStream(file).pipe(res);
  }
  const rel = path.normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '');
  let file = path.join(PUBLIC, rel === '/' || rel === '\\' ? 'index.html' : rel);
  if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return send(res, 404, 'Not found', 'text/plain');
  // no-store：界面文件都在本机、很小，不缓存。App 里的系统 WebKit 刷新页面时有时会沿用旧的样式 / 脚本，
  // 更新后界面没变；不缓存就一定拿到磁盘上的新文件
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  fs.createReadStream(file).pipe(res);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`唱歌学日语 已启动： http://localhost:${PORT}`);
  console.log(`播放器：${music.NAME}`);
  if (!process.env.UTA_NO_MUSIC) music.startWatcher(); // UTA_NO_MUSIC=1：不连接播放器（调试界面用）
  if (!process.env.UTA_NO_MUSIC && !process.env.UTA_NO_SHORTCUT) {
    ensureDesktopShortcut()
      .then((r) => {
        if (r === 'created') console.log('已在桌面创建「唱歌学日语」图标，以后双击它即可启动（不会再打开终端）。');
        else if (r === 'updated') console.log('桌面的「唱歌学日语」图标已更新。');
      })
      .catch((e) => console.error('桌面快捷方式创建失败（下次启动会重试）：', e.message));
  }
  getTokenizer().catch((e) => console.error('词典加载失败：', e.message));
});
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { music.stopWatcher(); process.exit(0); });
// Mac App 里的服务是 App 带起来的：App 没了（被强制退出、崩溃、被 kill）就跟着退出。
// 不然会留下一个没人管的后台服务，一直占着端口、连着播放器——它要是旧版本，还会和新开的那份抢着改网易云里的小助手
//（两边版本号不同就互相覆盖，进度被反复清零）。父进程没了以后 process.ppid 会变
if (process.env.UTA_APP) {
  const parent = process.ppid;
  setInterval(() => { if (process.ppid !== parent) { music.stopWatcher(); process.exit(0); } }, 3000).unref();
}
