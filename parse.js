// SwiftMark Scanner: a from-scratch single-pass Markdown-to-HTML parser.
//
// The scanner reads the input once and emits HTML directly, with no token
// tree and no dependencies. Its output matches marked 18.1.3 (GFM on,
// breaks off) byte for byte. Blocks are parsed line by line; inline
// content is scanned with one combined jump regex that leaps between
// special characters, and plain text is emitted as whole runs.
//
// Layout: helpers (escaping, entities, tabs), the inline scanner, the
// block parser, and the parse() entry point at the bottom.

const BLANK_RE = /^[ \t]*$/;
const NUM_REF_RE = /&#(?:(\d{1,7})|[Xx]([0-9A-Fa-f]{1,6}));/y;
// Marked's emphasis mask (#n): before scanning for emphasis, marked
// builds a "masked source" of the whole inline block. Code spans,
// inline links and tags are replaced by same-length `[aaa...]` runs,
// escaped punctuation by `+`, and backticks inside code spans by `+`.
// Delimiter runs inside a masked region are invisible to the emphasis
// matcher — this is what stops `_issue table_` from emphasizing when
// a mismatched `` `` `` run earlier in the paragraph makes the masking
// swallow it. The reflink-label part of #n is skipped: link labels are
// parsed recursively here, so their delimiters never reach this level.
const MASK_PUNCT_RE = /(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\([\p{P}\p{S}])/gu;
const MASK_SKIP_RE = /\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)|(?<!`)()(?<b>`+)[^`]+\k<b>(?!`)|<(?! )[^<>]*?>/g;

// Build the masked source for an inline block, or null when nothing
// in it can be masked (then the mask is the identity). All
// replacements preserve length, so indices line up with the original.
function maskInlineSource(s) {
  if (s.indexOf('`') === -1 && s.indexOf('[') === -1 && s.indexOf('<') === -1 && s.indexOf('\\') === -1) return null;
  const t = s.replace(MASK_PUNCT_RE, (n, g1, g2) => g2 ? '+'.repeat(n.length) : g1 ? g1 + n.slice(g1.length, -g1.length).replace(/`/g, '+') + g1 : n);
  return t.replace(MASK_SKIP_RE, (n) => '[' + 'a'.repeat(n.length - 2) + ']');
}
// A bare & that is NOT the start of something entity-like.
const BARE_AMP_RE = /&(?!(#\d{1,7}|#[Xx][0-9A-Fa-f]{1,6}|\w+);)/g;
const NUM_REF_OR_AMP_RE = /&#(?:(\d{1,7})|[Xx]([0-9A-Fa-f]{1,6}));|&(?!(#\d{1,7}|#[Xx][0-9A-Fa-f]{1,6}|\w+);)/g;
// Sticky: does an entity-like sequence start exactly at lastIndex?
const ENT_LIKE_RE = /&(?:#\d{1,7}|#[Xx][0-9A-Fa-f]{1,6}|\w+);/y;

// Expand the tabs in the LEADING whitespace run of `s` (up to the
// first non-space char) to spaces, assuming `s` starts at column
// `startCol`. A tab advances to the next multiple of 4. Tabs after
// the first non-space char are left alone — marked's list tokenizer
// expands only the leading whitespace (its J is applied to the
// leading-whitespace match), so a tab inside the line content (e.g.
// after a `>` quote marker) must survive to be expanded later by
// the quote/fence processing at the right column.
function expandLeadingTabs(s, startCol) {
  let i = 0;
  while (i < s.length && (s.charCodeAt(i) === 32 || s.charCodeAt(i) === 9)) i++;
  if (i === 0 || s.indexOf('\t', 0) === -1 || s.indexOf('\t', 0) >= i) return s;
  let col = startCol;
  let out = '';
  for (let j = 0; j < i; j++) {
    if (s.charCodeAt(j) === 9) {
      const n = 4 - (col & 3);
      out += '    '.slice(0, n);
      col += n;
    } else {
      out += ' ';
      col++;
    }
  }
  return out + s.slice(i);
}

// Column width of a leading whitespace run, with tabs expanded.
function indentWidth(s) {
  let col = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 9) col += 4 - (col & 3);
    else if (c === 32) col++;
    else break;
  }
  return col;
}

// Decode one numeric character reference body (the digits/hex part).
// Returns the replacement string, or null when the reference is invalid
// (and must stay literal, with its & escaped by the caller).
function decodeNumericRef(body, isHex) {
  const n = isHex ? parseInt(body, 16) : parseInt(body, 10);
  if (n === 0 || n > 0x10FFFF || (n >= 0xD800 && n <= 0xDFFF)) return '\uFFFD';
  if (n === 38) return '&amp;';
  return String.fromCodePoint(n);
}

// Escape text for normal HTML output, preserving entity-like sequences:
// `&name;` and `&#num;` pass through untouched (named ones are never
// decoded; numeric ones are decoded separately). `<`, `>`, `"`, `'` and
// bare `&` are escaped.
function escapeText(s) {
  if (!/[&<>"']/.test(s)) return s;
  let out = '';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 38) { // &
      // Entity-like? `&` + (#digits | #x hex | word) + `;`
      ENT_LIKE_RE.lastIndex = i;
      if (ENT_LIKE_RE.test(s)) continue;
      out += s.slice(start, i) + '&amp;';
      start = i + 1;
    } else if (c === 60) { // <
      out += s.slice(start, i) + '&lt;';
      start = i + 1;
    } else if (c === 62) { // >
      out += s.slice(start, i) + '&gt;';
      start = i + 1;
    } else if (c === 34) { // "
      out += s.slice(start, i) + '&quot;';
      start = i + 1;
    } else if (c === 39) { // '
      out += s.slice(start, i) + '&#39;';
      start = i + 1;
    }
  }
  return start === 0 ? s : out + s.slice(start);
}

// Escape for code spans and code blocks: every `&`, `<`, `>`, `"`, `'`
// is escaped, no entity preservation.
function escapeCode(s) {
  if (!/[&<>"']/.test(s)) return s;
  let out = '';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 38) { out += s.slice(start, i) + '&amp;'; start = i + 1; }
    else if (c === 60) { out += s.slice(start, i) + '&lt;'; start = i + 1; }
    else if (c === 62) { out += s.slice(start, i) + '&gt;'; start = i + 1; }
    else if (c === 34) { out += s.slice(start, i) + '&quot;'; start = i + 1; }
    else if (c === 39) { out += s.slice(start, i) + '&#39;'; start = i + 1; }
  }
  return start === 0 ? s : out + s.slice(start);
}

// Escape for attribute values (href, title, alt, info strings): same as
// escapeText but `'` becomes `&#39;` too.
function escapeAttr(s) {
  if (!/[&<>"']/.test(s)) return s;
  let out = '';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 38) {
      ENT_LIKE_RE.lastIndex = i;
      if (ENT_LIKE_RE.test(s)) continue;
      out += s.slice(start, i) + '&amp;';
      start = i + 1;
    } else if (c === 60) { out += s.slice(start, i) + '&lt;'; start = i + 1; }
    else if (c === 62) { out += s.slice(start, i) + '&gt;'; start = i + 1; }
    else if (c === 34) { out += s.slice(start, i) + '&quot;'; start = i + 1; }
    else if (c === 39) { out += s.slice(start, i) + '&#39;'; start = i + 1; }
  }
  return start === 0 ? s : out + s.slice(start);
}

// Apply numeric-reference decoding to a string, escaping bare `&`s.
// Named entities pass through untouched. Used on text runs and on link
// destinations/titles before they are escaped.
function decodeEntities(s) {
  if (s.indexOf('&') === -1) return s;
  NUM_REF_OR_AMP_RE.lastIndex = 0;
  let out = '';
  let last = 0;
  let m;
  while ((m = NUM_REF_OR_AMP_RE.exec(s)) !== null) {
    out += s.slice(last, m.index);
    if (m[1] !== undefined || m[2] !== undefined) {
      out += decodeNumericRef(m[1] !== undefined ? m[1] : m[2], m[1] === undefined);
    } else {
      out += '&amp;';
    }
    last = m.index + m[0].length;
  }
  return last === 0 ? s : out + s.slice(last);
}

// Clean a link destination the way marked does: percent-encode what
// must be encoded, leaving already-encoded sequences alone. Returns
// null only when encodeURI throws. No entity decoding, no protocol
// blocking (marked keeps javascript: links as-is).
function cleanUrl(href) {
  if (!href) return href;
  try {
    return encodeURI(href).replace(/%25/g, '%');
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------
// Inline scanner
// ------------------------------------------------------------------

// Token types (small integers, kept stable for the emitter).
const T_TEXT = 0;
const T_CODE = 1;
const T_HTML = 2;
const T_BR = 3;
const T_SOFT = 4;
const T_DELIM = 5;
const T_LINK_O = 6;
const T_LINK_C = 7;
const T_IMG = 8;

// One combined jump regex: the next position that can start inline
// markup. Plain text between matches is emitted as a whole run.
const INLINE_JUMP_RE = /[\\`*!_<&~@\[\n]|www\.|[hH][tT][tT][pP][sS]?:\/\/|[fF][tT][pP]:\/\//g;
const ASCII_PUNCT = '!\"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~';
const SCHEME_AUTOLINK_RE = /^<([A-Za-z][A-Za-z0-9+.-]{1,31}:[^<>\s]*)>/;
const EMAIL_AUTOLINK_RE = /^<([A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+)>/;
const EMAIL_LOCAL_RE = /[A-Za-z0-9._+-]/;
const EMAIL_DOMAIN_RE = /[A-Za-z0-9-_]+(?:\.[A-Za-z0-9-_]*[A-Za-z0-9])+(?![\w-])/y;
const EMAIL_DOMAIN_MAX_RE = /[A-Za-z0-9-_]+(?:\.[A-Za-z0-9-_]*[A-Za-z0-9])+/y;
// Raw HTML tag shapes, in the order CommonMark tries them.
const HTML_COMMENT_RE = /^<!--(?:-?>|[\s\S]*?-->)/;
const HTML_PI_RE = /^<\?[\s\S]*?\?>/;
const HTML_DECL_RE = /^<![A-Za-z]+\s[\s\S]*?>/;
const HTML_CDATA_RE = /^<!\[CDATA\[[\s\S]*?\]\]>/;
const HTML_TAG_OPEN_RE = /^<[A-Za-z][A-Za-z0-9-]*(?:\s+[A-Za-z_:][A-Za-z0-9_.:-]*(?:\s*=\s*(?:[^\s"'=<>`]+|'[^']*'|"[^"]*"))?)*\s*\/?>/;
const HTML_TAG_CLOSE_RE = /^<\/[A-Za-z][A-Za-z0-9-]*\s*>/;
const RAW_OPEN_RE = /^<(pre|code|kbd|script)(\s|>)/i;
const RAW_CLOSE_RE = /^<\/(pre|code|kbd|script)(\s|>)/i;
const URL_BACKPEDAL_RE = /(?:[^?!.,:;*_'\"~()&]+|\([^)]*\)|&(?![A-Za-z0-9]+;$)|[?!.,:;*_'\"~)]+(?!$))+/y;
const URL_DOMAIN_RE = /(?:[A-Za-z0-9-]+\.?)+[^\s<]*/y;
// Skip spans at the start of an emphasis forward scan: a `*` opener
// skips a `__...*...__` region, a `_` opener a `**..._...**` region.
// Sticky: run with lastIndex at the opener run's end.
const SKIP_AST_RE = /[^_*]*?__[^_*]*?\*[^_*]*?(?=__)/y;
const SKIP_UND_RE = /[^_*]*?\*\*[^_*]*?_[^_*]*?(?=\*\*)/y;

function isSpaceCode(c) {
  // JS `\s`: ASCII whitespace plus NBSP and the Unicode spaces.
  return c === 32 || c === 9 || c === 10 || c === 11 || c === 12 || c === 13 ||
    c === 160 || c === 5760 || (c >= 8192 && c <= 8202) || c === 8232 || c === 8233 ||
    c === 8239 || c === 8287 || c === 12288 || c === 65279;
}

function isPunctCode(c) {
  if (c < 128) return ASCII_PUNCT.indexOf(String.fromCharCode(c)) !== -1;
  return /[\p{P}\p{S}]/u.test(String.fromCodePoint(c));
}

// Flanking for a delimiter run: `before` is the code point before the
// run (-1 at the start), `after` the code point after it (-1 at the end).
// For `*`/`_` runs, `~` counts as a word character, not punctuation
// (marked's GFM flanking); for `~` runs it counts as punctuation.
function flanking(before, after, tildePunct) {
  const beforeSpace = before === -1 || isSpaceCode(before);
  const afterSpace = after === -1 || isSpaceCode(after);
  const beforePunct = before !== -1 && (tildePunct || before !== 126) && isPunctCode(before);
  const afterPunct = after !== -1 && (tildePunct || after !== 126) && isPunctCode(after);
  const left = !afterSpace && (!afterPunct || beforeSpace || beforePunct);
  const right = !beforeSpace && (!beforePunct || afterSpace || afterPunct);
  return [left, right];
}

// Parse inline content to HTML. `ctx` carries the link reference
// definitions map (defs) for this document.
function inlineParse(s, ctx) {
  const toks = [];
  const delims = [];
  // Marked resets inRawBlock per inline block but NOT inLink: an
  // unclosed `<a>` tag suppresses GFM autolinks in later blocks.
  const st = { linkEmitted: false, inLink: ctx.inLink, raw: false, mask: null };
  if (s.indexOf('*') !== -1 || s.indexOf('_') !== -1 || s.indexOf('~') !== -1) st.mask = maskInlineSource(s);
  scanInline(s, ctx, toks, delims, 0, s.length, st);
  ctx.inLink = st.inLink;
  processEmphasis(toks, delims, s);
  return emitInline(toks);
}

// Scan s[lo..hi) into toks/delims. Text runs are escaped as they are
// emitted, unless st.raw is set (inside an inline <pre>/<code>/<kbd>/
// <script> tag, where marked leaves text byte-for-byte). `st` records
// whether a link was emitted at this level, whether the scanner is
// inside a link (GFM autolinks are suppressed there), and raw mode.
function scanInline(s, ctx, toks, delims, lo, hi, st) {
  let pos = lo;
  let runStart = lo;
  let m;
  const pushText = (end) => {
    if (end > runStart) {
      const raw = s.slice(runStart, end);
      toks.push({ t: T_TEXT, s: st.raw ? raw : escapeText(raw) });
    }
  };
  // Is there non-whitespace content after position `p` (within hi)?
  // A hard break only counts when something follows it on a later line.
  const hasMore = (p) => {
    for (let k = p; k < hi; k++) {
      const c = s.charCodeAt(k);
      if (c !== 32 && c !== 9 && c !== 10 && c !== 11 && c !== 12 && c !== 13) return true;
    }
    return false;
  };
  for (;;) {
    INLINE_JUMP_RE.lastIndex = pos;
    m = INLINE_JUMP_RE.exec(s);
    if (m === null || m.index >= hi) break;
    const i = m.index;
    const head = m[0];
    const c = s.charCodeAt(i);
    if (head === 'www.' || head.slice(-3) === '://') {
      if (!st.inLink) {
        const r = tryAutolink(s, i, hi, head);
        if (r !== null) {
          pushText(i);
          toks.push({ t: T_LINK_O, href: cleanUrl(r.href), title: null, raw: true });
          toks.push({ t: T_TEXT, s: escapeCode(r.text) });
          toks.push({ t: T_LINK_C });
          pos = r.end;
          runStart = pos;
          continue;
        }
      }
      pos = i + head.length;
      continue;
    }
    if (c === 64) { // @ : possible bare-email autolink
      if (!st.inLink) {
        const r = tryEmail(s, i, hi, runStart, delims);
        if (r !== null) {
          pushText(r.start);
          toks.push({ t: T_LINK_O, href: cleanUrl(r.href), title: null, raw: true });
          toks.push({ t: T_TEXT, s: escapeCode(r.text) });
          toks.push({ t: T_LINK_C });
          pos = r.end;
          runStart = pos;
          continue;
        }
      }
      pos = i + 1;
      continue;
    }
    if (c === 92) { // backslash
      const nx = i + 1 < hi ? s[i + 1] : '';
      if (nx === '\n') {
        if (hasMore(i + 2)) {
          pushText(i);
          toks.push({ t: T_BR });
          pos = i + 2;
          while (pos < hi && (s.charCodeAt(pos) === 32 || s.charCodeAt(pos) === 9)) pos++;
          runStart = pos;
          continue;
        }
        pos = i + 1;
        continue;
      }
      if (nx !== '' && ASCII_PUNCT.indexOf(nx) !== -1) {
        pushText(i);
        toks.push({ t: T_TEXT, s: escapeText(nx) });
        pos = i + 2;
        runStart = pos;
        continue;
      }
      pos = i + 1;
      continue;
    }
    if (c === 96) { // backtick: code span
      let j = i;
      while (j < hi && s.charCodeAt(j) === 96) j++;
      const runLen = j - i;
      const close = findCodeEnd(s, j, hi, runLen);
      if (close !== -1) {
        let content = s.slice(j, close).replace(/\n/g, ' ');
        if (/[^ ]/.test(content) && content.charCodeAt(0) === 32 && content.charCodeAt(content.length - 1) === 32) {
          content = content.slice(1, -1);
        }
        pushText(i);
        toks.push({ t: T_CODE, s: escapeCode(content) });
        pos = close + runLen;
        runStart = pos;
        continue;
      }
      // No matching run: the backticks are literal; skip the whole run.
      pos = j;
      continue;
    }
    if (c === 42 || c === 95) { // * or _
      if (c === 95 && isEmailUnderscore(s, i, hi, runStart)) {
        // Part of an email address: plain text, not a delimiter.
        pos = i + 1;
        continue;
      }
      let j = i;
      while (j < hi && s.charCodeAt(j) === c) j++;
      const runLen = j - i;
      if (st.mask && st.mask.charCodeAt(i) !== c) {
        // Masked out (inside a link/codespan/tag per marked's #n):
        // not a delimiter, plain text.
        pos = j;
        continue;
      }
      const before = i > lo ? s.codePointAt(i - 1) : -1;
      const after = j < hi ? s.codePointAt(j) : -1;
      const [left, right] = flanking(before, after, false);
      let canOpen, canClose;
      if (c === 42) {
        canOpen = left;
        canClose = right;
      } else {
        canOpen = left && (!right || (before !== -1 && isPunctCode(before)));
        canClose = right && (!left || (after !== -1 && isPunctCode(after)));
      }
      pushText(i);
      const tok = { t: T_DELIM, ch: c === 42 ? '*' : '_', len: runLen, pre: '', post: '', preLit: 0, postLit: 0, innerPre: null, innerPost: null };
      toks.push(tok);
      delims.push({ tok, ch: tok.ch, len: runLen, canOpen, canClose, pos: i, end: j, afterSpace: after === -1 || isSpaceCode(after) });
      pos = j;
      runStart = pos;
      continue;
    }
    if (c === 126) { // ~ : strikethrough delimiter (1 or 2 pair; 3+ never)
      let j = i;
      while (j < hi && s.charCodeAt(j) === 126) j++;
      const runLen = j - i;
      if (st.mask && st.mask.charCodeAt(i) !== c) {
        pos = j; // masked out: plain text, not a delimiter
        continue;
      }
      const before = i > lo ? s.codePointAt(i - 1) : -1;
      const after = j < hi ? s.codePointAt(j) : -1;
      const [left, right] = flanking(before, after, true);
      pushText(i);
      const tok = { t: T_DELIM, ch: '~', len: runLen, pre: '', post: '', preLit: 0, postLit: 0, innerPre: null, innerPost: null };
      toks.push(tok);
      const pairable = runLen <= 2;
      delims.push({ tok, ch: '~', len: runLen, canOpen: pairable && left, canClose: pairable && right, pos: i, end: j, afterSpace: after === -1 || isSpaceCode(after) });
      pos = j;
      runStart = pos;
      continue;
    }
    if (c === 33) { // ! : image, only when followed by [
      if (i + 1 < hi && s.charCodeAt(i + 1) === 91) {
        const link = tryLink(s, i + 1, hi, ctx, true, st);
        if (link !== null) {
          pushText(i);
          if (link.href === null) {
            toks.push({ t: T_HTML, s: link.innerHtml });
          } else {
            toks.push({ t: T_IMG, href: link.href, title: link.title, alt: link.altHtml });
          }
          pos = link.end;
          runStart = pos;
          continue;
        }
      }
      pos = i + 1;
      continue;
    }
    if (c === 91) { // [ : link
      const link = tryLink(s, i, hi, ctx, false, st);
      if (link !== null) {
        pushText(i);
        if (link.href === null) {
          // Unsafe destination: emit the children with no <a> wrapper.
          toks.push({ t: T_HTML, s: link.innerHtml });
        } else {
          toks.push({ t: T_LINK_O, href: link.href, title: link.title, raw: false });
          toks.push({ t: T_HTML, s: link.innerHtml });
          toks.push({ t: T_LINK_C });
        }
        pos = link.end;
        runStart = pos;
        continue;
      }
      pos = i + 1;
      continue;
    }
    if (c === 60) { // < : autolink, raw HTML tag, or literal
      const sub = s.slice(i, hi);
      let am = SCHEME_AUTOLINK_RE.exec(sub);
      if (am) {
        pushText(i);
        const url = am[1];
        toks.push({ t: T_LINK_O, href: cleanUrl(url), title: null, raw: true });
        toks.push({ t: T_TEXT, s: escapeCode(url) });
        toks.push({ t: T_LINK_C });
        pos = i + am[0].length;
        runStart = pos;
        continue;
      }
      am = EMAIL_AUTOLINK_RE.exec(sub);
      if (am) {
        pushText(i);
        const email = am[1];
        toks.push({ t: T_LINK_O, href: 'mailto:' + email, title: null, raw: true });
        toks.push({ t: T_TEXT, s: escapeCode(email) });
        toks.push({ t: T_LINK_C });
        pos = i + am[0].length;
        runStart = pos;
        continue;
      }
      const hm = HTML_COMMENT_RE.exec(sub) || HTML_PI_RE.exec(sub) ||
        HTML_DECL_RE.exec(sub) || HTML_CDATA_RE.exec(sub) || HTML_TAG_OPEN_RE.exec(sub) ||
        HTML_TAG_CLOSE_RE.exec(sub);
      if (hm) {
        pushText(i);
        const tag = hm[0];
        // <a> tags toggle inLink (GFM autolinks are suppressed inside
        // links); <pre>/<code>/<kbd>/<script> toggle raw text mode.
        // Note the exact shapes: `<a` needs a SPACE after it, `</a>`
        // needs `>` immediately.
        if (/^<a /i.test(tag)) st.inLink = true;
        else if (/^<\/a>/i.test(tag)) st.inLink = false;
        if (!st.raw && RAW_OPEN_RE.test(tag)) st.raw = true;
        else if (st.raw && RAW_CLOSE_RE.test(tag)) st.raw = false;
        toks.push({ t: T_HTML, s: tag });
        pos = i + tag.length;
        runStart = pos;
        continue;
      }
      pos = i + 1;
      continue;
    }
    if (c === 38) { // & : entity (skipped entirely in raw mode)
      if (st.raw) { pos = i + 1; continue; }
      NUM_REF_RE.lastIndex = i;
      const nm = NUM_REF_RE.exec(s);
      if (nm && NUM_REF_RE.lastIndex <= hi) {
        pushText(i);
        toks.push({ t: T_TEXT, s: escapeText(decodeNumericRef(nm[1] !== undefined ? nm[1] : nm[2], nm[1] === undefined)) });
        pos = NUM_REF_RE.lastIndex;
        runStart = pos;
        continue;
      }
      ENT_LIKE_RE.lastIndex = i;
      if (ENT_LIKE_RE.test(s) && ENT_LIKE_RE.lastIndex <= hi) {
        pos = ENT_LIKE_RE.lastIndex;
        continue;
      }
      pos = i + 1;
      continue;
    }
    if (c === 10) { // newline: hard break (2+ trailing spaces) or soft
      let k = i - 1;
      let spaces = 0;
      while (k >= runStart && s.charCodeAt(k) === 32) { spaces++; k--; }
      if (spaces >= 2 && hasMore(i + 1)) {
        pushText(i - spaces);
        toks.push({ t: T_BR });
        pos = i + 1;
        while (pos < hi && (s.charCodeAt(pos) === 32 || s.charCodeAt(pos) === 9)) pos++;
        runStart = pos;
      } else {
        pushText(i);
        toks.push({ t: T_SOFT });
        pos = i + 1;
        runStart = pos;
      }
      continue;
    }
    pos = i + 1;
  }
  pushText(hi);
}

// Find the end of a code span: the next run of backticks whose length
// equals runLen, starting the search at `from`. Returns the index of
// that run, or -1.
function findCodeEnd(s, from, hi, runLen) {
  let i = from;
  for (;;) {
    const b = s.indexOf('`', i);
    if (b === -1 || b >= hi) return -1;
    let j = b;
    while (j < hi && s.charCodeAt(j) === 96) j++;
    if (j - b === runLen) return b;
    i = j;
  }
}

// Normalize a link reference label: collapse whitespace runs to one
// space, trim, then lower-upper-lower case (marked's F).
function normalizeLabel(label) {
  return label.replace(/\s+/g, ' ').trim().toLowerCase().toUpperCase().toLowerCase();
}

// Strip HTML tags from already-rendered inline HTML (for image alt
// text). Literal `<` in the source is escaped by then, so any `<...>`
// here is a real tag. An `<img>` contributes its (unescaped) alt text.
function stripTags(html) {
  return html.replace(/<img[^>]*alt="([^"]*)"[^>]*>|<[^>]*>/g, (m, alt) =>
    alt === undefined ? '' : unescapeAttr(alt));
}

// Reverse escapeAttr (for img alt text recovered from rendered HTML).
function unescapeAttr(s) {
  if (s.indexOf('&') === -1) return s;
  return s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

// Find the `]` matching the `[` at `open` (bracket counting, skipping
// code spans and escaped brackets). Returns the index, or -1. Marked
// only allows 3 levels of nesting; deeper labels never match.
// Used for reference labels, where the pattern is plain (no codespan
// alternatives) — the main label uses findLabelEnds below.
function findLabelEnd(s, open, hi) {
  let depth = 1;
  let i = open + 1;
  while (i < hi) {
    const c = s.charCodeAt(i);
    if (c === 92) { i += 2; continue; } // backslash escape
    if (c === 96) { // code span: skip to its end
      let j = i;
      while (j < hi && s.charCodeAt(j) === 96) j++;
      const close = findCodeEnd(s, j, hi, j - i);
      i = close === -1 ? j : close + (j - i);
      continue;
    }
    if (c === 91) {
      depth++;
      if (depth > 3) return -1;
    } else if (c === 93) {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  return -1;
}

// All candidate `]` positions for the label opened at `open`, in
// marked's regex-preference order. A backtick run in a label matches
// marked's label regex only as a "codespan" alternative
// (`+(?!`)[^`]*?`+(?!`)` — the closing run may be ANY length) or as
// 2+ backticks directly before `]` (``+(?=\])). The regex backtracks
// over those choices, so the first label end found is not always the
// one that forms a link: `[less `` a ` b ``](./docs/value.md)` needs
// the ``+(?=]) reading of the run before `]`, because the codespan
// reading swallows the `]` and the tail then fails. Collect the ends
// depth-first (shortest codespan content first, ``+(?=]) last) and
// let tryLink try each in turn. Capped to bound the backtracking.
function findLabelEnds(s, open, hi) {
  const out = [];
  const seen = new Set();
  let budget = 64; // recursive branches, not chars
  function scan(i, depth) {
    if (out.length >= 8 || budget <= 0) return;
    while (i < hi) {
      const c = s.charCodeAt(i);
      if (c === 92) { i += 2; continue; }
      if (c === 96) {
        let j = i;
        while (j < hi && s.charCodeAt(j) === 96) j++;
        // Choice 1: the codespan alternative — the closer is the FIRST
        // backtick run after the opening run, because the content
        // ([^`]*?) cannot contain a backtick. Later runs are NOT
        // alternative closers.
        let k = j;
        while (k < hi && s.charCodeAt(k) !== 96) k++;
        if (k < hi) {
          let e = k;
          while (e < hi && s.charCodeAt(e) === 96) e++;
          if (budget-- <= 0) return;
          scan(e, depth);
          if (out.length >= 8 || budget <= 0) return;
        }
        // Choice 2: ``+(?=]) — a run of 2+ directly before `]`.
        if (j - i >= 2 && j < hi && s.charCodeAt(j) === 93) {
          if (budget-- <= 0) return;
          scan(j, depth);
        }
        return;
      }
      if (c === 91) {
        depth++;
        if (depth > 3) return;
      } else if (c === 93) {
        depth--;
        if (depth === 0) {
          if (!seen.has(i)) { seen.add(i); out.push(i); }
          return;
        }
      }
      i++;
    }
  }
  scan(open + 1, 1);
  return out;
}

// Parse an inline link destination + title starting at `p` (just past
// the `(`). Returns {href, title, end} (end = index past the closing
// `)`) or null when it does not parse.
function parseInlineLinkTail(s, p, hi) {
  let i = p;
  while (i < hi && (s.charCodeAt(i) === 32 || s.charCodeAt(i) === 9 || s.charCodeAt(i) === 10)) i++;
  if (i >= hi) return null;
  // Angle destination first: `<...>` with backslash escapes honoured,
  // so an escaped `\>` does not close it.
  if (s.charCodeAt(i) === 60) {
    let j = i + 1;
    let ok = false;
    while (j < hi) {
      const c = s.charCodeAt(j);
      if (c === 92 && j + 1 < hi) { j += 2; continue; }
      if (c === 62) { ok = true; break; }
      if (c === 60 || c === 10) break;
      j++;
    }
    if (ok) {
      const t = finishLinkTail(s, j + 1, hi, unescapeText(s.slice(i + 1, j)));
      if (t !== null) return t;
    }
    // Fall through: the bare-destination parse may still match (the
    // destination can itself contain `<` and `>`).
  }
  // Bare destination: balanced parens, no spaces or controls.
  let depth = 0;
  let j = i;
  while (j < hi) {
    const c = s.charCodeAt(j);
    if (c === 32 || c === 9 || c === 10) break;
    if (c < 32) return null;
    if (c === 92 && j + 1 < hi && ASCII_PUNCT.indexOf(s[j + 1]) !== -1) {
      j += 2;
      continue;
    }
    if (c === 40) { depth++; j++; continue; }
    if (c === 41) {
      if (depth === 0) break;
      depth--; j++; continue;
    }
    j++;
  }
  if (depth !== 0) return null;
  let raw = s.slice(i, j);
  // A bare destination starting with `<` must end with `>` (else the
  // link is invalid); the outer brackets are then stripped. An odd run
  // of backslashes right before the final `>` also invalidates it.
  // The checks run on the raw text, before unescaping.
  if (raw.charCodeAt(0) === 60) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 62) return null;
    let bs = 0;
    for (let k = raw.length - 2; k >= 0 && raw.charCodeAt(k) === 92; k--) bs++;
    if (bs % 2 === 1) return null;
    raw = raw.slice(1, -1);
  }
  return finishLinkTail(s, j, hi, unescapeText(raw));
}

// After a destination: optional whitespace, an optional title, then `)`.
function finishLinkTail(s, i, hi, dest) {
  let k = i;
  while (k < hi && (s.charCodeAt(k) === 32 || s.charCodeAt(k) === 9 || s.charCodeAt(k) === 10)) k++;
  let title = null;
  if (k < hi && s.charCodeAt(k) !== 41) {
    const q = s.charCodeAt(k);
    if (q !== 34 && q !== 39 && q !== 40) return null;
    let j = k + 1;
    let buf = '';
    let ok = false;
    if (q === 40) {
      while (j < hi) {
        const c = s.charCodeAt(j);
        if (c === 40) return null;
        if (c === 41) { ok = true; break; }
        if (c === 92 && j + 1 < hi && ASCII_PUNCT.indexOf(s[j + 1]) !== -1) { buf += s[j + 1]; j += 2; continue; }
        buf += s[j];
        j++;
      }
    } else {
      while (j < hi) {
        const c = s.charCodeAt(j);
        if (c === q) { ok = true; break; }
        if (c === 92 && j + 1 < hi && ASCII_PUNCT.indexOf(s[j + 1]) !== -1) { buf += s[j + 1]; j += 2; continue; }
        buf += s[j];
        j++;
      }
    }
    if (!ok) return null;
    title = buf;
    k = j + 1;
    while (k < hi && (s.charCodeAt(k) === 32 || s.charCodeAt(k) === 9 || s.charCodeAt(k) === 10)) k++;
  }
  if (k >= hi || s.charCodeAt(k) !== 41) return null;
  return { href: dest, title, end: k + 1 };
}

// Resolve backslash escapes in a destination or title: `\` + ASCII
// punctuation becomes the punctuation itself.
function unescapeText(s) {
  if (s.indexOf('\\') === -1) return s;
  let out = '';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) === 92 && i + 1 < s.length && ASCII_PUNCT.indexOf(s[i + 1]) !== -1) {
      out += s.slice(start, i) + s[i + 1];
      i++;
      start = i + 1;
    }
  }
  return start === 0 ? s : out + s.slice(start);
}

// Match an inline HTML tag or autolink at s[pos..hi). Returns the
// match length, or 0.
function matchTagOrAutolink(s, pos, hi) {
  const sub = s.slice(pos, hi);
  const hm = HTML_COMMENT_RE.exec(sub) || HTML_PI_RE.exec(sub) ||
    HTML_DECL_RE.exec(sub) || HTML_CDATA_RE.exec(sub) || HTML_TAG_OPEN_RE.exec(sub) ||
    HTML_TAG_CLOSE_RE.exec(sub);
  if (hm) return hm[0].length;
  const am = SCHEME_AUTOLINK_RE.exec(sub) || EMAIL_AUTOLINK_RE.exec(sub);
  if (am) return am[0].length;
  return 0;
}

// Does the link label contain a `<` that starts an HTML tag or
// autolink running past the end of the label? Marked rejects such
// links: the tag would swallow the `](...)` tail. Escapes and code
// spans inside the label are skipped.
function labelHasRunawayTag(s, open, label, hi) {
  if (label.indexOf('<') === -1) return false;
  for (let q = 0; q < label.length; q++) {
    const c = label.charCodeAt(q);
    if (c === 92) { q++; continue; }
    if (c === 96) {
      let j = q;
      while (j < label.length && label.charCodeAt(j) === 96) j++;
      const ce = findCodeEnd(label, j, label.length, j - q);
      if (ce !== -1 && ce > j) { q = ce + (j - q) - 1; continue; }
      continue;
    }
    if (c !== 60) continue;
    const len = matchTagOrAutolink(s, open + 1 + q, hi);
    if (len === 0) continue;
    if (len > label.length - q) return true;
    q += len - 1;
  }
  return false;
}

// Try to parse a link (or image, when isImage) starting at the `[` at
// `open`. Returns {href, title, innerHtml, altHtml, end} or null.
// `st` is the current level's state; a fresh state is used for the
// label so a link inside the label can be detected (links may not
// contain links).
function tryLink(s, open, hi, ctx, isImage, st) {
  const ends = findLabelEnds(s, open, hi);
  for (const close of ends) {
    const r = tryLinkAt(s, open, close, hi, ctx, isImage, st);
    if (r !== null) return r;
  }
  return null;
}

// Try to form a link with the label ending at `close`.
function tryLinkAt(s, open, close, hi, ctx, isImage, st) {
  const label = s.slice(open + 1, close);
  if (labelHasRunawayTag(s, open, label, hi)) return null;
  let href = null;
  let title = null;
  let end = -1;
  const after = close + 1;
  if (after < hi && s.charCodeAt(after) === 40) { // ( : inline link
    const tail = parseInlineLinkTail(s, after + 1, hi);
    if (tail !== null) {
      href = tail.href;
      title = tail.title;
      end = tail.end;
    } else {
      // The inline tail is invalid: fall back to the shortcut form.
      const def = ctx.defs.get(normalizeLabel(label));
      if (def === undefined) return null;
      href = def.href;
      title = def.title;
      end = close + 1;
    }
  } else if (after < hi && s.charCodeAt(after) === 91) { // [ : ref link
    const refClose = findLabelEnd(s, after, hi);
    if (refClose === -1) return null;
    const refText = s.slice(after + 1, refClose);
    // An unescaped `[` inside the reference label means marked's
    // reflink pattern never matched at all, so the shortcut form is
    // tried instead.
    let nested = false;
    for (let q = 0; q < refText.length; q++) {
      if (refText.charCodeAt(q) === 92) { q++; continue; }
      if (refText.charCodeAt(q) === 91) { nested = true; break; }
    }
    if (nested) {
      const def0 = ctx.defs.get(normalizeLabel(label));
      if (def0 === undefined) return null;
      href = def0.href;
      title = def0.title;
      end = close + 1;
    } else {
      const key = normalizeLabel(refText === '' ? label : refText);
      const def = ctx.defs.get(key);
      if (def === undefined) return null;
      href = def.href;
      title = def.title;
      end = refClose + 1;
    }
  } else { // shortcut reference
    const def = ctx.defs.get(normalizeLabel(label));
    if (def === undefined) return null;
    href = def.href;
    title = def.title;
    end = close + 1;
  }
  // Parse the label. A link inside a link label kills the outer link.
  // Inside a label, GFM autolinks are suppressed (inLink) while raw
  // mode is shared with the outer scan.
  const labelState = { linkEmitted: false, inLink: true, raw: st.raw };
  const innerHtml = inlineParseWithState(label, ctx, labelState);
  if (!isImage && labelState.linkEmitted) return null;
  st.raw = labelState.raw;
  if (!isImage) st.linkEmitted = true;
  const cleanHref = cleanUrl(href);
  return {
    href: cleanHref,
    title: title === null ? null : escapeAttr(title),
    innerHtml,
    altHtml: stripTags(innerHtml),
    end,
  };
}

// GFM URL autolinks: www. (boundary-checked) or scheme:// URLs, with
// no dot requirement. The candidate is backpedalled to strip trailing
// punctuation; balanced parens are kept. A `mailto:`/`xmpp:` prefix
// extends the link start when it directly precedes the URL.
function tryAutolink(s, i, hi, head) {
  let start = i;
  if (head === 'www.') {
    const prev = i > 0 ? s.charCodeAt(i - 1) : -1;
    const ok = prev === -1 || prev === 32 || prev === 9 || prev === 10 ||
      prev === 42 || prev === 95 || prev === 126 || prev === 40;
    if (!ok) return null;
  } else {
    const before = s.slice(Math.max(0, i - 7), i);
    const m = /(^|[^A-Za-z0-9])(mailto:|xmpp:)$/i.exec(before);
    if (m) start = i - m[2].length;
  }
  URL_DOMAIN_RE.lastIndex = i + head.length;
  const dm = URL_DOMAIN_RE.exec(s);
  if (dm === null || URL_DOMAIN_RE.lastIndex > hi) return null;
  let end = URL_DOMAIN_RE.lastIndex;
  // Backpedal: repeatedly apply the trailing-punctuation rule to the
  // URL text itself until the end stops moving. It must run on the
  // substring: the rule's `$` is the end of the URL, not of the input.
  let prevEnd;
  do {
    prevEnd = end;
    const urlText = s.slice(start, end);
    URL_BACKPEDAL_RE.lastIndex = 0;
    const bm = URL_BACKPEDAL_RE.exec(urlText);
    if (bm !== null) end = start + URL_BACKPEDAL_RE.lastIndex;
  } while (end !== prevEnd);
  const text = s.slice(start, end);
  // A www. link gets an http:// prefix on its href (text unchanged).
  return { href: text.startsWith('www.') ? 'http://' + text : text, text, end };
}

// Bare-email autolink: the local part is scanned backwards from `@`
// (small set [A-Za-z0-9._+-]), the domain forwards (must contain a
// dot, labels end in alphanumerics, not followed by [\w-]). A
// `mailto:`/`xmpp:` prefix directly before the local part (itself
// preceded by a non-alphanumeric) extends the link. The local part
// must not be preceded by a character from the wider email set, or
// marked's text tokenizer would never have stopped there.
function tryEmail(s, i, hi, minStart, delims) {
  let start = i;
  while (start > minStart && EMAIL_LOCAL_RE.test(s[start - 1])) start--;
  if (start === i) return null;
  // The char before the local part must not be from the wider email
  // set — but only when it is inside the current text run; at the run
  // start it belongs to an already-emitted token (e.g. an emphasis
  // delimiter), which marked's tokenizer consumed separately.
  if (start > minStart && /[!#$%&'*\/=?`{|}~]/.test(s[start - 1])) return null;
  EMAIL_DOMAIN_RE.lastIndex = i + 1;
  const dm = EMAIL_DOMAIN_RE.exec(s);
  let end = -1;
  if (dm !== null && EMAIL_DOMAIN_RE.lastIndex <= hi) end = EMAIL_DOMAIN_RE.lastIndex;
  // The `(?![\w-])` lookahead can make the domain backtrack — or fail
  // outright — when the full domain ends right before a `_` run. But
  // if that run is the closer of an emphasis span opened before the
  // email, marked tokenizes the email inside the span (where the run
  // is invisible) and links the FULL domain. Detect that case with a
  // maximal (lookahead-free) domain match plus a pairing simulation.
  EMAIL_DOMAIN_MAX_RE.lastIndex = i + 1;
  const mm = EMAIL_DOMAIN_MAX_RE.exec(s);
  if (mm !== null && EMAIL_DOMAIN_MAX_RE.lastIndex <= hi) {
    const maxEnd = EMAIL_DOMAIN_MAX_RE.lastIndex;
    if ((end === -1 || maxEnd > end) && maxEnd < hi &&
        s.charCodeAt(maxEnd) === 95 &&
        emailCloserPairs(s, maxEnd, hi, delims)) {
      end = maxEnd;
    }
  }
  if (end === -1) return null;
  // Scheme prefix: mailto: (7) or xmpp: (5) directly before the
  // local part, preceded by a non-alphanumeric or the string start.
  if (start >= 7 && s.slice(start - 7, start).toLowerCase() === 'mailto:' &&
      (start - 7 === 0 || !/[A-Za-z0-9]/.test(s[start - 8]))) {
    start -= 7;
    const text = s.slice(start, end);
    return { href: text, text, start, end };
  }
  if (start >= 5 && s.slice(start - 5, start).toLowerCase() === 'xmpp:' &&
      (start - 5 === 0 || !/[A-Za-z0-9]/.test(s[start - 6]))) {
    start -= 5;
    if (end < hi && s.charCodeAt(end) === 47) {
      let q = end + 1;
      while (q < hi && /[A-Za-z0-9@.]/.test(s[q])) q++;
      if (q > end + 1) end = q;
    }
    const text = s.slice(start, end);
    return { href: text, text, start, end };
  }
  const text = s.slice(start, end);
  return { href: 'mailto:' + text, text, start, end };
}

// Does the `_` run starting at `runStart` close an emphasis span
// opened before the email? Simulate the nearest preceding `_`
// opener's forward scan (reusing findEmMatch) with the run appended
// as a synthetic closer. Used only for the email domain boundary.
function emailCloserPairs(s, runStart, hi, delims) {
  let j = runStart;
  while (j < hi && s.charCodeAt(j) === 95) j++;
  const runLen = j - runStart;
  const before = runStart > 0 ? s.codePointAt(runStart - 1) : -1;
  const after = j < hi ? s.codePointAt(j) : -1;
  const [left, right] = flanking(before, after, false);
  const canOpen = left && (!right || (before !== -1 && isPunctCode(before)));
  const canClose = right && (!left || (after !== -1 && isPunctCode(after)));
  if (!canClose) return false;
  let oi = -1;
  for (let k = delims.length - 1; k >= 0; k--) {
    if (delims[k].ch === '_' && delims[k].canOpen) { oi = k; break; }
  }
  if (oi < 0) return false;
  const synth = { tok: null, ch: '_', len: runLen, canOpen, canClose, pos: runStart, end: j, afterSpace: after === -1 || isSpaceCode(after) };
  delims.push(synth);
  const synthIdx = delims.length - 1;
  const m = findEmMatch(delims[oi], delims[oi].len, delims, oi + 1, delims.length, s);
  delims.pop();
  return m !== null && m.ci === synthIdx;
}

// Is the `_` at `i` part of a bare-email local part? If so it must
// stay plain text: marked's text tokenizer stops before the email,
// so the `_` never becomes an emphasis delimiter. A `_` at the START
// of the local part is an email character only when it does NOT form
// emphasis (marked tries emStrong first): simulate the run's forward
// scan over later `_` runs to decide.
function isEmailUnderscore(s, i, hi, minStart) {
  let ls = i;
  while (ls > minStart && EMAIL_LOCAL_RE.test(s[ls - 1])) ls--;
  if (ls > minStart && /[!#$%&'*\/=?`{|}~]/.test(s[ls - 1])) return false;
  let j = i;
  while (j < hi && EMAIL_LOCAL_RE.test(s[j])) j++;
  if (j >= hi || s.charCodeAt(j) !== 64) return false;
  EMAIL_DOMAIN_RE.lastIndex = j + 1;
  const dm = EMAIL_DOMAIN_RE.exec(s);
  if (dm === null || EMAIL_DOMAIN_RE.lastIndex > hi) return false;
  if (ls !== i) return true; // strictly inside the local part
  // At the local part's start: an emphasis delimiter if the run pairs.
  let e = i;
  while (e < hi && s.charCodeAt(e) === 95) e++;
  const before = i > 0 ? s.codePointAt(i - 1) : -1;
  const after = e < hi ? s.codePointAt(e) : -1;
  const [left, right] = flanking(before, after, false);
  const canOpen = left && (!right || (before !== -1 && isPunctCode(before)));
  if (!canOpen && !(i === 0 && after !== -1 && !isSpaceCode(after))) return true;
  const canClose = right && (!left || (after !== -1 && isPunctCode(after)));
  const D = { tok: null, ch: '_', len: e - i, canOpen, canClose, pos: i, end: e, afterSpace: after === -1 || isSpaceCode(after) };
  // Collect the `_` runs after the opener (raw string scan; runs
  // inside code spans are a rare false positive here).
  const runs = [];
  let p = e;
  while (p < hi) {
    const q = s.indexOf('_', p);
    if (q === -1 || q >= hi) break;
    let r = q;
    while (r < hi && s.charCodeAt(r) === 95) r++;
    const b2 = q > 0 ? s.codePointAt(q - 1) : -1;
    const a2 = r < hi ? s.codePointAt(r) : -1;
    const [l2, r2] = flanking(b2, a2, false);
    runs.push({ tok: null, ch: '_', len: r - q,
      canOpen: l2 && (!r2 || (b2 !== -1 && isPunctCode(b2))),
      canClose: r2 && (!l2 || (a2 !== -1 && isPunctCode(a2))),
      pos: q, end: r, afterSpace: a2 === -1 || isSpaceCode(a2) });
    p = r;
  }
  for (let k = D.len; k >= 1; k--) {
    if (findEmMatch(D, k, runs, 0, runs.length, s) !== null) return false;
  }
  return true;
}

// Emphasis / strikethrough, forward-matching exactly like marked's
// emStrong and del tokenizers (NOT the CommonMark stack algorithm —
// marked diverges from it, e.g. `**a *b*c* d**` pairs the outer `**`
// with the final `**`, and `*a **b** c*` matches nothing at all).
// For each opener run, scan forward over later runs of the same char:
// open-only runs add their length to `m`, closers subtract; the match
// completes when `m` drops to zero. Both-runs and (when the opener can
// also close) close-only runs are skipped by the rule of 3s. The
// inner content is then processed recursively, so inner pairs can only
// match inside their span. Leftover opener/closer chars become part of
// the inner content (as virtual delimiter runs at its start/end).
function processEmphasis(toks, delims, s) {
  if (delims.length === 0) return;
  processDelims(delims, s, 0, delims.length, 0);
}

// Process the delims in delims[lo..hi), which belong to the substring
// of `s` starting at `subStart` (0 at the top level). A run at
// `subStart` can open even when followed by punctuation (marked's
// `!n` case: no previous character).
function processDelims(delims, s, lo, hi, subStart) {
  for (let di = lo; di < hi; di++) {
    const D = delims[di];
    const ch = D.ch;
    const isDel = ch === '~';
    // Opener eligibility: left-flanking, or at the substring start
    // with a non-space char after the run. Only the first delim in
    // the range can be at the start. Tilde runs of length 3+ can
    // never open (the text tokenizer swallows them whole, so the
    // lexer never retries at a suffix).
    if (!D.canOpen && !(di === lo && D.pos === subStart && !D.afterSpace && (!isDel || D.len <= 2))) continue;
    // `*`/`_` try the full run first, then shorter suffixes (the
    // lexer's position-by-position retry through a failed run); `~`
    // only ever tries its full length.
    for (let k = D.len; k >= (isDel ? D.len : 1); k--) {
      const m = findEmMatch(D, k, delims, di + 1, hi, s);
      if (!m) continue;
      const C = delims[m.ci];
      const use = m.use;
      const openTag = isDel ? '<del>' : use === 2 ? '<strong>' : '<em>';
      const closeTag = isDel ? '</del>' : use === 2 ? '</strong>' : '</em>';
      // The opener: literal prefix (failed-attempt chars), the tag,
      // and a leftover inner run (the opener chars the tag didn't use).
      D.tok.preLit = D.len - k;
      D.tok.pre = openTag;
      D.tok.len = 0;
      // The closer: a leftover inner run, the tag, and a literal
      // suffix (the closer chars past the effective length).
      C.tok.post = closeTag;
      C.tok.postLit = C.len - m.bEff;
      C.tok.len = 0;
      // Inner delim list: leftover opener run, the delims between
      // opener and closer, leftover closer run. A delim adjacent to
      // a span boundary is re-flanked for the inner string: at the
      // inner start its before char is "start", at the inner end its
      // after char is "end" (marked tokenizes the inner text as a
      // separate string). No adjustment on a side that has a leftover
      // run — the adjacent char there is the same in both strings.
      const inner = [];
      const hasLeftOver = k - use > 0;
      const hasRightOver = m.bEff - use > 0;
      if (hasLeftOver) {
        const itok = { t: T_DELIM, ch, len: k - use, pre: '', post: '', preLit: 0, postLit: 0, innerPre: null, innerPost: null };
        D.tok.innerPre = itok;
        // The leftover opener run sits at the inner string's start:
        // it can't close, and its after char is the first char of the
        // inner content (right after the opener run in `s`).
        const aAfter = D.end < s.length ? s.codePointAt(D.end) : -1;
        inner.push({ tok: itok, ch, len: k - use, canOpen: false, canClose: false,
          pos: D.end, end: D.end, afterSpace: aAfter === -1 || isSpaceCode(aAfter) });
      }
      for (let j = di + 1; j < m.ci; j++) {
        let d = delims[j];
        const adjBefore = j === di + 1 && !hasLeftOver && d.pos === D.end;
        const adjAfter = j === m.ci - 1 && !hasRightOver && d.end === C.pos;
        if (adjBefore || adjAfter) {
          const before = adjBefore ? -1 : (d.pos > 0 ? s.codePointAt(d.pos - 1) : -1);
          const after = adjAfter ? -1 : (d.end < s.length ? s.codePointAt(d.end) : -1);
          const [left, right] = flanking(before, after, d.ch === '~');
          let canOpen, canClose;
          if (d.ch === '*') { canOpen = left; canClose = right; }
          else if (d.ch === '_') {
            canOpen = left && (!right || (before !== -1 && isPunctCode(before)));
            canClose = right && (!left || (after !== -1 && isPunctCode(after)));
          } else {
            const pairable = d.len <= 2;
            canOpen = pairable && left; canClose = pairable && right;
          }
          d = { ...d, canOpen, canClose, afterSpace: after === -1 || isSpaceCode(after) };
        }
        inner.push(d);
      }
      if (hasRightOver) {
        const itok = { t: T_DELIM, ch, len: m.bEff - use, pre: '', post: '', preLit: 0, postLit: 0, innerPre: null, innerPost: null };
        C.tok.innerPost = itok;
        // The leftover closer run sits at the inner string's end: it
        // can't open, and it closes iff the char before it (the last
        // char of the inner content) is not a space.
        const bBefore = C.pos > 0 ? s.codePointAt(C.pos - 1) : -1;
        inner.push({ tok: itok, ch, len: m.bEff - use, canOpen: false,
          canClose: bBefore !== -1 && !isSpaceCode(bBefore),
          pos: C.pos, end: C.pos + m.bEff - use, afterSpace: true });
      }
      if (inner.length > 0) processDelims(inner, s, 0, inner.length, D.end);
      di = m.ci; // skip the inner delims and the closer
      break;
    }
  }
}

// Find the closer for opener `D` with attempted length `k`, scanning
// the delims in delims[from..hi). Returns {ci, bEff, use} or null.
function findEmMatch(D, k, delims, from, hi, s) {
  const ch = D.ch;
  const isDel = ch === '~';
  const y = D.len; // the full run length (the rule of 3s uses it)
  const o = k < D.len; // a suffix attempt: the previous char is the same delimiter
  const R = D.canClose; // the opener can also close
  let m = k, f = 0;
  // The `__...*...__` / `**..._...**` skip span at the scan start:
  // possible only when the next delimiter is an opposite-char run of
  // exactly length 2 (the span's opening run).
  let skipEnd = -1;
  if (!isDel && from < hi && delims[from].ch !== ch && delims[from].len === 2) {
    const re = ch === '*' ? SKIP_AST_RE : SKIP_UND_RE;
    re.lastIndex = D.end;
    const sm = re.exec(s);
    if (sm) skipEnd = D.end + sm[0].length;
  }
  for (let j = from; j < hi; j++) {
    const C = delims[j];
    if (C.ch !== ch) continue;
    if (skipEnd >= 0 && C.pos < skipEnd) continue;
    if (isDel) {
      // Tilde pairs must have equal length; other lengths are
      // invisible to the scan.
      if (C.len !== k) continue;
      if (C.canOpen && !C.canClose) { m += C.len; continue; }
      m -= C.len;
    } else {
      if (!C.canOpen && !C.canClose) continue;
      const b = C.len;
      if (C.canOpen && !C.canClose) { m += b; continue; }
      if (C.canOpen && C.canClose) {
        if (o) return null; // a both-run after a suffix attempt ends the scan
        if (y % 3 !== 0 && (y + b) % 3 === 0) { f += b; continue; }
      } else if (R) {
        if (y % 3 !== 0 && (y + b) % 3 === 0) { f += b; continue; }
      }
      m -= b;
    }
    if (m > 0) continue;
    const bEff = isDel ? C.len : Math.min(C.len, C.len + m + f);
    const use = isDel ? k : (Math.min(k, bEff) % 2 === 1 ? 1 : 2);
    return { ci: j, bEff, use };
  }
  return null;
}

// Render a delimiter token: literal prefix, leftover inner run,
// closing tags, literal leftovers, opening tags, leftover inner run,
// literal suffix. (A token has at most one role — opener, closer, or
// literal — so only the fields for that role are non-empty.)
function renderDelim(tok) {
  let out = '';
  if (tok.preLit > 0) out += tok.ch.repeat(tok.preLit);
  if (tok.innerPost !== null) out += renderDelim(tok.innerPost);
  out += tok.post;
  if (tok.len > 0) out += tok.ch.repeat(tok.len);
  out += tok.pre;
  if (tok.innerPre !== null) out += renderDelim(tok.innerPre);
  if (tok.postLit > 0) out += tok.ch.repeat(tok.postLit);
  return out;
}

// Emit the token list as HTML.
function emitInline(toks) {
  let out = '';
  for (let i = 0; i < toks.length; i++) {
    const tok = toks[i];
    switch (tok.t) {
      case T_TEXT: out += tok.s; break;
      case T_CODE: out += '<code>' + tok.s + '</code>'; break;
      case T_HTML: out += tok.s; break;
      case T_BR: out += '<br>'; break;
      case T_SOFT: out += '\n'; break;
      case T_DELIM:
        out += renderDelim(tok);
        break;
      case T_LINK_O:
        out += '<a href="' + (tok.raw ? escapeCode(tok.href === null ? '' : tok.href) : escapeAttr(tok.href === null ? '' : tok.href)) + '"' +
          (tok.title !== null ? ' title="' + tok.title + '"' : '') + '>';
        break;
      case T_LINK_C: out += '</a>'; break;
      case T_IMG:
        out += '<img src="' + escapeAttr(tok.href === null ? '' : tok.href) +
          '" alt="' + escapeAttr(tok.alt) + '"' +
          (tok.title !== null ? ' title="' + tok.title + '"' : '') + '>';
        break;
    }
  }
  return out;
}

// Inline parse with an explicit state object (used for link labels, so
// the caller can tell whether a link was emitted inside).
function inlineParseWithState(s, ctx, st) {
  const toks = [];
  const delims = [];
  // The mask belongs to this string only: save the caller's mask
  // (the outer block's) and restore it afterwards.
  const prevMask = st.mask;
  st.mask = null;
  if (s.indexOf('*') !== -1 || s.indexOf('_') !== -1 || s.indexOf('~') !== -1) st.mask = maskInlineSource(s);
  scanInline(s, ctx, toks, delims, 0, s.length, st);
  st.mask = prevMask;
  processEmphasis(toks, delims, s);
  return emitInline(toks);
}

// ------------------------------------------------------------------
// Block parser
// ------------------------------------------------------------------

// Split a line into its indent width (columns, tabs expanded) and the
// index where the content starts.
function lineIndent(line) {
  let col = 0;
  let i = 0;
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if (c === 32) { col++; i++; }
    else if (c === 9) { col += 4 - (col & 3); i++; }
    else break;
  }
  return { col, start: i };
}

// Remove `n` columns of indent from the start of a line. A tab that
// starts before column `n` always ends exactly on a multiple of 4, so
// removal never splits a tab.
function stripIndent(line, n) {
  let col = 0;
  let i = 0;
  while (i < line.length && col < n) {
    const c = line.charCodeAt(i);
    if (c === 32) { col++; i++; }
    else if (c === 9) { col += 4 - (col & 3); i++; }
    else break;
  }
  return line.slice(i);
}

const BLOCK_TAGS = new Set(('address article aside base basefont blockquote body caption center col colgroup dd details dialog dir div dl dt fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hr html iframe legend li link main menu menuitem meta nav noframes ol optgroup option p param search section summary table tbody td tfoot th thead title tr track ul').split(' '));

// Match a fenced-code opening at the start of `line` (0-3 indent).
// Returns {ch, len, info} or null. A backtick fence whose info string
// contains a backtick is not a fence.
function fenceOpen(line) {
  const { col, start } = lineIndent(line);
  if (col > 3) return null;
  const c = line.charCodeAt(start);
  if (c !== 96 && c !== 126) return null;
  let j = start;
  while (j < line.length && line.charCodeAt(j) === c) j++;
  if (j - start < 3) return null;
  const info = line.slice(j).trim();
  if (c === 96 && info.indexOf('`') !== -1) return null;
  return { ch: c === 96 ? '`' : '~', len: j - start, info };
}

// Is `line` a closing fence for the given fence? Same character, at
// least as long, only spaces after.
function fenceClose(line, fence) {
  const { col, start } = lineIndent(line);
  if (col > 3) return false;
  const c = fence.ch === '`' ? 96 : 126;
  let j = start;
  while (j < line.length && line.charCodeAt(j) === c) j++;
  if (j - start < fence.len) return false;
  for (let k = j; k < line.length; k++) {
    const cc = line.charCodeAt(k);
    if (cc !== 32 && cc !== 9) return false;
  }
  return true;
}

// Match an ATX heading. Returns {level, text} or null.
function atxHeading(line) {
  const { col, start } = lineIndent(line);
  if (col > 3) return null;
  let j = start;
  while (j < line.length && line.charCodeAt(j) === 35) j++;
  const level = j - start;
  if (level === 0 || level > 6) return null;
  if (j < line.length) {
    const c = line.charCodeAt(j);
    if (c !== 32 && c !== 9) return null;
  }
  let text = line.slice(j).trim();
  // Strip a closing sequence of #s preceded by a space; a heading
  // whose text is only #s is empty.
  if (/^#+$/.test(text)) return { level, text: '' };
  const cm = /[ \t]+#+[ \t]*$/.exec(text);
  if (cm) text = text.slice(0, cm.index);
  return { level, text: text.trim() };
}

// Is `line` a thematic break? 3+ of -, _, * (one kind), spaces allowed.
function isThematicBreak(line) {
  const { col, start } = lineIndent(line);
  if (col > 3) return false;
  const c = line.charCodeAt(start);
  if (c !== 45 && c !== 95 && c !== 42) return false;
  let count = 0;
  for (let j = start; j < line.length; j++) {
    const cc = line.charCodeAt(j);
    if (cc === c) count++;
    else if (cc !== 32 && cc !== 9) return false;
  }
  return count >= 3;
}

// Is `line` a setext underline (=+ or -+, 0-3 indent, only trailing
// spaces after the run)? Returns 1 for `=`, 2 for `-`, 0 otherwise.
// Internal spaces (e.g. `- - -`) make it a thematic break, not a
// setext underline.
function setextLevel(line) {
  const { col, start } = lineIndent(line);
  if (col > 3) return 0;
  const c = line.charCodeAt(start);
  if (c !== 61 && c !== 45) return 0;
  let j = start;
  while (j < line.length && line.charCodeAt(j) === c) j++;
  for (let k = j; k < line.length; k++) {
    const cc = line.charCodeAt(k);
    if (cc !== 32 && cc !== 9) return 0;
  }
  return c === 61 ? 1 : 2;
}

// Match a list marker at the start of `line` (0-3 indent). Returns
// {bullet} or {ordered, start, delim} plus marker length, or null.
function listMarker(line) {
  const { col, start } = lineIndent(line);
  if (col > 3) return null;
  const c = line.charCodeAt(start);
  if (c === 45 || c === 43 || c === 42) {
    const nx = start + 1;
    if (nx >= line.length) return { bullet: String.fromCharCode(c), len: 1, empty: true };
    const nc = line.charCodeAt(nx);
    if (nc === 32 || nc === 9) return { bullet: String.fromCharCode(c), len: 1, empty: false };
    return null;
  }
  if (c >= 48 && c <= 57) {
    let j = start;
    while (j < line.length && line.charCodeAt(j) >= 48 && line.charCodeAt(j) <= 57) j++;
    if (j - start > 9) return null;
    if (j >= line.length) return null;
    const d = line.charCodeAt(j);
    if (d !== 46 && d !== 41) return null;
    const nx = j + 1;
    if (nx >= line.length) return { ordered: true, start: parseInt(line.slice(start, j), 10), delim: String.fromCharCode(d), len: j + 1 - start, empty: true };
    const nc = line.charCodeAt(nx);
    if (nc === 32 || nc === 9) return { ordered: true, start: parseInt(line.slice(start, j), 10), delim: String.fromCharCode(d), len: j + 1 - start, empty: false };
    return null;
  }
  return null;
}

// Match an HTML block start. Returns the type (1-7) or 0.
// `hasNlAfter` says whether a newline follows this line in the string
// being parsed: a `<pre|script|style|textarea` name at end-of-line
// counts as type 1 only when a newline follows (the `\n` is the
// `[\s>]` after the name).
function htmlBlockType(line, hasNlAfter) {
  const { col, start } = lineIndent(line);
  if (col > 3) return 0;
  if (line.charCodeAt(start) !== 60) return 0;
  const rest = line.slice(start);
  if (/^<(pre|script|style|textarea)[\s>]/i.test(rest)) return 1;
  if (hasNlAfter && /^<(pre|script|style|textarea)$/i.test(rest)) return 1;
  if (rest.startsWith('<!--')) return 2;
  if (rest.startsWith('<?')) return 3;
  if (/^<![A-Z]/i.test(rest)) return 4;
  if (/^<!\[CDATA\[/i.test(rest)) return 5;
  const tm = /^<\/?([A-Za-z][A-Za-z0-9-]*)([\s/>]|$)/.exec(rest);
  if (tm && BLOCK_TAGS.has(tm[1].toLowerCase())) return 6;
  // Type 7: a complete open tag (not pre/script/style/textarea) or a
  // complete close tag (no attributes) alone on the line.
  const m7 = /^<([A-Za-z][A-Za-z0-9-]*)(?:\s+[A-Za-z_:][A-Za-z0-9_.:-]*(?:\s*=\s*(?:[^ \t\n"'=<>`]+|'[^'\n]*'|"[^"\n]*"))?)*\s*\/?>[ \t]*$/.exec(rest);
  if (m7 && !/^(pre|script|style|textarea)$/i.test(m7[1])) return 7;
  if (/^<\/[A-Za-z][A-Za-z0-9-]*\s*>[ \t]*$/.test(rest)) return 7;
  return 0;
}

// Parse a link reference definition starting at lines[k]. Returns
// {used, label, href, title} (used = lines consumed) or null. The
// label may span lines (but not across a blank line); the destination
// may be on the next line; the title may span lines but not across a
// blank line. A title on a later line that fails to parse falls back
// to a title-less definition.
function parseDef(lines, k, hi) {
  const line = lines[k];
  const { col, start } = lineIndent(line);
  if (col > 3) return null;
  if (line.charCodeAt(start) !== 91) return null;
  // The label: no unescaped [ or ] inside, not all whitespace, may
  // span lines but not across a blank line.
  let li = k;
  let p = start + 1;
  let closeLine = -1;
  let closeCol = -1;
  outer: for (;;) {
    const curLine = lines[li];
    while (p < curLine.length) {
      const c = curLine.charCodeAt(p);
      if (c === 92) { p += 2; continue; }
      if (c === 91) return null;
      if (c === 93) { closeLine = li; closeCol = p; break outer; }
      p++;
    }
    if (li + 1 >= hi) return null;
    if (isBlank(lines[li + 1])) return null;
    li++;
    p = 0;
  }
  let label;
  if (closeLine === k) {
    label = line.slice(start + 1, closeCol);
  } else {
    const parts = [line.slice(start + 1)];
    for (let q = k + 1; q < closeLine; q++) parts.push(lines[q]);
    parts.push(lines[closeLine].slice(0, closeCol));
    label = parts.join('\n');
  }
  if (label.length === 0 || label.trim().length === 0) return null;
  const endLine = lines[closeLine];
  let p2 = closeCol + 1;
  if (p2 >= endLine.length || endLine.charCodeAt(p2) !== 58) return null;
  p2++;
  // Position within a virtual stream of lines[closeLine..].
  li = closeLine;
  let cur = endLine;
  p = p2;
  const skipSpaces = () => {
    while (p < cur.length && (cur.charCodeAt(p) === 32 || cur.charCodeAt(p) === 9)) p++;
  };
  skipSpaces();
  if (p >= cur.length) {
    // Destination may be on the next line.
    if (li + 1 >= hi) return null;
    li++;
    cur = lines[li];
    p = 0;
    skipSpaces();
    if (p >= cur.length) return null;
  }
  // Destination: angle form first, then bare form (balanced parens,
  // no nesting, no spaces).
  let href = '';
  let angleOk = false;
  if (cur.charCodeAt(p) === 60) {
    // Angle form: `<.*?>` — the first `>` ends it, and `<` is
    // allowed inside. If it fails, the bare form cannot start
    // with `<` either, so the definition is invalid.
    const end = cur.indexOf('>', p + 1);
    if (end === -1) return null;
    href = unescapeText(cur.slice(p + 1, end));
    p = end + 1;
    angleOk = true;
  }
  if (!angleOk) {
    const s0 = p;
    while (p < cur.length) {
      const c = cur.charCodeAt(p);
      if (c === 32 || c === 9 || c < 32) break;
      if (c === 40) {
        // A group must close with no parens inside (spaces allowed).
        let q = p + 1;
        let found = false;
        while (q < cur.length) {
          const d = cur.charCodeAt(q);
          if (d === 40) break;
          if (d === 41) { found = true; break; }
          q++;
        }
        if (!found) return null;
        p = q + 1;
        continue;
      }
      if (c === 41) return null;
      p++;
    }
    if (p === s0) return null;
    href = unescapeText(cur.slice(s0, p));
  }
  if (href.length === 0 && !angleOk) return null;
  // Optional title, on this line or the next; it may span lines but
  // not across a blank line, and it needs whitespace (or a newline)
  // separating it from the destination.
  let title = null;
  const pAfterDest = p;
  skipSpaces();
  const hadSpace = p > pAfterDest;
  let titleLine = -1;
  let titlePos = -1;
  if (p >= cur.length) {
    if (li + 1 < hi) {
      const nl = lines[li + 1];
      let q = 0;
      while (q < nl.length && (nl.charCodeAt(q) === 32 || nl.charCodeAt(q) === 9)) q++;
      if (q < nl.length && (nl.charCodeAt(q) === 34 || nl.charCodeAt(q) === 39 || nl.charCodeAt(q) === 40)) {
        titleLine = li + 1;
        titlePos = q;
      }
    }
  } else {
    if (!hadSpace) return null;
    const c = cur.charCodeAt(p);
    if (c !== 34 && c !== 39 && c !== 40) return null;
    titleLine = li;
    titlePos = p;
  }
  if (titleLine !== -1) {
    // Parse the title; any failure falls back to a title-less
    // definition when the title started on a later line than the
    // destination, and invalidates the definition otherwise.
    const destLine = li;
    const q = lines[titleLine].charCodeAt(titlePos);
    let tl = titleLine;
    let j = titlePos + 1;
    let buf = '';
    let ok = false;
    let bad = false;
    for (;;) {
      const tline = lines[tl];
      while (j < tline.length) {
        const c = tline.charCodeAt(j);
        if (q === 40) {
          if (c === 40) { bad = true; break; }
          if (c === 41) { ok = true; break; }
        } else if (c === q) { ok = true; break; }
        if (c === 92 && j + 1 < tline.length && ASCII_PUNCT.indexOf(tline[j + 1]) !== -1) { buf += tline[j + 1]; j += 2; continue; }
        buf += tline[j];
        j++;
      }
      if (bad || ok) break;
      if (tl + 1 >= hi) { bad = true; break; }
      if (isBlank(lines[tl + 1])) { bad = true; break; }
      buf += '\n';
      tl++;
      j = 0;
    }
    if (!bad && ok) {
      title = buf;
      j++;
      const tline = lines[tl];
      while (j < tline.length && (tline.charCodeAt(j) === 32 || tline.charCodeAt(j) === 9)) j++;
      if (j < tline.length) bad = true;
      else li = tl;
    }
    if (bad) {
      if (titleLine > destLine) {
        return { used: destLine - k + 1, label: normalizeLabel(label), href, title: null };
      }
      return null;
    }
  }
  return { used: li - k + 1, label: normalizeLabel(label), href, title };
}

// Is `line` a table delimiter row? Returns the alignments array
// ('left' | 'right' | 'center' | null per cell) or null.
function tableDelimiter(line) {
  let s = line.trim();
  if (s.charCodeAt(0) === 124) s = s.slice(1);
  if (s.length > 0 && s.charCodeAt(s.length - 1) === 124) s = s.slice(0, -1);
  if (s.length === 0) return null;
  const cells = s.split('|');
  const aligns = [];
  for (let i = 0; i < cells.length; i++) {
    const c = cells[i].trim();
    if (!/^:?-+:?$/.test(c)) return null;
    const left = c.charCodeAt(0) === 58;
    const right = c.charCodeAt(c.length - 1) === 58;
    aligns.push(left && right ? 'center' : left ? 'left' : right ? 'right' : null);
  }
  return aligns;
}

// Split a table row into cells on unescaped `|`, dropping outer pipes.
function splitTableRow(line) {
  let s = line.trim();
  // Unescape \| first is wrong; split on unescaped pipes instead.
  const cells = [];
  let buf = '';
  let i = 0;
  if (s.charCodeAt(0) === 124) { i = 1; }
  for (; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 92 && i + 1 < s.length && s.charCodeAt(i + 1) === 124) {
      buf += '|';
      i++;
      continue;
    }
    if (c === 124) {
      cells.push(buf.trim());
      buf = '';
      continue;
    }
    buf += s[i];
  }
  // Trailing outer pipe: the last empty cell is dropped when the line
  // ends with `|` (possibly with spaces, already trimmed).
  if (s.length > 0 && s.charCodeAt(s.length - 1) === 124) {
    cells.push(buf.trim());
    cells.pop();
  } else {
    cells.push(buf.trim());
  }
  return cells;
}

// ------------------------------------------------------------------
// Block-level helpers
// ------------------------------------------------------------------

// Is `line` blank (only spaces/tabs)?
function isBlank(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

// Does `line` start a blockquote marker (0-3 indent, `>`)?
function quoteStart(line) {
  const { col, start } = lineIndent(line);
  return col <= 3 && line.charCodeAt(start) === 62;
}

// HTML block type restricted to 1-6 (the types that interrupt).
function htmlBlockType16(line, hasNlAfter) {
  const t = htmlBlockType(line, hasNlAfter);
  return t >= 1 && t <= 6 ? t : 0;
}

// Does `line` start HTML types 1-6 under the INTERRUPTION pattern
// (paragraph, table body rows, lazy quote lines)? It differs from
// the block rule: it is CASE-SENSITIVE (upper-case tag names do not
// interrupt), a type-1 name at end-of-line always interrupts (the
// `$` alternative), a type-6 name at end-of-line interrupts only
// when a newline follows, and a tab after a type-6 name does not
// interrupt (the pattern is ` +`, spaces only).
function htmlInterrupts(line, hasNlAfter) {
  const { col, start } = lineIndent(line);
  if (col > 3) return false;
  if (line.charCodeAt(start) !== 60) return false;
  const rest = line.slice(start);
  if (/^<(pre|script|style|textarea)([\s>]|$)/.test(rest)) return true;
  if (rest.startsWith('<!--')) return true;
  if (rest.startsWith('<?')) return true;
  if (/^<![A-Za-z]/.test(rest)) return true;
  if (rest.startsWith('<![CDATA[')) return true;
  const tm = /^<\/?([A-Za-z][A-Za-z0-9-]*)/.exec(rest);
  if (tm && BLOCK_TAGS.has(tm[1])) {
    const after = rest.slice(tm[0].length);
    if (after.length === 0) return hasNlAfter;
    const c = after.charCodeAt(0);
    return c === 32 || c === 47 || c === 62;
  }
  return false;
}

// Does `line` start HTML types 1-6 under the LIST break-test
// pattern? Case-INSENSITIVE (unlike the paragraph interruption
// pattern); a type-6 name at end-of-line always breaks; a tab after
// a type-6 name does not break.
function htmlListBreak(line) {
  const { col, start } = lineIndent(line);
  if (col > 3) return false;
  if (line.charCodeAt(start) !== 60) return false;
  const rest = line.slice(start);
  if (/^<(pre|script|style|textarea)([\s>]|$)/i.test(rest)) return true;
  if (rest.startsWith('<!--')) return true;
  if (rest.startsWith('<?')) return true;
  if (/^<![A-Za-z]/.test(rest)) return true;
  if (/^<!\[CDATA\[/i.test(rest)) return true;
  const tm = /^<\/?([A-Za-z][A-Za-z0-9-]*)/.exec(rest);
  if (tm && BLOCK_TAGS.has(tm[1].toLowerCase())) {
    const after = rest.slice(tm[0].length);
    if (after.length === 0) return true;
    const c = after.charCodeAt(0);
    return c === 32 || c === 47 || c === 62;
  }
  return false;
}
function listMarkerPara(line, top) {
  const m = listMarker(line);
  if (m === null) return false;
  if (!top) return true;
  if (m.empty) return false;
  return m.bullet !== undefined || m.start === 1;
}

// Table pattern (header with a pipe + valid delimiter row with a
// pipe), used to interrupt paragraphs. The cell-count check is
// separate: a pattern with mismatched counts still interrupts, but
// the lines then fall through to a paragraph.
function tablePatternAt(lines, k, hi) {
  if (k + 1 >= hi) return false;
  const head = lines[k];
  if (head.indexOf('|') === -1) return false;
  if (lineIndent(head).col > 3) return false;
  const delim = lines[k + 1];
  if (delim.indexOf('|') === -1) return false;
  if (lineIndent(delim).col > 3) return false;
  return tableDelimiter(delim) !== null;
}

// A real table start: the pattern plus matching cell counts.
function tableStartsAt(lines, k, hi) {
  if (!tablePatternAt(lines, k, hi)) return false;
  const aligns = tableDelimiter(lines[k + 1]);
  return splitTableRow(lines[k]).length === aligns.length;
}

// Does lines[k..] start a setext heading? Used for the list lazy-line
// setext hack (virtual [m, f] arrays): the first line must be plain
// text (not a list marker, fence, quote, heading, `<`-line, or
// indented code) and the next line a setext underline.
function lheadingAt(lines, k, hi) {
  if (k + 1 >= hi) return false;
  const first = lines[k];
  if (isBlank(first)) return false;
  const { col, start } = lineIndent(first);
  if (col > 3) return false;
  if (first.charCodeAt(start) === 60) return false;
  if (listMarker(first) || fenceOpen(first) || quoteStart(first) ||
      atxHeading(first)) return false;
  return setextLevel(lines[k + 1]) > 0;
}

// Strip one blockquote marker from `line`: the whitespace after `>`
// is tab-expanded (columns counted from after the marker), then the
// marker plus one space is removed.
function stripQuoteMarker(line) {
  const { start } = lineIndent(line);
  const j = start + 1; // past >
  let k = j;
  let col = j;
  let out = '';
  while (k < line.length) {
    const c = line.charCodeAt(k);
    if (c === 32) { out += ' '; col++; k++; }
    else if (c === 9) { const n = 4 - (col & 3); out += '    '.slice(0, n); col += n; k++; }
    else break;
  }
  const rest = out + line.slice(k);
  return rest.charCodeAt(0) === 32 ? rest.slice(1) : rest;
}

// Does line k interrupt a paragraph/text run? `mode` is 'top' or
// 'item' (list items: any list marker interrupts).
function interruptsPara(lines, k, hi, mode, ctx) {
  const line = lines[k];
  if (isThematicBreak(line)) return true;
  if (atxHeading(line)) return true;
  if (setextLevel(line) > 0) return true;
  if (quoteStart(line)) return true;
  if (fenceOpen(line)) return true;
  if (listMarkerPara(line, mode === 'top')) return true;
  if (htmlInterrupts(line, k < hi - 1 || ctx.endsNl)) return true;
  if (tablePatternAt(lines, k, hi)) return true;
  return false;
}

// Does `line` end a table's body rows? Same as the top-level
// interruption set, minus setext underlines and table patterns —
// plus indented-code lines. A "blank" row-ender here is spaces-only:
// a tab-only line is a body row (empty cells), and a line with indent
// >= 4 followed by content is indented code.
function tableRowEnds(line, hasNlAfter) {
  return /^ *$/.test(line) || (lineIndent(line).col >= 4 && !isBlank(line)) ||
    isThematicBreak(line) || atxHeading(line) ||
    quoteStart(line) || fenceOpen(line) || listMarkerPara(line, true) ||
    htmlInterrupts(line, hasNlAfter);
}

// Does a lazy `line` end a blockquote? The Ke set: hr, ATX, fence,
// any list marker, html types 1-6. Setext underlines, table patterns
// and definitions do NOT interrupt lazy quote lines.
function interruptsKe(line, hasNlAfter) {
  return isThematicBreak(line) || atxHeading(line) || fenceOpen(line) ||
    listMarker(line) !== null || htmlInterrupts(line, hasNlAfter);
}

// ------------------------------------------------------------------
// Block collectors
// ------------------------------------------------------------------

// Fenced code starting at lines[i] (fence already matched).
function collectFence(lines, i, hi, fence) {
  // Indent compensation applies ONLY to backtick fences: marked's
  // indentCodeCompensation regex is /^(\s+)(?:```)/ — a tilde fence
  // never compensates, however indented its opening line is.
  const openIndent = fence.ch === '`' ? lineIndent(lines[i]).col : 0;
  let j = i + 1;
  while (j < hi && !fenceClose(lines[j], fence)) j++;
  const body = [];
  for (let k = i + 1; k < j; k++) {
    // Indent compensation: strip up to N leading whitespace chars.
    const line = lines[k];
    let s = 0;
    while (s < line.length && s < openIndent &&
      (line.charCodeAt(s) === 32 || line.charCodeAt(s) === 9)) s++;
    body.push(line.slice(s));
  }
  const info = unescapeText(fence.info);
  const lang = info.split(/[ \t]+/, 1)[0];
  // The renderer strips one trailing newline and adds one back, so
  // a body that already ends with one keeps it as-is.
  const joined = body.join('\n');
  const text = joined.length === 0 ? '' :
    joined.endsWith('\n') ? joined : joined + '\n';
  return {
    chunk: { k: 'code', text, lang, indented: false, raw: body.join('\n') },
    next: j < hi ? j + 1 : hi,
  };
}

// Indented code starting at lines[i]: indented lines plus blank lines
// that are followed by more indented lines. Trailing blanks dropped.
function collectIndentedCode(lines, i, hi) {
  const body = [];
  const rawLines = [];
  let j = i;
  while (j < hi) {
    const line = lines[j];
    if (isBlank(line)) {
      let m = j + 1;
      while (m < hi && isBlank(lines[m])) m++;
      if (m < hi && lineIndent(lines[m]).col >= 4) {
        while (j < m) { body.push(stripIndent(lines[j], 4)); rawLines.push(lines[j]); j++; }
        continue;
      }
      break;
    }
    if (lineIndent(line).col >= 4) {
      body.push(stripIndent(line, 4));
      rawLines.push(line);
      j++;
      continue;
    }
    break;
  }
  const text = body.length > 0 ? body.join('\n') + '\n' : '';
  return {
    chunk: { k: 'code', text, lang: '', indented: true, raw: rawLines.join('\n') },
    next: j,
  };
}

// HTML block starting at lines[i] (type already matched). The end tag
// (types 1-5) or a blank line (types 6-7) terminates it. The text
// keeps a trailing newline only when the block ends at EOF with the
// input ending in a newline, or (types 1-5) when the end-tag line is
// followed by a non-blank line.
function collectHtmlBlock(lines, i, hi, type, ctx) {
  let j = i;
  let endRe = null;
  if (type === 1) {
    const nm = /^ {0,3}<(pre|script|style|textarea)([\s>]|$)/i.exec(lines[i]);
    const name = nm ? nm[1].toLowerCase() : 'pre';
    endRe = new RegExp('</' + name + '[\\s>]', 'i');
  } else if (type === 2) {
    endRe = /-->/;
  } else if (type === 3) {
    endRe = /\?>/;
  } else if (type === 4) {
    endRe = />/;
  } else if (type === 5) {
    endRe = /\]\]>/;
  }
  if (endRe !== null) {
    while (j < hi) {
      if (endRe.test(lines[j])) { j++; break; }
      j++;
    }
  } else {
    while (j < hi && !isBlank(lines[j])) j++;
  }
  let text = lines.slice(i, j).join('\n');
  const atEof = j >= hi;
  // Marked's ge() strips the trailing newline only when the match ends
  // with 2+ newlines, which happens only when the end-tag line is
  // followed by a truly EMPTY line (length 0): the html regex's \n+
  // then swallows that line's newline too. A whitespace-only line
  // (spaces/tabs) stops the \n+ run, so the newline is kept.
  if (atEof ? ctx.endsNl : (type <= 5 && lines[j].length > 0)) text += '\n';
  return { chunk: { k: 'html', s: text }, next: j };
}

// Table starting at lines[i] (header + delimiter already matched).
function collectTable(lines, i, hi, ctx) {
  const aligns = tableDelimiter(lines[i + 1]);
  const n = aligns.length;
  const head = splitTableRow(lines[i]);
  while (head.length < n) head.push('');
  const rows = [];
  let j = i + 2;
  while (j < hi && !tableRowEnds(lines[j], j < hi - 1 || ctx.endsNl)) {
    const cells = splitTableRow(lines[j]);
    while (cells.length < n) cells.push('');
    if (cells.length > n) cells.length = n;
    rows.push(cells);
    j++;
  }
  return { chunk: { k: 'table', aligns, head, rows }, next: j };
}

// Paragraph (or setext heading) starting at lines[i]. In 'top' mode
// lines join verbatim; in 'item' mode indented lines join with 4
// columns stripped (the indented-code merge), including blank lines
// inside an indented run.
function collectParagraph(lines, i, hi, ctx, mode) {
  const textLines = [lines[i]];
  let k = i + 1;
  while (k < hi) {
    const line = lines[k];
    if (isBlank(line)) {
      // The paragraph regex's blank-line lookahead needs a `\n`
      // after the spaces, so a whitespace-only FINAL line joins
      // the paragraph when the string has no trailing newline
      // (cm-241: a quote group's virtual string never ends with
      // one). An empty line never joins.
      if (line.length > 0 && k === hi - 1 && !ctx.endsNl) {
        textLines.push(line);
        k++;
      }
      break;
    }
    if (interruptsPara(lines, k, hi, mode, ctx)) break;
    if (mode === 'item' && lineIndent(line).col >= 4) {
      // Indented-code run: indented lines plus blank lines followed
      // by more indented lines, all merged into the text.
      let j = k;
      while (j < hi) {
        const lj = lines[j];
        if (isBlank(lj)) {
          let m = j + 1;
          while (m < hi && isBlank(lines[m])) m++;
          if (m < hi && lineIndent(lines[m]).col >= 4) {
            while (j < m) { textLines.push(stripIndent(lines[j], 4)); j++; }
            continue;
          }
          break;
        }
        if (lineIndent(lj).col >= 4) {
          textLines.push(stripIndent(lj, 4));
          j++;
          continue;
        }
        break;
      }
      k = j;
      continue;
    }
    textLines.push(line);
    k++;
  }
  if (k < hi && setextLevel(lines[k]) > 0) {
    const level = setextLevel(lines[k]);
    return { chunk: { k: 'head', level, text: textLines.join('\n').trim() }, next: k + 1 };
  }
  return { chunk: { k: 'para', text: textLines.join('\n') }, next: k };
}

// ------------------------------------------------------------------
// Block parser
// ------------------------------------------------------------------

// Parse lines[lo..hi) into chunks. `mode` is 'top' (paragraph rule)
// or 'item' (list-item text rule: any list marker interrupts, and
// indented lines merge into the text with 4 columns stripped).
function parseBlocks(lines, lo, hi, ctx, mode, stats) {
  const chunks = [];
  let i = lo;
  let blankAfter = false;
  while (i < hi) {
    const line = lines[i];
    if (isBlank(line)) {
      if (chunks.length > 0) blankAfter = true;
      i++;
      continue;
    }
    // A non-blank line after a blank line that followed a chunk
    // means a space token sits between two blocks (a definition
    // counts as a block here: it is a token in marked's stream).
    if (blankAfter) {
      if (stats) stats.hasSpace = true;
      blankAfter = false;
    }
    if (lineIndent(line).col >= 4) {
      const r = collectIndentedCode(lines, i, hi);
      chunks.push(r.chunk);
      i = r.next;
      continue;
    }
    const fence = fenceOpen(line);
    if (fence) {
      const r = collectFence(lines, i, hi, fence);
      chunks.push(r.chunk);
      i = r.next;
      continue;
    }
    const atx = atxHeading(line);
    if (atx) {
      chunks.push({ k: 'head', level: atx.level, text: atx.text });
      i++;
      continue;
    }
    if (isThematicBreak(line)) {
      chunks.push({ k: 'hr' });
      i++;
      continue;
    }
    if (quoteStart(line)) {
      const r = collectQuote(lines, i, hi, ctx);
      chunks.push(r.chunk);
      i = r.next;
      continue;
    }
    if (listMarker(line)) {
      const r = collectList(lines, i, hi, ctx);
      chunks.push(r.chunk);
      // A list swallows the blank lines after its last item, but
      // marked trims them from the list's raw, so they still form a
      // space token before the next block.
      if (r.chunk.trailingBlank) blankAfter = true;
      i = r.next;
      continue;
    }
    const ht = htmlBlockType(line, i < hi - 1 || ctx.endsNl);
    if (ht > 0) {
      const r = collectHtmlBlock(lines, i, hi, ht, ctx);
      chunks.push(r.chunk);
      i = r.next;
      continue;
    }
    const def = parseDef(lines, i, hi);
    if (def) {
      if (!ctx.defs.has(def.label)) {
        ctx.defs.set(def.label, { href: def.href, title: def.title });
      }
      i += def.used;
      continue;
    }
    if (tableStartsAt(lines, i, hi)) {
      const r = collectTable(lines, i, hi, ctx);
      chunks.push(r.chunk);
      i = r.next;
      continue;
    }
    const r = collectParagraph(lines, i, hi, ctx, mode);
    chunks.push(r.chunk);
    i = r.next;
  }
  return chunks;
}

// Render chunks to HTML. `tight` applies to direct paragraph
// children only (bare inline, no <p>); nested quotes and lists reset
// it from their own looseness.
function renderChunks(chunks, ctx, tight) {
  let out = '';
  for (let ci = 0; ci < chunks.length; ci++) {
    const ch = chunks[ci];
    switch (ch.k) {
      case 'html': out += ch.s; break;
      case 'para':
        out += tight ? inlineParse(ch.text, ctx)
          : '<p>' + inlineParse(ch.text, ctx) + '</p>\n';
        break;
      case 'head':
        out += '<h' + ch.level + '>' + inlineParse(ch.text, ctx) +
          '</h' + ch.level + '>\n';
        break;
      case 'hr': out += '<hr>\n'; break;
      case 'code':
        out += '<pre><code' +
          (ch.lang ? ' class="language-' + escapeAttr(ch.lang) + '">' : '>') +
          escapeCode(ch.text) + '</code></pre>\n';
        break;
      case 'quote':
        out += '<blockquote>\n' + renderChunks(ch.chunks, ctx, false) +
          '</blockquote>\n';
        break;
      case 'list': {
        const tag = ch.ordered ? 'ol' : 'ul';
        out += '<' + tag +
          (ch.ordered && ch.start !== 1 ? ' start="' + ch.start + '"' : '') +
          '>\n';
        for (let ii = 0; ii < ch.items.length; ii++) {
          const item = ch.items[ii];
          out += '<li>';
          if (item.task) {
            const box = '<input ' + (item.checked ? 'checked="" ' : '') +
              'disabled="" type="checkbox"> ';
            if (!ch.loose) {
              out += box + renderChunks(item.chunks, ctx, true);
            } else if (item.chunks.length > 0 && item.chunks[0].k === 'para') {
              out += '<p>' + box + inlineParse(item.chunks[0].text, ctx) + '</p>\n';
              out += renderChunks(item.chunks.slice(1), ctx, false);
            } else {
              out += '<p>' + box + '</p>\n';
              out += renderChunks(item.chunks, ctx, false);
            }
          } else {
            out += renderChunks(item.chunks, ctx, !ch.loose);
          }
          out += '</li>\n';
        }
        out += '</' + tag + '>\n';
        break;
      }
      case 'table': {
        out += '<table>\n<thead>\n<tr>\n';
        for (let c = 0; c < ch.head.length; c++) {
          out += '<th' + (ch.aligns[c] ? ' align="' + ch.aligns[c] + '"' : '') +
            '>' + inlineParse(ch.head[c], ctx) + '</th>\n';
        }
        out += '</tr>\n</thead>\n';
        if (ch.rows.length > 0) {
          out += '<tbody>';
          for (let r = 0; r < ch.rows.length; r++) {
            const row = ch.rows[r];
            out += '<tr>\n';
            for (let c = 0; c < row.length; c++) {
              out += '<td' + (ch.aligns[c] ? ' align="' + ch.aligns[c] + '"' : '') +
                '>' + inlineParse(row[c], ctx) + '</td>\n';
            }
            out += '</tr>\n';
          }
          out += '</tbody>';
        }
        out += '</table>\n';
        break;
      }
    }
  }
  return out;
}

// Parse one Markdown document to HTML, byte-identical to marked
// 18.1.3 with gfm true and breaks false.
export function parse(src) {
  const normalized = src.replace(/\r\n?/g, '\n');
  const endsNl = normalized.endsWith('\n');
  const lines = normalized.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  const ctx = { defs: new Map(), endsNl, inLink: false };
  const chunks = parseBlocks(lines, 0, lines.length, ctx, 'top');
  return renderChunks(chunks, ctx, false);
}

// ------------------------------------------------------------------
// Lists
// ------------------------------------------------------------------

// Does the item's content lines contain a blank line strictly in the
// middle (non-blank content both before and after it)? That makes
// the whole list loose.
// Collect one list item's content lines starting at lines[k] (marker
// already matched). Returns the content lines, the index after the
// item, whether the item's raw ends with a blank line, and the task
// marker state.
function collectListItemLines(lines, k, hi, ctx) {
  const m = listMarker(lines[k]);
  const { start } = lineIndent(lines[k]);
  const b = start + m.len; // chars up to and including the marker
  const g = expandLeadingTabs(lines[k].slice(b), b);
  let firstNonSpace = -1;
  for (let q = 0; q < g.length; q++) {
    if (g.charCodeAt(q) !== 32) { firstNonSpace = q; break; }
  }
  let R;
  let d;
  let y = false;
  if (firstNonSpace === -1) {
    y = true;
    R = b + 1;
    d = '';
  } else if (firstNonSpace > 4) {
    R = 1;
    d = g.slice(1);
    R += b;
  } else {
    R = firstNonSpace;
    d = g.slice(R);
    R += b;
  }
  // Task marker on the item's first content line.
  let task = false;
  let checked = false;
  const tm = /^\[([ xX])\][ \t]+\S/.exec(d);
  if (tm) {
    task = true;
    checked = tm[1] !== ' ';
    d = d.replace(/^\[[ xX]\][ \t]+/, '');
  }
  const itemLines = [d];
  let next = k + 1;
  if (y && next < hi && isBlank(lines[next])) {
    // Empty item followed by a blank line: consume it, item done.
    return { itemLines, next: next + 1, endsWithBlank: true, task, checked };
  }
  let prevBlank = y;
  let mLine = d;
  while (next < hi) {
    const f = lines[next];
    const Z = expandLeadingTabs(f, 0);
    let fn = -1;
    for (let q = 0; q < Z.length; q++) {
      if (Z.charCodeAt(q) !== 32) { fn = q; break; }
    }
    if (isBlank(f)) {
      itemLines.push('');
      prevBlank = true;
      mLine = '';
      next++;
      continue;
    }
    if (fn >= R) {
      const content = Z.slice(R);
      itemLines.push(content);
      prevBlank = false;
      mLine = content;
      next++;
      continue;
    }
    // Indent < R: a fence, heading, html block (types 1-6), quote,
    // list marker, or thematic break ends the item.
    if (fenceOpen(f) || atxHeading(f) ||
        htmlListBreak(f) ||
        quoteStart(f) || listMarker(f) !== null || isThematicBreak(f)) {
      break;
    }
    // Lazy continuation: blocked after a blank line, after
    // code-like content, or after a fence/heading/html/hr line.
    if (prevBlank) break;
    if (lineIndent(mLine).col >= 4) break;
    if (fenceOpen(mLine) || atxHeading(mLine) ||
        htmlListBreak(mLine) || isThematicBreak(mLine)) break;
    let qe = f;
    if (/^ {0,3}(?:=+|-+)[ \t]*$/.test(f) && lheadingAt([mLine, f], 0, 2)) {
      // Setext hack: indent the lazy underline so it parses as
      // indented code and merges back into the text unstripped.
      qe = '    ' + f.replace(/^ {0,3}/, '');
    }
    itemLines.push(qe);
    prevBlank = false;
    mLine = Z.slice(R);
    next++;
  }
  // A trailing blank line only counts when there is content before
  // it: a lone empty item has no trailing blank line.
  const endsWithBlank = itemLines.length > 1 &&
    isBlank(itemLines[itemLines.length - 1]);
  return { itemLines, next, endsWithBlank, task, checked };
}

// Collect a list starting at lines[i] (marker already matched).
function collectList(lines, i, hi, ctx) {
  const first = listMarker(lines[i]);
  const ordered = !!first.ordered;
  const bullet = first.bullet;
  const delim = first.delim;
  const start = ordered ? first.start : 0;
  const items = [];
  let loose = false;
  let prevEndsWithBlank = false;
  let k = i;
  while (k < hi) {
    // A thematic break ends the list even when it looks like a
    // marker line (`* * *` is an hr, not a new item).
    if (isThematicBreak(lines[k])) break;
    const m = listMarker(lines[k]);
    if (m === null) break;
    if (ordered) {
      if (!m.ordered || m.delim !== delim) break;
    } else if (m.bullet !== bullet) {
      break;
    }
    if (items.length > 0 && prevEndsWithBlank) loose = true;
    const r = collectListItemLines(lines, k, hi, ctx);
    // The item's content is a virtual string with no trailing
    // newline; parse it with endsNl off, then restore. Looseness
    // comes from a space token between two blocks in the item's own
    // token stream — blank lines inside a nested list, quote, or
    // fenced code do not count.
    const savedNl = ctx.endsNl;
    ctx.endsNl = false;
    const itemStats = { hasSpace: false };
    const chunks = parseBlocks(r.itemLines, 0, r.itemLines.length, ctx, 'item', itemStats);
    ctx.endsNl = savedNl;
    if (itemStats.hasSpace) loose = true;
    items.push({ chunks, task: r.task, checked: r.checked });
    prevEndsWithBlank = r.endsWithBlank;
    k = r.next;
  }
  return {
    chunk: { k: 'list', ordered, start, loose, items, trailingBlank: prevEndsWithBlank, srcLines: lines.slice(i, k) },
    next: k,
  };
}

// ------------------------------------------------------------------
// Blockquotes
// ------------------------------------------------------------------

// Merge a group's chunks into the quote's accumulated chunks: a
// paragraph merges into a preceding paragraph, and indented code
// merges into a preceding paragraph with its raw (unstripped) lines.
function mergeGroupChunks(chunks, groupChunks) {
  if (groupChunks.length === 0) return;
  const last = chunks.length > 0 ? chunks[chunks.length - 1] : null;
  const first = groupChunks[0];
  if (last !== null && last.k === 'para' && first.k === 'para') {
    last.text += '\n' + first.text;
    for (let j = 1; j < groupChunks.length; j++) chunks.push(groupChunks[j]);
  } else if (last !== null && last.k === 'para' && first.k === 'code' && first.indented) {
    // The code merge uses the code TEXT (indent stripped), not the
    // raw lines: `> foo\n    - bar` -> `foo\n- bar`.
    const codeText = first.text.endsWith('\n') ? first.text.slice(0, -1) : first.text;
    last.text += '\n' + codeText;
    for (let j = 1; j < groupChunks.length; j++) chunks.push(groupChunks[j]);
  } else {
    for (let j = 0; j < groupChunks.length; j++) chunks.push(groupChunks[j]);
  }
}

// Collect a blockquote starting at lines[i] (marker already matched).
// Lines belong to the quote while they carry a `>` marker or are
// lazy continuation lines (Ke set: hr, ATX, fence, any list marker,
// html types 1-6 end lazy consumption; a blank `>` line consumes no
// lazy lines after it). Groups are leading lazy lines plus
// consecutive `>` lines; each group is parsed separately with the
// merge and stop/re-parse rules.
function collectQuote(lines, i, hi, ctx) {
  // Phase 1: the quote's line range [i, end).
  let end = i;
  let prevBlankMarker = false;
  while (end < hi) {
    const line = lines[end];
    if (quoteStart(line)) {
      end++;
      prevBlankMarker = isBlank(stripQuoteMarker(line));
      continue;
    }
    if (isBlank(line)) break;
    if (prevBlankMarker) break;
    if (interruptsKe(line, end < hi - 1 || ctx.endsNl)) break;
    end++;
    prevBlankMarker = false;
  }
  // Phase 2: parse groups with the merge/stop/re-parse rules.
  const chunks = [];
  let pos = i;
  let consumedEnd = i;
  while (pos < end) {
    // Next group: leading lazy lines plus consecutive `>` lines.
    let ge = pos;
    while (ge < end && !quoteStart(lines[ge])) ge++;
    while (ge < end && quoteStart(lines[ge])) ge++;
    // Build the group's content lines.
    const content = [];
    for (let k = pos; k < ge; k++) {
      const line = lines[k];
      if (quoteStart(line)) {
        content.push(stripQuoteMarker(line));
      } else if (content.length > 0 && /^ {0,3}(?:=+|-+)[ \t]*$/.test(line)) {
        // Lazy setext-looking line (not the group's first): indent
        // it so it cannot become a setext underline.
        content.push('    ' + line.replace(/^ {0,3}/, ''));
      } else {
        content.push(line);
      }
    }
    const groupChunks = (() => {
      // A group's content is a virtual string with no trailing
      // newline; parse it with endsNl off, then restore.
      const savedNl = ctx.endsNl;
      ctx.endsNl = false;
      const gc = parseBlocks(content, 0, content.length, ctx, 'top');
      ctx.endsNl = savedNl;
      return gc;
    })();
    mergeGroupChunks(chunks, groupChunks);
    consumedEnd = ge;
    if (ge >= end) break;
    const last = chunks[chunks.length - 1];
    if (last.k === 'code' || last.k === 'head' || last.k === 'hr' ||
        last.k === 'html' || last.k === 'table') {
      // Remaining lines return to the outer parse.
      break;
    }
    if (last.k === 'list') {
      // Re-parse the list with its source plus the remaining RAW
      // lines (markers intact); lazy lines join the list, `>` lines
      // end it.
      const combined = last.srcLines.concat(lines.slice(ge, end));
      const r = collectList(combined, 0, combined.length, ctx);
      chunks[chunks.length - 1] = r.chunk;
      pos = ge + (r.next - last.srcLines.length);
      consumedEnd = pos;
      continue;
    }
    if (last.k === 'quote') {
      // Re-parse the nested quote with its source plus the remaining
      // lines stripped of one marker level (lazy setext lines get
      // the indent treatment).
      const stripped = [];
      for (let k = ge; k < end; k++) {
        const line = lines[k];
        if (quoteStart(line)) {
          stripped.push(stripQuoteMarker(line));
        } else if (/^ {0,3}(?:=+|-+)[ \t]*$/.test(line)) {
          stripped.push('    ' + line.replace(/^ {0,3}/, ''));
        } else {
          stripped.push(line);
        }
      }
      const combined = last.srcLines.concat(stripped);
      const r = collectQuote(combined, 0, combined.length, ctx);
      chunks[chunks.length - 1] = r.chunk;
      pos = ge + (r.next - last.srcLines.length);
      consumedEnd = pos;
      continue;
    }
    pos = ge;
  }
  return {
    chunk: { k: 'quote', chunks, srcLines: lines.slice(i, consumedEnd) },
    next: consumedEnd,
  };
}
