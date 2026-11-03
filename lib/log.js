// Leveled console logger: quiet < normal < verbose < debug. A --log-file always gets
// everything (debug level, timestamped) regardless of what the console shows.
import fs from 'node:fs';
import util from 'node:util';

export const LEVELS = { quiet: 0, normal: 1, verbose: 2, debug: 3 };

export function createLogger({ level = LEVELS.normal, color = true, file = null } = {}) {
  const tty = process.stdout.isTTY;
  const useColor = color && tty && !process.env.NO_COLOR && typeof util.styleText === 'function';
  const paint = (style, s) => (useColor ? util.styleText(style, s) : s);
  const sink = file ? fs.createWriteStream(file, { flags: 'w' }) : null;
  const start = Date.now();
  let panel = null;
  let panelLines = 0;
  let lastDraw = 0;

  const toFile = (tag, msg) => {
    if (!sink) return;
    const t = ((Date.now() - start) / 1000).toFixed(2).padStart(8);
    sink.write(`${t}s ${tag.padEnd(5)} ${util.stripVTControlCharacters(String(msg))}\n`);
  };
  const cols = () => Math.max(40, (process.stdout.columns || 80) - 1);
  const clip = (s, n) => (s.length <= n ? s : s.slice(0, Math.max(0, n - 1)) + '…');
  const erasePanel = () => {
    if (!panelLines) return;
    process.stdout.write(`\x1b[${panelLines}F\x1b[J`);
    panelLines = 0;
  };
  const drawPanel = (state) => {
    const width = cols();
    const label = String(state.label || 'work').slice(0, 10).padEnd(10);
    const known = state.total > 0;
    const pct = known ? Math.min(100, Math.round((state.done / state.total) * 100)) : 0;
    const stats = known ? ` ${state.done}/${state.total}  ${String(pct).padStart(3)}%` : '  running';
    const barW = Math.max(8, width - label.length - stats.length - 3);
    let cells;
    if (known) {
      const filled = Math.min(barW, Math.round((pct / 100) * barW));
      cells = paint('green', '█'.repeat(filled)) + paint('dim', '░'.repeat(barW - filled));
    } else {
      const block = Math.min(6, barW);
      const span = barW - block;
      const pos = Math.floor(Date.now() / 90) % (span * 2 || 1);
      const x = pos <= span ? pos : span * 2 - pos;
      cells = paint('dim', '░'.repeat(x)) + paint('green', '█'.repeat(block)) + paint('dim', '░'.repeat(barW - block - x));
    }
    const bits = [];
    if (state.bytes != null) bits.push(fmtBytes(state.bytes));
    if (state.bytes > 0) {
      const sec = (Date.now() - start) / 1000;
      if (sec >= 1) bits.push(fmtBytes(state.bytes / sec) + '/s');
    }
    if (state.extra) bits.push(state.extra);
    bits.push(fmtDuration(Date.now() - start));
    const lines = [
      `  ${label}${cells}${stats}`,
      `  ${paint('dim', clip(bits.join('  ·  '), width - 2))}`,
      `  ${clip(state.detail || '', width - 2)}`,
    ];
    process.stdout.write(lines.join('\n') + '\n');
    panelLines = lines.length;
  };
  const clearProgress = () => {
    erasePanel();
    panel = null;
  };
  const showPanel = (state) => {
    panel = state;
    if (level !== LEVELS.normal || !tty) return;
    const now = Date.now();
    const finished = state.total > 0 && state.done >= state.total;
    if (!finished && panelLines && now - lastDraw < 80) return;
    erasePanel();
    drawPanel(state);
    lastDraw = now;
  };
  const emit = (min, tag, msg, stream = process.stdout) => {
    toFile(tag, msg);
    if (level < min) return;
    const resume = panel;
    erasePanel();
    stream.write(msg + '\n');
    if (resume && stream === process.stdout) {
      drawPanel(resume);
      lastDraw = Date.now();
    }
  };

  return {
    level,
    paint,
    step: (msg) => emit(LEVELS.normal, 'step', paint('bold', `==> ${msg}`)),
    info: (msg) => emit(LEVELS.normal, 'info', msg),
    detail: (msg) => emit(LEVELS.verbose, 'verb', paint('dim', `    ${msg}`)),
    debug: (msg) => emit(LEVELS.debug, 'debug', paint('gray', `    [debug] ${msg}`)),
    warn: (msg) => emit(LEVELS.quiet, 'warn', paint('yellow', `warning: ${msg}`), process.stderr),
    error: (msg) => emit(LEVELS.quiet, 'error', paint('red', `error: ${msg}`), process.stderr),
    // Final summary: shown even with --quiet.
    summary(msg) {
      panel = null;
      emit(LEVELS.quiet, 'sum', msg);
    },
    // Live 3-line panel (TTY, normal level). `total` 0 draws a sliding bar.
    // A string is still accepted so older call sites keep working.
    progress(msg) {
      showPanel(typeof msg === 'string' ? { label: 'work', detail: msg.trim() } : msg || {});
    },
    bar(state) {
      showPanel(state || {});
    },
    clearProgress,
    elapsed: () => Date.now() - start,
    close: () => new Promise((r) => (sink ? sink.end(r) : r())),
  };
}

export function fmtBytes(n) {
  if (n == null) return '?';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(i ? 1 : 0)} ${u[i]}`;
}
export function fmtDuration(ms) {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}
