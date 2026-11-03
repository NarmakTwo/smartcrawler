#!/usr/bin/env node
// Deep web-app crawler + extractor.
//
// Runs any page in an instrumented JSDOM sandbox, hooks every network sink, then
// works *backwards* through the artifacts it finds — JS, CSS, JSON, WASM, and
// compressed Unity `.unityweb` blobs — decompressing, parsing, and CyberChef-
// "Magic"-decoding each one to surface as many URLs as possible. With --mirror it
// downloads the whole dependency tree into <out>/site/<host>/<path>, preserving the
// folder structure, and rewrites it into a static site that runs fully offline.
// --flatten instead merges the entry folder and any CDN copy of that same folder
// into <out>/site, and rewrites links to match.
// Nothing here is specific to one game: point it at any URL. See --help.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import util, { parseArgs } from 'node:util';
import got from 'got';
import { REstringer } from 'restringer';
import { JSDOM, VirtualConsole, requestInterceptor } from 'jsdom';
import { decode as decodeWasm } from '@webassemblyjs/wasm-parser';
import { traverse as traverseWasm } from '@webassemblyjs/ast';
import { tokenizer as jsTokenizer } from 'acorn';
import * as cyberchef from 'cyberchef-node';
import { CATEGORIES, parseStubSpec, makeStub, isImageExt } from './lib/stubs.js';
import { parseAllowlist, urlAllowed } from './lib/allow.js';
import { createLogger, LEVELS, fmtBytes, fmtDuration } from './lib/log.js';

const chef = cyberchef.default ?? cyberchef;

// ---------- config ----------
const CLI = 'deep-mirror';
const VERSION = JSON.parse(fs.readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version;
const USAGE = `Usage: ${CLI} <url> [options]

Crawl a web page/app, discover every URL it will request, and optionally mirror
everything into a static site that runs offline (works with \`npx serve\`).

Arguments:
  <url>                    page to crawl (https:// is assumed if no scheme is given)

Output:
  -o, --out <dir>          output folder (default: ./out); the site goes in <dir>/site
  -m, --mirror             download every discovered asset (without it: discovery only)
  -f, --flatten            merge the entry folder and CDN copies of it into one tree
                           (site/index.html, site/Build/…) and rewrite links to match
  -c, --copyright <list>   write valid, silent/transparent stubs instead of downloading
                           these media types. Categories: ${Object.keys(CATEGORIES).join(', ')}; or
                           extensions, e.g. -c audio  -c "mp3,ogg,webm"  -c image -c video
  -s, --addstub <html|file>
                           run this in every mirrored page, before its own scripts. Pass
                           markup, plain JS, or a file; repeatable. Script bodies are
                           served from mirror-stub.js, not copied into each page
  -w, --allowlist <file>   JSON array of domain globs to leave remote instead of saving.
                           \`*\` matches one label. \`*.\` at the start of the host also
                           matches the bare host, so \`*://*.example.*\` matches
                           http://example.com and https://a.b.example.test

Crawling:
  -d, --depth <n>          how deep to recurse into discovered assets (default: 4)
      --max-pages <n>      max pages of the site (at/below the entry folder) to run in
                           the sandbox; their links and buttons are exercised too
                           (default: 30)
      --max-mb <n>         skip single files larger than this (default: 8192 with
                           --mirror, 40 without)
      --probe-limit <n>    max guessed relative paths to probe (default: 800)
      --no-wasm            don't parse WebAssembly modules
      --no-magic           don't run CyberChef Magic on encoded-looking strings
      --no-enumerate       don't list CDN-backed repos (jsDelivr → GitHub tree)

Logging:
  -q, --quiet              only warnings, errors and the final summary
  -v, --verbose            show every discovered URL, analyzed asset and download
                           (-vv = --debug)
      --debug              also show page console output, sandbox errors, probes,
                           timings and stack traces
      --log-file <file>    write a full debug log to <file> (independent of -q/-v)
      --no-color           disable colored output (also: NO_COLOR=1)

  -h, --help               show this help
      --version            print the version

Examples:
  ${CLI} https://example.com/game/
  ${CLI} example.com/game/ -m -o ./game-copy
  ${CLI} example.com/game/ -m -c audio,video -v
  ${CLI} example.com/play/ -m -f -o ./game-copy
  ${CLI} example.com/play/ -m -w allow.json
  npx serve ./game-copy/site`;

function fail(msg) {
  console.error(`${CLI}: ${msg}\n\nRun "${CLI} --help" for usage.`);
  process.exit(2);
}

let cli;
try {
  cli = parseArgs({
    allowPositionals: true,
    options: {
      out: { type: 'string', short: 'o', default: './out' },
      mirror: { type: 'boolean', short: 'm', default: false },
      flatten: { type: 'boolean', short: 'f', default: false },
      full: { type: 'boolean', default: false }, // legacy alias of --mirror
      copyright: { type: 'string', short: 'c', multiple: true, default: [] },
      addstub: { type: 'string', short: 's', multiple: true, default: [] },
      allowlist: { type: 'string', short: 'w' },
      'max-mb': { type: 'string' },
      depth: { type: 'string', short: 'd', default: '4' },
      'max-pages': { type: 'string', default: '30' },
      'probe-limit': { type: 'string', default: '800' },
      'no-wasm': { type: 'boolean', default: false },
      'no-magic': { type: 'boolean', default: false },
      'no-enumerate': { type: 'boolean', default: false },
      quiet: { type: 'boolean', short: 'q', default: false },
      verbose: { type: 'boolean', short: 'v', multiple: true, default: [] },
      debug: { type: 'boolean', default: false },
      'log-file': { type: 'string' },
      'no-color': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
      version: { type: 'boolean', default: false },
    },
  });
} catch (e) {
  fail(e.message);
}
const opts = cli.values;
if (opts.help) {
  console.log(USAGE);
  process.exit(0);
}
if (opts.version) {
  console.log(VERSION);
  process.exit(0);
}
if (opts.quiet && (opts.verbose.length || opts.debug)) fail('--quiet cannot be combined with --verbose/--debug');
const log = createLogger({
  level: opts.debug || opts.verbose.length > 1 ? LEVELS.debug : opts.verbose.length ? LEVELS.verbose : opts.quiet ? LEVELS.quiet : LEVELS.normal,
  color: !opts['no-color'],
  file: opts['log-file'] ? path.resolve(opts['log-file']) : null,
});
async function die(msg, err) {
  log.clearProgress();
  log.error(msg);
  if (err?.stack) log.debug(err.stack);
  await log.close();
  process.exit(1);
}
// Page scripts run in-process, so their unhandled errors land here too. Only errors
// raised by the crawler's own code are fatal.
const SELF_DIR = path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1'));
const isOwnError = (e) => {
  const stack = String(e?.stack || '').replace(/\\/g, '/');
  const top = stack.split('\n').find((l) => /^\s+at /.test(l)) || '';
  return top.includes(SELF_DIR.replace(/\\/g, '/')) && !top.includes('/node_modules/');
};
const onStray = (e) => {
  if (isOwnError(e)) return die(`unexpected failure: ${e?.message || e}`, e);
  log.debug(`[sandbox] unhandled page error: ${e?.message || e}`);
};
process.on('unhandledRejection', onStray);
process.on('uncaughtException', onStray);

let STUB_EXTS;
try {
  STUB_EXTS = parseStubSpec(opts.copyright);
} catch (e) {
  fail(e.message);
}
let ALLOW = [];
if (opts.allowlist) {
  const file = path.resolve(opts.allowlist);
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) fail(`--allowlist: file not found: ${opts.allowlist}`);
  try {
    ALLOW = parseAllowlist(JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')));
  } catch (e) {
    fail(`--allowlist: ${e.message}`);
  }
}
function isAllowlisted(url) {
  if (!ALLOW.length || url === baseUrl) return false;
  return urlAllowed(ALLOW, url);
}
const HEAD_STUB_SRC = opts.addstub
  .map((v) => {
    const file = path.resolve(v);
    let html = v;
    if (fs.existsSync(file) && fs.statSync(file).isFile()) html = fs.readFileSync(file, 'utf8');
    else if (/\.(html?|js)$/i.test(v) && !/[<>(){};]/.test(v)) fail(`--addstub: file not found: ${v}`);
    return html.trim();
  })
  .join('\n');
// Script bodies go in one external file. Inlining them puts the stub's own text into
// every page, so a stub that blocks HTML containing a phrase blocks the pages it was
// added to (the launcher then can't swap a chapter in).
const HEAD_STUB_JS = [];
const HEAD_STUB_HTML = HEAD_STUB_SRC.replace(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi, (full, attrs, body) => {
  if (/\bsrc\s*=/i.test(attrs)) return full;
  HEAD_STUB_JS.push(body.trim());
  return '';
}).trim();
if (HEAD_STUB_SRC && !HEAD_STUB_SRC.includes('<')) HEAD_STUB_JS.push(HEAD_STUB_SRC);
if (cli.positionals.length === 0) fail('missing <url>');
if (cli.positionals.length > 1) fail(`expected one <url>, got: ${cli.positionals.join(' ')}`);

const intOpt = (name, dflt) => {
  const raw = opts[name] ?? dflt;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) fail(`--${name} must be a non-negative integer (got "${raw}")`);
  return n;
};

let baseUrl = cli.positionals[0].trim();
if (!/^[a-z][a-z\d+.-]*:/i.test(baseUrl)) baseUrl = 'https://' + baseUrl.replace(/^\/+/, '');
try {
  const u = new URL(baseUrl);
  if (!/^https?:$/.test(u.protocol)) fail(`only http(s) URLs are supported (got ${u.protocol})`);
  baseUrl = u.href;
} catch {
  fail(`not a valid URL: ${cli.positionals[0]}`);
}

const DO_MIRROR = opts.mirror || opts.full;
const DO_WASM = !opts['no-wasm'];
const DO_MAGIC = !opts['no-magic'];
const DO_ENUMERATE = !opts['no-enumerate'];
const MAX_DEPTH = intOpt('depth');
const MAX_PAGES = Math.max(1, intOpt('max-pages'));
const MIRROR_MAX_MB = intOpt('max-mb', DO_MIRROR ? '8192' : '40');

const OUT = path.resolve(opts.out);
const SITE = path.join(OUT, 'site');
const ANALYZE_MAX_BYTES = 64 * 1024 * 1024;
const URLSCAN_MAX_BYTES = 48 * 1024 * 1024;
const MAGIC_MAX = 150;
const MAGIC_BUDGET_MS = 20000;
const PROBE_MAX = intOpt('probe-limit');
const BINARY_ANALYZE_CAP = 12 * 1024 * 1024; // without --mirror, skip fetching bigger opaque blobs
const LEAF_EXT = /\.(png|jpe?g|gif|webp|avif|bmp|ico|ogg|mp3|wav|m4a|aac|opus|flac|webm|mp4|m4v|mov|ttf|otf|woff2?)(\?.*)?$/i;
const SETTLE_QUIET_MS = 2000;
const SETTLE_MAX_MS = 45000;

// URLs / asset-ish paths inside source text.
const URL_IN_CODE = new RegExp(
  [
    'https?:\\/\\/[^\\s"\'`<>\\\\)]+', // absolute
    '\\/\\/[a-z0-9.-]+\\/[^\\s"\'`<>\\\\)]+', // protocol-relative
    '(?:Build|StreamingAssets|TemplateData|assets?|static|dist)\\/[^\\s"\'`<>\\\\)]+', // framework dirs
    '[\\w./-]+\\.(?:m?js|css|json|wasm|unityweb|data|bundle|assets|resS|resource|pck|pak|zip|bin|br|gz|html?|txt|xml|csv|tsv|ya?ml|png|jpe?g|webp|avif|gif|svg|ico|bmp|ktx2?|basis|dds|glb|gltf|atlas|fnt|mp3|ogg|opus|wav|m4a|aac|flac|webm|mp4|m4v|mov|bank|woff2?|ttf|otf)(?:\\?[^\\s"\'`<>\\\\)]*)?(?![\\w])', // relative files by ext
  ].join('|'),
  'gi'
);
const MAGIC_TOKEN = /(?:[A-Za-z0-9+/]{24,}={0,2})|(?:[A-Za-z0-9_-]{28,})|(?:[0-9a-fA-F]{32,})/g;

// ---------- state ----------
/** @type {Map<string, {url:string, methods:Set<string>, vias:Set<string>, stacks:string[], definedIn?:string[]}>} */
const hits = new Map();
/** @type {Map<string,string>} */
const scriptSources = new Map(); // label -> source text (for provenance + harvest)
const fetchedJs = new Set();
/** @type {Map<string, {localPath:string, size:number, encoding:string, note?:string}>} */
const downloaded = new Map();
const analyzed = new Set();
const extraction = []; // { from, kind, urls:[], imports?:[], notes?:[] }
let magicCalls = 0;
let magicStart = 0; // set on first Magic call so the budget isn't spent by the sandbox

const baseHost = new URL(baseUrl).host;
const mirroredHosts = new Set([baseHost]);

// ---------- small helpers ----------
function ensureDir(p) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
}
function saveOut(name, content) {
  const p = path.join(OUT, name);
  ensureDir(p);
  fs.writeFileSync(p, content);
}
function resolveUrl(raw, base = baseUrl) {
  if (raw == null || raw === '') return null;
  let s = String(raw).trim().replace(/[),;.'"]+$/, '');
  if (s.startsWith('//')) s = 'https:' + s;
  try {
    return new URL(s, base).href;
  } catch {
    return null;
  }
}
function captureStack() {
  const stack = new Error().stack || '';
  return stack
    .split('\n')
    .slice(2, 7)
    .map((l) => l.trim())
    .filter((l) => l && !l.includes('crawl.js') && !l.includes('node:internal'))
    .join(' | ');
}
function record(raw, { method = 'GET', via = 'unknown', base = baseUrl, stack = '' } = {}) {
  const url = resolveUrl(raw, base);
  if (!url) return null;
  if (!/^https?:|^blob:|^data:/i.test(url)) return null;
  let entry = hits.get(url);
  if (!entry) {
    entry = { url, methods: new Set(), vias: new Set(), stacks: [] };
    hits.set(url, entry);
    log.detail(`+ ${url}  ${log.paint('gray', `[${via}]`)}`);
  }
  entry.methods.add(String(method || 'GET').toUpperCase());
  entry.vias.add(via);
  if (stack && entry.stacks.length < 3 && !entry.stacks.includes(stack)) entry.stacks.push(stack);
  return url;
}
function classify(url) {
  if (url.startsWith('blob:')) return 'blob';
  if (url.startsWith('data:')) return 'data';
  const p = new URL(url).pathname.toLowerCase();
  if (/\.(mjs|js)$/.test(p)) return 'script';
  if (/\.(json|map)$/.test(p)) return 'json';
  if (/\.(css)$/.test(p)) return 'style';
  if (/\.(html?|htm)$/.test(p) || p.endsWith('/')) return 'document';
  if (/\.(wasm|unityweb|data|bin|br|gz|pak|bundle|png|jpe?g|webp|gif|svg|mp3|ogg|wav|woff2?|ttf|ico)/.test(p))
    return 'binary';
  return 'other';
}
function looksLikeJs(url) {
  try {
    const p = new URL(url).pathname.toLowerCase();
    return (p.endsWith('.js') || p.endsWith('.mjs')) && !p.includes('.unityweb');
  } catch {
    return false;
  }
}
function isBinaryUrl(url) {
  return classify(url) === 'binary';
}
// Extension to replace with a stub under --copyright, or null.
function stubExtFor(url) {
  if (!STUB_EXTS.size) return null;
  try {
    const ext = path.posix.extname(new URL(url).pathname).slice(1).toLowerCase();
    return STUB_EXTS.has(ext) ? ext : null;
  } catch {
    return null;
  }
}
function hostDir(u) {
  const url = typeof u === 'string' ? new URL(u) : u;
  return url.port ? `${url.hostname}_${url.port}` : url.hostname;
}
function pathOf(url) {
  try {
    return decodeURIComponent(url.pathname);
  } catch {
    return url.pathname;
  }
}
// Directory URL (origin + path, always trailing slash) → files under it share one
// relative layout. With --flatten, the entry folder and every other host directory
// whose path ends in the same folder name (the usual CDN copy) are roots.
const FLAT_ROOTS = []; // { host, path, href } path/href include the trailing slash
function addFlatRoot(abs) {
  if (!opts.flatten || !abs) return;
  let u;
  try {
    u = new URL(abs);
  } catch {
    return;
  }
  if (!/^https?:$/i.test(u.protocol)) return;
  if (isAllowlisted(u.href)) return;
  let p = pathOf(u);
  if (!p.endsWith('/')) p = p.replace(/[^/]*$/, '');
  if (p === '/' && u.href.replace(/\/$/, '') !== baseUrl.replace(/\/$/, '')) return;
  const href = u.origin + p;
  if (FLAT_ROOTS.some((r) => r.href === href)) return;
  FLAT_ROOTS.push({ host: u.host, path: p, href });
  FLAT_ROOTS.sort((a, b) => b.href.length - a.href.length);
}
function seedFlatRoots(html, pageUrl) {
  if (!opts.flatten) return;
  const dir = pageUrl.slice(0, pageUrl.lastIndexOf('/') + 1);
  addFlatRoot(dir);
  const base = String(html).match(/<base\b[^>]*?\bhref\s*=\s*(["']?)([^"'\s>]+)\1/i);
  if (base) {
    const r = resolveUrl(base[2], pageUrl);
    if (r) addFlatRoot(r);
  }
  const folder = dir.replace(/\/$/, '').split('/').pop();
  if (!folder) return;
  const re = new RegExp(`https?:\\/\\/[^\\s"'\`<>\\\\]*\\/${folder}\\/`, 'gi');
  for (const m of String(html).matchAll(re)) addFlatRoot(m[0]);
}
function refreshFlatRoots() {
  if (!opts.flatten) return;
  const dir = baseUrl.slice(0, baseUrl.lastIndexOf('/') + 1);
  addFlatRoot(dir);
  const folder = dir.replace(/\/$/, '').split('/').pop();
  if (!folder) return;
  for (const u of hits.keys()) {
    if (!/^https?:/i.test(u)) continue;
    let url;
    try {
      url = new URL(u);
    } catch {
      continue;
    }
    const parts = pathOf(url).split('/');
    const idx = parts.lastIndexOf(folder);
    if (idx > 0) addFlatRoot(url.origin + parts.slice(0, idx + 1).join('/') + '/');
  }
}
// Path under a flatten root, or null to keep the host/<path> layout. '' is the site root.
function flattenRel(url) {
  if (!opts.flatten) return null;
  const p = pathOf(url);
  for (const root of FLAT_ROOTS) {
    if (url.host !== root.host) continue;
    if (p === root.path.slice(0, -1) || p.startsWith(root.path)) return p.startsWith(root.path) ? p.slice(root.path.length) : '';
  }
  return null;
}
// Where this URL lived before --flatten, so a re-run can move files already on disk.
function hostLayout(u) {
  const url = new URL(u);
  let p = pathOf(url);
  if (p.endsWith('/') || p === '') p += 'index.html';
  let local = path.join(SITE, hostDir(url), ...p.split('/').filter(Boolean));
  if (url.search) {
    const q = local + '__q' + Buffer.from(url.search).toString('hex').slice(0, 24);
    if (fs.existsSync(q)) return q;
  }
  return local;
}
function adoptFlattened(url, local) {
  if (!opts.flatten) return;
  const old = hostLayout(url);
  if (old === local || !fs.existsSync(old) || !fs.statSync(old).isFile()) return;
  if (!fs.existsSync(local)) {
    ensureDir(local);
    fs.renameSync(old, local);
  } else fs.rmSync(old, { force: true });
}
function pruneEmptyDirs(dir) {
  if (!fs.existsSync(dir)) return;
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    if (fs.statSync(p).isDirectory()) pruneEmptyDirs(p);
  }
  if (dir !== SITE && fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
}
function relocateDownloaded() {
  if (!opts.flatten) return;
  refreshFlatRoots();
  for (const [url, meta] of downloaded) {
    if (!meta.localPath) continue;
    const next = urlToLocal(url);
    if (next !== meta.localPath && fs.existsSync(meta.localPath)) adoptFlattened(url, next);
    meta.localPath = next;
  }
  pruneEmptyDirs(SITE);
}
// Static servers ignore query strings, so "x.json?v=3" is stored as plain "x.json".
// Only when two different queries of one path are both mirrored does one get a
// "__q<hex>" name (and the rewrite/shim map that exact URL to it).
const localClaims = new Map(); // local path -> url that owns it
function urlToLocal(u) {
  const url = new URL(u);
  const flat = flattenRel(url);
  let local;
  if (flat != null) {
    let rel = flat;
    if (rel === '' || rel.endsWith('/')) rel += 'index.html';
    local = path.join(SITE, ...rel.split('/').filter(Boolean));
  } else {
    let p = pathOf(url);
    if (p.endsWith('/') || p === '') p += 'index.html';
    local = path.join(SITE, hostDir(url), ...p.split('/').filter(Boolean));
  }
  const sameFile = (a, b) => {
    try {
      const ua = new URL(a);
      const ub = new URL(b);
      const norm = (x) => pathOf(x).replace(/\/$/, '/index.html');
      return ua.host === ub.host && norm(ua) === norm(ub);
    } catch {
      return false;
    }
  };
  if (url.search) {
    const owner = localClaims.get(local);
    if (owner && owner !== u) local += '__q' + Buffer.from(url.search).toString('hex').slice(0, 24);
  } else if (opts.flatten && localClaims.has(local) && localClaims.get(local) !== u && !sameFile(localClaims.get(local), u)) {
    const tag = '__' + hostDir(url).replace(/[^a-z0-9]+/gi, '_');
    const ext = path.extname(local);
    local = ext ? local.slice(0, -ext.length) + tag + ext : local + tag;
  }
  if (!localClaims.has(local) || !url.search) localClaims.set(local, u);
  return local;
}

// ---------- decoding / decompression ----------
function sniffInflate(buf, tryBrotli = false) {
  if (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
    try {
      return ['gzip', zlib.gunzipSync(buf)];
    } catch {
      /* fall through */
    }
  }
  if (buf.length >= 2 && buf[0] === 0x78 && [0x01, 0x9c, 0xda, 0x5e].includes(buf[1])) {
    try {
      return ['zlib', zlib.inflateSync(buf)];
    } catch {
      /* fall through */
    }
  }
  if (buf.length >= 4 && buf[0] === 0x28 && buf[1] === 0xb5 && buf[2] === 0x2f && buf[3] === 0xfd && zlib.zstdDecompressSync) {
    try {
      return ['zstd', zlib.zstdDecompressSync(buf)];
    } catch {
      /* fall through */
    }
  }
  // Brotli has no magic bytes (Unity ships .unityweb as a bare brotli stream), so only
  // attempt it when the name hints at it or the raw bytes aren't already usable.
  if (tryBrotli || !(isWasm(buf) || looksTextual(buf))) {
    try {
      const out = zlib.brotliDecompressSync(buf);
      if (out && out.length > 0 && (isWasm(out) || looksTextual(out) || tryBrotli)) return ['brotli', out];
    } catch {
      /* not brotli */
    }
  }
  return ['none', buf];
}
function isWasm(buf) {
  return buf.length >= 4 && buf[0] === 0x00 && buf[1] === 0x61 && buf[2] === 0x73 && buf[3] === 0x6d;
}
function looksTextual(buf) {
  const n = Math.min(buf.length, 4096);
  if (n === 0) return false;
  // Text = no NULs and almost no C0 control bytes; high bytes are fine (UTF-8 / Latin-1 accents, CJK).
  let control = 0;
  for (let i = 0; i < n; i++) {
    const c = buf[i];
    if (c === 0) return false;
    if (c < 32 && c !== 9 && c !== 10 && c !== 13 && c !== 27) control++;
  }
  return control / n < 0.02;
}
function chefValue(r) {
  if (r == null) return '';
  if (typeof r === 'string') return r;
  if (typeof r.value === 'string') return r.value;
  return r.value ?? '';
}

// User's autoDecode, adapted: chef.bake blocks flow-control ops in the Node API,
// so call the Magic operation directly. Returns decoded candidate strings.
async function autoDecode(input) {
  if (!DO_MAGIC || typeof chef.magic !== 'function') return [];
  if (!magicStart) magicStart = Date.now();
  if (magicCalls >= MAGIC_MAX || Date.now() - magicStart > MAGIC_BUDGET_MS) return [];
  magicCalls++;
  try {
    const out = await chef.magic(input, [3 /* depth */, false /* intensive */, false /* extensive */]);
    const results = out?.value ?? out ?? [];
    return (Array.isArray(results) ? results : [])
      .map((r) => (typeof r?.data === 'string' ? r.data : ''))
      .filter(Boolean);
  } catch {
    return [];
  }
}
async function extractUrlsViaChef(text) {
  if (typeof chef.extractURLs !== 'function') return [];
  try {
    const v = chefValue(await chef.extractURLs(text, [false, false, true]));
    return String(v)
      .split(/\s+/)
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

// ---------- URL harvesting from text ----------
// Absolute URLs are trusted immediately. Relative guesses (e.g. "Build/x.data" found
// in a string) are only *speculative*: they get probed, and recorded only on 2xx.
const speculative = new Map(); // url -> via
let probeCount = 0;
let layoutProbeCount = 0;
function speculate(href, via) {
  if (!href || hits.has(href) || speculative.has(href)) return;
  if (!/^https?:/i.test(href) || isAllowlisted(href)) return;
  speculative.set(href, via);
}
// Absolute URLs in code are often docs/bug links in comments or error strings. Count them
// as requests only when the host was really contacted at runtime or the path is an asset;
// everything else is kept as a "reference" in the report but never fetched.
const ASSET_PATH = /\.(m?js|css|json|wasm|unityweb|data|bundle|assets|pck|pak|zip|bin|br|gz|txt|xml|csv|png|jpe?g|webp|avif|gif|svg|ico|ktx2?|basis|glb|gltf|atlas|mp3|ogg|opus|wav|m4a|webm|mp4|woff2?|ttf|otf)(\.part\d+)?$/i;
const activeHosts = new Set([baseHost]);
const references = new Map(); // url -> via
function isActiveUrl(href) {
  const u = new URL(href);
  return activeHosts.has(u.host) || ASSET_PATH.test(u.pathname);
}
function harvestAbsolute(href, via, found) {
  if (!isActiveUrl(href)) {
    if (!hits.has(href) && references.size < 5000) references.set(href, via);
    return;
  }
  if (record(href, { via })) found.add(href);
}
function harvestMatch(raw, label, base, found) {
  const href = resolveUrl(raw, base);
  if (!href || href.startsWith('blob:') || href.startsWith('data:')) return;
  if (/^(https?:)?\/\//i.test(raw.trim())) harvestAbsolute(href, `static:${label}`, found);
  else speculate(href, `static:${label}`);
}
function jsStringLiterals(code) {
  // Only real string/template literals — avoids matching property accesses like `t.data`.
  const lits = [];
  for (const sourceType of ['script', 'module']) {
    lits.length = 0;
    try {
      for (const tok of jsTokenizer(code, {
        ecmaVersion: 'latest',
        sourceType,
        allowHashBang: true,
        allowReturnOutsideFunction: true,
        allowAwaitOutsideFunction: true,
        allowImportExportEverywhere: true,
      })) {
        const label = tok.type.label;
        if ((label === 'string' || label === 'template') && tok.value) lits.push(String(tok.value));
      }
      return lits;
    } catch {
      /* try next sourceType */
    }
  }
  return null; // not parseable JS
}
function harvestStaticUrls(code, label, base = baseUrl) {
  const found = new Set();
  if (!code) return found;
  const lits = code.length < 30_000_000 ? jsStringLiterals(code) : null;
  const haystacks = lits ?? [code];
  for (const text of haystacks) {
    for (const m of text.matchAll(URL_IN_CODE)) harvestMatch(m[0], label, base, found);
  }
  // sourceMappingURL comments live outside literals.
  for (const m of code.matchAll(/[#@]\s*sourceMappingURL=([^\s'"*]+)/g)) {
    if (!m[1].startsWith('data:')) speculate(resolveUrl(m[1], base), `sourcemap:${label}`);
  }
  return found;
}
async function deepDecodeText(text, label, base) {
  const found = new Set();
  if (!DO_MAGIC) return found;
  const tokens = new Set();
  for (const m of text.matchAll(MAGIC_TOKEN)) {
    tokens.add(m[0]);
    if (tokens.size > 400) break;
  }
  for (const tok of tokens) {
    if (/^https?:/i.test(tok)) continue;
    const decoded = await autoDecode(tok);
    for (const d of decoded) {
      for (const m of d.matchAll(URL_IN_CODE)) harvestMatch(m[0], `magic:${label}`, base, found);
    }
    if (magicCalls >= MAGIC_MAX || (magicStart && Date.now() - magicStart > MAGIC_BUDGET_MS)) break;
  }
  return found;
}

// ---------- WASM analysis ----------
function stringsFromBuffer(buf, min = 5) {
  const out = [];
  let cur = [];
  const limit = Math.min(buf.length, URLSCAN_MAX_BYTES);
  for (let i = 0; i < limit; i++) {
    const c = buf[i];
    if (c >= 32 && c < 127) {
      cur.push(c);
    } else {
      if (cur.length >= min) out.push(Buffer.from(cur).toString('latin1'));
      cur = [];
    }
  }
  if (cur.length >= min) out.push(Buffer.from(cur).toString('latin1'));
  return out;
}
async function analyzeWasm(buf, srcLabel, base) {
  const info = { from: srcLabel, kind: 'wasm', urls: [], imports: [], notes: [] };
  try {
    const ast = decodeWasm(buf, { ignoreCodeSection: true, ignoreDataSection: false });
    const dataBuffers = [];
    let dataBytes = 0;
    traverseWasm(ast, {
      ModuleImport(p) {
        info.imports.push(`${p.node.module}.${p.node.name}`);
      },
      Data(p) {
        const values = p.node.init?.values;
        if (values && dataBytes < URLSCAN_MAX_BYTES) {
          const b = Buffer.from(values);
          dataBuffers.push(b);
          dataBytes += b.length;
        }
      },
    });
    info.notes.push(`${info.imports.length} imports, ${dataBuffers.length} data segments, ${dataBytes} data bytes`);
    const blob = Buffer.concat(dataBuffers);
    const urls = new Set();
    for (const s of stringsFromBuffer(blob)) {
      for (const m of s.matchAll(URL_IN_CODE)) harvestMatch(m[0], `wasm:${srcLabel}`, base, urls);
    }
    info.urls = [...urls];
  } catch (e) {
    info.notes.push('wasm parse failed: ' + (e?.message || e));
  }
  extraction.push(info);
  return info;
}

// ---------- fetch + analyze one asset ----------
async function fetchBytes(url) {
  if (isAllowlisted(url)) return null;
  if (downloaded.has(url)) {
    const meta = downloaded.get(url);
    try {
      return { buf: fs.readFileSync(meta.localPath), meta };
    } catch {
      /* re-fetch */
    }
  }
  const local = urlToLocal(url);
  adoptFlattened(url, local);
  if (fs.existsSync(local) && fs.statSync(local).isFile()) {
    const size = await headSize(url);
    const onDisk = fs.statSync(local).size;
    if (size != null && size === onDisk) {
      const buf = fs.readFileSync(local);
      const meta = { localPath: local, size: onDisk, encoding: '-', note: 'reused' };
      downloaded.set(url, meta);
      return { buf, meta };
    }
  }
  const res = await got(url, { responseType: 'buffer', decompress: false, throwHttpErrors: false, timeout: { request: 60000 } });
  if (res.statusCode < 200 || res.statusCode >= 300) return null;
  const buf = decodeTransport(res.body, res.headers['content-encoding']);
  ensureDir(local);
  fs.writeFileSync(local, buf);
  const meta = { localPath: local, size: buf.length, encoding: res.headers['content-encoding'] || '-' };
  downloaded.set(url, meta);
  return { buf, meta };
}

// Content-Encoding is transport-level: store what the browser would actually see, so the
// static server never has to replay encoding headers. (Unity's own .br/.unityweb payloads
// are file-level and untouched.)
function decodeTransport(buf, enc) {
  // got returns a plain Uint8Array, whose toString() ignores 'utf8' and joins byte values.
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  try {
    if (enc === 'gzip' || enc === 'x-gzip') return zlib.gunzipSync(buf);
    if (enc === 'br') return zlib.brotliDecompressSync(buf);
    if (enc === 'deflate') return zlib.inflateSync(buf);
  } catch {
    /* mislabelled — keep raw */
  }
  return buf;
}

// UnityWebData1.0 container: magic, u32 headerSize, then [u32 offset, u32 size, u32 nameLen, name]*.
function parseUnityWebData(buf) {
  const MAGIC = 'UnityWebData1.0\0';
  if (buf.length < 20 || buf.toString('latin1', 0, 16) !== MAGIC) return null;
  const headerSize = buf.readUInt32LE(16);
  const files = [];
  let p = 20;
  while (p + 12 <= headerSize && p + 12 <= buf.length) {
    const offset = buf.readUInt32LE(p);
    const size = buf.readUInt32LE(p + 4);
    const nameLen = buf.readUInt32LE(p + 8);
    const name = buf.toString('utf8', p + 12, p + 12 + nameLen);
    p += 12 + nameLen;
    if (offset + size > buf.length) break;
    files.push({ name, data: buf.subarray(offset, offset + size) });
  }
  return files;
}
function scanUnityWebData(files, label, base) {
  const info = { from: label, kind: 'unitywebdata', urls: [], notes: [`${files.length} packed files`] };
  const urls = new Set();
  for (const f of files) {
    info.notes.push(`${f.name} (${f.data.length} bytes)`);
    for (const s of stringsFromBuffer(f.data, 6)) {
      for (const m of s.matchAll(URL_IN_CODE)) harvestMatch(m[0], `unitydata:${f.name}`, base, urls);
    }
  }
  info.notes.splice(40);
  info.urls = [...urls];
  extraction.push(info);
  return urls;
}

// Split bundles (x.data.unityweb.part001, x.bin.002, ...) are one compressed stream cut
// into pieces; stitch, decompress and look inside.
async function analyzeSplitBundles() {
  const groups = new Map();
  for (const u of hits.keys()) {
    const m = u.match(/^(.*?)\.(?:part)?(\d{1,4})(\?.*)?$/i);
    if (!m || !/\.(unityweb|data|wasm|pck|br|gz|bin)$/i.test(m[1])) continue;
    if (!groups.has(m[1])) groups.set(m[1], []);
    groups.get(m[1]).push({ url: u, n: Number(m[2]) });
  }
  for (const [stem, parts] of groups) {
    if (parts.length < 2 || analyzed.has('split:' + stem)) continue;
    analyzed.add('split:' + stem);
    parts.sort((a, b) => a.n - b.n);
    if (!DO_MIRROR) {
      let total = 0;
      for (const p of parts) total += (await headSize(p.url)) || 0;
      if (total > MIRROR_MAX_MB * 1024 * 1024) {
        extraction.push({ from: stem, kind: 'split', urls: [], notes: [`${parts.length} parts, ${total} bytes — use --mirror to scan`] });
        continue;
      }
    }
    const bufs = [];
    for (const p of parts) {
      const r = await fetchBytes(p.url).catch(() => null);
      if (!r) break;
      bufs.push(r.buf);
    }
    if (bufs.length !== parts.length) continue;
    const [enc, body] = sniffInflate(Buffer.concat(bufs), true);
    const files = parseUnityWebData(body);
    if (files) log.detail(`unpacked ${stem} (${parts.length} parts → ${files.length} files)`);
    if (files) queueNew([...scanUnityWebData(files, stem, stem)], 2);
    else extraction.push({ from: stem, kind: 'split', urls: [], notes: [`${parts.length} parts, enc:${enc}, ${body.length} bytes (unknown container)`] });
  }
}

// Engine conventions: a .wasm usually has siblings the loader derives at runtime.
// url(...) and @import references (fonts, backgrounds, cursors) — the sandbox never
// fetches them. In scripts they're only guesses, since they resolve against the page.
function harvestCss(text, base, mode = 'record') {
  const out = new Set();
  const RE = /url\(\s*(["']?)([^"')\s]+)\1\s*\)|@import\s+(["'])([^"']+)\3/gi;
  for (const m of text.matchAll(RE)) {
    const ref = m[2] || m[4];
    if (!ref || /^(data:|#|var\(|about:|javascript:)|\$\{|[+`]/i.test(ref)) continue;
    if (mode === 'record') {
      const u = record(ref, { via: 'css:url', base });
      if (u) out.add(u);
    } else {
      const u = resolveUrl(ref, base);
      if (u) speculate(u, 'css-in-js');
    }
  }
  return out;
}

function speculateEngineSiblings() {
  const dirs = new Map(); // directory URL -> file names seen in it
  for (const u of hits.keys()) {
    if (!/^https?:/i.test(u)) continue;
    const m = u.match(/^(.*)\.wasm(\?.*)?$/i);
    if (m) {
      for (const ext of ['.pck', '.data', '.js', '.worker.js', '.audio.worklet.js', '.side.wasm', '.wasm.map'])
        speculate(m[1] + ext, 'engine-sibling');
    }
    const clean = u.split(/[?#]/)[0];
    const name = clean.slice(clean.lastIndexOf('/') + 1);
    if (!name || name.startsWith('.')) continue;
    const dir = clean.slice(0, clean.length - name.length);
    if (!dirs.has(dir)) dirs.set(dir, new Set());
    dirs.get(dir).add(name);
  }
  // Emscripten loaders (X.js) fetch X.wasm / X.data via paths built at runtime.
  for (const [label, code] of scriptSources) {
    const clean = label.split(/[?#]/)[0];
    if (!/^https?:.*\.js$/i.test(clean)) continue;
    if (/wasmBinaryFile|ENVIRONMENT_IS_WEB|locateFile/.test(code.slice(0, 400000))) {
      for (const ext of ['.wasm', '.data']) speculate(clean.slice(0, -3) + ext, 'emscripten-sibling');
    }
  }
  // Twin directories: builds of the same engine/export share a file layout, so when two
  // directories have several file names in common, each probably has the other's files too.
  const list = [...dirs].filter(([, s]) => s.size >= 3 && s.size <= 400);
  const all = [...hits.keys()].filter((u) => /^https?:/i.test(u)).map((u) => u.split(/[?#]/)[0]);
  for (const [a, sa] of list) {
    for (const [b, sb] of list) {
      if (a === b || a.startsWith(b) || b.startsWith(a)) continue;
      let common = 0;
      for (const n of sa) if (sb.has(n)) common++;
      if (common < 3) continue;
      // Copy the twin's whole subtree (e.g. b/mus/*.ogg → a/mus/*.ogg), not just its top level.
      for (const u of all) if (u.startsWith(b) && u.length > b.length) speculate(a + u.slice(b.length), 'twin-dir');
    }
  }
}

async function headSize(url) {
  try {
    const res = await got.head(url, { throwHttpErrors: false, timeout: { request: 20000 } });
    const len = Number(res.headers['content-length']);
    return Number.isFinite(len) ? len : null;
  } catch {
    return null;
  }
}
async function analyzeAsset(url, depth) {
  if (analyzed.has(url) || depth > MAX_DEPTH) return;
  if (url.startsWith('blob:') || url.startsWith('data:')) return;
  analyzed.add(url);
  const kind = classify(url);
  if (isAllowlisted(url)) {
    extraction.push({ from: url, kind, urls: [], notes: ['allowlisted, left remote'] });
    return;
  }
  if (stubExtFor(url)) {
    extraction.push({ from: url, kind, urls: [], notes: ['stubbed (--copyright), not fetched'] });
    return;
  }
  log.debug(`analyze ${url} (depth ${depth}, ${kind})`);

  // Leaf media (images/audio/video/fonts) hold no URLs worth recursing; don't pull them
  // for analysis (they're still fetched later by --mirror).
  if (LEAF_EXT.test(url)) {
    extraction.push({ from: url, kind, urls: [], notes: ['leaf asset, not scanned'] });
    return;
  }
  // Don't wander into unrelated pages of the host: only HTML at/below the entry directory.
  if (kind === 'document' && url !== baseUrl && !url.startsWith(baseUrl.slice(0, baseUrl.lastIndexOf('/') + 1))) {
    extraction.push({ from: url, kind, urls: [], notes: ['page outside entry scope, not crawled'] });
    return;
  }
  // Without --mirror, don't download big opaque blobs just to string-scan them.
  if (kind === 'binary' && !DO_MIRROR && !downloaded.has(url)) {
    const size = await headSize(url);
    if (size != null && size > BINARY_ANALYZE_CAP) {
      extraction.push({ from: url, kind, urls: [], notes: [`large binary ${size} bytes — scan skipped (use --mirror)`] });
      return;
    }
  }

  const got1 = await fetchBytes(url).catch(() => null);
  if (!got1) return;
  const { buf, meta } = got1;
  if (buf.length > ANALYZE_MAX_BYTES && kind === 'binary' && !DO_MIRROR) {
    extraction.push({ from: url, kind, urls: [], notes: [`skipped analysis (${buf.length} bytes > cap)`] });
    return;
  }

  const tryBrotli = /\.(unityweb|br)(\?.*)?$/i.test(url);
  const [enc, body] = buf.length <= ANALYZE_MAX_BYTES ? sniffInflate(buf, tryBrotli) : ['none', buf];
  meta.decoded = enc;

  const packed = parseUnityWebData(body);
  if (packed) {
    queueNew([...scanUnityWebData(packed, url, url)], depth + 1);
    return;
  }

  if (DO_WASM && isWasm(body)) {
    const found = await analyzeWasm(body, url, url);
    log.detail(`scanned ${url} (wasm, ${found.notes[0] || ''}) → ${found.urls.length} urls`);
    await queueNew([...found.urls], depth + 1);
    return;
  }

  if (looksTextual(body)) {
    const text = body.toString('utf8');
    scriptSources.set(url, text);
    const found = new Set([...harvestStaticUrls(text, url, url)]);
    for (const u of harvestCss(text, url, kind === 'style' || kind === 'document' ? 'record' : 'speculate')) found.add(u);
    for (const u of await extractUrlsViaChef(text)) {
      const href = resolveUrl(u, url);
      if (href && /^https?:/i.test(href)) harvestAbsolute(href, `extractURLs:${url}`, found);
    }
    for (const u of await deepDecodeText(text, url, url)) found.add(u);
    if (looksLikeJs(url) && text.length <= 40000) deobfuscate(text, url);
    extraction.push({ from: url, kind: 'text', urls: [...found], notes: [`${text.length} chars, enc:${enc}`] });
    log.detail(`scanned ${url} (${fmtBytes(text.length)} text${enc !== 'none' ? `, ${enc}` : ''}) → ${found.size} urls`);
    await queueNew([...found], depth + 1);
    return;
  }

  // Opaque binary: still scan raw bytes for embedded URLs.
  const urls = new Set();
  for (const s of stringsFromBuffer(body)) {
    for (const m of s.matchAll(URL_IN_CODE)) harvestMatch(m[0], `bin:${url}`, url, urls);
  }
  extraction.push({ from: url, kind: 'binary', urls: [...urls], notes: [`${body.length} bytes, enc:${enc}`] });
  await queueNew([...urls], depth + 1);
}

// Probe speculative (guessed) URLs; promote to real hits only on HTTP 2xx.
async function probeSpeculative() {
  // Directory-like guesses ("/", "Build/") resolve to listing/landing pages, not assets.
  const entries = [...speculative.entries()].filter(([u, via]) => {
    if (hits.has(u)) return false;
    const p = new URL(u).pathname;
    return !p.endsWith('/') && (via === 'twin-dir' || path.posix.basename(p).includes('.'));
  });
  // Layout-based guesses (engine siblings, twin directories) are few and usually right,
  // so they get their own budget; string-literal guesses share --probe-limit, entry
  // folder first.
  const strong = ([, via]) => /^(engine-sibling|emscripten-sibling|twin-dir)/.test(via);
  const layout = entries.filter(strong).slice(0, Math.max(0, PROBE_MAX * 4 - layoutProbeCount));
  const literal = entries.filter((e) => !strong(e)).sort(([a], [b]) => inEntryScope(b) - inEntryScope(a));
  const literalPending = literal.slice(0, Math.max(0, PROBE_MAX - probeCount));
  if (literal.length > literalPending.length) {
    const msg = `probe limit: checked ${probeCount + literalPending.length} guessed paths, skipped ${literal.length - literalPending.length} (raise --probe-limit to check more)`;
    if (literalPending.length) log.info(`  ${msg}`);
    else log.detail(msg);
  }
  layoutProbeCount += layout.length;
  probeCount += literalPending.length;
  const pending = [...layout, ...literalPending];
  let idx = 0;
  let probedDone = 0;
  const worker = async () => {
    while (idx < pending.length) {
      const [u, via] = pending[idx++];
      try {
        let ok = false;
        const h = await got.head(u, { throwHttpErrors: false, timeout: { request: 15000 } });
        ok = h.statusCode >= 200 && h.statusCode < 300;
        if (!ok && (h.statusCode === 403 || h.statusCode === 405)) {
          const g = await got.get(u, { throwHttpErrors: false, timeout: { request: 15000 }, headers: { range: 'bytes=0-0' } });
          ok = g.statusCode >= 200 && g.statusCode < 300;
        }
        if (ok) record(u, { via: `probe:${via}` });
        log.debug(`probe ${ok ? 'hit ' : 'miss'} ${u}`);
      } catch {
        log.debug(`probe fail ${u}`);
      } finally {
        probedDone++;
        log.bar({ label: 'probe', done: probedDone, total: pending.length, detail: u });
      }
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));
  return pending.length;
}

// Enumerate CDN-backed repos (jsdelivr /gh/ maps 1:1 to a GitHub repo tree), so we can
// mirror files the running page never requests (e.g. Unity StreamingAssets).
async function enumerateCdnRoots() {
  const ghRe = /^https:\/\/cdn\.jsdelivr\.net\/gh\/([^/]+)\/([^/@]+)@([^/]+)\/(.+)$/;
  const roots = new Map();
  for (const u of hits.keys()) {
    const m = u.match(ghRe);
    if (!m || isAllowlisted(u)) continue;
    const [, owner, repo, ref, sub] = m;
    const key = `${owner}/${repo}@${ref}`;
    if (!roots.has(key)) roots.set(key, { owner, repo, ref, prefixes: new Set() });
    const top = sub.split('/')[0];
    if (top && !top.includes('.')) roots.get(key).prefixes.add(top);
  }
  let added = 0;
  for (const { owner, repo, ref, prefixes } of roots.values()) {
    try {
      const res = await got(`https://api.github.com/repos/${owner}/${repo}/git/trees/${ref}?recursive=1`, {
        headers: { 'User-Agent': 'crawl', Accept: 'application/vnd.github+json' },
        responseType: 'json',
        throwHttpErrors: false,
        timeout: { request: 30000 },
      });
      const tree = res.body?.tree || [];
      for (const f of tree) {
        if (f.type !== 'blob') continue;
        for (const pre of prefixes) {
          if (f.path === pre || f.path.startsWith(pre + '/')) {
            const u = `https://cdn.jsdelivr.net/gh/${owner}/${repo}@${ref}/${f.path}`;
            if (!hits.has(u)) added++;
            record(u, { via: 'cdn:github-tree' });
          }
        }
      }
    } catch (e) {
      log.debug(`CDN enumeration failed for ${owner}/${repo}@${ref}: ${e.message}`); // best-effort
    }
  }
  return added;
}

function deobfuscate(code, label) {
  try {
    const r = new REstringer(code);
    r.logger?.setLogLevelNone?.();
    const out = r.deobfuscate() ? r.script : code;
    const safe = label.replace(/[^\w.-]+/g, '_').slice(-80);
    saveOut(`deob/${safe}.js`, out);
    if (out !== code) harvestStaticUrls(out, `${label}:deob`, label);
  } catch {
    /* ignore */
  }
}

// ---------- discovery queue ----------
const queue = [];
const queued = new Set();
function queueNew(urls, depth) {
  for (const u of urls) {
    if (!u || queued.has(u)) continue;
    if (u.startsWith('blob:') || u.startsWith('data:')) continue;
    if (!/^https?:/i.test(u)) continue;
    queued.add(u);
    queue.push({ url: u, depth });
  }
}
async function drainQueue() {
  let done = 0;
  while (queue.length) {
    const { url, depth } = queue.shift();
    done++;
    log.bar({ label: 'analyze', done, total: done + queue.length, detail: url });
    await analyzeAsset(url, depth);
  }
}

// ---------- JSDOM sandbox hooks (discovery) ----------
function rememberJs(url, code) {
  if (!code || fetchedJs.has(url)) return;
  fetchedJs.add(url);
  scriptSources.set(url, code);
  harvestStaticUrls(code, url, url);
}
function patchAccessor(proto, prop, { base, via }) {
  if (!proto) return;
  const desc = Object.getOwnPropertyDescriptor(proto, prop);
  if (!desc || !desc.set) return;
  Object.defineProperty(proto, prop, {
    configurable: true,
    enumerable: desc.enumerable,
    get: desc.get,
    set(value) {
      record(value, { via, base: base(), stack: captureStack() });
      return desc.set.call(this, value);
    },
  });
}
function stubResponse(url) {
  const type = looksLikeJs(url) ? 'application/javascript' : 'application/octet-stream';
  return new Response(new Uint8Array(0), { status: 200, headers: { 'Content-Type': type, 'Content-Length': '0' } });
}
function installHooks(window) {
  const baseOf = () => window.location.href;

  const blobSizeDesc = Object.getOwnPropertyDescriptor(window.Blob.prototype, 'size');
  if (blobSizeDesc?.get) {
    Object.defineProperty(window.Blob.prototype, 'size', {
      configurable: true,
      enumerable: blobSizeDesc.enumerable,
      get() {
        const n = blobSizeDesc.get.call(this);
        return n === 0 ? 1024 * 1024 * 1024 : n;
      },
    });
  }
  let blobSerial = 0;
  const blobStore = new Map();
  if (typeof window.URL.createObjectURL !== 'function') {
    window.URL.createObjectURL = (blob) => {
      const id = `blob:crawl/${++blobSerial}`;
      blobStore.set(id, blob);
      return id;
    };
  }
  if (typeof window.URL.revokeObjectURL !== 'function') window.URL.revokeObjectURL = (id) => blobStore.delete(id);

  // Loaders declare `function createUnityInstance` globally, which replaces any accessor
  // without calling its setter. Wrap it from a capture-phase load listener instead: that
  // runs after the loader executes but before the page's own onload handler calls it.
  const wrapEngineEntry = () => {
    const fn = window.createUnityInstance;
    if (typeof fn !== 'function' || fn.__crawlWrapped) return;
    const wrapped = function (canvas, config, onProgress) {
      if (config && typeof config === 'object') {
        for (const [key, value] of Object.entries(config)) {
          if (typeof value === 'string' && /^(https?:|blob:|\/|\.\/)/i.test(value))
            record(value, { via: `unity.config.${key}`, base: baseOf(), stack: captureStack() });
        }
      }
      try {
        return fn.apply(this, arguments);
      } catch (e) {
        return Promise.reject(e);
      }
    };
    wrapped.__crawlWrapped = true;
    window.createUnityInstance = wrapped;
  };
  window.document.addEventListener(
    'load',
    (e) => {
      if (e.target?.localName === 'script') wrapEngineEntry();
    },
    true
  );

  const realFetch = globalThis.fetch.bind(globalThis);
  window.fetch = async (input, init = {}) => {
    const raw = typeof input === 'string' || input instanceof URL ? String(input) : input.url;
    const url = record(raw, {
      method: init.method || (typeof input !== 'string' && !(input instanceof URL) ? input.method : 'GET'),
      via: 'fetch',
      base: baseOf(),
      stack: captureStack(),
    });
    if (url && looksLikeJs(url) && /^(GET)?$/i.test(init.method || '')) {
      try {
        const res = await realFetch(url, init);
        rememberJs(url, await res.clone().text());
        return res;
      } catch {
        return stubResponse(url);
      }
    }
    return stubResponse(url || raw);
  };

  const XHR = window.XMLHttpRequest;
  const open = XHR.prototype.open;
  const send = XHR.prototype.send;
  XHR.prototype.open = function (method, url, ...rest) {
    this.__crawl = { method, url: resolveUrl(url, baseOf()) };
    record(url, { method, via: 'xhr.open', base: baseOf(), stack: captureStack() });
    return open.call(this, method, url, ...rest);
  };
  XHR.prototype.send = function (body) {
    if (this.__crawl?.url) record(this.__crawl.url, { method: this.__crawl.method, via: 'xhr.send', base: baseOf() });
    // The sandbox clicks buttons; never let that submit anything for real.
    if (!/^(GET|HEAD)$/i.test(this.__crawl?.method || 'GET')) return;
    return send.call(this, body);
  };

  const RealWS = window.WebSocket;
  window.WebSocket = function (url, protocols) {
    record(url, { via: 'websocket', base: baseOf(), stack: captureStack() });
    try {
      return protocols !== undefined ? new RealWS(url, protocols) : new RealWS(url);
    } catch {
      return { close() {}, addEventListener() {}, removeEventListener() {}, send() {} };
    }
  };
  window.WebSocket.prototype = RealWS?.prototype;
  Object.assign(window.WebSocket, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });

  if (window.EventSource) {
    const RealES = window.EventSource;
    window.EventSource = function (url, config) {
      record(url, { via: 'eventsource', base: baseOf(), stack: captureStack() });
      try {
        return new RealES(url, config);
      } catch {
        return { close() {}, addEventListener() {}, removeEventListener() {} };
      }
    };
  }
  if (window.navigator) {
    window.navigator.sendBeacon = function (url) {
      record(url, { method: 'POST', via: 'sendBeacon', base: baseOf(), stack: captureStack() });
      return true;
    };
  }

  const fakeCache = {
    async match(req) {
      record(typeof req === 'string' ? req : req.url, { via: 'caches.match', base: baseOf() });
      return undefined;
    },
    async put(req) {
      record(typeof req === 'string' ? req : req.url, { method: 'PUT', via: 'caches.put', base: baseOf() });
    },
    async delete(req) {
      record(typeof req === 'string' ? req : req.url, { method: 'DELETE', via: 'caches.delete', base: baseOf() });
      return true;
    },
    async add(req) {
      record(typeof req === 'string' ? req : req.url, { via: 'caches.add', base: baseOf() });
    },
    async addAll(reqs) {
      for (const r of reqs) await this.add(r);
    },
    async keys() {
      return [];
    },
  };
  window.caches = {
    async keys() {
      return [];
    },
    async open() {
      return fakeCache;
    },
    async delete() {
      return true;
    },
    async has() {
      return false;
    },
    async match(req) {
      return fakeCache.match(req);
    },
  };

  for (const [Ctor, prop, via] of [
    [window.HTMLScriptElement, 'src', 'script.src'],
    [window.HTMLImageElement, 'src', 'img.src'],
    [window.HTMLIFrameElement, 'src', 'iframe.src'],
    [window.HTMLSourceElement, 'src', 'source.src'],
    [window.HTMLVideoElement, 'src', 'video.src'],
    [window.HTMLAudioElement, 'src', 'audio.src'],
    [window.HTMLLinkElement, 'href', 'link.href'],
    [window.SVGImageElement, 'href', 'svgimage.href'],
  ]) {
    if (Ctor?.prototype) patchAccessor(Ctor.prototype, prop, { base: baseOf, via });
  }

  const realSetAttribute = window.Element.prototype.setAttribute;
  window.Element.prototype.setAttribute = function (name, value) {
    const n = String(name).toLowerCase();
    if (['src', 'href', 'data', 'xlink:href', 'poster', 'srcset'].includes(n)) {
      if (n === 'srcset') {
        String(value)
          .split(',')
          .map((p) => p.trim().split(/\s+/)[0])
          .filter(Boolean)
          .forEach((u) => record(u, { via: `${this.localName}.srcset`, base: baseOf() }));
      } else {
        record(value, { via: `${this.localName}.${n}`, base: baseOf(), stack: captureStack() });
      }
    }
    return realSetAttribute.call(this, name, value);
  };

  const RealWorker = window.Worker;
  window.Worker = function (url, opts) {
    record(url, { via: 'worker', base: baseOf(), stack: captureStack() });
    try {
      return RealWorker ? new RealWorker(url, opts) : { terminate() {}, postMessage() {} };
    } catch {
      return { terminate() {}, postMessage() {} };
    }
  };

  const mo = new window.MutationObserver((mutations) => {
    for (const m of mutations) {
      if (m.type !== 'attributes' || !m.attributeName) continue;
      const val = m.target.getAttribute(m.attributeName);
      if (val) record(val, { via: `mutation:${m.target.localName}.${m.attributeName}`, base: baseOf() });
    }
  });
  mo.observe(window.document, {
    subtree: true,
    attributes: true,
    attributeFilter: ['src', 'href', 'data', 'poster', 'srcset'],
  });
}
async function settle(getCount) {
  const start = Date.now();
  let lastChange = Date.now();
  let last = getCount();
  while (Date.now() - start < SETTLE_MAX_MS) {
    await new Promise((r) => setTimeout(r, 250));
    const now = getCount();
    if (now !== last) {
      last = now;
      lastChange = Date.now();
    } else if (Date.now() - lastChange >= SETTLE_QUIET_MS) break;
  }
}
function attachProvenance() {
  for (const entry of hits.values()) {
    const foundIn = [];
    const bn = entry.url.split('/').pop();
    for (const [label, code] of scriptSources) {
      if (code.includes(entry.url) || (bn && bn.length > 6 && code.includes(bn))) foundIn.push(label);
    }
    entry.definedIn = [...new Set(foundIn)].slice(0, 8);
  }
}

// ---------- mirror writing + rewrite ----------
async function mirrorAll() {
  // Download every discovered asset (any host — CDNs included), bounded by --max-mb.
  refreshFlatRoots();
  relocateDownloaded();
  const isDirLike = (u) => {
    const p = new URL(u).pathname;
    return p.endsWith('/') || !path.posix.basename(p).includes('.');
  };
  const targets = [...hits.values()].map((e) => e.url).filter((u) => /^https?:/i.test(u) && !isDirLike(u));

  let count = 0;
  let reused = 0;
  let stubbed = 0;
  let bytes = 0;
  let done = 0;
  for (const u of targets) {
    if (!isAllowlisted(u)) continue;
    downloaded.set(u, { localPath: '', size: 0, encoding: '-', note: 'allowlisted' });
    log.detail(`allow ${u}`);
  }
  const pending = targets.filter((u) => !isAllowlisted(u) && !downloaded.get(u)?.localPath);
  let idx = 0;
  const tick = (u) => {
    done++;
    log.bar({
      label: 'download',
      done,
      total: pending.length,
      bytes,
      detail: path.posix.basename(new URL(u).pathname),
    });
  };
  async function worker() {
    while (idx < pending.length) {
      const u = pending[idx++];
      const local = urlToLocal(u);
      adoptFlattened(u, local);
      try {
        const stubExt = stubExtFor(u);
        if (stubExt) {
          // Images: read just the header so the stub keeps the original's dimensions.
          const header = isImageExt(stubExt) ? await fetchHeadBytes(u, 64 * 1024) : null;
          const stub = makeStub(stubExt, header);
          ensureDir(local);
          fs.writeFileSync(local, stub);
          downloaded.set(u, { localPath: local, size: stub.length, encoding: '-', note: `stub (${stubExt})` });
          stubbed++;
          log.detail(`stub ${u} (${stubExt}, ${fmtBytes(stub.length)})`);
          continue;
        }
        // Resume: keep binaries already on disk from a previous run (text is re-fetched
        // because it gets rewritten in place).
        const plain = local.replace(/\.(br|gz)$/i, '');
        if (plain !== local && !fs.existsSync(local) && fs.existsSync(plain)) {
          // decompressed by normalizeFileCompression() on an earlier run
          strippedNames.add(path.basename(local));
          downloaded.set(u, { localPath: plain, size: fs.statSync(plain).size, encoding: '-', note: 'reused (decompressed)' });
          reused++;
          log.detail(`reuse ${u}`);
          continue;
        }
        const size = await headSize(u);
        const isText = ['script', 'json', 'style', 'document'].includes(classify(u));
        const onDisk = fs.existsSync(local) && fs.statSync(local).isFile() ? fs.statSync(local).size : 0;
        if (!isText && onDisk > 0 && (size == null || size === onDisk)) {
          downloaded.set(u, { localPath: local, size: onDisk, encoding: '-', note: 'reused' });
          reused++;
          log.detail(`reuse ${u}`);
          continue;
        }
        if (size != null && size > MIRROR_MAX_MB * 1024 * 1024) {
          downloaded.set(u, { localPath: '', size, encoding: '-', note: 'skipped: over --max-mb' });
          log.warn(`skipped ${u} (${fmtBytes(size)} > --max-mb ${MIRROR_MAX_MB})`);
          continue;
        }
        const res = await got(u, { responseType: 'buffer', decompress: false, throwHttpErrors: false, timeout: { request: 300000 } });
        if (res.statusCode < 200 || res.statusCode >= 300) {
          downloaded.set(u, { localPath: '', size: 0, encoding: '-', note: `HTTP ${res.statusCode}` });
          log.detail(`HTTP ${res.statusCode} ${u}`);
          continue;
        }
        const body = decodeTransport(res.body, res.headers['content-encoding']);
        ensureDir(local);
        fs.writeFileSync(local, body);
        downloaded.set(u, { localPath: local, size: body.length, encoding: res.headers['content-encoding'] || '-' });
        count++;
        bytes += body.length;
        log.detail(`get ${u} (${fmtBytes(body.length)})`);
      } catch (e) {
        downloaded.set(u, { localPath: '', size: 0, encoding: '-', note: 'error: ' + (e?.message || e) });
        log.detail(`error ${u}: ${e?.message || e}`);
      } finally {
        tick(u);
      }
    }
  }
  await Promise.all(Array.from({ length: 6 }, worker));
  log.clearProgress();
  return { count, reused, stubbed, bytes };
}

// First `n` bytes of a URL (Range request; the stream is cut off if the server ignores it).
async function fetchHeadBytes(url, n) {
  const chunks = [];
  let got_ = 0;
  try {
    const stream = got.stream(url, { headers: { range: `bytes=0-${n - 1}` }, decompress: true, timeout: { request: 30000 } });
    for await (const c of stream) {
      chunks.push(c);
      got_ += c.length;
      if (got_ >= n) {
        stream.destroy();
        break;
      }
    }
  } catch (e) {
    log.debug(`header fetch failed for ${url}: ${e.message}`);
  }
  return chunks.length ? Buffer.concat(chunks).subarray(0, n) : null;
}

// ---------- static-site output ----------
// Static servers (npx serve, GitHub Pages, ...) send no Content-Encoding for file-level
// x.wasm.br / x.data.gz, which loaders expecting the browser to decode would choke on.
// Store such files decompressed under the plain name and rename references to them.
const strippedNames = new Set(); // basenames like "b138.wasm.br"
function normalizeFileCompression() {
  for (const [u, meta] of downloaded) {
    if (!meta.localPath) continue;
    const m = meta.localPath.match(/^(.*)\.(br|gz)$/i);
    if (!m || !/\.(br|gz)$/i.test(new URL(u).pathname)) continue;
    let out;
    try {
      const buf = fs.readFileSync(meta.localPath);
      out = m[2].toLowerCase() === 'gz' ? zlib.gunzipSync(buf) : zlib.brotliDecompressSync(buf);
    } catch {
      continue; // not really compressed — leave as is
    }
    fs.writeFileSync(m[1], out);
    fs.rmSync(meta.localPath);
    strippedNames.add(path.basename(meta.localPath));
    Object.assign(meta, { localPath: m[1], size: out.length, note: `decompressed .${m[2]}` });
  }
}

const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const toPosix = (p) => p.split(path.sep).join('/');
const siteRel = (local) => toPosix(path.relative(SITE, local));
function relRootFor(file) {
  const r = toPosix(path.relative(path.dirname(file), SITE));
  return r ? r + '/' : './';
}

function mapperConfig(file, url, sameOrigin) {
  const queryMap = {};
  for (const [u, meta] of downloaded) if (meta.localPath?.includes('__q')) queryMap[u] = siteRel(meta.localPath);
  return {
    H: Object.fromEntries([...mirroredHosts].map((h) => [h, hostDir('https://' + h)])),
    Q: queryMap,
    S: [...strippedNames],
    D: path.relative(SITE, path.dirname(file)).split(path.sep).filter(Boolean).length,
    P: hostDir(url),
    X: sameOrigin,
    ...(opts.flatten ? { F: FLAT_ROOTS.map((r) => r.href) } : {}),
    ...(ALLOW.length ? { W: ALLOW.map((a) => [a.re.source, a.hasScheme ? 1 : 0]) } : {}),
  };
}
// Shared by the page/worker shim and the service worker. Maps a URL onto the local tree:
// mirrored host → <root>/<host>/...; with C.X, the original site's root-relative "/x"
// (which now hits the static server's root) → <root>/<page host>/x. With C.F (--flatten),
// a URL under one of those directory prefixes maps to the site root instead.
const MAPPER_SRC = `const root=new URL('../'.repeat(C.D)||'./',location.href).href,dirs=new Set(Object.values(C.H)),strip=new Set(C.S);
const allowRes=(C.W||[]).map(([s,h])=>[new RegExp(s,'i'),h]);
const map=u=>{try{if(u==null||(typeof u==='object'&&!(u instanceof URL)))return u;const s=String(u);
if(/^(blob|data|javascript|about|mailto):/i.test(s))return u;const x=new URL(s,G.document?document.baseURI:location.href);
if(!/^https?:$/.test(x.protocol))return u;
if(allowRes.some(([re,h])=>h?re.test(x.protocol+'//'+x.hostname)||re.test(x.protocol+'//'+x.host):re.test(x.hostname)||re.test(x.host)))return u;let r;
if(C.Q[x.href])r=C.Q[x.href];else if(C.F){const full=x.origin+x.pathname,hit=C.F.find(p=>full===p.slice(0,-1)||full.startsWith(p));
if(hit)r=(full.startsWith(hit)?full.slice(hit.length):'')+x.search+x.hash;else if(x.origin!==location.origin){const d=C.H[x.host];if(!d)return u;r=d+x.pathname+x.search+x.hash}
else{if(!x.href.startsWith(root))return u;r=x.href.slice(root.length)}}
else if(x.origin!==location.origin){const d=C.H[x.host];if(!d)return u;r=d+x.pathname+x.search+x.hash}
else if(C.X){r=x.href.startsWith(root)?x.href.slice(root.length):x.pathname.slice(1)+x.search+x.hash;if(!dirs.has(r.split(/[/?#]/)[0]))r=C.P+'/'+r}
else{if(!x.href.startsWith(root))return u;r=x.href.slice(root.length)}
r=r.replace(/([^/?#]+)\\.(br|gz)(?=[?#]|$)/i,(m,n,e)=>strip.has(m)?n:m);return root+r}catch{return u}};`;
const cfgJson = (cfg) => JSON.stringify(cfg).replace(/</g, '\\u003c');

function buildShim(file, url) {
  // Clean-URL servers (npx serve's default) answer ".../dir/index.html" at ".../dir" with no
  // trailing slash, shifting every relative URL up a level. Put the slash back before any
  // <base> or relative URL is resolved.
  const slashFix = /^index\.html?$/i.test(path.basename(file))
    ? `if(G.document&&!location.pathname.endsWith('/')&&!/\\.html?$/i.test(location.pathname))history.replaceState(history.state,'',location.pathname+'/'+location.search+location.hash);`
    : '';
  return `/*mirror-shim*/(()=>{const C=${cfgJson(mapperConfig(file, url, true))},G=globalThis;if(G.__mirrorShim)return;G.__mirrorShim=1;
${slashFix}${MAPPER_SRC}
if(G.document&&navigator.serviceWorker&&G.isSecureContext)navigator.serviceWorker.register(root+'mirror-sw.js').catch(()=>{});
if(G.fetch){const F=G.fetch;G.fetch=function(i,o){return F.call(this,typeof Request!=='undefined'&&i instanceof Request?new Request(map(i.url),i):map(i),o)}}
if(G.XMLHttpRequest){const O=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(m,u,...a){return O.call(this,m,map(u),...a)}}
if(G.importScripts){const I=G.importScripts;G.importScripts=(...u)=>I(...u.map(map))}
for(const k of ['Worker','SharedWorker','EventSource']){const W=G[k];if(W){G[k]=function(u,o){return new W(map(u),o)};G[k].prototype=W.prototype}}
if(G.document){for(const n of ['HTMLScriptElement','HTMLImageElement','HTMLMediaElement','HTMLSourceElement','HTMLLinkElement','HTMLIFrameElement','HTMLEmbedElement','HTMLObjectElement','HTMLTrackElement','HTMLInputElement']){
const K=G[n];if(!K)continue;for(const p of ['src','href','data','poster']){const d=Object.getOwnPropertyDescriptor(K.prototype,p);if(d&&d.set)Object.defineProperty(K.prototype,p,{...d,set(v){d.set.call(this,map(v))}})}}
const A=Element.prototype.setAttribute;Element.prototype.setAttribute=function(n,v){return A.call(this,n,/^(src|href|data|poster)$/i.test(n)?map(v):v)}}
})();`;
}

// Site-relative path of the local copy of `abs`, or null if we don't have it — links to
// things that weren't mirrored stay pointing at the live site instead of a local 404.
function existingLocal(abs) {
  let u;
  try {
    u = new URL(abs);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(u.protocol) || !mirroredHosts.has(u.host) || isAllowlisted(abs)) return null;
  const meta = downloaded.get(abs);
  if (meta?.localPath && fs.existsSync(meta.localPath)) return siteRel(meta.localPath);
  const flat = flattenRel(u);
  if (flat != null) {
    if (u.pathname.endsWith('/') || flat === '') {
      const dir = path.join(SITE, ...flat.split('/').filter(Boolean));
      if (flat === '' || fs.existsSync(dir)) return flat === '' ? '' : siteRel(dir) + '/';
    }
    const file = urlToLocal(abs);
    if (fs.existsSync(file)) return siteRel(file);
    const plainFlat = file.replace(/\.(br|gz)$/i, '');
    return plainFlat !== file && fs.existsSync(plainFlat) ? siteRel(plainFlat) : null;
  }
  let segs;
  try {
    segs = decodeURIComponent(u.pathname).split('/').filter(Boolean);
  } catch {
    return null;
  }
  const p = path.join(SITE, hostDir(u), ...segs);
  if (!fs.existsSync(p)) {
    const plain = p.replace(/\.(br|gz)$/i, '');
    return plain !== p && fs.existsSync(plain) ? siteRel(plain) : null;
  }
  return siteRel(p) + (fs.statSync(p).isDirectory() && u.pathname.endsWith('/') ? '/' : '');
}
function localRef(abs, relRoot) {
  const rel = existingLocal(abs);
  if (rel == null) return null;
  const u = new URL(abs);
  return relRoot + rel + (rel.includes('__q') ? '' : u.search) + u.hash;
}

// Rewrites URL references in HTML markup / CSS so they resolve against `relRoot`
// (the effective base's path to the site root). Relative refs are already correct.
function rewriteRefs(text, relRoot, baseAbs) {
  const ABS = /(?<![\w\\])(?:https?:)?\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)+(?::\d+)?(?:[/?#][^\s"'<>()\\`]*)?/gi;
  text = text.replace(ABS, (m) => localRef(m.startsWith('//') ? 'https:' + m : m, relRoot) ?? m);
  const rootRel = (m, pre, ref) => {
    const local = localRef(new URL(ref, baseAbs).href, relRoot);
    return local ? pre + local : m;
  };
  return text
    .replace(/(\s(?:src|href|poster|data|action|background)\s*=\s*["']?)(\/(?![/\\])[^"'\s>]*)/gi, rootRel)
    .replace(/(url\(\s*["']?)(\/(?![/\\])[^"')\s]*)/gi, rootRel)
    .replace(/(@import\s+["'])(\/(?![/\\])[^"']*)/gi, rootRel)
    .replace(/(\ssrcset\s*=\s*["'])([^"']*)/gi, (m, pre, list) =>
      pre + list.replace(/(^|,\s*)(\/(?![/\\])[^\s,]*)/g, (mm, sep, ref) => sep + (localRef(new URL(ref, baseAbs).href, relRoot) ?? ref))
    );
}
// File-level .br/.gz that were decompressed: drop the suffix wherever the name appears.
function rewriteFlatPrefixes(text, file) {
  if (!opts.flatten || !FLAT_ROOTS.length) return text;
  const rel = relRootFor(file);
  for (const root of FLAT_ROOTS) {
    const protoRel = '//' + root.href.replace(/^https?:/i, '');
    text = text.replaceAll(root.href, rel).replaceAll(protoRel, rel);
  }
  return text;
}
function renameStripped(text) {
  for (const name of strippedNames) {
    text = text.replace(new RegExp(`(?<![\\w.-])${reEsc(name)}(?![\\w.-])`, 'g'), name.replace(/\.(br|gz)$/i, ''));
  }
  return text;
}

function rewriteHtml(html, file, url) {
  // Every relative URL in a document (markup *and* inline-script fetches) resolves against
  // <base href> when present, so rewrite relative to that effective base.
  const bm = html.match(/<base\b[^>]*?\bhref\s*=\s*(["']?)([^"'\s>]+)\1[^>]*>/i);
  let baseAbs = url;
  if (bm) {
    const r = resolveUrl(bm[2], url);
    if (r && /^https?:/i.test(r)) baseAbs = r;
  }
  const baseLocal = existingLocal(new URL('./', baseAbs).href);
  if (baseLocal == null) return renameStripped(html); // base points somewhere not mirrored
  const baseDir = path.join(SITE, baseLocal);
  const relRoot = relRootFor(path.join(baseDir, '_'));

  const BASE_MARK = '\u0000mirror-base\u0000';
  let newBase = null;
  if (bm) {
    newBase = bm[0].replace(bm[2], (toPosix(path.relative(path.dirname(file), baseDir)) || '.') + '/');
    html = html.replace(bm[0], BASE_MARK);
  }
  // Inline JS bodies are left alone (string surgery breaks `new URL(abs)` and friends);
  // the shim maps their requests at runtime. Only markup and <script src> get rewritten.
  html = html
    .split(/(<script\b[^>]*>[\s\S]*?<\/script\s*>)/i)
    .map((part, i) => {
      if (i % 2 === 0) return rewriteRefs(part, relRoot, baseAbs);
      const m = part.match(/^(<script\b[^>]*>)([\s\S]*)$/i);
      return rewriteRefs(m[1], relRoot, baseAbs) + m[2];
    })
    .join('');
  if (newBase) html = html.replace(BASE_MARK, newBase);
  return renameStripped(html);
}

function headStubTag(file) {
  const parts = [];
  if (HEAD_STUB_HTML) parts.push(HEAD_STUB_HTML);
  if (HEAD_STUB_JS.length) parts.push(`<script src="${relRootFor(file)}mirror-stub.js"></script>`);
  return parts.join('');
}

function rewriteTextMirror() {
  for (const [u, meta] of downloaded) if (meta.localPath) mirroredHosts.add(new URL(u).host);
  relocateDownloaded();
  normalizeFileCompression();
  const stubFile = path.join(SITE, 'mirror-stub.js');
  if (HEAD_STUB_JS.length) fs.writeFileSync(stubFile, HEAD_STUB_JS.join('\n') + '\n');
  else fs.rmSync(stubFile, { force: true });
  const workerUrls = new Set([...hits.values()].filter((e) => [...e.vias].some((v) => v === 'worker')).map((e) => e.url));
  let rewritten = 0;
  for (const [url, meta] of downloaded) {
    if (!meta.localPath) continue;
    let raw;
    try {
      raw = fs.readFileSync(meta.localPath);
    } catch {
      continue;
    }
    if (!looksTextual(raw)) continue;
    const original = raw.toString('utf8');
    if (original.includes('/*mirror-shim*/')) {
      // Reused page: don't stack another shim, but do replace a previously inlined stub.
      if (!headStubTag(meta.localPath)) continue;
      let text = original
        .replace(/(<head(?:\s[^>]*)?>)<script\b(?![^>]*\bsrc\s*=)[^>]*>[\s\S]*?<\/script>(?=<script>\/\*mirror-shim\*\/)/i, '$1')
        .replace(/<script\b[^>]*\bsrc\s*=\s*["'][^"']*mirror-stub\.js["'][^>]*>\s*<\/script>/gi, '');
      const tag = headStubTag(meta.localPath);
      if (!/mirror-stub\.js/i.test(text)) {
        const head = /<head(?:\s[^>]*)?>/i;
        text = head.test(text) ? text.replace(head, (m) => m + tag) : tag + text;
      }
      if (text !== original) {
        fs.writeFileSync(meta.localPath, text);
        rewritten++;
      }
      continue;
    }
    const kind = classify(url);
    const isHtml = kind === 'document' || /\.html?$/i.test(meta.localPath) || /^\s*<(!doctype html|html)/i.test(original);
    let text;
    if (isHtml) text = rewriteFlatPrefixes(rewriteHtml(original, meta.localPath, url), meta.localPath);
    else if (kind === 'style') text = rewriteFlatPrefixes(renameStripped(rewriteRefs(original, relRootFor(meta.localPath), url)), meta.localPath);
    else text = rewriteFlatPrefixes(renameStripped(original), meta.localPath); // JS/JSON: runtime shim + service worker do the mapping
    if (isHtml) {
      const tag = headStubTag(meta.localPath) + `<script>${buildShim(meta.localPath, url)}</script>`;
      const head = /<head(?:\s[^>]*)?>/i;
      text = head.test(text) ? text.replace(head, (m) => m + tag) : tag + text;
    } else if (workerUrls.has(url) && kind === 'script') {
      text = buildShim(meta.localPath, url) + '\n' + text;
    }
    if (text !== original) {
      fs.writeFileSync(meta.localPath, text);
      rewritten++;
    }
  }
  return rewritten;
}

// Reports code that compares the page's own origin against a hard-coded domain — the
// usual reason a mirror shows "wrong site" or a blank screen when served locally.
function findOriginChecks() {
  const SINK = /\b(?:(?:window|document|top|self|parent)\.)?location\.(?:host(?:name)?|origin|href)\b|\bdocument\.(?:domain|referrer)\b/g;
  const DOMAIN = /["'`](?:https?:\/\/)?((?:[a-z0-9-]+\.)+[a-z]{2,})(?::\d+)?\/?["'`]/gi;
  const COMPARE = /===?|!==?|indexOf|includes|match|test|endsWith|startsWith|search/;
  // A check against the site's own page hosts is a sitelock; libraries (ads, analytics,
  // engines) routinely compare against their own domains, which is only reported with -v.
  const pageHosts = new Set([...pagesRun].map((u) => new URL(u).hostname));
  const results = [];
  const seen = new Set(); // the same inline script is also scanned as part of its page
  for (const [label, code] of scriptSources) {
    if (code.length > 30_000_000) continue;
    let n = 0;
    let first = null;
    let ownHost = false;
    for (const m of code.matchAll(SINK)) {
      const near = code.slice(Math.max(0, m.index - 160), m.index + m[0].length + 160);
      const lineStart = code.lastIndexOf('\n', m.index) + 1;
      const line = code.slice(lineStart, Math.min(code.indexOf('\n', m.index) >>> 0, lineStart + 400));
      const domains = [...near.matchAll(DOMAIN)].map((d) => d[1].toLowerCase());
      if (domains.length && COMPARE.test(near) && !seen.has(line)) {
        seen.add(line);
        n++;
        if (domains.some((d) => pageHosts.has(d))) ownHost = true;
        if (!first) {
          const before = code.slice(0, m.index);
          first = `${before.split('\n').length}:${m.index - before.lastIndexOf('\n')}`;
        }
      }
    }
    if (n) results.push({ source: label, matches: n, first, ownHost });
  }
  return results;
}

function writeStaticSiteFiles(entryLocal) {
  // Root landing page → entry, so `npx serve <out>/site` opens the game directly.
  const rootIndex = path.join(SITE, 'index.html');
  const target = siteRel(entryLocal).replace(/(^|\/)index\.html?$/i, '$1'); // folder form avoids a clean-URL redirect
  if (!localClaims.has(rootIndex)) {
    fs.writeFileSync(
      rootIndex,
      `<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=${target}"><title>Redirecting…</title>` +
        `<script>location.replace(${JSON.stringify(target)})</script><a href="${target}">${target}</a>`
    );
  }
  // Service worker: catches what the shim can't wrap (CSS url() set from JS, innerHTML
  // images, import(), late media) and serves it locally. Falls back to the network on a
  // local miss, so it's harmless if it outlives this mirror on the same origin.
  fs.writeFileSync(
    path.join(SITE, 'mirror-sw.js'),
    `/*mirror-sw*/const C=${cfgJson(mapperConfig(path.join(SITE, '_'), baseUrl, false))},G=globalThis;
${MAPPER_SRC}
self.addEventListener('install',()=>self.skipWaiting());
self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));
self.addEventListener('fetch',e=>{const q=e.request;if(q.method!=='GET'&&q.method!=='HEAD')return;
const to=map(q.url);if(typeof to!=='string'||to.split('#')[0]===q.url)return;
e.respondWith(fetch(to,{method:q.method,headers:q.headers}).then(r=>r.ok||r.status===206?r:fetch(q)).catch(()=>fetch(q)))});
`
  );
  // Threaded engines (Emscripten pthreads, Godot 4) need cross-origin isolation, which a
  // static server can only provide through its own header config.
  const needsIsolation = [...scriptSources.values()].some((t) => /new\s+SharedArrayBuffer|PThread\.|Atomics\.wait\(/.test(t));
  const isolation = [
    { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
    { key: 'Cross-Origin-Embedder-Policy', value: 'require-corp' },
  ];
  // Only then is any server config written (serve.json for npx serve, _headers for
  // Netlify / Cloudflare Pages); otherwise the folder works with any static server as-is.
  for (const f of ['serve.json', '_headers']) fs.rmSync(path.join(SITE, f), { force: true });
  if (needsIsolation) {
    fs.writeFileSync(path.join(SITE, 'serve.json'), JSON.stringify({ headers: [{ source: '**', headers: isolation }] }, null, 2));
    fs.writeFileSync(path.join(SITE, '_headers'), `/*\n${isolation.map((h) => `  ${h.key}: ${h.value}`).join('\n')}\n`);
  }
  return needsIsolation;
}

// ---------- main ----------
fs.mkdirSync(OUT, { recursive: true });

const PHASES = DO_MIRROR ? 4 : 3;
let phaseStart = Date.now();
let phaseNo = 0;
const phase = (title) => {
  if (phaseNo) log.debug(`phase took ${fmtDuration(Date.now() - phaseStart)}`);
  phaseStart = Date.now();
  log.step(`[${++phaseNo}/${PHASES}] ${title}`);
};

log.info(`${log.paint('bold', CLI)} ${VERSION}  ${baseUrl}`);
log.info(`output: ${OUT}`);
if (opts.flatten) log.info('flatten: entry folder and matching CDN copies land in the site root');
if (ALLOW.length) log.info(`allowlist: ${ALLOW.map((a) => a.pattern).join(', ')} (left remote)`);
if (STUB_EXTS.size) log.info(`stubbing media: ${[...STUB_EXTS].join(', ')}`);
if (HEAD_STUB_JS.length || HEAD_STUB_HTML) log.info(`adding ${opts.addstub.length} <head> stub(s)${HEAD_STUB_JS.length ? ' via mirror-stub.js' : ''}`);
if (!DO_MIRROR && STUB_EXTS.size) log.warn('--copyright only has an effect together with --mirror');
log.debug(`options: ${JSON.stringify({ ...opts, verbose: opts.verbose.length })}`);

phase('Loading the page in a sandbox');
let htmlRes;
try {
  htmlRes = await got(baseUrl, { timeout: { request: 60000 }, throwHttpErrors: false });
} catch (e) {
  await die(`could not fetch ${baseUrl}: ${e.code || e.message}`, e);
}
if (htmlRes.statusCode >= 400) await die(`${baseUrl} answered HTTP ${htmlRes.statusCode}`);
if (htmlRes.url && htmlRes.url !== baseUrl) {
  log.info(`redirected to ${htmlRes.url}`);
  baseUrl = htmlRes.url;
  activeHosts.add(new URL(baseUrl).host);
}
seedFlatRoots(htmlRes.body, baseUrl);
const htmlLocal = urlToLocal(baseUrl);
adoptFlattened(baseUrl, htmlLocal);
ensureDir(htmlLocal);
fs.writeFileSync(htmlLocal, htmlRes.body);
downloaded.set(baseUrl, { localPath: htmlLocal, size: htmlRes.body.length, encoding: '-' });
saveOut('base.html', htmlRes.body);
record(baseUrl, { via: 'document' });

const refreshActiveHosts = () => {
  for (const u of hits.keys()) if (/^https?:/i.test(u)) activeHosts.add(new URL(u).host);
  for (const [u, via] of references) {
    if (isActiveUrl(u)) {
      references.delete(u);
      record(u, { via });
    }
  }
};
const entryDir = () => baseUrl.slice(0, baseUrl.lastIndexOf('/') + 1);
const inEntryScope = (u) => u.startsWith(entryDir());
const pagesRun = new Set();
const sourceBase = new Map(); // script label -> base URL it was found under

// Run one HTML page in a JSDOM sandbox, then poke its javascript: links and onclick
// handlers so URLs built at runtime (e.g. `chapter${n}/index.html`) get requested too.
async function runPage(url, html) {
  pagesRun.add(url);
  const tag = url === baseUrl ? '' : `${siteRel(urlToLocal(url))}#`;
  const before = hits.size;
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (e) => log.debug(`[sandbox ${tag || 'entry'}] ${e?.message || e}${e?.detail?.stack ? '\n' + e.detail.stack : ''}`));
  for (const m of ['log', 'info', 'warn', 'error', 'debug']) {
    virtualConsole.on(m, (...args) => log.debug(`[page console.${m}] ${args.map((a) => (typeof a === 'string' ? a : util.inspect(a, { depth: 2 }))).join(' ')}`));
  }
  const dom = new JSDOM(html, {
    url,
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole,
    resources: {
      interceptors: [
        requestInterceptor(async (request, { element }) => {
          const via = element ? `resource:${element.localName}` : 'resource';
          const u = record(request.url, { method: request.method, via, base: url, stack: captureStack() });
          if (u && looksLikeJs(u)) return undefined; // let jsdom run nested JS
          return stubResponse(u || request.url);
        }),
      ],
    },
    beforeParse: installHooks,
  });
  const watch = () => {
    log.bar({ label: 'sandbox', extra: `${hits.size} URLs`, detail: tag ? tag.slice(0, -1) : new URL(url).host });
    return hits.size;
  };
  await settle(watch);
  const doc = dom.window.document;
  const pageBase = doc.baseURI || url;

  // Static pass over inline scripts + final HTML attributes (after scripts ran, before
  // any action below can replace the document).
  [...doc.querySelectorAll('script')].forEach((el, index) => {
    const code = el.textContent || '';
    if (!code.trim()) {
      if (el.src) record(el.src, { via: 'script[src]', base: pageBase });
      return;
    }
    const label = `${tag}inline:${index}`;
    scriptSources.set(label, code);
    sourceBase.set(label, pageBase);
    harvestStaticUrls(code, label, pageBase);
    if (code.length <= 40000) deobfuscate(code, label);
  });
  for (const el of doc.querySelectorAll('style')) harvestCss(el.textContent || '', pageBase);
  for (const el of doc.querySelectorAll('[style]')) harvestCss(el.getAttribute('style') || '', pageBase);
  for (const el of doc.querySelectorAll('[src],[href],[poster],[data],[srcset]')) {
    for (const attr of ['src', 'href', 'poster', 'data']) {
      const v = el.getAttribute(attr);
      if (!v || /^(javascript|mailto|tel):|^#/i.test(v)) continue;
      if (el.localName === 'a' && attr === 'href') {
        // Links count only when they lead to another page of this site.
        try {
          const abs = new URL(v, pageBase).href.split('#')[0];
          if (inEntryScope(abs)) record(abs, { via: 'html:a.href' });
        } catch {
          /* bad href */
        }
        continue;
      }
      record(v, { via: `html:${el.localName}.${attr}`, base: pageBase });
    }
    const ss = el.getAttribute('srcset');
    if (ss) ss.split(',').forEach((p) => record(p.trim().split(/\s+/)[0], { via: `html:${el.localName}.srcset`, base: pageBase }));
  }

  const actions = [...doc.querySelectorAll('a[href]')].map((a) => a.getAttribute('href')).filter((h) => /^javascript:/i.test(h)).slice(0, 60);
  const clickables = [...doc.querySelectorAll('[onclick]')].slice(0, 60);
  if (actions.length || clickables.length) {
    log.detail(`trying ${actions.length} javascript: links and ${clickables.length} onclick handlers on ${url}`);
    for (const h of new Set(actions)) {
      let code = h.slice('javascript:'.length);
      try {
        code = decodeURIComponent(code);
      } catch {
        /* keep raw */
      }
      try {
        dom.window.eval(code);
      } catch (e) {
        log.debug(`action ${code.slice(0, 80)} threw: ${e.message}`);
      }
    }
    for (const el of clickables) {
      try {
        el.click();
      } catch (e) {
        log.debug(`click on <${el.localName}> threw: ${e.message}`);
      }
    }
    await settle(watch);
  }
  dom.window.close();
  log.clearProgress();
  log.info(`  ${url === baseUrl ? 'the page' : siteRel(urlToLocal(url))} requested ${hits.size - before} URLs while running`);
}

// Same-scope HTML pages discovered so far that haven't been run in the sandbox yet.
async function runNewPages() {
  const sameAs = (a, b) => a.replace(/index\.html?$/i, '') === b.replace(/index\.html?$/i, '');
  const todo = [...hits.keys()].filter(
    (u) => /^https?:/i.test(u) && classify(u) === 'document' && inEntryScope(u) && !pagesRun.has(u) && ![...pagesRun].some((p) => sameAs(p, u))
  );
  for (const u of todo) {
    if (pagesRun.size >= MAX_PAGES) {
      log.warn(`--max-pages ${MAX_PAGES} reached; ${todo.length - todo.indexOf(u)} more pages not run in the sandbox`);
      return;
    }
    try {
      const res = await got(u, { timeout: { request: 60000 }, throwHttpErrors: false });
      pagesRun.add(u);
      if (res.statusCode >= 400 || !/html/i.test(res.headers['content-type'] || 'text/html')) continue;
      await runPage(u, res.body);
    } catch (e) {
      pagesRun.add(u);
      log.detail(`could not load page ${u}: ${e.message}`);
    }
  }
}

await runPage(baseUrl, htmlRes.body);
refreshActiveHosts();

// Deep pass: run new pages → analyze → enumerate CDN repos → probe guesses, until nothing new appears.
phase('Digging through pages, scripts, WASM, bundles and data files');
const decodedSources = new Set();
for (let round = 1; round <= 6; round++) {
  refreshActiveHosts();
  const before = hits.size;
  await runNewPages();
  queueNew([...hits.keys()], 1);
  await drainQueue();
  const scripts = [...scriptSources];
  for (let i = 0; i < scripts.length; i++) {
    const [label, code] = scripts[i];
    if (decodedSources.has(label)) continue;
    decodedSources.add(label);
    log.bar({ label: 'decode', done: i + 1, total: scripts.length, detail: label });
    await deepDecodeText(code, label, sourceBase.get(label) || baseUrl);
  }
  await analyzeSplitBundles();
  await drainQueue();
  if (DO_ENUMERATE) {
    log.bar({ label: 'cdn', detail: 'listing repository files' });
    const added = await enumerateCdnRoots();
    if (added) log.info(`  round ${round}: listing the CDN repo found ${added} more files`);
  }
  speculateEngineSiblings();
  if (speculative.size) {
    log.bar({ label: 'probe', done: 0, total: speculative.size, detail: 'checking guessed paths' });
    const beforeProbe = hits.size;
    const probed = await probeSpeculative();
    speculative.clear();
    log.clearProgress();
    if (probed) log.info(`  round ${round}: ${hits.size - beforeProbe} of ${probed} guessed paths exist`);
  }
  log.clearProgress();
  log.info(`  round ${round}: ${hits.size - before} new URLs (${hits.size} total)`);
  if (hits.size === before) break;
}

attachProvenance();

let mirror = { count: 0, reused: 0, stubbed: 0, bytes: 0 };
if (DO_MIRROR) {
  phase(`Downloading ${[...hits.keys()].filter((u) => /^https?:/.test(u)).length} files`);
  mirror = await mirrorAll();
  log.info(
    `  fetched ${mirror.count} files not already pulled in during analysis (${fmtBytes(mirror.bytes)}), ` +
      `${mirror.stubbed} stubbed${mirror.reused ? `, ${mirror.reused} reused` : ''}`
  );
}
phase('Writing the static site');
const rewrittenCount = rewriteTextMirror();
const needsIsolation = writeStaticSiteFiles(urlToLocal(baseUrl));
const originChecks = findOriginChecks();
log.info(`  rewrote links in ${rewrittenCount} files`);
log.debug(`phase took ${fmtDuration(Date.now() - phaseStart)}`);

// ---------- reports ----------
const urls = [...hits.values()]
  .map((e) => ({
    url: e.url,
    kind: classify(e.url),
    methods: [...e.methods].sort(),
    vias: [...e.vias].sort(),
    definedIn: e.definedIn || [],
    local: downloaded.get(e.url)?.localPath?.replace(/\\/g, '/') || null,
    bytes: downloaded.get(e.url)?.size ?? null,
    note: downloaded.get(e.url)?.note || (isAllowlisted(e.url) ? 'allowlisted' : null),
  }))
  .sort((a, b) => a.url.localeCompare(b.url));

const network = urls.filter((u) => u.kind !== 'blob' && u.kind !== 'data');
saveOut(
  'urls.json',
  JSON.stringify(
    {
      base: baseUrl,
      discoveredAt: new Date().toISOString(),
      count: network.length,
      urls,
      references: [...references].map(([url, via]) => ({ url, via })).sort((a, b) => a.url.localeCompare(b.url)),
    },
    null,
    2
  )
);
saveOut(
  'extraction-report.json',
  JSON.stringify(
    {
      base: baseUrl,
      magicCalls,
      originChecks,
      sources: extraction.sort((a, b) => (b.urls?.length || 0) - (a.urls?.length || 0)),
    },
    null,
    2
  )
);

const missing = urls.filter((u) => u.note && /skipped|error|HTTP/.test(u.note));
const entryPath = '/' + siteRel(urlToLocal(baseUrl));
saveOut(
  'mirror-manifest.json',
  JSON.stringify(
    {
      docroot: 'site',
      entry: entryPath,
      hosts: [...mirroredHosts],
      mirrored: mirror.count,
      reused: mirror.reused,
      stubbed: urls.filter((u) => u.note?.startsWith('stub')).map((u) => u.url),
      allowlisted: urls.filter((u) => u.note === 'allowlisted').map((u) => u.url),
      rewritten: rewrittenCount,
      originChecks,
      missing: missing.map((m) => ({ url: m.url, note: m.note })),
    },
    null,
    2
  )
);

const byKind = {};
for (const u of network) byKind[u.kind] = (byKind[u.kind] || 0) + 1;
const shown = (p) => {
  const rel = path.relative(process.cwd(), p);
  const s = rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : p;
  return /\s/.test(s) ? `"${s}"` : s;
};
const report = (name) => shown(path.join(OUT, name));

const siteLocks = originChecks.filter((c) => c.ownHost);
for (const c of siteLocks.slice(0, 10)) {
  log.warn(`${c.source} compares the page origin against this site's domain (${c.matches}×, first at ${c.first}); the copy may refuse to run elsewhere`);
}
if (siteLocks.length > 10) log.warn(`…and ${siteLocks.length - 10} more files with origin checks (see ${report('extraction-report.json')})`);
for (const c of originChecks.filter((x) => !x.ownHost)) log.detail(`origin comparison against another domain in ${c.source} (first at ${c.first}), probably harmless`);
for (const m of missing.slice(0, 5)) log.warn(`not mirrored: ${m.url} (${m.note})`);
if (missing.length > 5) log.warn(`…and ${missing.length - 5} more not mirrored (see ${report('mirror-manifest.json')})`);

const b = (s) => log.paint('bold', s);
const lines = [
  '',
  b(`Done in ${fmtDuration(log.elapsed())}.`),
  `  Found      ${network.length} URLs  (${Object.entries(byKind).map(([k, v]) => `${k} ${v}`).join(', ')})`,
];
if (log.level >= LEVELS.verbose) {
  lines.push(`  Analysis   ${magicCalls} magic decodes, ${probeCount} guessed paths probed, ${references.size} doc-only references`);
}
if (DO_MIRROR) {
  const saved = [...downloaded.values()].filter((d) => d.localPath && !d.note?.startsWith('stub'));
  const savedBytes = saved.reduce((s, d) => s + (d.size || 0), 0);
  const allowedN = network.filter((u) => u.note === 'allowlisted').length;
  lines.push(
    `  Saved      ${saved.length} files (${fmtBytes(savedBytes)}${mirror.reused ? `, ${mirror.reused} reused from a previous run` : ''}), ` +
      `${mirror.stubbed} stubbed, ${missing.length} missing${allowedN ? `, ${allowedN} left remote` : ''}`
  );
}
lines.push(`  Reports    ${report('urls.json')}, ${report('extraction-report.json')}, ${report('mirror-manifest.json')}`);
if (DO_MIRROR) {
  lines.push(
    '',
    b('Serve this folder:'),
    `  npx serve ${shown(SITE)}`,
    `  then open the address it prints (usually http://localhost:3000). Entry page: ${entryPath}`
  );
  if (needsIsolation) lines.push('  Threaded build: COOP/COEP headers are in serve.json (npx serve) and _headers (Netlify/Cloudflare Pages).');
  if (siteLocks.length) lines.push(log.paint('yellow', `  ${siteLocks.length} file(s) contain origin checks (see the warnings above).`));
} else {
  lines.push('', `Discovery only. Re-run with ${b('-m')} to download a playable offline copy into ${shown(SITE)}.`);
}
log.summary(lines.join('\n'));
await log.close();
