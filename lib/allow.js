// Domain globs for --allowlist. A matching URL is left pointing at the live site.
// `*` matches one label (no dot). `*.` at the start of the host also matches
// the bare host, so `*://*.example.*` matches both http://example.com and
// https://a.b.example.test. A path on the pattern is ignored: the whole host stays remote.

function compileAllow(pattern) {
  let src = '';
  let i = 0;
  while (i < pattern.length) {
    const afterScheme = i >= 3 && pattern.slice(i - 3, i) === '://';
    if (pattern.startsWith('*.', i) && (i === 0 || afterScheme)) {
      src += '(?:[^./]+\\.)*';
      i += 2;
      continue;
    }
    const ch = pattern[i++];
    // One label, so `*.example.*` matches example.com and not example.com.evil.com.
    src += ch === '*' ? '[^./]*' : ch.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp('^' + src + '$', 'i');
}

// " *://*.example.*/js " → { pattern, hasScheme, re } matched against scheme://hostname.
export function parseAllowPattern(raw) {
  let pattern = String(raw).trim();
  if (!pattern) throw new Error('empty pattern');
  const hasScheme = /^[a-z*][a-z0-9+.-]*:\/\//i.test(pattern);
  if (hasScheme) {
    const at = pattern.indexOf('://');
    const slash = pattern.indexOf('/', at + 3);
    if (slash !== -1) pattern = pattern.slice(0, slash);
  } else {
    const slash = pattern.indexOf('/');
    if (slash !== -1) pattern = pattern.slice(0, slash);
  }
  return { pattern, hasScheme, re: compileAllow(pattern) };
}

export function parseAllowlist(list) {
  if (!Array.isArray(list) || list.some((x) => typeof x !== 'string')) {
    throw new Error('expected a JSON array of strings');
  }
  return list.map(parseAllowPattern);
}

export function urlAllowed(patterns, url) {
  if (!patterns.length) return false;
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (!/^https?:$/i.test(u.protocol)) return false;
  const origin = u.protocol + '//' + u.hostname;
  const withPort = u.protocol + '//' + u.host;
  for (const a of patterns) {
    if (a.hasScheme) {
      if (a.re.test(origin) || a.re.test(withPort)) return true;
    } else if (a.re.test(u.hostname) || a.re.test(u.host)) return true;
  }
  return false;
}
