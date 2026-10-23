#!/usr/bin/env node
/**
 * OpenTracks（旧 DOVA-SYNDROME）BGM 检索器
 * 用法：
 *   node opentracks.mjs search --query "雨の夜 孤独 穏やか" --query "rainy night city ambient" [options]
 *   node opentracks.mjs similar 9749 [options]
 *   node opentracks.mjs detail 9749
 *
 * 设计要点：
 * - 站内每页只有 5 条结果，AI 検索 与 标签検索 都靠翻页取池子
 * - 同组标签之间是「与（AND）」，叠加越多越窄
 * - 试听 mp3 直链带短时效签名，落盘/生成 HTML 时现取现用
 */
import fs from 'node:fs';
import path from 'node:path';

const BASE = 'https://opentracks.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const TAG_RE = /^([mri])(\d{2})$/;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(url, tries = 3) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': UA, 'Accept-Language': 'ja,en;q=0.8,zh;q=0.7' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
      return await res.text();
    } catch (e) {
      lastErr = e;
      await sleep(600 * (i + 1));
    }
  }
  throw lastErr;
}

const decode = (s) =>
  (s || '')
    .replace(/<br\s*\/?>/gi, ' / ')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();

function toSec(t) {
  if (!t) return 0;
  const p = t.split(':').map(Number);
  return p.length === 2 ? p[0] * 60 + p[1] : 0;
}

/** 解析列表页（AI 検索 / 标签検索 共用结构） */
function parseList(html) {
  return html
    .split('<div class="bgmlist" data-private-bgm="')
    .slice(1)
    .map((b) => {
      const id = b.match(/^(\d+)"/)?.[1];
      if (!id) return null;
      const tagsBlock = b.match(/bgmlist-icotags">([\s\S]*?)<\/div><\/div>/)?.[1] || '';
      return {
        id,
        title: decode(b.match(/bgmlist-tracktitle"><a href="\/bgm\/detail\/\d+">([^<]*)<\/a>/)?.[1]),
        composer: decode(b.match(/by<a href="\/creator\/detail\/(\d+)">([^<]*)<\/a>/)?.[2]),
        composerId: b.match(/by<a href="\/creator\/detail\/(\d+)"/)?.[1],
        date: b.match(/bgmlist-trackarea"><div>\s*([\d.]+)\s*</)?.[1] || '',
        desc: decode(b.match(/bgmlist-trackdetail">([\s\S]*?)<\/div>/)?.[1]),
        kind: decode(b.match(/bgmlist-icobgm">([^<]*)</)?.[1] || 'BGM'),
        time: b.match(/bgmlist-icotime">\s*([\d:]+)\s*</)?.[1] || '',
        loop: /bgmlist-icoloop_yes/.test(b),
        dl: Number(b.match(/bgmlist-icodl">(\d+)</)?.[1] || 0),
        tags: [...tagsBlock.matchAll(/<span>([^<]*)<\/span>/g)].map((m) => decode(m[1])).filter((t) => t && t !== '...'),
      };
    })
    .filter(Boolean);
}

/** 解析详情页：完整标签（带编码）、试听 mp3、说明 */
function parseDetail(html, id) {
  const tagMatches = [...html.matchAll(/<a href="\/bgm\?tags_([mri])="?([mri]\d{2})"?>([^<]*)<\/a>/g)];
  const audio = html.match(/<source src="([^"]+)"[^>]*type="audio\/mpeg"/)?.[1];
  const title = decode(html.match(/<h1 class="trialL-title">([\s\S]*?)<span>/)?.[1]);
  return {
    id,
    title,
    composer: decode(html.match(/written by <a href="\/creator\/detail\/\d+">([^<]*)<\/a>/)?.[1]),
    composerId: html.match(/written by <a href="\/creator\/detail\/(\d+)"/)?.[1],
    date: html.match(/公開日[\s\S]{0,60}?(\d{4}\.\d{2}\.\d{2})/)?.[1] || '',
    kind: decode(html.match(/素材種別<span>：<\/span>([^<]*)</)?.[1]),
    tracks: decode(html.match(/Tracks<span>：<\/span>([^<]*)</)?.[1]),
    time: html.match(/再生時間<span>：<\/span>([\d:]+)/)?.[1] || '',
    loop: /trialL-detailloop_yes/.test(html),
    dl: Number(html.match(/DL<span>：<\/span>(\d+)/)?.[1] || 0),
    desc: decode(html.match(/trialL-below_trackP">([\s\S]*?)<\/p>/)?.[1]),
    tags: tagMatches.map((m) => ({ code: m[2], name: decode(m[3]) })),
    audio: audio ? audio.replace(/&amp;/g, '&') : '',
    url: `${BASE}/bgm/detail/${id}`,
    downloadUrl: `${BASE}/bgm/detail/${id}/download`,
  };
}

function tagGroups(codes) {
  const g = { m: [], r: [], i: [] };
  for (const c of codes) if (TAG_RE.test(c)) g[c[0]].push(c);
  return g;
}

function buildTagUrl(codes, sort, page) {
  const g = tagGroups(codes);
  const qs = new URLSearchParams();
  for (const k of ['m', 'r', 'i']) for (const c of g[k]) qs.append(`tags_${k}`, c);
  if (sort) qs.set('sort', String(sort));
  qs.set('page', String(page));
  return `${BASE}/bgm?${qs.toString()}`;
}

function addHit(hits, item, source, rank, weight) {
  const cur = hits.get(item.id) || { item, hits: [] };
  if (!cur.hits.some((h) => h.source === source && h.rank === rank)) {
    cur.hits.push({ source, rank, weight });
  }
  hits.set(item.id, cur);
}

/**
 * 采集候选池
 * spec = { queries, pages, tags, tagPages, sort }
 */
async function collect(spec) {
  const hits = new Map();
  const add = (item, source, rank, weight) => addHit(hits, item, source, rank, weight);

  const tasks = [];
  for (const k of spec.keywords) {
    for (let p = 1; p <= spec.kwPages; p++) {
      tasks.push({ kind: 'kw', k, p });
    }
  }
  for (const q of spec.queries) {
    for (let p = 1; p <= spec.pages; p++) {
      tasks.push({ kind: 'q', q, p });
    }
  }
  for (const ts of spec.tagsets) {
    for (let p = 1; p <= spec.tagPages; p++) tasks.push({ kind: 'tag', ts, p });
  }

  const limit = 4;
  let cursor = 0;
  async function worker() {
    while (cursor < tasks.length) {
      const t = tasks[cursor++];
      let url, source, weight;
      if (t.kind === 'kw') {
        const qs = new URLSearchParams({ keywords: t.k, sort: String(spec.sort ?? 2), page: String(t.p) });
        url = `${BASE}/bgm?${qs.toString()}`;
        source = `kw:${t.k}#${t.p}`;
        weight = 0.95 / (1 + 0.22 * (t.p - 1));
      } else if (t.kind === 'q') {
        const qs = new URLSearchParams({ query: t.q, target: 'bgm', page: String(t.p) });
        url = `${BASE}/bgm/ai-search?${qs.toString()}`;
        source = `q:${t.q}#${t.p}`;
        weight = 1 / (1 + 0.25 * (t.p - 1));
      } else {
        url = buildTagUrl(t.ts, spec.sort, t.p);
        source = `tag:${t.ts.join('+')}#${t.p}`;
        weight = (spec.tagWeight ?? 0.8) / (1 + 0.2 * (t.p - 1));
      }
      const html = await get(url);
      parseList(html).forEach((item, i) => {
        add(item, source, i + 1, weight * (1 / (1 + 0.08 * i)));
      });
      await sleep(150);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  return hits;
}

/** 预筛 + 计分（详情抓取前） */
function preScore(rec, spec) {
  let s = rec.hits.reduce((a, h) => a + h.weight, 0);
  const it = rec.item;
  const sec = toSec(it.time);
  if (spec.duration && sec) {
    const [lo, hi] = spec.duration;
    s += sec >= lo && sec <= hi ? 0.45 : -0.9;
  }
  if (spec.loop === 'yes') s += it.loop ? 0.3 : -0.7;
  if (spec.loop === 'no' && it.loop) s -= 0.3;
  if (spec.kind === 'bgm' && it.kind !== 'BGM') s -= 1.2;
  if (spec.kind === 'jingle' && it.kind !== 'ジングル') s -= 1.2;
  if (spec.vocal === 'no') {
    if (it.tags.some((t) => /ﾎﾞｰｶﾙ|ｺｰﾗｽ|歌/.test(t))) s -= 2;
  }
  if (spec.minDl && it.dl < spec.minDl) s -= 1.2;
  // 简介里直接出现风格关键词，是比标签更强的精确信号
  if (spec.keywords.length) {
    const hitK = spec.keywords.filter((k) => (it.desc || '').includes(k)).length;
    s += Math.min(hitK * 0.9, 1.8);
  }
  const dlBonus = (spec.dlBonus ?? 0.6) * Math.min(1, Math.log10(it.dl + 1) / 5);
  return s + dlBonus;
}

/** 详情抓取后精排 */
function finalScore(rec, spec) {
  const d = rec.detail;
  let s = rec.pre;
  const names = (d.tags || []).map((t) => t.name);
  let tagBonus = 0;
  for (const t of spec.includeTags) if (names.includes(t)) tagBonus += 0.9;
  s += Math.min(tagBonus, 2.7);
  for (const t of spec.excludeTags) if (names.includes(t)) s -= 1.5;
  if (spec.vocal === 'no' && names.some((n) => /ﾎﾞｰｶﾙ|ｺｰﾗｽ/.test(n))) s -= 1.5;
  const sec = toSec(d.time);
  if (spec.duration) {
    const [lo, hi] = spec.duration;
    if (sec && sec >= lo && sec <= hi) s += 0.2;
  }
  // 种子模式：按标签集合相似度排序，压过单纯的热门程度
  if (spec.seedTags) {
    // 曲风相似只看「流派」标签；拍子/速度类标签几乎人人都有，会稀释判断
    const GENRE = new Set(['r12', 'r13', 'r14', 'r15', 'r16', 'r17', 'r18', 'r19', 'r20', 'r21', 'r22', 'r23', 'r24', 'r25', 'r27', 'r28', 'r30', 'r31', 'r32', 'r33', 'r34', 'r35']);
    const by = (p) => new Set(d.tags.filter((t) => t.code.startsWith(p)).map((t) => t.code));
    const S = {
      m: new Set(spec.seedTags.filter((c) => c[0] === 'm')),
      r: new Set(spec.seedTags.filter((c) => GENRE.has(c))),
      i: new Set(spec.seedTags.filter((c) => c[0] === 'i')),
    };
    const jac = (a, b) => {
      const inter = [...a].filter((x) => b.has(x)).length;
      const uni = new Set([...a, ...b]).size;
      return uni ? inter / uni : 0;
    };
    const cm = by('m'), cr = new Set([...by('r')].filter((c) => GENRE.has(c))), ci = by('i');
    s += 1.4 * jac(S.m, cm) + 2.2 * jac(S.r, cr) + 0.3 * jac(S.i, ci);
    // 情绪互斥：种子偏暗，候选明显明快则压分（反之亦然）
    const dark = ['m13', 'm16', 'm17', 'm26', 'm29'];
    const bright = ['m01', 'm02', 'm09'];
    const seedDark = dark.some((c) => S.m.has(c));
    const seedBright = bright.some((c) => S.m.has(c));
    if (seedDark && !seedBright && bright.some((c) => cm.has(c))) s -= 1.0;
    if (seedBright && !seedDark && dark.some((c) => cm.has(c))) s -= 1.0;
  }
  return s;
}

function reasonOf(rec, spec) {
  const d = rec.detail;
  const bits = [];
  const qn = rec.hits.filter((h) => h.source.startsWith('q:')).length;
  const tn = rec.hits.filter((h) => h.source.startsWith('tag')).length;
  if (qn) bits.push(`${qn} 组语义查询命中`);
  if (tn) bits.push('标签交集 Top');
  const names = (d.tags || []).map((t) => t.name);
  const matched = spec.includeTags.filter((t) => names.includes(t));
  if (matched.length) bits.push(`标签吻合：${matched.join('、')}`);
  bits.push(`DL ${d.dl.toLocaleString('en-US')}`);
  if (d.loop) bits.push('可循环');
  return bits.join(' · ');
}

async function mapLimit(items, limit, fn) {
  let i = 0;
  const out = new Array(items.length);
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        out[idx] = await fn(items[idx], idx);
      }
    })
  );
  return out;
}

function parseArgs(argv) {
  const o = { queries: [], keywords: [], tagsets: [], includeTags: [], excludeTags: [], pages: 2, kwPages: 3, tagPages: 2, pool: 12 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const v = argv[i + 1];
    const take = () => (i++, argv[i]);
    switch (a) {
      case '--query': o.queries.push(take()); break;
      case '--keyword': o.keywords.push(take()); break;
      case '--kw-pages': o.kwPages = Number(take()); break;
      case '--tags': o.tagsets.push(take().split(',').map((x) => x.trim()).filter((x) => TAG_RE.test(x))); break;
      case '--like-tags': o.includeTags.push(...take().split(',').map((x) => x.trim()).filter(Boolean)); break;
      case '--exclude-tags': o.excludeTags.push(...take().split(',').map((x) => x.trim()).filter(Boolean)); break;
      case '--pages': o.pages = Number(take()); break;
      case '--tag-pages': o.tagPages = Number(take()); break;
      case '--sort': o.sort = Number(take()); break;
      case '--pool': o.pool = Number(take()); break;
      case '--only': o.only = take().split(',').map((x) => x.trim()).filter(Boolean); break;
      case '--min-dl': o.minDl = Number(take()); break;
      case '--kind': o.kind = take(); break;
      case '--loop': o.loop = take(); break;
      case '--vocal': o.vocal = take(); break;
      case '--duration': {
        const [lo, hi] = take().split('-').map(Number);
        o.duration = [lo || 0, hi || 1e5];
        break;
      }
      case '--out': o.out = take(); break;
      case '--audio': o.audio = true; break;
      case '--json': o.jsonOut = take(); break;
      case '--seed': o.seed = take(); break;
      default: break;
    }
  }
  return o;
}

async function runSearch(opts) {
  if (!opts.queries.length && !opts.tagsets.length && !opts.seed && !opts.keywords.length) {
    throw new Error('至少需要 --query / --keyword / --tags / --seed 之一');
  }
  const spec = {
    queries: [...opts.queries],
    keywords: opts.keywords,
    kwPages: opts.kwPages,
    pages: opts.pages,
    tagsets: opts.tagsets.filter((ts) => ts.length),
    tagPages: opts.tagPages,
    sort: opts.sort ?? 2,
    includeTags: opts.includeTags,
    excludeTags: opts.excludeTags,
    duration: opts.duration,
    loop: opts.loop,
    kind: opts.kind,
    vocal: opts.vocal,
    minDl: opts.minDl,
  };

  // 种子曲：用它的说明文本做语义查询 + 相似曲直接入池
  if (opts.seed) {
    const seedHtml = await get(`${BASE}/bgm/detail/${opts.seed}`);
    const seed = parseDetail(seedHtml, opts.seed);
    const seedTags = seed.tags.map((t) => t.code);
    const seedQuery = (seed.desc || seed.title).slice(0, 100);
    if (seedQuery) spec.queries.push(seedQuery);
    const g = tagGroups(seedTags);
    const pick = [...g.m.slice(0, 1), ...g.r.slice(0, 2), ...g.i.slice(0, 1)];
    if (pick.length) spec.tagsets = [[...new Set(pick)], ...spec.tagsets];
    spec.includeTags = [...new Set([...seed.tags.filter((t) => t.code.startsWith('m')).slice(0, 3).map((t) => t.name), ...spec.includeTags])];
    spec.seedTags = seedTags;
    spec.seedId = opts.seed;
    spec.tagWeight = 0.3;
    spec.dlBonus = 0.35;
    console.error(`[seed] ${seed.title} → tags: ${seed.tags.map((t) => t.name).join(', ')}`);
  }

  const hits = await collect(spec);

  if (opts.seed) {
    const simHtml = await get(`${BASE}/bgm/detail/${opts.seed}/similar`);
    parseList(simHtml)
      .filter((it) => it.id !== opts.seed)
      .forEach((item, i) => addHit(hits, item, 'similar', i + 1, 0.6 / (1 + 0.1 * i)));
  }
  console.error(
    `[pool] ${hits.size} 条候选（${spec.queries.length} 组语义查询 × ${spec.pages} 页` +
      `${spec.keywords.length ? ` + 关键词 ${spec.keywords.join('/')} × ${spec.kwPages} 页` : ''}` +
      `${spec.tagsets.length ? ` + ${spec.tagsets.length} 组标签交集 [${spec.tagsets.map((t) => t.join('+')).join(' | ')}] × ${spec.tagPages} 页` : ''}）`
  );

  const ranked = [...hits.values()]
    .filter((r) => r.item.id !== spec.seedId)
    .map((r) => ({ ...r, pre: preScore(r, spec) }))
    .filter((r) => r.pre > 0)
    .filter((r) => !opts.only || opts.only.includes(r.item.id))
    .sort((a, b) => b.pre - a.pre)
    .slice(0, Math.max(opts.pool * 2, 16));

  const withDetail = await mapLimit(ranked, 3, async (r) => {
    try {
      const html = await get(`${BASE}/bgm/detail/${r.item.id}`);
      return { ...r, detail: parseDetail(html, r.item.id) };
    } catch {
      // 详情页偶发超时：降级用列表页数据，不让整首消失
      const it = r.item;
      return {
        ...r,
        detail: {
          id: it.id, title: it.title, composer: it.composer, composerId: it.composerId,
          date: it.date, kind: it.kind, tracks: '', time: it.time, loop: it.loop, dl: it.dl,
          desc: it.desc, tags: it.tags.map((n) => ({ code: '', name: n })), audio: '',
          url: `${BASE}/bgm/detail/${it.id}`, downloadUrl: `${BASE}/bgm/detail/${it.id}/download`,
        },
      };
    }
  });

  const final = withDetail
    .filter(Boolean)
    .filter((r) => !opts.only || opts.only.includes(r.item.id))
    .map((r) => ({ ...r, score: finalScore(r, spec) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, opts.pool)
    .map((r) => ({
      score: Number(r.score.toFixed(2)),
      id: r.item.id,
      title: r.detail.title || r.item.title,
      composer: r.detail.composer || r.item.composer,
      composerId: r.detail.composerId || r.item.composerId,
      time: r.detail.time || r.item.time,
      seconds: toSec(r.detail.time || r.item.time),
      dl: r.detail.dl || r.item.dl,
      loop: r.detail.loop,
      kind: r.detail.kind || r.item.kind,
      date: r.detail.date || r.item.date,
      tags: (r.detail.tags || []).map((t) => `${t.name}(${t.code})`),
      desc: r.detail.desc || r.item.desc,
      audio: r.detail.audio,
      url: r.detail.url,
      downloadUrl: r.detail.downloadUrl,
      hits: r.hits.map((h) => h.source),
      reason: reasonOf(r, spec),
    }));

  return { spec, results: final };
}

function mdTable(rows) {
  const lines = [
    '| # | 曲名 | 作曲者 | 时长 | DL | 可循环 | 标签 | 链接 |',
    '|---|---|---|---|---|---|---|---|',
  ];
  rows.forEach((r, i) => {
    const tags = r.tags.slice(0, 8).join(' / ');
    lines.push(
      `| ${i + 1} | ${r.title} | ${r.composer} | ${r.time} | ${r.dl.toLocaleString('en-US')} | ${r.loop ? '✓' : '–'} | ${tags} | [试听](${r.url}) |`
    );
  });
  return lines.join('\n');
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function buildHtml(rows, spec) {
  const cards = rows
    .map((r, i) => {
      const src = r.localAudio ? `audio/${r.localAudio}` : r.audio;
      return `<article class="card">
  <header><span class="rank">${i + 1}</span><h2>${esc(r.title)}</h2><span class="composer">${esc(r.composer)}</span></header>
  <div class="meta"><span>${r.time}</span><span>DL ${r.dl.toLocaleString('en-US')}</span>${r.loop ? '<span class="ok">loop</span>' : ''}<span>${esc(r.kind)}</span></div>
  ${src ? `<audio controls preload="none" src="${esc(src)}"></audio>` : '<p class="warn">无试听地址</p>'}
  <p class="desc">${esc(r.desc).slice(0, 160)}</p>
  <p class="tags">${r.tags.slice(0, 10).map((t) => `<span>${esc(t)}</span>`).join('')}</p>
  <p class="why">${esc(r.reason)}</p>
  <p class="links">
    <a href="${r.url}" onclick="return openOut('${r.url}', event)">详情页</a>
    <a href="${r.downloadUrl}" onclick="return openOut('${r.downloadUrl}', event)">下载页</a>
    <button class="copy" data-u="${r.url}">复制链接</button>
  </p>
  <p class="rawurl">${r.url}</p>
</article>`;
    })
    .join('\n');
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>BGM 候选清单</title>
<style>
:root{color-scheme:dark}
body{margin:0;padding:28px;background:#0f1115;color:#e6e8ec;font:14px/1.6 "Segoe UI","Microsoft YaHei",sans-serif}
h1{font-size:20px;margin:0 0 6px}
.sub{color:#8b93a1;margin:0 0 22px;font-size:13px}
.grid{display:grid;gap:14px;grid-template-columns:repeat(auto-fill,minmax(330px,1fr))}
.card{background:#171a21;border:1px solid #242833;border-radius:12px;padding:14px 16px}
header{display:flex;align-items:baseline;gap:8px}
.rank{color:#5d6675;font-variant-numeric:tabular-nums}
h2{font-size:15px;margin:0;flex:1}
.composer{color:#8b93a1;font-size:12px;white-space:nowrap}
.meta{display:flex;gap:10px;color:#9aa3b2;font-size:12px;margin:6px 0 10px}
.ok{color:#6ee7a0}
audio{width:100%;height:34px;margin-bottom:8px}
.desc{color:#b9c0cc;margin:0 0 8px;font-size:13px}
.tags{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 8px}
.tags span{background:#232834;color:#a9b3c4;border-radius:5px;padding:1px 6px;font-size:11px}
.why{color:#7f8797;font-size:12px;margin:0 0 8px}
.links{margin:0 0 6px;display:flex;gap:12px;align-items:center;flex-wrap:wrap}
.copy{background:#232834;color:#a9b3c4;border:1px solid #2e3542;border-radius:6px;padding:2px 8px;font-size:12px;cursor:pointer}
.copy:hover{color:#e6e8ec;border-color:#3d4657}
.rawurl{margin:0;color:#5d6675;font-size:11px;word-break:break-all;user-select:all}
a{color:#67a7ff;text-decoration:none}
a:hover{text-decoration:underline}
</style></head><body>
<h1>OpenTracks BGM 候选清单</h1>
<p class="sub">${esc(rows.length)} 首 · 查询：${esc(spec.queries.join(' | '))}${spec.tagsets.length ? ' · 标签交集：' + esc(spec.tagsets.map((t) => t.join('+')).join(' | ')) : ''}</p>
<div class="grid">${cards}</div>
<script>
// 同一时间只允许一首在放：任一播放器开始播放时，暂停其余所有播放器
function bindExclusive() {
  document.querySelectorAll('audio').forEach(function (a) {
    if (a.dataset.excl === '1') return;
    a.dataset.excl = '1';
    var stopOthers = function () {
      document.querySelectorAll('audio').forEach(function (b) {
        if (b !== a && !b.paused) { try { b.pause(); } catch (e) {} }
      });
    };
    a.addEventListener('play', stopOthers);
    a.addEventListener('playing', stopOthers);
  });
}
bindExclusive();
function openOut(u, ev) {
  if (ev) ev.preventDefault();
  try { var w = window.open(u, '_blank', 'noopener'); if (w) return false; } catch (e) {}
  try { if (window.top && window.top !== window) { window.top.location.href = u; return false; } } catch (e) {}
  location.href = u;
  return false;
}
document.querySelectorAll('button.copy').forEach(function (b) {
  b.addEventListener('click', function () {
    var u = b.getAttribute('data-u');
    var done = function () {
      b.textContent = '已复制';
      setTimeout(function () { b.textContent = '复制链接'; }, 1200);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(u).then(done, function () { window.prompt('手动复制：', u); });
    } else {
      window.prompt('手动复制：', u);
    }
  });
});
</script>
</body></html>`;
}

async function downloadAudio(rows, dir) {
  fs.mkdirSync(path.join(dir, 'audio'), { recursive: true });
  await mapLimit(rows, 3, async (r) => {
    if (!r.audio) return;
    try {
      const res = await fetch(r.audio, { headers: { 'User-Agent': UA, Referer: `${BASE}/bgm/detail/${r.id}` } });
      if (!res.ok) return;
      const buf = Buffer.from(await res.arrayBuffer());
      const name = `${r.id}.mp3`;
      fs.writeFileSync(path.join(dir, 'audio', name), buf);
      r.localAudio = name;
    } catch {
      /* 保留远程直链 */
    }
  });
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  let positional;
  const rest = [];
  for (let i = 1; i < argv.length; i++) {
    const t = argv[i];
    if (t.startsWith('--')) {
      rest.push(t);
      if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) rest.push(argv[++i]);
    } else if (positional === undefined) {
      positional = t;
    }
  }
  const opts = parseArgs(rest);

  if (cmd === 'detail') {
    const html = await get(`${BASE}/bgm/detail/${positional}`);
    console.log(JSON.stringify(parseDetail(html, positional), null, 2));
    return;
  }
  if (cmd === 'similar') {
    const html = await get(`${BASE}/bgm/detail/${positional}/similar`);
    console.log(JSON.stringify(parseList(html), null, 2));
    return;
  }

  const { spec, results } = await runSearch(opts);
  if (opts.out) {
    fs.mkdirSync(opts.out, { recursive: true });
    if (opts.audio) await downloadAudio(results, opts.out);
    fs.writeFileSync(path.join(opts.out, 'shortlist.html'), buildHtml(results, spec), 'utf8');
  }
  if (opts.jsonOut) {
    fs.writeFileSync(opts.jsonOut, JSON.stringify(results, null, 2), 'utf8');
  }
  const stripped = results.map(({ audio, ...rest }) => rest);
  console.log(mdTable(results));
  console.log('\n<!-- JSON\n' + JSON.stringify(stripped, null, 2) + '\n-->');
  if (opts.out) console.log(`\n清单已生成：${path.join(opts.out, 'shortlist.html')}`);
}

main().catch((e) => {
  console.error('ERROR', e.message);
  process.exit(1);
});

