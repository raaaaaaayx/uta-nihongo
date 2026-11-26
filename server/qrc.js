// QQ 音乐的逐字歌词（QRC）：解密 + 解析。
//
// QQ 的歌词接口带上 qrc:1, crypt:1 时，返回的歌词是一串十六进制的密文：
//   十六进制 → 每 8 字节一块，用「腾讯改过的三重 DES」解密 → 整体 zlib 解压 → UTF-8 文本。
// 密钥是固定的，所有歌共用。标准的三重 DES（node 自带的 des-ede3）解不开：S 盒、取位的字节序、密钥调度都有出入，
// 所以下面照着能解开的参考实现一位一位地做。
//
// 解密部分（下面到 decryptQrc 为止）译自 WXRIW/QQMusicDecoder 的 DESHelper.cs / Decrypter.cs（C#，MIT 许可）：
//   https://github.com/WXRIW/QQMusicDecoder
//
//   MIT License
//   Copyright (c) 2023 WXRIW
//
//   Permission is hereby granted, free of charge, to any person obtaining a copy
//   of this software and associated documentation files (the "Software"), to deal
//   in the Software without restriction, including without limitation the rights
//   to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
//   copies of the Software, and to permit persons to whom the Software is
//   furnished to do so, subject to the following conditions:
//
//   The above copyright notice and this permission notice shall be included in all
//   copies or substantial portions of the Software.
//
//   THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
//   IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
//   FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
//   AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
//   LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
//   OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
//   SOFTWARE.
import zlib from 'node:zlib';

const ENCRYPT = 1, DECRYPT = 0;

// 原实现里的数都是 32 位无符号整数。JS 的位运算结果是 32 位有符号数，所以右移一律用 >>>，最后再 >>> 0 变回无符号
// 从字节数组里取第 b 位，放到结果的第 c 位。字节是按「每 4 个一组、组内倒着」数的（小端的 32 位字）
const bitNum = (a, b, c) => (((a[Math.floor(b / 32) * 4 + 3 - Math.floor((b % 32) / 8)] >> (7 - (b % 8))) & 1) << c) >>> 0;
// 从一个 32 位数里取从高位数起的第 b 位，放到一个字节的第 c 位
const bitNumIntR = (a, b, c) => (((a >>> (31 - b)) & 1) << c) & 0xff;
// 从一个 32 位数里取从高位数起的第 b 位，放到结果从高位数起的第 c 位
const bitNumIntL = (a, b, c) => (((a << b) & 0x80000000) >>> c) >>> 0;
const sboxBit = (a) => (a & 0x20) | ((a & 0x1f) >> 1) | ((a & 0x01) << 4);

// 和标准 DES 的 S 盒有两处不同（第 2 个盒第 2 行、第 4 个盒第 4 行），照原样
const SBOX = [
  [14, 4, 13, 1, 2, 15, 11, 8, 3, 10, 6, 12, 5, 9, 0, 7,
    0, 15, 7, 4, 14, 2, 13, 1, 10, 6, 12, 11, 9, 5, 3, 8,
    4, 1, 14, 8, 13, 6, 2, 11, 15, 12, 9, 7, 3, 10, 5, 0,
    15, 12, 8, 2, 4, 9, 1, 7, 5, 11, 3, 14, 10, 0, 6, 13],
  [15, 1, 8, 14, 6, 11, 3, 4, 9, 7, 2, 13, 12, 0, 5, 10,
    3, 13, 4, 7, 15, 2, 8, 15, 12, 0, 1, 10, 6, 9, 11, 5,
    0, 14, 7, 11, 10, 4, 13, 1, 5, 8, 12, 6, 9, 3, 2, 15,
    13, 8, 10, 1, 3, 15, 4, 2, 11, 6, 7, 12, 0, 5, 14, 9],
  [10, 0, 9, 14, 6, 3, 15, 5, 1, 13, 12, 7, 11, 4, 2, 8,
    13, 7, 0, 9, 3, 4, 6, 10, 2, 8, 5, 14, 12, 11, 15, 1,
    13, 6, 4, 9, 8, 15, 3, 0, 11, 1, 2, 12, 5, 10, 14, 7,
    1, 10, 13, 0, 6, 9, 8, 7, 4, 15, 14, 3, 11, 5, 2, 12],
  [7, 13, 14, 3, 0, 6, 9, 10, 1, 2, 8, 5, 11, 12, 4, 15,
    13, 8, 11, 5, 6, 15, 0, 3, 4, 7, 2, 12, 1, 10, 14, 9,
    10, 6, 9, 0, 12, 11, 7, 13, 15, 1, 3, 14, 5, 2, 8, 4,
    3, 15, 0, 6, 10, 10, 13, 8, 9, 4, 5, 11, 12, 7, 2, 14],
  [2, 12, 4, 1, 7, 10, 11, 6, 8, 5, 3, 15, 13, 0, 14, 9,
    14, 11, 2, 12, 4, 7, 13, 1, 5, 0, 15, 10, 3, 9, 8, 6,
    4, 2, 1, 11, 10, 13, 7, 8, 15, 9, 12, 5, 6, 3, 0, 14,
    11, 8, 12, 7, 1, 14, 2, 13, 6, 15, 0, 9, 10, 4, 5, 3],
  [12, 1, 10, 15, 9, 2, 6, 8, 0, 13, 3, 4, 14, 7, 5, 11,
    10, 15, 4, 2, 7, 12, 9, 5, 6, 1, 13, 14, 0, 11, 3, 8,
    9, 14, 15, 5, 2, 8, 12, 3, 7, 0, 4, 10, 1, 13, 11, 6,
    4, 3, 2, 12, 9, 5, 15, 10, 11, 14, 1, 7, 6, 0, 8, 13],
  [4, 11, 2, 14, 15, 0, 8, 13, 3, 12, 9, 7, 5, 10, 6, 1,
    13, 0, 11, 7, 4, 9, 1, 10, 14, 3, 5, 12, 2, 15, 8, 6,
    1, 4, 11, 13, 12, 3, 7, 14, 10, 15, 6, 8, 0, 5, 9, 2,
    6, 11, 13, 8, 1, 4, 10, 7, 9, 5, 0, 15, 14, 2, 3, 12],
  [13, 2, 8, 4, 6, 15, 11, 1, 10, 9, 3, 14, 5, 0, 12, 7,
    1, 15, 13, 8, 10, 3, 7, 4, 12, 5, 6, 11, 0, 14, 9, 2,
    7, 11, 4, 1, 9, 12, 14, 2, 0, 6, 10, 13, 15, 3, 5, 8,
    2, 1, 14, 7, 4, 10, 8, 13, 15, 12, 9, 0, 3, 5, 6, 11],
];

const KEY_RND_SHIFT = [1, 1, 2, 2, 2, 2, 2, 2, 1, 2, 2, 2, 2, 2, 2, 1];
const KEY_PERM_C = [56, 48, 40, 32, 24, 16, 8, 0, 57, 49, 41, 33, 25, 17, 9, 1, 58, 50, 42, 34, 26, 18, 10, 2, 59, 51, 43, 35];
const KEY_PERM_D = [62, 54, 46, 38, 30, 22, 14, 6, 61, 53, 45, 37, 29, 21, 13, 5, 60, 52, 44, 36, 28, 20, 12, 4, 27, 19, 11, 3];
const KEY_COMPRESSION = [13, 16, 10, 23, 0, 4, 2, 27, 14, 5, 20, 9, 22, 18, 11, 3, 25, 7, 15, 6, 26, 19, 12, 1,
  40, 51, 30, 36, 46, 54, 29, 39, 50, 44, 32, 47, 43, 48, 38, 55, 33, 52, 45, 41, 49, 35, 28, 31];

// 一把 8 字节的密钥 → 16 轮的子密钥（每轮 6 字节）。解密时子密钥倒着排
function keySchedule(key, mode) {
  const schedule = Array.from({ length: 16 }, () => new Uint8Array(6));
  let C = 0, D = 0;
  for (let i = 0, j = 31; i < 28; ++i, --j) C = (C | bitNum(key, KEY_PERM_C[i], j)) >>> 0;
  for (let i = 0, j = 31; i < 28; ++i, --j) D = (D | bitNum(key, KEY_PERM_D[i], j)) >>> 0;
  for (let i = 0; i < 16; ++i) {
    const s = KEY_RND_SHIFT[i];
    C = (((C << s) | (C >>> (28 - s))) & 0xfffffff0) >>> 0;
    D = (((D << s) | (D >>> (28 - s))) & 0xfffffff0) >>> 0;
    const to = schedule[mode === DECRYPT ? 15 - i : i];
    let j = 0;
    for (; j < 24; ++j) to[j >> 3] |= bitNumIntR(C, KEY_COMPRESSION[j], 7 - (j % 8));
    for (; j < 48; ++j) to[j >> 3] |= bitNumIntR(D, KEY_COMPRESSION[j] - 27, 7 - (j % 8)); // 标准算法这里减的是 28
  }
  return schedule;
}

// 初始置换：8 个字节 → 两个 32 位数
function initialPermutation(input) {
  let s0 = 0, s1 = 0;
  for (let g = 0; g < 4; g++) {
    for (let k = 0; k < 8; k++) {
      const c = 31 - (g * 8 + k);
      s0 = (s0 | bitNum(input, 57 + 2 * g - 8 * k, c)) >>> 0;
      s1 = (s1 | bitNum(input, 56 + 2 * g - 8 * k, c)) >>> 0;
    }
  }
  return [s0, s1];
}
// 逆初始置换：两个 32 位数 → 8 个字节
function inversePermutation(s0, s1, out) {
  for (let n = 0; n < 4; n++) {
    for (const [idx, b0] of [[3 - n, 7 - n], [7 - n, 3 - n]]) {
      let v = 0;
      for (let q = 0; q < 4; q++) v |= bitNumIntR(s1, b0 + 8 * q, 7 - 2 * q) | bitNumIntR(s0, b0 + 8 * q, 6 - 2 * q);
      out[idx] = v;
    }
  }
}

const P_BOX = [15, 6, 19, 20, 28, 11, 27, 16, 0, 14, 22, 25, 4, 17, 30, 9, 1, 7, 23, 13, 31, 26, 2, 8, 18, 12, 29, 5, 21, 10, 3, 24];
// 轮函数：32 位扩展成 48 位 → 和子密钥异或 → 过 8 个 S 盒 → 置换
function f(state, key) {
  const t1 = (bitNumIntL(state, 31, 0) | ((state & 0xf0000000) >>> 1) | bitNumIntL(state, 4, 5)
    | bitNumIntL(state, 3, 6) | ((state & 0x0f000000) >>> 3) | bitNumIntL(state, 8, 11)
    | bitNumIntL(state, 7, 12) | ((state & 0x00f00000) >>> 5) | bitNumIntL(state, 12, 17)
    | bitNumIntL(state, 11, 18) | ((state & 0x000f0000) >>> 7) | bitNumIntL(state, 16, 23)) >>> 0;
  const t2 = (bitNumIntL(state, 15, 0) | ((state & 0x0000f000) << 15) | bitNumIntL(state, 20, 5)
    | bitNumIntL(state, 19, 6) | ((state & 0x00000f00) << 13) | bitNumIntL(state, 24, 11)
    | bitNumIntL(state, 23, 12) | ((state & 0x000000f0) << 11) | bitNumIntL(state, 28, 17)
    | bitNumIntL(state, 27, 18) | ((state & 0x0000000f) << 9) | bitNumIntL(state, 0, 23)) >>> 0;
  const l = [
    ((t1 >>> 24) & 0xff) ^ key[0], ((t1 >>> 16) & 0xff) ^ key[1], ((t1 >>> 8) & 0xff) ^ key[2],
    ((t2 >>> 24) & 0xff) ^ key[3], ((t2 >>> 16) & 0xff) ^ key[4], ((t2 >>> 8) & 0xff) ^ key[5],
  ];
  const s = ((SBOX[0][sboxBit(l[0] >> 2)] << 28)
    | (SBOX[1][sboxBit(((l[0] & 0x03) << 4) | (l[1] >> 4))] << 24)
    | (SBOX[2][sboxBit(((l[1] & 0x0f) << 2) | (l[2] >> 6))] << 20)
    | (SBOX[3][sboxBit(l[2] & 0x3f)] << 16)
    | (SBOX[4][sboxBit(l[3] >> 2)] << 12)
    | (SBOX[5][sboxBit(((l[3] & 0x03) << 4) | (l[4] >> 4))] << 8)
    | (SBOX[6][sboxBit(((l[4] & 0x0f) << 2) | (l[5] >> 6))] << 4)
    | SBOX[7][sboxBit(l[5] & 0x3f)]) >>> 0;
  let out = 0;
  for (let c = 0; c < 32; c++) out = (out | bitNumIntL(s, P_BOX[c], c)) >>> 0;
  return out;
}

// 一轮 DES：input 的 8 个字节 → output 的 8 个字节（可以是同一个数组）
function crypt(input, output, schedule) {
  let [s0, s1] = initialPermutation(input);
  for (let i = 0; i < 15; ++i) {
    const t = s1;
    s1 = (f(s1, schedule[i]) ^ s0) >>> 0;
    s0 = t;
  }
  s0 = (f(s1, schedule[15]) ^ s0) >>> 0;
  inversePermutation(s0, s1, output);
}

// 三重 DES 的三套子密钥。解密：先用后 8 字节解、再用中间 8 字节加、最后用前 8 字节解
function tripleKeySetup(key, mode) {
  return mode === ENCRYPT
    ? [keySchedule(key.subarray(0), mode), keySchedule(key.subarray(8), DECRYPT), keySchedule(key.subarray(16), mode)]
    : [keySchedule(key.subarray(16), mode), keySchedule(key.subarray(8), ENCRYPT), keySchedule(key.subarray(0), mode)];
}

const QQ_KEY = Buffer.from('!@#)(*$%123ZXC!@!@#)(NHL', 'ascii');
let schedules = null;
// 十六进制密文 → 明文字符串。不是这种密文（长度不对、解压不开）会抛错，由调用的地方决定怎么退
export function decryptQrc(hex) {
  const src = Buffer.from(String(hex || '').trim(), 'hex');
  if (!src.length || src.length % 8) throw new Error('不是 QRC 密文');
  schedules ||= tripleKeySetup(QQ_KEY, DECRYPT);
  const out = Buffer.alloc(src.length);
  const block = new Uint8Array(8);
  for (let i = 0; i < src.length; i += 8) {
    crypt(src.subarray(i, i + 8), block, schedules[0]);
    crypt(block, block, schedules[1]);
    crypt(block, block, schedules[2]);
    out.set(block, i);
  }
  return zlib.inflateSync(out).toString('utf8');
}

// ---------------- 解析 ----------------
// 解开的歌词是一段 XML，正文在 <Lyric_1 LyricType="1" LyricContent="…"/> 的属性里；没有逐字的歌解出来可能就是普通 LRC。
// 取出正文（不是 XML 就原样返回）
const unescapeXml = (s) => s
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&apos;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
export function qrcContent(text) {
  const m = /<Lyric_1\b[^>]*?\bLyricContent="([^"]*)"/.exec(String(text || ''));
  return m ? unescapeXml(m[1]) : String(text || '');
}
// 逐字正文：每行形如 [行开始毫秒,行时长]字(开始毫秒,时长)字(开始毫秒,时长)…（字在前，时间在后；字里可以带括号）
// 返回 [{ t, d, words: [{ t, d, text }] }]（秒），和网易云逐字歌词解析出来的一样；不是这种格式就返回空数组
export function parseQrc(content) {
  const out = [];
  for (const raw of String(content || '').split(/\r?\n/)) {
    const head = /^\[(\d+),(\d+)\]/.exec(raw);
    if (!head) continue;
    const words = [];
    const re = /([\s\S]*?)\((\d+),(\d+)\)/g;
    re.lastIndex = head[0].length;
    let m;
    while ((m = re.exec(raw))) if (m[1] !== '') words.push({ t: Number(m[2]) / 1000, d: Number(m[3]) / 1000, text: m[1].replace(/　/g, ' ') });
    if (words.length) out.push({ t: Number(head[1]) / 1000, d: Number(head[2]) / 1000, words });
  }
  return out;
}
// 正文开头的 [kana:…]：按汉字出现的顺序给的读音。逐字版里假名后面也带着 (开始,时长)，去掉
export function qrcKana(content) {
  const m = /\[kana:([^\]]*)\]/.exec(String(content || ''));
  return m ? m[1].replace(/\(\d+,\d+\)/g, '') : '';
}

// ---------------- 把逐字时间对到另一份歌词上 ----------------
// lines：一份只有逐行时间的歌词（网易云的）；yrc：同一首歌在 QQ 上的逐字歌词。
// 两边的分行常常不一样（这边两行、那边并成一行），空格、标点、英文大小写、括号里的和声也各写各的，所以不按「行」对，按「字」对：
// 把 QQ 的逐字歌词连成一长串带时间的字，每一行到这一长串里找自己那一段。
// 两边的音频也不一定是同一个文件，开头可能差着零点几秒：先估出时间差，再把逐字时间平移到 lines 这边的时间轴上。
// 行的文字保持 lines 原样（读音修正、AI 讲解都是按文字记的）；空格、标点不占时间。
// 返回 { lines: 带上 ct 的新数组, matched: 对上的行数, total: 有文字的行数, offset: QQ 比这边晚多少秒 }；
// 对不上（不是同一首 / 同一个版本）时 matched 很少或是 0，由调用的地方决定用不用。
const SKIP = /[\s\p{P}\p{S}]/u; // 空白、标点、符号：对字时不算
const normCh = (ch) => ch.normalize('NFKC').toLowerCase(); // 全角 / 半角、大小写当成一样
// QQ 的逐字歌词 → 一长串规整过的字（s），和每个位置的起止时间（t0 / t1）。一个时间段里有几个字就平分
function charStream(yrc) {
  let s = '';
  const t0 = [], t1 = [];
  for (const y of yrc) {
    for (const w of y.words) {
      const chars = [...w.text].filter((ch) => /\S/.test(ch));
      chars.forEach((ch, k) => {
        if (SKIP.test(ch)) return;
        const n = normCh(ch);
        for (let u = 0; u < n.length; u++) { t0.push(w.t + (w.d * k) / chars.length); t1.push(w.t + (w.d * (k + 1)) / chars.length); }
        s += n;
      });
    }
  }
  return { s, t0, t1 };
}
// 一行文字 → 用来找的那串字（key），和原文每个字对应 key 里的哪一段（没有对应的是 null：空白、标点；noParen 时括号里的也不算）
function lineKey(text, noParen) {
  let key = '', depth = 0;
  const map = [];
  for (const ch of text) {
    if (noParen && /[(（]/.test(ch)) depth++;
    const skip = SKIP.test(ch) || depth > 0;
    if (noParen && /[)）]/.test(ch)) depth = Math.max(0, depth - 1);
    if (skip) { map.push({ ch, at: null }); continue; }
    const n = normCh(ch);
    map.push({ ch, at: [key.length, key.length + n.length] });
    key += n;
  }
  return { key, map };
}
const occurrences = (s, key) => { const out = []; for (let i = s.indexOf(key); i >= 0; i = s.indexOf(key, i + 1)) out.push(i); return out; };
export function mergeWords(lines, yrc) {
  const keys = lines.map((l) => lineKey(String(l.text || ''), false));
  const total = keys.filter((k) => k.key).length;
  const fail = { lines, matched: 0, total, offset: 0 };
  if (!yrc.length || !total) return fail;
  const st = charStream(yrc);
  // 时间差：每一行在那一长串里出现的位置和它自己的时间差多少，取中位数。只出现一次、又够长的句子最可靠，优先用它们
  const diffs = (strict) => lines.flatMap((l, i) => {
    const k = keys[i].key;
    if (k.length < (strict ? 4 : 2)) return [];
    const occ = occurrences(st.s, k);
    if (!occ.length || (strict && occ.length !== 1)) return [];
    return [occ.map((p) => st.t0[p] - l.t).reduce((a, d) => (Math.abs(d) < Math.abs(a) ? d : a))];
  });
  let ds = diffs(true);
  if (ds.length < 4) ds = diffs(false);
  if (ds.length < 3) return fail;
  ds.sort((a, b) => a - b);
  const offset = ds[ds.length >> 1];
  // 两边要真是同一个录音：大多数行的时间差都得贴着中位数。散得开（现场版、另一个编曲）就不用
  if (ds.filter((d) => Math.abs(d - offset) <= 0.8).length < ds.length * 0.7) return fail;
  const r3 = (x) => Math.round(Math.max(0, x) * 1000) / 1000;
  let cursor = 0, matched = 0; // cursor：前面的行已经用到那一长串的哪儿了（一段字只给一行用，重复的句子各找各的）
  const out = lines.map((l, i) => {
    // 先整行找；找不到再把括号里的（和声、注释，另一边常常不写）去掉找
    for (const k of [keys[i], lineKey(String(l.text || ''), true)]) {
      if (!k.key || (k !== keys[i] && k.key === keys[i].key)) continue;
      let pos = -1;
      for (const p of occurrences(st.s, k.key)) {
        const d = Math.abs(st.t0[p] - offset - l.t);
        if (p < cursor || d >= 3) continue;
        if (pos < 0 || d < Math.abs(st.t0[pos] - offset - l.t)) pos = p;
      }
      if (pos < 0) continue;
      // 按 UTF-16 码元一格一格记，和分词结果的下标保持一致；不占时间的字停在前一个字结束的地方
      const ct = [];
      let last = st.t0[pos] - offset;
      for (const { ch, at } of k.map) {
        const a = at ? st.t0[pos + at[0]] - offset : last, b = at ? st.t1[pos + at[1] - 1] - offset : last;
        for (let u = 0; u < ch.length; u++) ct.push([r3(a + ((b - a) * u) / ch.length), r3(a + ((b - a) * (u + 1)) / ch.length)]);
        last = b;
      }
      cursor = pos + k.key.length;
      matched++;
      return { ...l, t: r3(st.t0[pos] - offset), end: r3(st.t1[pos + k.key.length - 1] - offset), ct };
    }
    return l;
  });
  return { lines: out, matched, total, offset: Math.round(offset * 1000) / 1000 };
}
