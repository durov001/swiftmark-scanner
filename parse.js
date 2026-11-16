// Swiftmark Scanner — a from-scratch single-pass Markdown parser.
//
// Renders CommonMark 0.31.2 + GFM, byte-identical to marked 18.1.3 under
// its default options, with no dependencies. The inline scanner walks its
// input once, dispatching on character codes, and emits HTML directly into
// chunk arrays — there is no inline token tree. Block structure is read
// line by line with a small container stack; paragraphs, headings and
// table cells keep their raw inline text until render time, so link
// reference definitions are honoured wherever they appear in the document.
//
// parse() is stateless: no caching or memoisation across calls, no file,
// clock or environment access, no lookup of case outputs.

const ASCII_PUNCT = new Uint8Array(128);
for (const ch of "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~") ASCII_PUNCT[ch.charCodeAt(0)] = 1;

const NONASCII_PUNCT = /[\p{P}\p{S}]/u;
const NONASCII_PUNCT_NOT_TILDE = /(?!~)[\p{P}\p{S}]/u;
const NONASCII_SPACE = /\s/u;

function isPunctCp(cp) {
  if (cp < 128) return ASCII_PUNCT[cp] === 1;
  return NONASCII_PUNCT.test(String.fromCodePoint(cp));
}

function isPunctCpNoTilde(cp) {
  if (cp === 126) return false;
  return isPunctCp(cp);
}

function isSpaceCp(cp) {
  if (cp < 128) return cp === 32 || (cp >= 9 && cp <= 13);
  return NONASCII_SPACE.test(String.fromCodePoint(cp));
}

// Code point of the character starting at i (handles surrogate pairs).
function cpAt(s, i) {
  const c = s.charCodeAt(i);
  if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
    const d = s.charCodeAt(i + 1);
    if (d >= 0xdc00 && d <= 0xdfff) return (c - 0xd800) * 0x400 + (d - 0xdc00) + 0x10000;
  }
  return c;
}

// Code point of the character ending at i (i is one past its end).
function cpBefore(s, i) {
  if (i >= 2) {
    const d = s.charCodeAt(i - 1);
    if (d >= 0xdc00 && d <= 0xdfff) {
      const c = s.charCodeAt(i - 2);
      if (c >= 0xd800 && c <= 0xdbff) return (c - 0xd800) * 0x400 + (d - 0xdc00) + 0x10000;
    }
  }
  return s.charCodeAt(i - 1);
}

function isWordChar(c) {
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95;
}

function isHexChar(c) {
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102);
}

// Is the '&' at i followed by a named-entity-like tail (&word;)?
function isEntityLike(s, i, n) {
  let j = i + 1;
  while (j < n && isWordChar(s.charCodeAt(j))) j++;
  return j > i + 1 && j < n && s.charCodeAt(j) === 59;
}

// Decode a numeric character reference starting at i ("&#...;" or
// "&#x...;"). Returns {cp, len} with the decoded code point, or null
// when the text at i is not a valid numeric reference.
function decodeNumeric(s, i, n) {
  let j = i + 2;
  let cp = -1;
  if (j < n && (s.charCodeAt(j) === 120 || s.charCodeAt(j) === 88)) {
    j++;
    const start = j;
    while (j < n && j - start < 6 && isHexChar(s.charCodeAt(j))) j++;
    if (j === start || j >= n || s.charCodeAt(j) !== 59) return null;
    cp = parseInt(s.slice(start, j), 16);
  } else {
    const start = j;
    while (j < n && j - start < 7) {
      const c = s.charCodeAt(j);
      if (c < 48 || c > 57) break;
      j++;
    }
    if (j === start || j >= n || s.charCodeAt(j) !== 59) return null;
    cp = parseInt(s.slice(start, j), 10);
  }
  if (cp === 0 || (cp >= 0xd800 && cp <= 0xdfff) || cp > 0x10ffff) cp = 0xfffd;
  return { cp, len: j + 1 - i };
}

// Escape a plain-text run the way marked escapes normal text: decode
// numeric character references, escape < > " ' always, and escape & only
// when it does not start an entity-like sequence. With encode=true (code
// spans/blocks, autolink href and text) every & < > " ' is escaped and no
// entity decoding happens.
function escapeText(s, encode) {
  // Fast path: no escapable char at all (indexOf is C-speed).
  if (s.indexOf("&") === -1 && s.indexOf("<") === -1 && s.indexOf(">") === -1 && s.indexOf('"') === -1 && s.indexOf("'") === -1) return s;
  const n = s.length;
  let out = "";
  let seg = 0;
  let dirty = false;
  let i = 0;
  while (i < n) {
    const c = s.charCodeAt(i);
    let rep = null;
    let adv = 1;
    if (c === 38) {
      if (!encode && i + 2 < n && s.charCodeAt(i + 1) === 35) {
        const d = decodeNumeric(s, i, n);
        if (d !== null) {
          if (d.cp === 38) rep = "&amp;";
          else if (d.cp === 60) rep = "&lt;";
          else if (d.cp === 62) rep = "&gt;";
          else if (d.cp === 34) rep = "&quot;";
          else if (d.cp === 39) rep = "&#39;";
          else rep = String.fromCodePoint(d.cp);
          adv = d.len;
        }
      }
      if (rep === null) {
        if (!encode && isEntityLike(s, i, n)) { i++; continue; }
        rep = "&amp;";
      }
    } else if (c === 60) rep = "&lt;";
    else if (c === 62) rep = "&gt;";
    else if (c === 34) rep = "&quot;";
    else if (c === 39) rep = "&#39;";
    else { i++; continue; }
    if (!dirty) { out = s.slice(0, i); dirty = true; }
    else out += s.slice(seg, i);
    out += rep;
    i += adv;
    seg = i;
  }
  if (!dirty) return s;
  return out + s.slice(seg);
}

// Decode numeric character references in a text run without escaping
// anything (plain-text rendering, as used for image alt text).
function decodeText(s) {
  if (s.indexOf("&#") === -1) return s;
  const n = s.length;
  let out = "";
  let seg = 0;
  let dirty = false;
  let i = 0;
  while (i < n) {
    if (s.charCodeAt(i) === 38 && i + 2 < n && s.charCodeAt(i + 1) === 35) {
      const d = decodeNumeric(s, i, n);
      if (d !== null) {
        if (!dirty) { out = s.slice(0, i); dirty = true; }
        else out += s.slice(seg, i);
        out += String.fromCodePoint(d.cp);
        i += d.len;
        seg = i;
        continue;
      }
    }
    i++;
  }
  if (!dirty) return s;
  return out + s.slice(seg);
}

// Render one backslash-escaped punctuation character (escaped form).
function escapeChar(c) {
  if (c === 38) return "&amp;";
  if (c === 60) return "&lt;";
  if (c === 62) return "&gt;";
  if (c === 34) return "&quot;";
  if (c === 39) return "&#39;";
  return String.fromCharCode(c);
}

function isAllSpaces(s) {
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) !== 32) return false;
  return true;
}

// Is there any non-whitespace character at or after `from`?
function hasMoreContent(src, from, n) {
  for (let i = from; i < n; i++) {
    const c = src.charCodeAt(i);
    if (c === 32 || c === 9 || c === 10 || c === 13 || c === 11 || c === 12) continue;
    if (c > 127 && isSpaceCp(cpAt(src, i))) continue;
    return true;
  }
  return false;
}
function escapeCode(s) {
  const n = s.length;
  let out = "";
  let seg = 0;
  let dirty = false;
  for (let i = 0; i < n; i++) {
    const c = s.charCodeAt(i);
    let rep = null;
    if (c === 38) rep = "&amp;";
    else if (c === 60) rep = "&lt;";
    else if (c === 62) rep = "&gt;";
    else if (c === 34) rep = "&quot;";
    else if (c === 39) rep = "&#39;";
    else continue;
    if (!dirty) { out = s.slice(0, i); dirty = true; }
    else out += s.slice(seg, i);
    out += rep;
    seg = i + 1;
  }
  if (!dirty) return s;
  return out + s.slice(seg);
}

// marked's cleanUrl: encodeURI, then restore %25 back to %. Returns null
// when encodeURI throws (lone surrogate), which drops the link/image tag.
function cleanUrl(href) {
  try {
    return encodeURI(href).replace(/%25/g, "%");
  } catch {
    return null;
  }
}

// Unescape backslash escapes. ASCII-only (inline text) vs Unicode
// punctuation/symbol (link destinations and titles).
function unescapeAscii(s) {
  if (s.indexOf("\\") === -1) return s;
  let out = "";
  let seg = 0;
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) === 92 && i + 1 < s.length && s.charCodeAt(i + 1) < 128 && ASCII_PUNCT[s.charCodeAt(i + 1)] === 1) {
      out += s.slice(seg, i) + s[i + 1];
      i++;
      seg = i + 1;
    }
  }
  return out + s.slice(seg);
}

function unescapeUnicode(s) {
  if (s.indexOf("\\") === -1) return s;
  let out = "";
  let seg = 0;
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) === 92 && i + 1 < s.length && isPunctCp(cpAt(s, i + 1))) {
      out += s.slice(seg, i);
      const cp = cpAt(s, i + 1);
      out += String.fromCodePoint(cp);
      i += cp > 0xffff ? 2 : 1;
      seg = i + 1;
    }
  }
  return out + s.slice(seg);
}

// Parenthesis balance of a bare link destination, skipping escaped
// parens: -1 balanced, -2 unbalanced opening paren left over, otherwise
// the index of the first unbalanced closing paren.
function parenBalance(s) {
  if (s.indexOf("(") === -1 && s.indexOf(")") === -1) return -1;
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 92) { i++; continue; }
    if (c === 40) depth++;
    else if (c === 41) { depth--; if (depth < 0) return i; }
  }
  return depth > 0 ? -2 : -1;
}

// Normalise a link label: trim, collapse whitespace runs to one space,
// fold case the way marked does (lower, upper, lower).
function normalizeLabel(label) {
  return label.trim().replace(/\s+/g, " ").toLowerCase().toUpperCase().toLowerCase();
}

// ---------- flanking ----------

function isAlnum(c) {
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
}

function isLetter(c) {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
}

function isDigit(c) {
  return c >= 48 && c <= 57;
}

function isSpaceChar(c) {
  if (c === 32 || (c >= 9 && c <= 13)) return true;
  if (c < 128) return false;
  return NONASCII_SPACE.test(String.fromCharCode(c));
}

// [leftFlanking, rightFlanking] for the delimiter run [start, end).
// The start and end of the text count as whitespace. When tilde is set,
// '~' itself is not punctuation.
function flanking(src, start, end, n, tilde) {
  let prevWs = true;
  let prevPunct = false;
  let prevExists = start > 0;
  let nextWs = true;
  let nextPunct = false;
  let nextExists = end < n;
  if (prevExists) {
    const cp = cpBefore(src, start);
    prevWs = isSpaceCp(cp);
    prevPunct = tilde ? isPunctCpNoTilde(cp) : isPunctCp(cp);
  }
  if (nextExists) {
    const cp = cpAt(src, end);
    nextWs = isSpaceCp(cp);
    nextPunct = tilde ? isPunctCpNoTilde(cp) : isPunctCp(cp);
  }
  const left = nextExists && !nextWs && (!nextPunct || !prevExists || prevWs || prevPunct);
  const right = prevExists && !prevWs && (!prevPunct || !nextExists || nextWs || nextPunct);
  return [left, right];
}

function isPunctBefore(src, i) {
  if (i <= 0) return false;
  return isPunctCp(cpBefore(src, i));
}

function isPunctAfter(src, i, n) {
  if (i >= n) return false;
  return isPunctCp(cpAt(src, i));
}

// ---------- autolinks (<...>) ----------

function isEmailLocalAutolink(c) {
  return isWordChar(c) || c === 46 || c === 33 || c === 35 || c === 36 || c === 37 || c === 38 ||
    c === 39 || c === 42 || c === 43 || c === 47 || c === 61 || c === 63 || c === 94 || c === 96 ||
    c === 123 || c === 124 || c === 125 || c === 126 || c === 45;
}

// Try an autolink at i (src[i] === '<'). Returns {end, href, text} or null.
function tryAutolink(src, i, n) {
  let j = i + 1;
  if (j < n) {
    const c0 = src.charCodeAt(j);
    if (isLetter(c0)) {
      let k = j + 1;
      let count = 1;
      while (k < n && count < 32) {
        const c = src.charCodeAt(k);
        if (isAlnum(c) || c === 43 || c === 45 || c === 46) { k++; count++; }
        else break;
      }
      if (count >= 2 && k < n && src.charCodeAt(k) === 58) {
        let m = k + 1;
        while (m < n) {
          const c = src.charCodeAt(m);
          if (c === 62) {
            const text = src.slice(i + 1, m);
            return { end: m + 1, href: text, text };
          }
          if (c <= 32 || c === 60) return null;
          if (c > 127 && isSpaceCp(cpAt(src, m))) return null;
          m++;
        }
        return null;
      }
    }
  }
  // email: local@domain, domain needs a dot
  j = i + 1;
  const localStart = j;
  while (j < n && isEmailLocalAutolink(src.charCodeAt(j))) j++;
  if (j === localStart || j >= n || src.charCodeAt(j) !== 64) return null;
  j++;
  let labels = 0;
  let lastEnd = -1;
  for (;;) {
    if (j >= n || !isAlnum(src.charCodeAt(j))) return null;
    let k = j + 1;
    while (k < n && k - j < 63) {
      const c = src.charCodeAt(k);
      if (isAlnum(c) || c === 45) k++;
      else break;
    }
    while (k > j + 1 && src.charCodeAt(k - 1) === 45) k--;
    labels++;
    lastEnd = k;
    j = k;
    if (j < n && src.charCodeAt(j) === 46) { j++; continue; }
    break;
  }
  if (labels < 2) return null;
  if (lastEnd < n && (src.charCodeAt(lastEnd) === 45 || src.charCodeAt(lastEnd) === 95)) return null;
  if (lastEnd >= n || src.charCodeAt(lastEnd) !== 62) return null;
  const text = src.slice(i + 1, lastEnd);
  return { end: lastEnd + 1, href: "mailto:" + text, text };
}

// ---------- inline HTML tags ----------

// Try an inline HTML tag at i (src[i] === '<').
// Returns {end, linkOpen, linkClose, rawOpen, rawClose} or null.
function tryTag(src, i, n) {
  if (i + 1 >= n) return null;
  const c1 = src.charCodeAt(i + 1);
  const noFlags = { linkOpen: false, linkClose: false, rawOpen: false, rawClose: false };
  if (c1 === 33) {
    // comment, CDATA or declaration
    if (i + 3 < n && src.charCodeAt(i + 2) === 45 && src.charCodeAt(i + 3) === 45) {
      if (i + 4 < n && src.charCodeAt(i + 4) === 62) return { end: i + 5, ...noFlags };
      if (i + 5 < n && src.charCodeAt(i + 4) === 45 && src.charCodeAt(i + 5) === 62) return { end: i + 6, ...noFlags };
      const end = src.indexOf("-->", i + 4);
      if (end === -1) return null;
      return { end: end + 3, ...noFlags };
    }
    if (src.startsWith("[CDATA[", i + 2)) {
      const end = src.indexOf("]]>", i + 9);
      if (end === -1) return null;
      return { end: end + 3, ...noFlags };
    }
    if (i + 2 < n && isLetter(src.charCodeAt(i + 2))) {
      let j = i + 3;
      while (j < n && isLetter(src.charCodeAt(j))) j++;
      if (j < n && isSpaceChar(src.charCodeAt(j))) {
        const end = src.indexOf(">", j);
        if (end === -1) return null;
        return { end: end + 1, ...noFlags };
      }
    }
    return null;
  }
  if (c1 === 63) {
    const end = src.indexOf("?>", i + 2);
    if (end === -1) return null;
    return { end: end + 2, ...noFlags };
  }
  if (c1 === 47) {
    // close tag: </name\s*>
    let j = i + 2;
    if (j >= n || !isLetter(src.charCodeAt(j))) return null;
    const nameStart = j;
    j++;
    while (j < n) {
      const c = src.charCodeAt(j);
      if (isLetter(c) || isDigit(c) || c === 45) j++;
      else break;
    }
    const name = src.slice(nameStart, j);
    const afterName = j;
    while (j < n && isSpaceChar(src.charCodeAt(j))) j++;
    if (j >= n || src.charCodeAt(j) !== 62) return null;
    const lower = name.toLowerCase();
    return {
      end: j + 1,
      linkOpen: false,
      linkClose: lower === "a" && src.charCodeAt(afterName) === 62,
      rawOpen: false,
      rawClose: lower === "pre" || lower === "code" || lower === "kbd" || lower === "script",
    };
  }
  // open tag: <name (attribute)* \s* /? >
  let j = i + 1;
  if (!isLetter(src.charCodeAt(j))) return null;
  const nameStart = j;
  j++;
  while (j < n) {
    const c = src.charCodeAt(j);
    if (isLetter(c) || isDigit(c) || c === 45) j++;
    else break;
  }
  const name = src.slice(nameStart, j);
  const afterName = j;
  for (;;) {
    let k = j;
    if (k >= n || !isSpaceChar(src.charCodeAt(k))) break;
    while (k < n && isSpaceChar(src.charCodeAt(k))) k++;
    if (k >= n) break;
    const ac = src.charCodeAt(k);
    if (!isLetter(ac) && ac !== 95 && ac !== 58) break;
    k++;
    while (k < n) {
      const c = src.charCodeAt(k);
      if (isWordChar(c) || c === 46 || c === 58 || c === 45) k++;
      else break;
    }
    let m = k;
    while (m < n && isSpaceChar(src.charCodeAt(m))) m++;
    if (m < n && src.charCodeAt(m) === 61) {
      m++;
      while (m < n && isSpaceChar(src.charCodeAt(m))) m++;
      if (m >= n) return null;
      const vc = src.charCodeAt(m);
      if (vc === 34) {
        const end = src.indexOf('"', m + 1);
        if (end === -1) return null;
        m = end + 1;
      } else if (vc === 39) {
        const end = src.indexOf("'", m + 1);
        if (end === -1) return null;
        m = end + 1;
      } else {
        if (isSpaceChar(vc) || vc === 34 || vc === 39 || vc === 61 || vc === 60 || vc === 62 || vc === 96) return null;
        while (m < n) {
          const c = src.charCodeAt(m);
          if (isSpaceChar(c) || c === 34 || c === 39 || c === 61 || c === 60 || c === 62 || c === 96) break;
          m++;
        }
      }
      k = m;
    }
    j = k;
  }
  while (j < n && isSpaceChar(src.charCodeAt(j))) j++;
  if (j < n && src.charCodeAt(j) === 47) j++;
  if (j >= n || src.charCodeAt(j) !== 62) return null;
  const lower = name.toLowerCase();
  const afterNameChar = afterName < n ? src.charCodeAt(afterName) : -1;
  return {
    end: j + 1,
    linkOpen: lower === "a" && afterNameChar === 32,
    linkClose: false,
    rawOpen: (lower === "pre" || lower === "code" || lower === "kbd" || lower === "script") &&
      (afterNameChar === 62 || (afterNameChar !== -1 && isSpaceChar(afterNameChar))),
    rawClose: false,
  };
}

// ---------- GFM extended autolinks ----------

const BACKPEDAL_PUNCT = new Uint8Array(128);
for (const ch of "?!.,:;*_'\"~)") BACKPEDAL_PUNCT[ch.charCodeAt(0)] = 1;

// One backpedal pass over a raw autolink match: trims trailing
// punctuation, unbalanced parens and a trailing &entity; tail.
function backpedalOnce(u) {
  const n = u.length;
  let i = 0;
  let lastGood = 0;
  while (i < n) {
    const c = u.charCodeAt(i);
    if (c < 128 && BACKPEDAL_PUNCT[c] === 1) {
      let j = i;
      while (j < n && u.charCodeAt(j) < 128 && BACKPEDAL_PUNCT[u.charCodeAt(j)] === 1) j++;
      if (j === n) break;
      i = j;
      lastGood = j;
      continue;
    }
    if (c === 40) {
      const close = u.indexOf(")", i + 1);
      if (close === -1) break;
      i = close + 1;
      lastGood = i;
      continue;
    }
    if (c === 38) {
      let j = i + 1;
      while (j < n && isAlnum(u.charCodeAt(j))) j++;
      if (j > i + 1 && j < n && u.charCodeAt(j) === 59 && j + 1 === n) break;
      i++;
      lastGood = i;
      continue;
    }
    while (i < n) {
      const d = u.charCodeAt(i);
      if (d === 40 || d === 38) break;
      if (d < 128 && BACKPEDAL_PUNCT[d] === 1) break;
      i++;
    }
    lastGood = i;
  }
  return u.slice(0, lastGood);
}

function backpedal(u) {
  let prev = u;
  for (;;) {
    const next = backpedalOnce(prev);
    if (next === prev) return next;
    prev = next;
  }
}

// Domain labels + path of a scheme/www autolink, starting at j.
// Returns the end index, or -1 when no label follows. When
// stopAtBracket is set, the path scan stops at the first ']' (a ']' that
// may close an active '[' opener must not be swallowed by the autolink,
// or the link would never form).
function scanUrlTail(src, j, n, stopAtBracket) {
  let labels = 0;
  while (j < n) {
    const c = src.charCodeAt(j);
    if (!isAlnum(c) && c !== 45) break;
    while (j < n) {
      const d = src.charCodeAt(j);
      if (isAlnum(d) || d === 45) j++;
      else break;
    }
    labels++;
    if (j < n && src.charCodeAt(j) === 46) { j++; continue; }
    break;
  }
  if (labels === 0) return -1;
  while (j < n) {
    const c = src.charCodeAt(j);
    if (c === 60 || isSpaceChar(c)) break;
    if (stopAtBracket && c === 93) break;
    j++;
  }
  return j;
}

// www. autolink at i. Returns {end, text} or null.
function scanWww(src, i, n, stopAtBracket) {
  const tail = scanUrlTail(src, i + 4, n, stopAtBracket);
  if (tail === -1) return null;
  const text = backpedal(src.slice(i, tail));
  if (text.length === 0) return null;
  return { end: i + text.length, text };
}

// http://, https:// or ftp:// autolink at i (case-insensitive scheme).
// Returns {end, text} or null.
function scanScheme(src, i, n, stopAtBracket) {
  let j = i;
  let schemeLen = 0;
  const c0 = src.charCodeAt(j) | 32;
  if (c0 === 104) {
    // http / https
    if (j + 3 >= n) return null;
    if ((src.charCodeAt(j + 1) | 32) !== 116) return null;
    if ((src.charCodeAt(j + 2) | 32) !== 116) return null;
    if ((src.charCodeAt(j + 3) | 32) !== 112) return null;
    schemeLen = 4;
    if (j + 4 < n && (src.charCodeAt(j + 4) | 32) === 115) schemeLen = 5;
  } else if (c0 === 102) {
    if (j + 2 >= n) return null;
    if ((src.charCodeAt(j + 1) | 32) !== 116) return null;
    if ((src.charCodeAt(j + 2) | 32) !== 112) return null;
    schemeLen = 3;
  } else return null;
  j += schemeLen;
  if (j + 2 >= n || src.charCodeAt(j) !== 58 || src.charCodeAt(j + 1) !== 47 || src.charCodeAt(j + 2) !== 47) return null;
  const tail = scanUrlTail(src, j + 3, n, stopAtBracket);
  if (tail === -1) return null;
  const text = backpedal(src.slice(i, tail));
  if (text.length === 0) return null;
  return { end: i + text.length, text };
}

// Extended-autolink email starting at i (local-part start).
// Returns the end index or -1.
function scanEmail(src, i, n) {
  let j = i;
  while (j < n) {
    const c = src.charCodeAt(j);
    if (isWordChar(c) || c === 46 || c === 43 || c === 45) j++;
    else break;
  }
  if (j === i || j >= n || src.charCodeAt(j) !== 64) return -1;
  j++;
  if (j >= n) return -1;
  let c = src.charCodeAt(j);
  if (!isAlnum(c) && c !== 45 && c !== 95) return -1;
  while (j < n) {
    c = src.charCodeAt(j);
    if (isAlnum(c) || c === 45 || c === 95) j++;
    else break;
  }
  let groups = 0;
  while (j < n && src.charCodeAt(j) === 46) {
    let k = j + 1;
    while (k < n) {
      const d = src.charCodeAt(k);
      if (isAlnum(d) || d === 45 || d === 95) k++;
      else break;
    }
    let e = k;
    while (e > j + 1 && (src.charCodeAt(e - 1) === 45 || src.charCodeAt(e - 1) === 95)) e--;
    if (e === j + 1) break;
    j = e;
    groups++;
  }
  if (groups === 0) return -1;
  if (j < n) {
    const d = src.charCodeAt(j);
    if (d === 95) {
      // A trailing '_' is fine when it closes an emphasis span that
      // started before the email: marked lexes the emphasis first and
      // the url tokenizer then sees the email without the closer.
      // Without an opener before the email, the '_' kills the match.
      let k = i - 1, foundOpener = false;
      while (k >= 0) {
        const c = src.charCodeAt(k);
        if (c === 10 || c === 91 || c === 93 || c === 96 || c === 60) break;
        if (c === 95) { foundOpener = true; break; }
        k--;
      }
      if (!foundOpener) return -1;
    } else if (isWordChar(d) || d === 45) return -1;
  }
  return j;
}

// mailto: or xmpp: autolink at i. Returns {end, text} or null.
function scanMailto(src, i, n) {
  const c0 = src.charCodeAt(i) | 32;
  let j;
  let xmpp = false;
  if (c0 === 109) {
    if (i + 6 >= n) return null;
    if (src.slice(i, i + 7).toLowerCase() !== "mailto:") return null;
    j = i + 7;
  } else if (c0 === 120) {
    if (i + 4 >= n) return null;
    if (src.slice(i, i + 5).toLowerCase() !== "xmpp:") return null;
    j = i + 5;
    xmpp = true;
  } else return null;
  const end = scanEmail(src, j, n);
  if (end === -1) return null;
  let tail = end;
  if (xmpp && tail < n && src.charCodeAt(tail) === 47) {
    let k = tail + 1;
    while (k < n) {
      const c = src.charCodeAt(k);
      if (isAlnum(c) || c === 64 || c === 46) k++;
      else break;
    }
    if (k > tail + 1) tail = k;
  }
  return { end: tail, text: src.slice(i, tail) };
}

// Pre-scan: all bare-email ranges in the inline text, in order.
function findEmails(src) {
  const out = [];
  const n = src.length;
  let at = src.indexOf("@");
  while (at !== -1) {
    let start = at;
    while (start > 0) {
      const c = src.charCodeAt(start - 1);
      if (isWordChar(c) || c === 46 || c === 43 || c === 45) start--;
      else break;
    }
    if (start < at) {
      const end = scanEmail(src, start, n);
      if (end !== -1) {
        out.push({ start, end });
        at = src.indexOf("@", end);
        continue;
      }
    }
    at = src.indexOf("@", at + 1);
  }
  return out;
}

// Pre-scan: "phantom code span" ranges for emphasis masking. Marked
// masks emphasis delimiters using a two-pass mask: first it replaces
// backticks inside code spans with '+', then it masks links, code spans
// and HTML tags. When a link's label holds an UNPAIRED backtick run
// (e.g. `` ``url` ``), the masker pairs it with the next same-length
// backtick run AFTER the link and masks everything in between -- so
// emphasis delimiters between the link and that later run are
// suppressed. Returns sorted [start, end] ranges (start = just after
// the link's ']', end = the matching backtick run).
function findPhantomSpans(src) {
  const spans = [];
  const n = src.length;
  let i = 0;
  while (i < n) {
    if (src.charCodeAt(i) !== 91) { i++; continue; } // '['
    let depth = 1, j = i + 1;
    while (j < n && depth > 0) {
      const c = src.charCodeAt(j);
      if (c === 91) depth++;
      else if (c === 93) depth--;
      else if (c === 92) j++;
      j++;
    }
    if (depth !== 0) { i++; continue; }
    const closePos = j - 1;
    if (closePos + 1 >= n || src.charCodeAt(closePos + 1) !== 40) { i++; continue; } // '('
    // Inline-link candidate: find unpaired backtick runs in the label.
    const labelStart = i + 1, labelEnd = closePos;
    let s = labelStart;
    while (s < labelEnd) {
      if (src.charCodeAt(s) !== 96) { s++; continue; }
      let runEnd = s;
      while (runEnd < labelEnd && src.charCodeAt(runEnd) === 96) runEnd++;
      const runLen = runEnd - s;
      // Pair with the next same-length run in the label (a code span);
      // a paired run's closer is consumed, not a phantom opener itself.
      let pairedEnd = -1, k = runEnd;
      while (k < labelEnd) {
        if (src.charCodeAt(k) === 96) {
          let m = k;
          while (m < labelEnd && src.charCodeAt(m) === 96) m++;
          if (m - k === runLen) { pairedEnd = m; break; }
          k = m;
        } else k++;
      }
      if (pairedEnd !== -1) { s = pairedEnd; continue; }
      // Phantom opener: find the next same-length run after the link.
      let p = closePos + 1;
      while (p < n) {
        if (src.charCodeAt(p) === 96) {
          let q = p;
          while (q < n && src.charCodeAt(q) === 96) q++;
          if (q - p === runLen) { spans.push([closePos + 1, p]); break; }
          p = q;
        } else p++;
      }
      s = runEnd;
    }
    i++;
  }
  return spans;
}

// ---------- inline parser ----------

// Parse inline Markdown. In HTML mode returns HTML; in text mode
// (textMode true) returns plain text, as used for image alt attributes.
// doc is the document state {refs: Map, inLink: boolean}; inLink is
// shared across inline parses of one document, refs likewise.
function inlineToHtml(src, doc, textMode) {
  const n = src.length;
  if (n === 0) return "";
  const state = textMode ? { inLink: false } : doc;
  const chunks = [];
  const delims = [];
  const openers = [];
  const brackets = [];
  const holders = [];
  const linkRanges = [];
  const emails = findEmails(src);
  // Phantom spans need both a '[' and a backtick; skip the scan otherwise.
  const phantomSpans = (textMode || src.indexOf("[") === -1 || src.indexOf("`") === -1) ? [] : findPhantomSpans(src);
  let phantomIdx = 0;
  let emailIdx = 0;
  let inRaw = false;
  let linkSeq = 0;
  let textStart = 0;

  // Is position p inside a phantom code span (emphasis suppressed)?
  function inPhantomSpan(p) {
    while (phantomIdx < phantomSpans.length && phantomSpans[phantomIdx][1] <= p) phantomIdx++;
    return phantomIdx < phantomSpans.length && p >= phantomSpans[phantomIdx][0] && p < phantomSpans[phantomIdx][1];
  }

  // Is any '[' opener still active? Used to stop extended-autolink
  // paths at ']' so a link's closing bracket is not swallowed.
  function hasActiveOpener() {
    for (let oi = openers.length - 1; oi >= 0; oi--) {
      if (openers[oi].active) return true;
    }
    return false;
  }

  function flushText(upto) {
    if (textStart < upto) {
      const t = src.slice(textStart, upto);
      chunks.push(inRaw ? t : (textMode ? decodeText(t) : escapeText(t)));
    }
    textStart = upto;
  }

  // Parse a link title at pos (at ", ' or (). Returns {title, end} or null.
  function parseTitle(pos) {
    const q = src.charCodeAt(pos);
    if (q === 40) {
      let m = pos + 1;
      while (m < n) {
        const c = src.charCodeAt(m);
        if (c === 41) return { title: unescapeUnicode(src.slice(pos + 1, m)), end: m + 1 };
        if (c === 92) { m += 2; continue; }
        m++;
      }
      return null;
    }
    let m = pos + 1;
    while (m < n) {
      const c = src.charCodeAt(m);
      if (c === q) return { title: unescapeUnicode(src.slice(pos + 1, m)), end: m + 1 };
      if (c === 92) { m += 2; continue; }
      m++;
    }
    return null;
  }

  // Parse an inline link destination at j (at '(').
  // Returns {dest, title, end} or null.
  function parseInlineDest(j) {
    let k = j + 1;
    while (k < n) {
      const c = src.charCodeAt(k);
      if (c === 32 || c === 9 || c === 10) k++;
      else break;
    }
    if (k >= n) return null;
    let dest;
    if (src.charCodeAt(k) === 60) {
      let m = k + 1;
      const start = m;
      let closed = false;
      while (m < n) {
        const c = src.charCodeAt(m);
        if (c === 62) { closed = true; break; }
        if (c === 10 || c === 60) return null;
        if (c === 92) { m += 2; continue; }
        m++;
      }
      if (!closed) return null;
      dest = unescapeUnicode(src.slice(start, m));
      k = m + 1;
    } else if (src.charCodeAt(k) === 41) {
      dest = "";
    } else {
      let m = k;
      while (m < n) {
        const c = src.charCodeAt(m);
        if (c === 32 || c === 9 || c === 10 || c <= 31) break;
        m++;
      }
      if (m === k) return null;
      let rawDest = src.slice(k, m);
      const bal = parenBalance(rawDest);
      if (bal === -2) return null;
      if (bal > -1) {
        rawDest = rawDest.slice(0, bal);
        m = k + bal;
        if (m >= n || src.charCodeAt(m) !== 41) return null;
        return { dest: unescapeUnicode(rawDest), title: null, end: m + 1 };
      }
      dest = unescapeUnicode(rawDest);
      k = m;
    }
    // optional title: separator then a quoted/paren title
    let sepEnd = -1;
    {
      let s = k;
      if (s < n && (src.charCodeAt(s) === 32 || src.charCodeAt(s) === 9)) {
        while (s < n && (src.charCodeAt(s) === 32 || src.charCodeAt(s) === 9)) s++;
        if (s < n && src.charCodeAt(s) === 10) {
          s++;
          while (s < n && (src.charCodeAt(s) === 32 || src.charCodeAt(s) === 9)) s++;
        }
        sepEnd = s;
      } else if (s < n && src.charCodeAt(s) === 10) {
        s++;
        while (s < n && (src.charCodeAt(s) === 32 || src.charCodeAt(s) === 9)) s++;
        sepEnd = s;
      }
    }
    if (sepEnd !== -1 && sepEnd < n) {
      const tc = src.charCodeAt(sepEnd);
      if (tc === 34 || tc === 39 || tc === 40) {
        const tp = parseTitle(sepEnd);
        if (tp) {
          let e = tp.end;
          while (e < n) {
            const c = src.charCodeAt(e);
            if (c === 32 || c === 9 || c === 10) e++;
            else break;
          }
          if (e < n && src.charCodeAt(e) === 41) return { dest, title: tp.title, end: e + 1 };
          return null;
        }
      }
    }
    let e = k;
    while (e < n) {
      const c = src.charCodeAt(e);
      if (c === 32 || c === 9 || c === 10) e++;
      else break;
    }
    if (e < n && src.charCodeAt(e) === 41) return { dest, title: null, end: e + 1 };
    return null;
  }

  // Find the closing ']' of a reference label starting at j (at '[').
  // Returns its index, or -1.
  function findRefLabel(j) {
    let m = j + 1;
    let hasNonWs = false;
    while (m < n) {
      const c = src.charCodeAt(m);
      if (c === 93) return hasNonWs ? m : -1;
      if (c === 91) return -1;
      if (c === 92) {
        if (m + 1 >= n) return -1;
        hasNonWs = true;
        m += 2;
        continue;
      }
      if (c === 10) {
        let k = m + 1;
        while (k < n && (src.charCodeAt(k) === 32 || src.charCodeAt(k) === 9)) k++;
        if (k < n && src.charCodeAt(k) === 10) return -1;
        m++;
        continue;
      }
      if (c !== 32 && c !== 9) hasNonWs = true;
      m++;
    }
    return -1;
  }

  // Does a shortcut/collapsed label match the reference-label shape?
  function validRefLabel(label) {
    if (label.length === 0) return false;
    let hasNonWs = false;
    for (let i = 0; i < label.length; i++) {
      const c = label.charCodeAt(i);
      if (c === 92) { i++; hasNonWs = true; continue; }
      if (c === 91 || c === 93) return false;
      if (c === 10) {
        let k = i + 1;
        while (k < label.length && (label.charCodeAt(k) === 32 || label.charCodeAt(k) === 9)) k++;
        if (k < label.length && label.charCodeAt(k) === 10) return false;
        continue;
      }
      if (c !== 32 && c !== 9) hasNonWs = true;
    }
    return hasNonWs;
  }

  // Are the brackets strictly between startPos and endPos balanced?
  function bracketsBalanced(startPos, endPos) {
    let hi = brackets.length - 1;
    while (hi >= 0 && brackets[hi].pos >= endPos) hi--;
    let lo = hi;
    while (lo >= 0 && brackets[lo].pos > startPos) lo--;
    lo++;
    let depth = 0;
    for (let i = lo; i <= hi; i++) {
      if (brackets[i].open) depth++;
      else {
        depth--;
        if (depth < 0) return false;
      }
    }
    return depth === 0;
  }

  // Does the link text [textStart, textEnd) contain a <...> construct
  // that is not closed before closePos? (marked's Be check.)
  function hasUnclosedTag(textStart, textEnd, closePos) {
    for (let s = textStart; s < textEnd; s++) {
      const c = src.charCodeAt(s);
      if (c === 92) { s++; continue; }
      if (c === 96) {
        let j = s;
        while (j < textEnd && src.charCodeAt(j) === 96) j++;
        const len = j - s;
        let k = j;
        let found = -1;
        while (k < textEnd) {
          const bt = src.indexOf("`", k);
          if (bt === -1 || bt >= textEnd) break;
          let m = bt;
          while (m < textEnd && src.charCodeAt(m) === 96) m++;
          if (m - bt === len && m <= textEnd) { found = bt; break; }
          k = m;
        }
        if (found !== -1) { s = found + len - 1; continue; }
        continue;
      }
      if (c !== 60) continue;
      const tag = tryTag(src, s, n) || tryAutolink(src, s, n);
      if (tag && tag.end > closePos) return true;
      if (tag) s = tag.end - 1;
    }
    return false;
  }

  // Validate a link label's backticks per marked's label regex: backticks
  // are allowed only inside a loose code span (backtick run, non-backtick
  // content, backtick run -- lengths need not match) or as a run of 2+
  // immediately before the closing ']'. An unmatched backtick run makes
  // the whole label unmatchable, so no inline/full-ref link forms.
  function validLabelBackticks(textStart, textEnd) {
    let s = textStart;
    while (s < textEnd) {
      const c = src.charCodeAt(s);
      if (c === 92) { s += 2; continue; }
      if (c !== 96) { s++; continue; }
      let j = s;
      while (j < textEnd && src.charCodeAt(j) === 96) j++;
      // A 2+ run at the very end of the label is allowed.
      if (j - s >= 2 && j === textEnd) return true;
      // Otherwise look for a loose code span: non-backtick content then
      // another backtick run.
      let k = j;
      let hasContent = false;
      while (k < textEnd && src.charCodeAt(k) !== 96) { k++; hasContent = true; }
      if (hasContent && k < textEnd) {
        let m = k;
        while (m < textEnd && src.charCodeAt(m) === 96) m++;
        s = m;
        continue;
      }
      return false;
    }
    return true;
  }

  // Would the label be valid after marked's emphasis masking? Marked
  // masks backticks inside code spans with '+' before checking links
  // for its blockSkip mask, so a label with a code span containing a
  // stray backtick (e.g. `` a ` b ``) looks like a valid link to the
  // masker even though the real link regex rejects it. When that
  // happens the whole link is masked and emphasis inside it is
  // suppressed. A label is masked-valid when every backtick run pairs
  // with a later same-length run (content starting and ending with a
  // non-backtick char, closer not followed by a backtick).
  function maskedValidLabel(textStart, textEnd) {
    let s = textStart;
    while (s < textEnd) {
      const c = src.charCodeAt(s);
      if (c === 92) { s += 2; continue; }
      if (c !== 96) { s++; continue; }
      let j = s;
      while (j < textEnd && src.charCodeAt(j) === 96) j++;
      const runLen = j - s;
      let k = j, found = -1;
      while (k < textEnd) {
        if (src.charCodeAt(k) === 96) {
          let m = k;
          while (m < textEnd && src.charCodeAt(m) === 96) m++;
          if (m - k === runLen && (m >= textEnd || src.charCodeAt(m) !== 96) &&
              k > j && src.charCodeAt(j) !== 96 && src.charCodeAt(k - 1) !== 96) {
            found = m;
            break;
          }
          k = m;
        } else k++;
      }
      if (found === -1) return false;
      s = found;
    }
    return true;
  }

  // Attempt to form a link or image ending at the ']' at closePos.
  // Returns the position just past the link syntax, or -1.
  function tryLink(closePos, closeChunk) {
    for (let oi = openers.length - 1; oi >= 0; oi--) {
      const op = openers[oi];
      if (!op.active) continue;
      if (!bracketsBalanced(op.pos, closePos)) continue;
      const textStart = op.pos + 1;
      const textEnd = closePos;
      if (hasUnclosedTag(textStart, textEnd, closePos)) continue;
      const labelOk = validLabelBackticks(textStart, textEnd);
      const j = closePos + 1;
      let dest = null;
      let title = null;
      let endPos = -1;
      let resolved = false;
      if (j < n && src.charCodeAt(j) === 40) {
        const parsed = parseInlineDest(j);
        if (parsed && labelOk) {
          dest = parsed.dest;
          title = parsed.title;
          endPos = parsed.end;
          resolved = true;
        } else if (parsed && !labelOk && maskedValidLabel(textStart, textEnd)) {
          // The link does not form (label backticks invalid), but the
          // emphasis masker sees a valid link here and hides the whole
          // label from the emphasis tokenizer: kill delimiters inside.
          for (let di = delims.length - 1; di >= 0; di--) {
            if (delims[di].pos > op.pos && delims[di].pos < closePos) {
              delims[di].canOpen = false;
              delims[di].canClose = false;
              delims[di].dead = true;
            } else if (delims[di].pos <= op.pos) break;
          }
        }
      } else if (j < n && src.charCodeAt(j) === 91) {
        const refEnd = findRefLabel(j);
        if (refEnd !== -1 && labelOk) {
          const ref = doc.refs.get(normalizeLabel(src.slice(j + 1, refEnd)));
          if (ref) {
            dest = ref.href;
            title = ref.title;
            endPos = refEnd + 1;
            resolved = true;
          } else {
            // reference parses but has no definition: no shortcut fallback
            continue;
          }
        }
      }
      if (!resolved) {
        // shortcut or collapsed reference
        const label = src.slice(textStart, textEnd);
        if (!validRefLabel(label)) continue;
        const ref = doc.refs.get(normalizeLabel(label));
        if (!ref) continue;
        dest = ref.href;
        title = ref.title;
        if (j + 1 < n && src.charCodeAt(j) === 91 && src.charCodeAt(j + 1) === 93) {
          endPos = j + 2;
        } else {
          endPos = closePos + 1;
        }
      }
      // form the link or image
      linkSeq++;
      if (op.image) {
        const alt = inlineToHtml(src.slice(textStart, textEnd), doc, true);
        if (textMode) {
          chunks[op.chunk] = alt;
        } else {
          const cleaned = cleanUrl(dest);
          if (cleaned === null) {
            chunks[op.chunk] = escapeText(alt);
          } else {
            let img = '<img src="' + escapeText(cleaned) + '" alt="' + escapeText(alt) + '"';
            if (title) img += ' title="' + escapeText(title) + '"';
            img += ">";
            chunks[op.chunk] = img;
          }
        }
        if (op.bangChunk >= 0) chunks[op.bangChunk] = "";
        chunks[closeChunk] = "";
        for (let ci = op.chunk + 1; ci < closeChunk; ci++) chunks[ci] = "";
        for (let di = delims.length - 1; di >= 0; di--) {
          if (delims[di].chunk > op.chunk && delims[di].chunk < closeChunk) {
            delims[di].canOpen = false;
            delims[di].canClose = false;
            delims[di].dead = true;
          } else if (delims[di].chunk <= op.chunk) break;
        }
        for (let hi = holders.length - 1; hi >= 0; hi--) {
          if (holders[hi].chunk > op.chunk && holders[hi].chunk < closeChunk) holders[hi].dead = true;
          else if (holders[hi].chunk <= op.chunk) break;
        }
        for (let oi2 = openers.length - 1; oi2 >= 0; oi2--) {
          if (openers[oi2].chunk > op.chunk && openers[oi2].chunk < closeChunk) openers[oi2].active = false;
          else if (openers[oi2].chunk <= op.chunk) break;
        }
        op.active = false;
      } else {
        if (textMode) {
          chunks[op.chunk] = "";
          chunks[closeChunk] = "";
        } else {
          const cleaned = cleanUrl(dest);
          if (cleaned === null) {
            chunks[op.chunk] = "";
            chunks[closeChunk] = "";
          } else {
            let a = '<a href="' + escapeText(cleaned) + '"';
            if (title) a += ' title="' + escapeText(title) + '"';
            a += ">";
            chunks[op.chunk] = a;
            chunks[closeChunk] = "</a>";
          }
        }
        for (let di = delims.length - 1; di >= 0; di--) {
          if (delims[di].chunk > op.chunk && delims[di].chunk < closeChunk) delims[di].linkId = linkSeq;
          else if (delims[di].chunk <= op.chunk) break;
        }
        linkRanges.push([textStart, textEnd]);
        // A formed link deactivates earlier '[' openers -- but not image
        // openers, which may still form an image around the link.
        for (let oi2 = 0; oi2 < oi; oi2++) if (!openers[oi2].image) openers[oi2].active = false;
        op.active = false;
      }
      return endPos;
    }
    return -1;
  }

  // Resolve emphasis/delimiter runs (CommonMark Appendix A).
  function resolveEmphasis() {
    for (let ci = 0; ci < delims.length; ci++) {
      const closer = delims[ci];
      if (!closer.canClose || closer.dead) continue;
      while (closer.len > 0) {
        let found = -1;
        for (let oi = ci - 1; oi >= 0; oi--) {
          const opener = delims[oi];
          if (opener.dead || opener.ch !== closer.ch || !opener.canOpen || opener.len === 0) continue;
          if (opener.linkId !== closer.linkId) continue;
          const oddMatch = (opener.canClose || closer.canOpen) &&
            ((opener.len + closer.len) % 3 === 0) &&
            (opener.len % 3 !== 0 || closer.len % 3 !== 0);
          if (oddMatch) continue;
          // Marked's pool rule: a single-* opener cannot close over a
          // strong span whose opening ** follows a space/punct (so the
          // scan adds it to the pool) and whose closing ** is attached
          // to following text (so rule of 3 skips that closer).
          const use0 = (opener.len >= 2 && closer.len >= 2) ? 2 : 1;
          // Mirror: a ** closer must not be stolen by a single-* opener
          // when an earlier ** opener's pool survives to this closer
          // (marked processes the ** opener first and it claims the
          // closer for a <strong>).
          if (use0 === 1 && opener.orig === 1 && opener.len === 1 && closer.orig === 2 && closer.len >= 2 && opener.ch === "*") {
            let earlierStrong = -1;
            for (let di = oi - 1; di >= 0; di--) {
              const d = delims[di];
              if (d.dead || d.ch !== "*" || d.linkId !== opener.linkId) continue;
              if (d.orig === 2 && d.len === 2 && d.canOpen) { earlierStrong = di; break; }
            }
            if (earlierStrong !== -1) {
              let pool = 2, skipped = 0;
              for (let di = earlierStrong + 1; di < ci; di++) {
                const d = delims[di];
                if (d.dead || d.ch !== "*") continue;
                if (d.linkId !== opener.linkId) continue;
                const both = d.canOpen && d.canClose;
                if (!both && d.canOpen) { pool += d.orig; continue; }
                if (!both && d.canClose) { pool -= d.orig; continue; }
                if (both) {
                  if ((2 % 3 !== 0) && ((2 + d.orig) % 3 === 0)) { skipped += d.orig; continue; }
                  pool -= d.orig;
                }
              }
              pool -= 2;
              const effB = Math.min(2, 2 + pool + skipped);
              if (effB === 2) continue;
            }
          }
          // A ** opener prefers a later ** closer when its pool survives:
          // marked scans the ** opener left-to-right with a pool (openers
          // add, closers subtract, rule of 3 skips group-6 closers). If
          // the pool still holds >= 2 when a later ** closer is reached,
          // the opener forms <strong> with it, and a single-* closer in
          // between must NOT steal one delimiter from the opener.
          if (use0 === 1 && opener.orig === 2 && opener.len === 2 && closer.orig === 1 && opener.ch === "*") {
            let laterStrong = -1;
            for (let di = ci + 1; di < delims.length; di++) {
              const d = delims[di];
              if (d.dead || d.ch !== "*" || d.linkId !== opener.linkId) continue;
              if (d.orig === 2 && d.len >= 2 && d.canClose) { laterStrong = di; break; }
              if (d.canClose && d.orig >= 1 && d.pos > closer.pos && d.len > 0 && d.openTags === "" && d.closeTags === "") {
                // A closer that already formed a span does not block; an
                // unmatched closer before the ** closer still counts in
                // the pool, so keep scanning.
              }
            }
            if (laterStrong !== -1) {
              let pool = 2, skipped = 0;
              for (let di = oi + 1; di < laterStrong; di++) {
                const d = delims[di];
                if (d.dead || d.ch !== "*") continue;
                if (d.linkId !== opener.linkId) continue;
                // Use orig lengths: marked's pool scan runs before any
                // inner span is formed, so consumed delimiters count too.
                const both = d.canOpen && d.canClose;
                if (!both && d.canOpen) { pool += d.orig; continue; }
                if (!both && d.canClose) { pool -= d.orig; continue; }
                if (both) {
                  // Group 5/6 closer: rule of 3 skips it when the opener
                  // length is not divisible by 3 but the sum is.
                  if ((2 % 3 !== 0) && ((2 + d.orig) % 3 === 0)) { skipped += d.orig; continue; }
                  pool -= d.orig;
                }
              }
              pool -= 2;
              const effB = Math.min(2, 2 + pool + skipped);
              if (effB === 2) continue;
            }
          }
          if (use0 === 1 && opener.orig === 1 && closer.orig === 1 && opener.ch === "*") {
            let hasPoolOpener = false, hasAttachedCloser = false;
            for (let di = oi + 1; di < ci; di++) {
              const d = delims[di];
              if (d.orig !== 2 || d.ch !== "*") continue;
              if (d.openTags.includes("<strong>")) {
                const before = d.pos - 1;
                if (before < 0) hasPoolOpener = true;
                else {
                  const bc = src.charCodeAt(before);
                  if (isSpaceChar(bc) || isPunctCp(src.codePointAt(before))) hasPoolOpener = true;
                }
              }
              if (d.closeTags.includes("</strong>")) {
                const after = d.pos + d.orig;
                if (after < n) {
                  const ac = src.charCodeAt(after);
                  if (!isSpaceChar(ac) && !isPunctCp(src.codePointAt(after))) hasAttachedCloser = true;
                }
              }
            }
            if (hasPoolOpener && hasAttachedCloser) continue;
          }
          found = oi;
          break;
        }
        if (found === -1) break;
        const opener = delims[found];
        const use = (opener.len >= 2 && closer.len >= 2) ? 2 : 1;
        opener.len -= use;
        closer.len -= use;
        // Record how many delimiters marked's pool would consume from
        // this closer into the span (b = min(orig, orig + pool +
        // skipped)). Only needed when the closer keeps a leftover: if
        // the last match consumed the whole run (b == orig), the
        // leftover sits INSIDE the span (before the close tag).
        if (!textMode && closer.len > 0 && (closer.ch === "*" || closer.ch === "_")) {
          const oLen = opener.orig;
          let pool = oLen, skipped = 0;
          for (let di = found + 1; di < ci; di++) {
            const d = delims[di];
            if (d.dead || d.ch !== closer.ch || d.linkId !== opener.linkId) continue;
            const both = d.canOpen && d.canClose;
            if (!both && d.canOpen) { pool += d.orig; continue; }
            if (!both && d.canClose) { pool -= d.orig; continue; }
            if (both) {
              if ((oLen % 3 !== 0) && ((oLen + d.orig) % 3 === 0)) { skipped += d.orig; continue; }
              pool -= d.orig;
            }
          }
          pool -= closer.orig;
          closer.lastB = Math.min(closer.orig, closer.orig + pool + skipped);
        }
        if (!textMode) {
          const tag = closer.ch === "~" ? "del" : (use === 2 ? "strong" : "em");
          opener.openTags = "<" + tag + ">" + opener.openTags;
          closer.closeTags = closer.closeTags + "</" + tag + ">";
        }
        // Delimiters strictly inside the formed span can no longer match
        // anything outside it (marked lexes the span's content on its own).
        // Only clear their canOpen/canClose: their tags (if any) still render.
        for (let di = found + 1; di < ci; di++) {
          if (delims[di].len > 0) {
            delims[di].canOpen = false;
            delims[di].canClose = false;
          }
        }
      }
    }
    for (const d of delims) {
      if (d.dead) continue;
      if (d.len === d.orig && d.openTags === "" && d.closeTags === "") continue;
      if (d.len > 0 && d.closeTags !== "" && d.lastB === d.orig && d.openTags === "") {
        // Leftover inside the span: the last match consumed the whole
        // closer run into the span's raw text.
        chunks[d.chunk] = d.ch.repeat(d.len) + d.closeTags;
      } else {
        chunks[d.chunk] = d.closeTags + d.ch.repeat(d.len) + d.openTags;
      }
    }
  }

  let i = 0;
  const hasEmails = emails.length > 0;
  while (i < n) {
    if (hasEmails) {
      while (emailIdx < emails.length && emails[emailIdx].start < i) emailIdx++;
      if (emailIdx < emails.length && emails[emailIdx].start === i) {
        const e = emails[emailIdx];
        emailIdx++;
        if (!state.inLink) {
          flushText(i);
          chunks.push("");
          holders.push({ chunk: chunks.length - 1, start: e.start, end: e.end, href: "mailto:" + src.slice(e.start, e.end), text: src.slice(e.start, e.end), dead: false });
          i = e.end;
          textStart = i;
          continue;
        }
      }
    }
    const c = src.charCodeAt(i);
    switch (c) {
      case 92: { // backslash
        if (i + 1 < n) {
          const d = src.charCodeAt(i + 1);
          if (d === 10) {
            if (hasMoreContent(src, i + 2, n)) {
              flushText(i);
              if (!textMode) chunks.push("<br>");
              i += 2;
              while (i < n && (src.charCodeAt(i) === 32 || src.charCodeAt(i) === 9)) i++;
              textStart = i;
              continue;
            }
            i++;
            continue;
          }
          if (d < 128 && ASCII_PUNCT[d] === 1) {
            flushText(i);
            chunks.push(textMode ? String.fromCharCode(d) : escapeChar(d));
            i += 2;
            textStart = i;
            continue;
          }
        }
        i++;
        continue;
      }
      case 10: { // newline: hard break on 2+ trailing spaces
        let j = i - 1;
        let spaces = 0;
        while (j >= textStart && src.charCodeAt(j) === 32) { spaces++; j--; }
        if (spaces >= 2 && hasMoreContent(src, i + 1, n)) {
          flushText(i - spaces);
          if (!textMode) chunks.push("<br>");
          i++;
          while (i < n && (src.charCodeAt(i) === 32 || src.charCodeAt(i) === 9)) i++;
          textStart = i;
          continue;
        }
        i++;
        continue;
      }
      case 96: { // backtick
        let j = i;
        while (j < n && src.charCodeAt(j) === 96) j++;
        const len = j - i;
        // When a '[' opener is active and the label up to the next ']'
        // is valid (backticks paired), the link will form, so the code
        // span's closer must be inside the label -- it must not swallow
        // the ']'. When the label is invalid the link cannot form and
        // the span may cross the ']' (cm-342).
        let searchEnd = n;
        if (openers.length > 0 && hasActiveOpener()) {
          const br = src.indexOf("]", j);
          if (br !== -1) {
            let opPos = -1;
            for (let oi = openers.length - 1; oi >= 0; oi--) {
              if (openers[oi].active) { opPos = openers[oi].pos; break; }
            }
            if (opPos !== -1 && validLabelBackticks(opPos + 1, br)) searchEnd = br;
          }
        }
        let k = j;
        let found = -1;
        while (k < searchEnd) {
          const bt = src.indexOf("`", k);
          if (bt === -1 || bt >= searchEnd) break;
          let m = bt;
          while (m < n && src.charCodeAt(m) === 96) m++;
          if (m - bt === len) { found = bt; break; }
          k = m;
        }
        if (found === -1) { i = j; continue; }
        flushText(i);
        let content = src.slice(j, found);
        if (content.indexOf("\n") !== -1) content = content.replace(/\n/g, " ");
        if (content.length >= 2 && content.charCodeAt(0) === 32 && content.charCodeAt(content.length - 1) === 32 && !isAllSpaces(content)) {
          content = content.slice(1, -1);
        }
        chunks.push(textMode ? content : "<code>" + escapeCode(content) + "</code>");
        i = found + len;
        textStart = i;
        continue;
      }
      case 42:
      case 95: { // * _
        let j = i;
        while (j < n && src.charCodeAt(j) === c) j++;
        const len = j - i;
        if (inPhantomSpan(i)) { i = j; continue; }
        flushText(i);
        const [lf, rf] = flanking(src, i, j, n, false);
        let open = lf;
        let close = rf;
        if (c === 95) {
          const prevPunct = isPunctBefore(src, i);
          const nextPunct = isPunctAfter(src, j, n);
          open = lf && (!rf || prevPunct);
          close = rf && (!lf || nextPunct);
        }
        chunks.push(src.slice(i, j));
        delims.push({ ch: c === 42 ? "*" : "_", len, orig: len, pos: i, canOpen: open, canClose: close, chunk: chunks.length - 1, linkId: 0, openTags: "", closeTags: "", dead: false, lastB: 0 });
        i = j;
        textStart = i;
        continue;
      }
      case 126: { // ~
        let j = i;
        while (j < n && src.charCodeAt(j) === 126) j++;
        const len = j - i;
        if (len >= 3) { i = j; continue; }
        if (inPhantomSpan(i)) { i = j; continue; }
        flushText(i);
        const [lf, rf] = flanking(src, i, j, n, true);
        chunks.push(src.slice(i, j));
        delims.push({ ch: "~", len, orig: len, canOpen: lf, canClose: rf, chunk: chunks.length - 1, linkId: 0, openTags: "", closeTags: "", dead: false });
        i = j;
        textStart = i;
        continue;
      }
      case 33: { // !
        if (i + 1 < n && src.charCodeAt(i + 1) === 91) {
          flushText(i);
          chunks.push("!");
          const bang = chunks.length - 1;
          chunks.push("[");
          openers.push({ pos: i + 1, chunk: chunks.length - 1, image: true, bangChunk: bang, active: true });
          brackets.push({ pos: i + 1, open: true });
          i += 2;
          textStart = i;
          continue;
        }
        i++;
        continue;
      }
      case 91: { // [
        flushText(i);
        chunks.push("[");
        openers.push({ pos: i, chunk: chunks.length - 1, image: false, bangChunk: -1, active: true });
        brackets.push({ pos: i, open: true });
        i++;
        textStart = i;
        continue;
      }
      case 93: { // ]
        flushText(i);
        chunks.push("]");
        const closeChunk = chunks.length - 1;
        brackets.push({ pos: i, open: false });
        const endPos = tryLink(i, closeChunk);
        if (endPos !== -1) {
          i = endPos;
          textStart = endPos;
          continue;
        }
        i++;
        textStart = i;
        continue;
      }
      case 60: { // <
        const al = tryAutolink(src, i, n);
        if (al) {
          flushText(i);
          if (textMode) {
            chunks.push(al.text);
          } else {
            const cleaned = cleanUrl(al.href);
            if (cleaned === null) chunks.push(escapeCode(al.text));
            else chunks.push('<a href="' + escapeCode(cleaned) + '">' + escapeCode(al.text) + "</a>");
          }
          i = al.end;
          textStart = i;
          continue;
        }
        const tag = tryTag(src, i, n);
        if (tag) {
          flushText(i);
          chunks.push(src.slice(i, tag.end));
          if (tag.linkOpen) state.inLink = true;
          else if (tag.linkClose) state.inLink = false;
          if (tag.rawOpen) inRaw = true;
          else if (tag.rawClose) inRaw = false;
          i = tag.end;
          textStart = i;
          continue;
        }
        i++;
        continue;
      }
      case 119: { // w (lowercase only: Www. is not an autolink in marked)
        if (!state.inLink && i + 3 < n && src.charCodeAt(i + 1) === 119 && src.charCodeAt(i + 2) === 119 && src.charCodeAt(i + 3) === 46) {
          let ok = false;
          if (i === 0) ok = true;
          else {
            const p = src.charCodeAt(i - 1);
            ok = p === 32 || p === 9 || p === 10 || p === 11 || p === 12 || p === 13 || p === 42 || p === 95 || p === 126 || p === 40;
            if (!ok && p > 127) ok = isSpaceCp(cpBefore(src, i));
          }
          if (ok) {
            const stopB = openers.length > 0 && hasActiveOpener();
            const u = scanWww(src, i, n, stopB);
            if (u) {
              flushText(i);
              chunks.push("");
              holders.push({ chunk: chunks.length - 1, start: i, end: u.end, href: "http://" + u.text, text: u.text, dead: false });
              i = u.end;
              textStart = i;
              continue;
            }
          }
        }
        i++;
        continue;
      }
      case 104:
      case 72:
      case 102:
      case 70: { // h, H, f, F
        if (!state.inLink) {
          const stopB = openers.length > 0 && hasActiveOpener();
          const u = scanScheme(src, i, n, stopB);
          if (u) {
            flushText(i);
            chunks.push("");
            holders.push({ chunk: chunks.length - 1, start: i, end: u.end, href: u.text, text: u.text, dead: false });
            i = u.end;
            textStart = i;
            continue;
          }
        }
        i++;
        continue;
      }
      case 109:
      case 77:
      case 120:
      case 88: { // m, M, x, X
        if (!state.inLink) {
          const u = scanMailto(src, i, n);
          if (u) {
            flushText(i);
            chunks.push("");
            holders.push({ chunk: chunks.length - 1, start: i, end: u.end, href: u.text, text: u.text, dead: false });
            i = u.end;
            textStart = i;
            continue;
          }
        }
        i++;
        continue;
      }
      default:
        i++;
        continue;
    }
  }
  flushText(n);
  resolveEmphasis();
  for (const h of holders) {
    if (h.dead) continue;
    if (textMode) {
      chunks[h.chunk] = h.text;
      continue;
    }
    let inside = false;
    for (let r = 0; r < linkRanges.length; r++) {
      if (h.start >= linkRanges[r][0] && h.end <= linkRanges[r][1]) { inside = true; break; }
    }
    if (inside) {
      chunks[h.chunk] = escapeText(h.text);
    } else {
      const cleaned = cleanUrl(h.href);
      if (cleaned === null) chunks[h.chunk] = escapeCode(h.text);
      else chunks[h.chunk] = '<a href="' + escapeCode(cleaned) + '">' + escapeCode(h.text) + "</a>";
    }
  }
  return chunks.join("");
}

// ============================================================================
// Block parsing (chunk 4a): line helpers, blockquotes, ATX, fences, hr,
// indented code. Blocks are collected into a small tree first (inline text is
// stored raw); rendering happens afterwards, once every link reference
// definition in the document has been seen.
// ============================================================================

const BLOCK_TAGS = new Set(
  "address article aside base basefont blockquote body caption center col colgroup dd details dialog dir div dl dt fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hr html iframe legend li link main menu menuitem meta nav noframes ol optgroup option p param search section summary table tbody td tfoot th thead title tr track ul".split(" ")
);

// Build the array of line-start offsets for src. A trailing newline does not
// create an extra empty line; an empty source has no lines at all.
function buildLineStarts(src) {
  const len = src.length;
  if (len === 0) return [];
  const starts = [0];
  for (let i = 0; i < len; i++) {
    if (src.charCodeAt(i) === 10 && i + 1 < len) starts.push(i + 1);
  }
  return starts;
}

// First non-space/tab character of a line: returns its column and index.
// Tabs advance to the next multiple of 4. If the line is blank, idx === end
// and col is the column at end.
function lineIndent(src, ls, le) {
  let col = 0, i = ls;
  while (i < le) {
    const c = src.charCodeAt(i);
    if (c === 32) { col++; i++; }
    else if (c === 9) { col += 4 - (col & 3); i++; }
    else break;
  }
  return { col, idx: i };
}

function isBlankLine(src, ls, le) {
  for (let i = ls; i < le; i++) {
    const c = src.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

// Strip up to n columns of indent from a line, returning the content as a
// string. Leading tabs are expanded to spaces first (marked expands tabs
// with J before slicing), so a tab straddling the boundary contributes its
// full expanded width. Used for list item content.
function stripIndentText(src, ls, le, n) {
  let i = ls, col = 0, hasTab = false;
  while (i < le) {
    const c = src.charCodeAt(i);
    if (c === 32) { col++; i++; }
    else if (c === 9) { hasTab = true; col += 4 - (col & 3); i++; }
    else break;
  }
  if (i >= le) return "";
  if (!hasTab) {
    const strip = Math.min(n, col);
    return src.slice(ls + strip, le);
  }
  let expanded = "";
  let c2 = 0, j = ls;
  while (j < i) {
    const ch = src.charCodeAt(j);
    if (ch === 32) { expanded += " "; c2++; }
    else { const w = 4 - (c2 & 3); expanded += " ".repeat(w); c2 += w; }
    j++;
  }
  const rest = expanded.length >= n ? expanded.slice(n) : "";
  return rest + src.slice(i, le);
}

// Remove an indented code block's indent from a line, exactly like marked's
// codeRemoveIndent: 0-3 spaces plus a tab, or 1-4 spaces. Tabs are NOT
// expanded here; a second tab survives as a literal tab.
function stripCodeIndent(src, ls, le) {
  let i = ls, spaces = 0;
  while (i < le && spaces < 3 && src.charCodeAt(i) === 32) { spaces++; i++; }
  if (i < le && src.charCodeAt(i) === 9) return i + 1;
  let j = ls, count = 0;
  while (j < le && count < 4 && src.charCodeAt(j) === 32) { count++; j++; }
  return j;
}

// Does the line (at ls..le) start a blockquote? Returns the content start
// index and leading-space pad, or null. The marker is up to 3 spaces/tabs of
// indent (column <= 3), then '>', then the following whitespace is expanded
// (tabs to spaces) and one space is dropped, like marked's marker handling.
function quoteMarker(src, ls, le) {
  const { col, idx } = lineIndent(src, ls, le);
  if (col > 3 || idx >= le || src.charCodeAt(idx) !== 62) return null; // '>'
  let cidx = idx + 1, pad = 0;
  const wstart = cidx;
  while (cidx < le) {
    const c = src.charCodeAt(cidx);
    if (c !== 32 && c !== 9) break;
    cidx++;
  }
  if (cidx > wstart) {
    let ecol = col + 1, spaces = 0;
    for (let k = wstart; k < cidx; k++) {
      const c = src.charCodeAt(k);
      if (c === 32) { spaces++; ecol++; }
      else { const w = 4 - (ecol & 3); spaces += w; ecol += w; }
    }
    pad = spaces - 1;
    if (pad < 0) pad = 0;
  }
  return { idx: cidx, pad };
}

// ATX heading: 1-6 '#' after at most 3 spaces of indent, followed by a
// space/tab or end of line. Returns {level, textStart, textEnd} or null.
function atxHeading(src, ls, le) {
  const { col, idx } = lineIndent(src, ls, le);
  if (col > 3) return null;
  let i = idx, level = 0;
  while (i < le && src.charCodeAt(i) === 35 && level < 7) { level++; i++; }
  if (level === 0 || level > 6) return null;
  if (i < le) {
    const c = src.charCodeAt(i);
    if (c !== 32 && c !== 9) return null;
  }
  // Text: trim leading/trailing whitespace, then strip a trailing closing
  // sequence (trailing '#'s) only when what remains is empty or ends with a
  // space/tab.
  let ts = i, te = le;
  while (ts < te && src.charCodeAt(ts) <= 32) ts++;
  while (te > ts && src.charCodeAt(te - 1) <= 32) te--;
  if (te > ts && src.charCodeAt(te - 1) === 35) {
    let e = te;
    while (e > ts && src.charCodeAt(e - 1) === 35) e--;
    if (e === ts || src.charCodeAt(e - 1) === 32 || src.charCodeAt(e - 1) === 9) {
      te = e;
      while (te > ts && src.charCodeAt(te - 1) <= 32) te--;
    }
  }
  return { level, ts, te };
}

// Thematic break: 3+ of the same '-', '*', '_' char, spaces/tabs between,
// at most 3 spaces of indent, nothing else on the line.
function hrLine(src, ls, le) {
  const { col, idx } = lineIndent(src, ls, le);
  if (col > 3 || idx >= le) return false;
  const ch = src.charCodeAt(idx);
  if (ch !== 45 && ch !== 42 && ch !== 95) return false;
  let count = 0;
  for (let i = idx; i < le; i++) {
    const c = src.charCodeAt(i);
    if (c === ch) count++;
    else if (c !== 32 && c !== 9) return false;
  }
  return count >= 3;
}

// Fence start: 3+ backticks or 3+ tildes after at most 3 spaces of indent.
// Returns {char, len, infoStart, infoEnd} or null. A backtick fence's info
// string may not contain a backtick.
function fenceStart(src, ls, le) {
  const { col, idx } = lineIndent(src, ls, le);
  if (col > 3 || idx >= le) return null;
  const ch = src.charCodeAt(idx);
  if (ch !== 96 && ch !== 126) return null;
  let i = idx, len = 0;
  while (i < le && src.charCodeAt(i) === ch) { len++; i++; }
  if (len < 3) return null;
  let is = i, ie = le;
  while (is < ie) {
    const c = src.charCodeAt(is);
    if (c !== 32 && c !== 9) break;
    is++;
  }
  while (ie > is) {
    const c = src.charCodeAt(ie - 1);
    if (c !== 32 && c !== 9) break;
    ie--;
  }
  if (ch === 96) {
    for (let j = is; j < ie; j++) if (src.charCodeAt(j) === 96) return null;
  }
  return { ch, len, is, ie };
}

// Setext underline: '=' or '-' run (one kind only, CONTIGUOUS), at most 3
// spaces of indent, trailing spaces/tabs allowed after the run. Returns 1
// for '=', 2 for '-', 0 no. ('= =' is not an underline; '--- -' is not.)
function setextLevel(src, ls, le) {
  const { col, idx } = lineIndent(src, ls, le);
  if (col > 3 || idx >= le) return 0;
  const ch = src.charCodeAt(idx);
  if (ch !== 61 && ch !== 45) return 0;
  let i = idx;
  while (i < le && src.charCodeAt(i) === ch) i++;
  while (i < le) {
    const c = src.charCodeAt(i);
    if (c !== 32 && c !== 9) return 0;
    i++;
  }
  return ch === 61 ? 1 : 2;
}

// List marker at a line start (indent column <= 3). Returns
// {ordered, delim, num, markerEnd, contentCol} or null. markerEnd is the
// index just after the marker; contentCol is the column where the item's
// content indent begins (marker + following spaces, capped: 5+ spaces count
// as 1). The marker must be followed by a space/tab or end of line.
function listMarker(src, ls, le) {
  const { col, idx } = lineIndent(src, ls, le);
  if (col > 3 || idx >= le) return null;
  const c = src.charCodeAt(idx);
  let ordered = false, delim = 0, num = 0, mend = idx;
  if (c === 45 || c === 43 || c === 42) {
    delim = c;
    mend = idx + 1;
  } else if (c >= 48 && c <= 57) {
    let i = idx, digits = 0;
    num = 0;
    while (i < le && src.charCodeAt(i) >= 48 && src.charCodeAt(i) <= 57 && digits < 10) {
      num = num * 10 + (src.charCodeAt(i) - 48);
      digits++;
      i++;
    }
    if (digits === 0 || digits > 9) return null;
    if (i >= le) return null;
    const d = src.charCodeAt(i);
    if (d !== 46 && d !== 41) return null;
    delim = d;
    ordered = true;
    mend = i + 1;
  } else return null;
  // Marker must be followed by a space/tab or end of line.
  if (mend < le) {
    const c2 = src.charCodeAt(mend);
    if (c2 !== 32 && c2 !== 9) return null;
  }
  // Content indent: marker column width + following spaces (tab-expanded),
  // capped at marker+1 when 5 or more spaces follow. When capped, the extra
  // spaces stay part of the content (pad = spaces kept before the content).
  const markerCol = col + (mend - idx);
  let j = mend, wcol = markerCol, spaces = 0;
  while (j < le) {
    const cc = src.charCodeAt(j);
    if (cc === 32) { wcol++; spaces++; j++; }
    else if (cc === 9) { const w = 4 - (wcol & 3); wcol += w; spaces += w; j++; }
    else break;
  }
  const empty = j >= le;
  let contentCol, pad = 0;
  if (empty) contentCol = markerCol + 1;
  else if (spaces > 4) { contentCol = markerCol + 1; pad = spaces - 1; }
  else contentCol = wcol;
  return { ordered, delim, num, mend, contentCol, empty, firstContent: j, pad };
}

// A list marker that can interrupt a paragraph: any bullet, or an ordered
// marker starting with 1, followed by space/tab and non-space content.
function listInterrupt(src, ls, le) {
  const m = listMarker(src, ls, le);
  if (!m) return false;
  if (m.empty) return false;
  if (!m.ordered) return true;
  // Ordered: only exactly "1." / "1)" interrupts ("10." does not).
  return m.num === 1;
}

// ---------- HTML blocks ----------

// Case-insensitive match of a word at src[pos..]. Non-letter characters
// in the word must match exactly.
function matchWordCI(src, pos, word) {
  for (let i = 0; i < word.length; i++) {
    const c = src.charCodeAt(pos + i);
    const w = word.charCodeAt(i);
    if (c === w) continue;
    if (w >= 65 && w <= 90 && c === w + 32) continue;
    if (w >= 97 && w <= 122 && c === w - 32) continue;
    return false;
  }
  return true;
}

// HTML block start type (1-7) for a line, or 0. The line must start with '<'
// after at most 3 columns of indent. Types 1-6 can interrupt a paragraph;
// type 7 cannot (checked by the caller).
function htmlBlockType(src, ls, le) {
  const { col, idx } = lineIndent(src, ls, le);
  if (col > 3 || idx >= le || src.charCodeAt(idx) !== 60) return 0; // '<'
  const p = idx + 1;
  if (p >= le) return 0;
  const c1 = src.charCodeAt(p);
  // Type 2: <!-- ; type 3: <? ; type 4: <! + letter ; type 5: <![CDATA[
  if (c1 === 33) { // '!'
    if (p + 1 < le && src.charCodeAt(p + 1) === 45 && p + 2 < le && src.charCodeAt(p + 2) === 45) return 2;
    if (p + 1 < le && src.charCodeAt(p + 1) === 91) {
      // <![CDATA[ (case-insensitive)
      if (matchWordCI(src, p + 2, "CDATA[") ) return 5;
      return 0;
    }
    if (p + 1 < le) {
      const d = src.charCodeAt(p + 1);
      if ((d >= 65 && d <= 90) || (d >= 97 && d <= 122)) return 4;
    }
    return 0;
  }
  if (c1 === 63) return 3; // '?'
  // Type 1 / 6 / 7: a tag name.
  let np = p, closing = false;
  if (c1 === 47) { closing = true; np = p + 1; }
  if (np >= le) return 0;
  const nc = src.charCodeAt(np);
  if (!((nc >= 65 && nc <= 90) || (nc >= 97 && nc <= 122))) return 0;
  let ne = np;
  while (ne < le) {
    const cc = src.charCodeAt(ne);
    if (!((cc >= 65 && cc <= 90) || (cc >= 97 && cc <= 122) || (cc >= 48 && cc <= 57) || cc === 45)) break;
    ne++;
  }
  const name = src.slice(np, ne).toLowerCase();
  if (!closing) {
    // Type 1: script/pre/style/textarea followed by whitespace, '>', or EOL.
    if (name === "script" || name === "pre" || name === "style" || name === "textarea") {
      if (ne >= le) return 1;
      const ac = src.charCodeAt(ne);
      if (ac === 32 || ac === 9 || ac === 62) return 1;
      return 0;
    }
  }
  // Type 6: block tag followed by space/tab, EOL, '/>' or '>'.
  if (BLOCK_TAGS.has(name)) {
    if (ne >= le) return 6;
    const ac = src.charCodeAt(ne);
    if (ac === 32 || ac === 9 || ac === 62) return 6;
    if (ac === 47 && ne + 1 < le && src.charCodeAt(ne + 1) === 62) return 6;
    return 0;
  }
  if (closing) {
    // Type 7 close tag: </name\s*> alone on the line.
    let j = ne;
    while (j < le) {
      const cc = src.charCodeAt(j);
      if (cc !== 32 && cc !== 9) break;
      j++;
    }
    if (j >= le || src.charCodeAt(j) !== 62) return 0;
    j++;
    while (j < le) {
      const cc = src.charCodeAt(j);
      if (cc !== 32 && cc !== 9) return 0;
      j++;
    }
    return 7;
  }
  // Type 7 open tag: <name (attr)* */?> alone on the line. Attributes use
  // spaces only (no tabs) between name and value.
  if (name === "script" || name === "pre" || name === "style" || name === "textarea") return 0;
  let j = ne;
  while (j < le) {
    const cc = src.charCodeAt(j);
    if (cc === 62) { // '>'
      j++;
      while (j < le) {
        const c2 = src.charCodeAt(j);
        if (c2 !== 32 && c2 !== 9) return 0;
        j++;
      }
      return 7;
    }
    if (cc === 47 && j + 1 < le && src.charCodeAt(j + 1) === 62) {
      j += 2;
      while (j < le) {
        const c2 = src.charCodeAt(j);
        if (c2 !== 32 && c2 !== 9) return 0;
        j++;
      }
      return 7;
    }
    if (cc !== 32) return 0;
    // Attribute: spaces + name + optional = value.
    while (j < le && src.charCodeAt(j) === 32) j++;
    if (j >= le) return 0;
    const ac = src.charCodeAt(j);
    if (!((ac >= 65 && ac <= 90) || (ac >= 97 && ac <= 122) || ac === 58 || ac === 95)) return 0;
    j++;
    while (j < le) {
      const c2 = src.charCodeAt(j);
      if (!((c2 >= 65 && c2 <= 90) || (c2 >= 97 && c2 <= 122) || (c2 >= 48 && c2 <= 57) || c2 === 58 || c2 === 95 || c2 === 46 || c2 === 45)) break;
      j++;
    }
    // Optional = value (spaces around '=').
    let k = j;
    while (k < le && src.charCodeAt(k) === 32) k++;
    if (k < le && src.charCodeAt(k) === 61) { // '='
      k++;
      while (k < le && src.charCodeAt(k) === 32) k++;
      if (k >= le) return 0;
      const q = src.charCodeAt(k);
      if (q === 34 || q === 39) {
        k++;
        while (k < le && src.charCodeAt(k) !== q) k++;
        if (k >= le) return 0;
        k++;
      } else {
        let n = 0;
        while (k < le) {
          const c2 = src.charCodeAt(k);
          if (c2 === 32 || c2 === 9 || c2 === 34 || c2 === 39 || c2 === 61 || c2 === 60 || c2 === 62 || c2 === 96) break;
          k++; n++;
        }
        if (n === 0) return 0;
      }
      j = k;
    } else j = k;
  }
  return 0;
}

// Does this line interrupt a paragraph as an HTML block? Only types 1-6,
// with the paragraph pattern's stricter rules: script/pre/style/textarea and
// CDATA are case-sensitive, and a block tag needs a SPACE (not a tab) after
// its name (or EOL / '/>' / '>').
function htmlInterrupt(src, ls, le) {
  const { col, idx } = lineIndent(src, ls, le);
  if (col > 3 || idx >= le || src.charCodeAt(idx) !== 60) return false;
  const p = idx + 1;
  if (p >= le) return false;
  const c1 = src.charCodeAt(p);
  if (c1 === 33) {
    if (p + 1 < le && src.charCodeAt(p + 1) === 45 && p + 2 < le && src.charCodeAt(p + 2) === 45) return true; // <!--
    if (p + 1 < le && src.charCodeAt(p + 1) === 91) {
      return src.slice(p + 2, p + 8) === "CDATA["; // case-sensitive
    }
    if (p + 1 < le) {
      const d = src.charCodeAt(p + 1);
      if ((d >= 65 && d <= 90) || (d >= 97 && d <= 122)) return true; // <! + letter
    }
    return false;
  }
  if (c1 === 63) return true; // <?
  let np = p, closing = false;
  if (c1 === 47) { closing = true; np = p + 1; }
  if (np >= le) return false;
  const nc = src.charCodeAt(np);
  if (!((nc >= 65 && nc <= 90) || (nc >= 97 && nc <= 122))) return false;
  let ne = np;
  while (ne < le) {
    const cc = src.charCodeAt(ne);
    if (!((cc >= 65 && cc <= 90) || (cc >= 97 && cc <= 122) || (cc >= 48 && cc <= 57) || cc === 45)) break;
    ne++;
  }
  const name = src.slice(np, ne); // case-sensitive here
  if (!closing) {
    if (name === "script" || name === "pre" || name === "style" || name === "textarea") {
      if (ne >= le) return true;
      const ac = src.charCodeAt(ne);
      return ac === 32 || ac === 9 || ac === 62;
    }
  }
  if (BLOCK_TAGS.has(name.toLowerCase())) {
    if (ne >= le) return true;
    const ac = src.charCodeAt(ne);
    if (ac === 32 || ac === 62) return true;
    if (ac === 47 && ne + 1 < le && src.charCodeAt(ne + 1) === 62) return true;
    return false;
  }
  return false;
}

// Find the end line of an HTML block of the given type, starting at line i.
// Returns the index of the last line belonging to the block.
function htmlBlockEnd(src, starts, i, type, tagName) {
  const n = starts.length;
  if (type === 6 || type === 7) {
    let j = i;
    while (j < n) {
      const ls = starts[j], le = j + 1 < n ? starts[j + 1] - 1 : src.length;
      if (isBlankLine(src, ls, le)) break;
      j++;
    }
    return j - 1;
  }
  // Types 1-5: scan for the closing construct.
  let needle, closeName = null;
  if (type === 1) closeName = tagName;
  else if (type === 2) needle = "-->";
  else if (type === 3) needle = "?>";
  else if (type === 4) needle = ">";
  else needle = "]]>";
  const startPos = starts[i];
  let found = -1;
  if (closeName !== null) {
    // Case-insensitive search for "</name>": scan "</" occurrences.
    let at = startPos;
    for (;;) {
      const lt = src.indexOf("</", at);
      if (lt === -1) break;
      let ok = true;
      for (let k = 0; k < closeName.length; k++) {
        const c = src.charCodeAt(lt + 2 + k);
        const w = closeName.charCodeAt(k);
        if (c !== w && c !== w - 32 && c !== w + 32) { ok = false; break; }
      }
      if (ok && src.charCodeAt(lt + 2 + closeName.length) === 62) { found = lt; break; }
      at = lt + 2;
    }
  } else {
    found = src.indexOf(needle, startPos);
  }
  if (found === -1) return n - 1;
  // The line containing the found position.
  let lo = i, hi = n - 1, ans = i;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (starts[mid] <= found) { ans = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  return ans;
}

// ---------- block dispatch helpers ----------

function lineEnd(src, starts, i) {
  if (i + 1 < starts.length) return starts[i + 1] - 1;
  // Last line: exclude a trailing newline.
  const len = src.length;
  return len > 0 && src.charCodeAt(len - 1) === 10 ? len - 1 : len;
}

// Would this line start a new block (for paragraph continuation / laziness)?
// Setext underlines, table delimiters and link definitions are NOT block
// starts here: they continue a paragraph.
// Is this line the start of a block that ends a paragraph? top=true at the
// document level and inside blockquotes (only "1." ordered markers
// interrupt); top=false inside list items, where marked lexes line by line
// and ANY list marker starts a new list.
function isBlockStart(src, ls, le, top = true) {
  const { col, idx } = lineIndent(src, ls, le);
  if (col > 3 || idx >= le) return false;
  const c0 = src.charCodeAt(idx);
  if (c0 === 62) return true; // '>' blockquote
  if (c0 === 35) return atxHeading(src, ls, le) !== null;
  if (c0 === 96 || c0 === 126) return fenceStart(src, ls, le) !== null;
  if (c0 === 45 || c0 === 42 || c0 === 95) {
    if (hrLine(src, ls, le)) return true;
    // Not an hr: fall through to the list check ('-' and '*' can be markers).
  }
  if (c0 === 60) return htmlInterrupt(src, ls, le);
  if (c0 === 43 || c0 === 42 || c0 === 45 || (c0 >= 48 && c0 <= 57)) {
    if (!top) {
      // Any non-empty list marker starts a new list inside a list item.
      const m = listMarker(src, ls, le);
      return m !== null && !m.empty;
    }
    return listInterrupt(src, ls, le);
  }
  return false;
}

// Does a plain text line look like a setext underline (for quote chunks)?
function isSetextText(t) {
  let i = 0;
  while (i < t.length && t.charCodeAt(i) === 32 && i < 3) i++;
  if (i >= t.length) return false;
  const ch = t.charCodeAt(i);
  if (ch !== 61 && ch !== 45) return false;
  while (i < t.length && t.charCodeAt(i) === ch) i++;
  while (i < t.length) {
    const c = t.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
    i++;
  }
  return true;
}

// Find the innermost paragraph of a block (descending through blockquotes
// and lists), or null when the innermost leaf is not a paragraph. Used to
// absorb lazy lines into a nested container's paragraph.
function innermostPara(b) {
  let cur = b;
  for (;;) {
    if (cur.t === 0) return cur;
    if (cur.t === 6) {
      if (cur.kids.length === 0) return null;
      cur = cur.kids[cur.kids.length - 1];
      continue;
    }
    if (cur.t === 7) {
      if (cur.items.length === 0) return null;
      const it = cur.items[cur.items.length - 1];
      if (it.kids.length === 0) return null;
      cur = it.kids[it.kids.length - 1];
      continue;
    }
    return null;
  }
}

// Merge a freshly parsed chunk's blocks into the container's block list.
// Only the FIRST block of the chunk can merge with the previous chunk's last
// block (blocks within one chunk are already separated by blank lines).
// canMerge is false when the previous chunk ended with a blank line (the
// paragraph was closed). A paragraph following a paragraph merges into one;
// indented code following a paragraph merges its text in; a paragraph after
// a quote or list is absorbed into that container's innermost paragraph;
// a quote following a quote merges recursively.
function mergeChunkBlocks(kids, chunk, canMerge) {
  // Whether any block of this chunk was pushed as new (breaking the
  // merge chain): container merges after the first block are only valid
  // when every earlier block of the chunk was absorbed into the previous
  // container (e.g. a lazy paragraph merged into a quote's paragraph,
  // leaving a quote later in the chunk that continues the same quote).
  let pushed = false;
  for (let bi = 0; bi < chunk.length; bi++) {
    const b = chunk[bi];
    const last = kids.length ? kids[kids.length - 1] : null;
    if (canMerge && last && (bi === 0 || !pushed)) {
      if (last.t === 6 && b.t === 6) {
        mergeChunkBlocks(last.kids, b.kids, true);
        continue;
      }
      if (last.t === 7 && b.t === 7 && last.ordered === b.ordered && last.start === b.start) {
        for (const it of b.items) last.items.push(it);
        if (b.loose) last.loose = true;
        continue;
      }
    }
    if (bi === 0 && canMerge && last) {
      if (last.t === 0 && b.t === 0) {
        last.text += "\n" + b.text;
        continue;
      }
      if (last.t === 0 && b.t === 2) {
        last.text += "\n" + b.text;
        continue;
      }
      if ((last.t === 6 || last.t === 7) && b.t === 0) {
        const inner = innermostPara(last);
        if (inner) {
          inner.text += "\n" + b.text;
          continue;
        }
      }
    }
    kids.push(b);
    pushed = true;
  }
}

// ---------- blockquotes ----------

function collectQuote(src, starts, i, defs) {
  const n = starts.length;
  const kids = [];
  let j = i;
  let canMerge = true;
  for (;;) {
    // One chunk: lazy lines (before any quote line) + quote lines, ending
    // at the first lazy line after a quote line has been seen.
    const chunkLines = [];
    let sawQuote = false;
    while (j < n) {
      const ls = starts[j], le = lineEnd(src, starts, j);
      const qm = quoteMarker(src, ls, le);
      if (qm) {
        chunkLines.push({ text: (qm.pad ? " ".repeat(qm.pad) : "") + src.slice(qm.idx, le), lazy: false });
        sawQuote = true;
        j++;
      } else if (!sawQuote) {
        if (isBlankLine(src, ls, le)) break;
        if (isBlockStart(src, ls, le)) break;
        chunkLines.push({ text: src.slice(ls, le), lazy: true });
        j++;
      } else break;
    }
    if (chunkLines.length === 0) break;
    // Lazy setext lines inside a chunk (not its first line) are indented by
    // four spaces so they stay paragraph text instead of forming a heading.
    for (let k = 1; k < chunkLines.length; k++) {
      if (chunkLines[k].lazy && isSetextText(chunkLines[k].text)) {
        chunkLines[k].text = "    " + chunkLines[k].text.replace(/^ {0,3}/, "");
      }
    }
    const chunkText = chunkLines.map(l => l.text).join("\n");
    const chunkBlocks = parseBlocks(chunkText, defs);
    mergeChunkBlocks(kids, chunkBlocks, canMerge);
    // A chunk ending on a blank line closes its paragraph: the next chunk
    // must not merge into it, and lazy lines after it are not part of the
    // quote at all.
    const lastLine = chunkLines[chunkLines.length - 1].text;
    canMerge = lastLine.trim() !== "";
    if (!canMerge) break;
    const last = kids.length ? kids[kids.length - 1] : null;
    if (last && (last.t === 2 || last.t === 3 || last.t === 1 || last.t === 4 || last.t === 5 || last.t === 8)) break;
    // Continue only if the next line is a lazy line (a new chunk can start).
    if (j >= n) break;
    const ls = starts[j], le = lineEnd(src, starts, j);
    if (isBlankLine(src, ls, le)) break;
    if (quoteMarker(src, ls, le)) break;
    if (isBlockStart(src, ls, le)) break;
  }
  return { kids, next: j };
}

// ---------- link reference definitions ----------

// Parse a definition starting at line i. Returns the index of the first line
// after the definition, or -1 when the lines are not a definition. A parsed
// definition is recorded in defs (first definition wins per label).
function parseDef(src, starts, i, defs) {
  const n = starts.length;
  const ls = starts[i], le = lineEnd(src, starts, i);
  const { col, idx } = lineIndent(src, ls, le);
  if (col > 3 || idx >= le || src.charCodeAt(idx) !== 91) return -1; // '['
  const srcLen = src.length;
  // Label: scan for the closing ']', allowing escapes and newlines that are
  // not followed by a blank line. The label must contain a non-space char.
  let p = idx + 1, labelEnd = -1, hasContent = false;
  while (p < srcLen) {
    const c = src.charCodeAt(p);
    if (c === 92) { // backslash escape
      if (p + 1 >= srcLen) break;
      p += 2;
      hasContent = true;
      continue;
    }
    if (c === 93) { labelEnd = p; break; }
    if (c === 91) break; // '[' not allowed
    if (c === 10) {
      let q = p + 1;
      while (q < srcLen && (src.charCodeAt(q) === 32 || src.charCodeAt(q) === 9)) q++;
      if (q >= srcLen || src.charCodeAt(q) === 10) break; // blank line follows
      p++;
      continue;
    }
    if (c !== 32 && c !== 9) hasContent = true;
    p++;
  }
  if (labelEnd === -1 || !hasContent) return -1;
  if (labelEnd + 1 >= srcLen || src.charCodeAt(labelEnd + 1) !== 58) return -1; // ':'
  let q = labelEnd + 2;
  // Spaces after the colon, then optionally a newline + spaces/tabs.
  while (q < srcLen && src.charCodeAt(q) === 32) q++;
  if (q < srcLen && src.charCodeAt(q) === 10) {
    q++;
    while (q < srcLen && (src.charCodeAt(q) === 32 || src.charCodeAt(q) === 9)) q++;
  }
  if (q >= srcLen) return -1;
  // Destination: <...> or a bare run of non-whitespace.
  let dest = "", destEnd = q;
  const dc = src.charCodeAt(q);
  if (dc === 60) { // '<'
    let e = q + 1;
    while (e < srcLen && src.charCodeAt(e) !== 62 && src.charCodeAt(e) !== 10) e++;
    if (e >= srcLen || src.charCodeAt(e) !== 62) return -1;
    dest = src.slice(q + 1, e);
    destEnd = e + 1;
  } else {
    if (dc <= 32) return -1;
    let e = q;
    while (e < srcLen) {
      const cc = src.charCodeAt(e);
      if (cc <= 32) break;
      e++;
    }
    dest = src.slice(q, e);
    destEnd = e;
    // Bare destinations need balanced parentheses.
    if (parenBalance(dest) !== -1) return -1;
  }
  // Optional title: spaces (possibly across a newline) + "..." / '...' / (...).
  let title = null, titleEnd = destEnd;
  let r = destEnd;
  let sp = r;
  while (sp < srcLen && src.charCodeAt(sp) === 32) sp++;
  let hasSpace = sp > r;
  let nl = false;
  if (sp < srcLen && src.charCodeAt(sp) === 10) {
    nl = true;
    sp++;
    while (sp < srcLen && (src.charCodeAt(sp) === 32 || src.charCodeAt(sp) === 9)) sp++;
  }
  if (sp < srcLen && (hasSpace || nl)) {
    const tc = src.charCodeAt(sp);
    if (tc === 34 || tc === 39 || tc === 40) {
      const close = tc === 40 ? 41 : tc;
      let e = sp + 1, ok = false;
      while (e < srcLen) {
        const cc = src.charCodeAt(e);
        if (cc === 92 && e + 1 < srcLen) { e += 2; continue; }
        if (cc === close) { ok = true; break; }
        if (tc === 39 && cc === 10) {
          // Single-quoted titles may not span a blank line.
          if (e + 1 < srcLen && src.charCodeAt(e + 1) === 10) break;
        }
        if (tc === 40 && cc === 40) break; // no unescaped '(' in paren titles
        e++;
      }
      if (ok) {
        title = src.slice(sp + 1, e);
        titleEnd = e + 1;
        r = titleEnd;
      } else if (tc === 39 || tc === 40) {
        // A broken title means no title (and the definition may still hold
        // only if nothing but spaces follows the destination).
        r = destEnd;
      } else {
        r = destEnd;
      }
    } else {
      r = destEnd;
    }
  } else {
    r = destEnd;
  }
  // After the destination/title: only spaces/tabs, then a newline or EOF.
  // If a title was found but trailing text follows it, the definition is
  // still valid WITHOUT the title (marked's regex backtracks) -- retry
  // from the end of the destination.
  let s = r;
  while (s < srcLen && (src.charCodeAt(s) === 32 || src.charCodeAt(s) === 9)) s++;
  if (s < srcLen && src.charCodeAt(s) !== 10) {
    if (title === null) return -1;
    s = destEnd;
    while (s < srcLen && (src.charCodeAt(s) === 32 || src.charCodeAt(s) === 9)) s++;
    if (s < srcLen && src.charCodeAt(s) !== 10) return -1;
    title = null;
    titleEnd = destEnd;
  }
  // The definition consumes through the end of the line holding the title
  // (or the destination). Find that line index.
  let endLine = i;
  while (endLine + 1 < n && starts[endLine + 1] <= s) endLine++;
  const label = normalizeLabel(src.slice(idx + 1, labelEnd));
  if (label === "") return -1;
  if (!defs.has(label)) {
    defs.set(label, { href: unescapeUnicode(dest), title: title === null ? null : unescapeUnicode(title) });
  }
  return endLine + 1;
}

// ---------- lists ----------

// HTML block start per the list-loop pattern (case-insensitive): a block tag
// followed by a space, end of line, '/>' or '>', or script/pre/style/textarea
// (any case), a comment, a processing instruction, <! + letter, or CDATA.
function htmlBeginAt(src, ls, le, maxCol) {
  const { col, idx } = lineIndent(src, ls, le);
  if (col > maxCol || idx >= le || src.charCodeAt(idx) !== 60) return false;
  const p = idx + 1;
  if (p >= le) return false;
  const c1 = src.charCodeAt(p);
  if (c1 === 33) {
    if (p + 1 < le && src.charCodeAt(p + 1) === 45 && p + 2 < le && src.charCodeAt(p + 2) === 45) return true;
    if (p + 1 < le && src.charCodeAt(p + 1) === 91) return matchWordCI(src, p + 2, "CDATA[");
    if (p + 1 < le) {
      const d = src.charCodeAt(p + 1);
      if ((d >= 65 && d <= 90) || (d >= 97 && d <= 122)) return true;
    }
    return false;
  }
  if (c1 === 63) return true;
  let np = p;
  if (c1 === 47) np = p + 1;
  if (np >= le) return false;
  const nc = src.charCodeAt(np);
  if (!((nc >= 65 && nc <= 90) || (nc >= 97 && nc <= 122))) return false;
  let ne = np;
  while (ne < le) {
    const cc = src.charCodeAt(ne);
    if (!((cc >= 65 && cc <= 90) || (cc >= 97 && cc <= 122) || (cc >= 48 && cc <= 57) || cc === 45)) break;
    ne++;
  }
  const name = src.slice(np, ne).toLowerCase();
  if (c1 !== 47 && (name === "script" || name === "pre" || name === "style" || name === "textarea")) {
    if (ne >= le) return true;
    const ac = src.charCodeAt(ne);
    return ac === 32 || ac === 9 || ac === 62;
  }
  if (BLOCK_TAGS.has(name)) {
    if (ne >= le) return true;
    const ac = src.charCodeAt(ne);
    if (ac === 32 || ac === 62) return true;
    if (ac === 47 && ne + 1 < le && src.charCodeAt(ne + 1) === 62) return true;
    return false;
  }
  return false;
}

// Does this line end the current list item? A fence, heading, HTML block,
// blockquote, any list marker, or a thematic break, at an indent below R
// and at most 3 (marked's break regexes are clamped to min(3, R-1)). A
// block start at indent R or more, or deeper than 3, belongs to the item.
function isListBreak(src, ls, le, R) {
  const { col, idx } = lineIndent(src, ls, le);
  if (idx >= le || col >= R || col > 3) return false;
  const c0 = src.charCodeAt(idx);
  if (c0 === 62) return true; // blockquote
  if (c0 === 35) {
    let i = idx, level = 0;
    while (i < le && src.charCodeAt(i) === 35 && level < 7) { level++; i++; }
    if (level < 1 || level > 6) return false;
    if (i >= le) return true;
    const c = src.charCodeAt(i);
    return c === 32 || c === 9;
  }
  if (c0 === 96 || c0 === 126) {
    let i = idx, len = 0;
    while (i < le && src.charCodeAt(i) === c0) { len++; i++; }
    if (len < 3) return false;
    if (c0 === 96) {
      for (let j = i; j < le; j++) if (src.charCodeAt(j) === 96) return false;
    }
    return true;
  }
  if (c0 === 45 || c0 === 42 || c0 === 95) {
    let count = 0, isHr = true;
    for (let i = idx; i < le; i++) {
      const c = src.charCodeAt(i);
      if (c === c0) count++;
      else if (c !== 32 && c !== 9) { isHr = false; break; }
    }
    if (isHr && count >= 3) return true;
    // Not an hr: fall through to the list-marker check.
  }
  if (c0 === 60) return htmlBeginAt(src, ls, le, R);
  if (c0 === 45 || c0 === 43 || c0 === 42 || (c0 >= 48 && c0 <= 57)) {
    return listMarker(src, ls, le) !== null;
  }
  return false;
}

// List marker with a custom indent limit (for the list-break check, where the
// limit is the item's content indent R rather than 3).
function listMarkerLoose(src, ls, le, maxCol) {
  const { col, idx } = lineIndent(src, ls, le);
  if (col > maxCol || idx >= le) return false;
  const c = src.charCodeAt(idx);
  if (c === 45 || c === 43 || c === 42) {
    if (idx + 1 < le) {
      const c2 = src.charCodeAt(idx + 1);
      if (c2 !== 32 && c2 !== 9) return false;
    }
    return true;
  }
  if (c >= 48 && c <= 57) {
    let i = idx, digits = 0;
    while (i < le && src.charCodeAt(i) >= 48 && src.charCodeAt(i) <= 57 && digits < 10) { digits++; i++; }
    if (digits === 0 || digits > 9 || i >= le) return false;
    const d = src.charCodeAt(i);
    if (d !== 46 && d !== 41) return false;
    if (i + 1 < le) {
      const c2 = src.charCodeAt(i + 1);
      if (c2 !== 32 && c2 !== 9) return false;
    }
    return true;
  }
  return false;
}

// Lazy-line break test for lists: the item's last content line (as a plain
// string) ends the item's paragraph if it is indented-code-like (4+ columns)
// or starts a fence, heading, HTML block, or thematic break.
function lazyBreaks(line) {
  let col = 0, i = 0;
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if (c === 32) { col++; i++; }
    else if (c === 9) { col += 4 - (col & 3); i++; }
    else break;
  }
  if (col >= 4) return true;
  if (i >= line.length) return false;
  const c0 = line.charCodeAt(i);
  if (c0 === 96 || c0 === 126) {
    let len = 0, j = i;
    while (j < line.length && line.charCodeAt(j) === c0) { len++; j++; }
    if (len >= 3) return true;
  }
  if (c0 === 35) {
    let level = 0, j = i;
    while (j < line.length && line.charCodeAt(j) === 35 && level < 7) { level++; j++; }
    if (level >= 1 && level <= 6) {
      if (j >= line.length) return true;
      const c = line.charCodeAt(j);
      if (c === 32 || c === 9) return true;
    }
  }
  if (c0 === 45 || c0 === 42 || c0 === 95) {
    let count = 0;
    for (let j = i; j < line.length; j++) {
      const c = line.charCodeAt(j);
      if (c === c0) count++;
      else if (c !== 32 && c !== 9) { count = 0; break; }
    }
    if (count >= 3) return true;
  }
  if (c0 === 60) {
    // HTML block start (case-insensitive, list-loop rules) on this line.
    return htmlBeginAt(line, 0, line.length, 3);
  }
  return false;
}

function collectList(src, starts, i, defs) {
  const n = starts.length;
  const first = listMarker(src, starts[i], lineEnd(src, starts, i));
  const ordered = first.ordered, delim = first.delim;
  const items = [];
  let j = i;
  let loose = false;
  while (j < n) {
    const ls = starts[j], le = lineEnd(src, starts, j);
    const m = listMarker(src, ls, le);
    if (!m || m.ordered !== ordered || m.delim !== delim) break;
    if (hrLine(src, ls, le)) break;
    const R = m.contentCol;
    const itemLines = [];
    const firstText = (m.pad ? " ".repeat(m.pad) : "") + src.slice(m.firstContent, le);
    itemLines.push(firstText);
    j++;
    const itemEmpty = m.empty;
    if (itemEmpty && j < n) {
      const nls = starts[j], nle = lineEnd(src, starts, j);
      if (isBlankLine(src, nls, nle)) {
        j++;
        items.push({ lines: [""], blankInside: false, hadTrailingBlank: true });
        continue;
      }
    }
    let lastContent = firstText;
    let sawBlank = false, blankInside = false, hadTrailingBlank = false;
    while (j < n) {
      const cls = starts[j], cle = lineEnd(src, starts, j);
      if (isListBreak(src, cls, cle, R)) break;
      const { col, idx } = lineIndent(src, cls, cle);
      const blank = idx >= cle;
      if (blank || col >= R) {
        const text = stripIndentText(src, cls, cle, R);
        itemLines.push(text);
        if (blank) { sawBlank = true; hadTrailingBlank = true; }
        else {
          if (sawBlank) blankInside = true;
          hadTrailingBlank = false;
          sawBlank = false;
          lastContent = text;
        }
        j++;
      } else {
        // Less indented, non-blank: lazy, or the item ends. A lazy line
        // after a blank line never belongs to the item (the blank line
        // closed its paragraph).
        if (itemEmpty) break;
        if (sawBlank) break;
        if (lazyBreaks(lastContent)) break;
        const text = src.slice(cls, cle);
        itemLines.push(text);
        hadTrailingBlank = false;
        // Marked's last-line var is the line with R columns stripped even
        // for lazy lines (chopping into the text when indent < R), so a
        // lazy line's own leading spaces never trip the indented-code
        // check on the next line.
        lastContent = stripIndentText(src, cls, cle, R);
        j++;
      }
    }
    items.push({ lines: itemLines, blankInside, hadTrailingBlank });
  }
  // Looseness: a blank line between two items, or a blank line separating
  // an item's own top-level blocks (a blank line inside a NESTED list does
  // not loosen the outer list).
  for (let k = 0; k < items.length; k++) {
    if (k + 1 < items.length && items[k].hadTrailingBlank) loose = true;
  }
  // Parse each item's content into blocks; detect task checkboxes.
  const parsed = [];
  for (const it of items) {
    // Trim trailing blank lines (they are separators, not content).
    let lines = it.lines;
    while (lines.length > 1 && lines[lines.length - 1].trim() === "") lines.pop();
    if (lines.length === 1 && lines[0].trim() === "") lines = [""];
    let task = false, checked = false;
    const first = lines[0];
    if (first.length >= 4 && first.charCodeAt(0) === 91) {
      const c1 = first.charCodeAt(1);
      if ((c1 === 32 || c1 === 120 || c1 === 88) && first.charCodeAt(2) === 93) {
        let s = 3;
        while (s < first.length && (first.charCodeAt(s) === 32 || first.charCodeAt(s) === 9)) s++;
        if (s > 3 && s < first.length) {
          task = true;
          checked = c1 !== 32;
          lines[0] = first.slice(s);
        }
      }
    }
    const text = lines.join("\n");
    const kids = text.trim() === "" ? [] : parseBlocks(text, defs, false);
    for (let k = 1; k < kids.length; k++) if (kids[k].blankBefore) loose = true;
    if (kids.looseHint) loose = true;
    parsed.push({ task, checked, kids });
  }
  // Trailing blank lines after the last item are not part of the list: hand
  // them back so the outer level sees them (they separate the next block).
  let next = j;
  while (next > i && isBlankLine(src, starts[next - 1], lineEnd(src, starts, next - 1))) next--;
  return { node: { t: 7, ordered, start: ordered ? first.num : 0, loose, items: parsed }, next };
}

// ---------- tables ----------

// Split a table row into cells (marked's `de`): unescaped '|' splits, escaped
// '\|' stays literal; empty edge cells are dropped; cells are trimmed and
// '\|' becomes '|'. When target is given, the result is truncated/padded.
function splitCells(line, target) {
  const cells = [];
  let start = 0;
  for (let i = 0; i < line.length; i++) {
    if (line.charCodeAt(i) !== 124) continue; // '|'
    let bs = 0, p = i - 1;
    while (p >= 0 && line.charCodeAt(p) === 92) { bs++; p--; }
    if (bs % 2 === 1) continue; // escaped pipe
    cells.push(line.slice(start, i));
    start = i + 1;
  }
  cells.push(line.slice(start));
  if (cells.length > 0 && cells[0].trim() === "") cells.shift();
  if (cells.length > 0 && cells[cells.length - 1].trim() === "") cells.pop();
  if (target !== undefined) {
    if (cells.length > target) cells.length = target;
    else while (cells.length < target) cells.push("");
  }
  for (let i = 0; i < cells.length; i++) {
    cells[i] = cells[i].trim().replace(/\\\|/g, "|");
  }
  return cells;
}

// Parse a delimiter row (already stripped of leading indent). Returns
// {count, align} or null. Each cell must be :?-+:? (spaces allowed).
function parseDelimiter(text) {
  const parts = text.split("|");
  if (parts.length > 0 && parts[0].trim() === "") parts.shift();
  if (parts.length > 0 && parts[parts.length - 1].trim() === "") parts.pop();
  if (parts.length === 0) return null;
  const align = [];
  for (const part of parts) {
    // Must match /^ *:?-+:? *$/.
    let s = 0, e = part.length;
    while (s < e && part.charCodeAt(s) === 32) s++;
    while (e > s && part.charCodeAt(e - 1) === 32) e--;
    let j = s, leftColon = false, rightColon = false, dashes = 0;
    if (j < e && part.charCodeAt(j) === 58) { leftColon = true; j++; }
    while (j < e && part.charCodeAt(j) === 45) { dashes++; j++; }
    if (j < e && part.charCodeAt(j) === 58) { rightColon = true; j++; }
    if (dashes === 0 || j !== e) return null;
    if (leftColon && rightColon) align.push("center");
    else if (rightColon) align.push("right");
    else if (leftColon) align.push("left");
    else align.push(null);
  }
  return { count: parts.length, align };
}

// A table row line ends the table when it is a blank line, hr, heading,
// blockquote, indented code, fence, list interrupt, or HTML block.
function isTableRowEnd(src, ls, le) {
  const { col, idx } = lineIndent(src, ls, le);
  // A whitespace-only line containing a tab is a table row (marked's row
  // pattern excludes only space-only lines); spaces-only lines are caught
  // by the caller before this is reached.
  if (idx >= le) return false;
  if (col >= 4) return true;
  if (col > 3) return false;
  const c0 = src.charCodeAt(idx);
  if (c0 === 62) return true;
  if (c0 === 35) return atxHeading(src, ls, le) !== null;
  if (c0 === 96 || c0 === 126) return fenceStart(src, ls, le) !== null;
  if (c0 === 45 || c0 === 42 || c0 === 95) {
    if (hrLine(src, ls, le)) return true;
    // Not an hr: fall through to the list check.
  }
  if (c0 === 60) return htmlInterrupt(src, ls, le);
  if (c0 === 45 || c0 === 43 || c0 === 42 || (c0 >= 48 && c0 <= 57)) return listInterrupt(src, ls, le);
  return false;
}

// Try to parse a table starting at line i. Returns {node, next} or null.
function tryTable(src, starts, i) {
  const n = starts.length;
  if (i + 1 >= n) return null;
  const hls = starts[i], hle = lineEnd(src, starts, i);
  const dls = starts[i + 1], dle = lineEnd(src, starts, i + 1);
  let hs = hls;
  while (hs < hle && src.charCodeAt(hs) === 32) hs++;
  if (hs >= hle) return null;
  const headerText = src.slice(hs, hle);
  const { col: dcol, idx: didx } = lineIndent(src, dls, dle);
  if (dcol > 3) return null;
  const delimText = src.slice(didx, dle);
  const delim = parseDelimiter(delimText);
  if (!delim) return null;
  if (delimText.indexOf(":") === -1 && delimText.indexOf("|") === -1) return null;
  const headerCells = splitCells(headerText);
  if (headerCells.length !== delim.count) return null;
  const rows = [];
  let j = i + 2;
  while (j < n) {
    const rls = starts[j], rle = lineEnd(src, starts, j);
    // Only a spaces-only (or empty) line ends the table; a line with a
    // tab is a row (marked's table regex excludes ` *\n` only).
    let spacesOnly = true;
    for (let p = rls; p < rle; p++) {
      if (src.charCodeAt(p) !== 32) { spacesOnly = false; break; }
    }
    if (spacesOnly) break;
    if (isTableRowEnd(src, rls, rle)) break;
    rows.push(splitCells(src.slice(rls, rle), headerCells.length));
    j++;
  }
  return { node: { t: 8, align: delim.align, head: headerCells, rows }, next: j };
}

// Setext level of a plain text line (1 '=', 2 '-', 0 no). The run must be
// contiguous; only trailing spaces/tabs may follow.
function setextLevelText(t) {
  let i = 0;
  while (i < t.length && t.charCodeAt(i) === 32 && i < 3) i++;
  if (i >= t.length) return 0;
  const ch = t.charCodeAt(i);
  if (ch !== 61 && ch !== 45) return 0;
  while (i < t.length && t.charCodeAt(i) === ch) i++;
  while (i < t.length) {
    const c = t.charCodeAt(i);
    if (c !== 32 && c !== 9) return 0;
    i++;
  }
  return ch === 61 ? 1 : 2;
}

// Is a plain text line a list marker line (any bullet or ordered marker)?
function isListMarkerText(t) {
  let i = 0, col = 0;
  while (i < t.length) {
    const c = t.charCodeAt(i);
    if (c === 32) { col++; i++; }
    else if (c === 9) { col += 4 - (col & 3); i++; }
    else break;
  }
  if (col > 3 || i >= t.length) return false;
  const c = t.charCodeAt(i);
  if (c === 45 || c === 43 || c === 42) {
    if (i + 1 >= t.length) return true;
    const c2 = t.charCodeAt(i + 1);
    return c2 === 32 || c2 === 9;
  }
  if (c >= 48 && c <= 57) {
    let j = i, digits = 0;
    while (j < t.length && t.charCodeAt(j) >= 48 && t.charCodeAt(j) <= 57 && digits < 10) { digits++; j++; }
    if (digits === 0 || digits > 9 || j >= t.length) return false;
    const d = t.charCodeAt(j);
    if (d !== 46 && d !== 41) return false;
    if (j + 1 >= t.length) return true;
    const c2 = t.charCodeAt(j + 1);
    return c2 === 32 || c2 === 9;
  }
  return false;
}

// ---------- main block loop ----------

// Parse a source string into blocks. top=true at the document level and
// inside blockquotes (paragraphs keep continuation-line spaces); top=false
// inside list items (a continuation line indented 4+ is lexed as indented
// code and merged into the text with its indent stripped, like marked).
function parseBlocks(src, defs, top = true) {
  const starts = buildLineStarts(src);
  const n = starts.length;
  const blocks = [];
  let i = 0;
  // Whether a blank line preceded the next block (used for list looseness:
  // a list is loose when an item's top-level blocks are separated by one).
  let sawBlank = false;
  const addBlock = (b) => {
    if (blocks.length > 0) b.blankBefore = sawBlank;
    sawBlank = false;
    blocks.push(b);
  };
  while (i < n) {
    const ls = starts[i], le = lineEnd(src, starts, i);
    if (isBlankLine(src, ls, le)) { sawBlank = true; i++; continue; }
    const { col, idx } = lineIndent(src, ls, le);
    const c0 = src.charCodeAt(idx);
    // Blockquote.
    if (c0 === 62 && col <= 3) {
      const q = collectQuote(src, starts, i, defs);
      addBlock({ t: 6, kids: q.kids });
      i = q.next;
      continue;
    }
    // ATX heading.
    if (c0 === 35 && col <= 3) {
      const h = atxHeading(src, ls, le);
      if (h) {
        addBlock({ t: 1, level: h.level, text: src.slice(h.ts, h.te) });
        i++;
        continue;
      }
    }
    // Fenced code.
    if ((c0 === 96 || c0 === 126) && col <= 3) {
      const f = fenceStart(src, ls, le);
      if (f) {
        // Backtick fences compensate the opening fence's indent (in
        // characters) from each content line; tilde fences do not.
        const fenceIndent = f.ch === 96 ? (idx - ls) : 0;
        const contentLines = [];
        let j = i + 1;
        while (j < n) {
          const fls = starts[j], fle = lineEnd(src, starts, j);
          const { col: fcol, idx: fidx } = lineIndent(src, fls, fle);
          let closed = false;
          if (fcol <= 3 && fidx < fle && src.charCodeAt(fidx) === f.ch) {
            let k = fidx, clen = 0;
            while (k < fle && src.charCodeAt(k) === f.ch) { clen++; k++; }
            if (clen >= f.len) {
              let ok = true;
              while (k < fle) {
                if (src.charCodeAt(k) !== 32 && src.charCodeAt(k) !== 9) { ok = false; break; }
                k++;
              }
              if (ok) closed = true;
            }
          }
          if (closed) { j++; break; }
          if (fenceIndent > 0) {
            let k = fls, removed = 0;
            while (k < fle && removed < fenceIndent) {
              const c = src.charCodeAt(k);
              if (c !== 32 && c !== 9) break;
              k++; removed++;
            }
            contentLines.push(src.slice(k, fle));
          } else {
            contentLines.push(src.slice(fls, fle));
          }
          j++;
        }
        let lang = unescapeUnicode(src.slice(f.is, f.ie));
        let wend = 0;
        while (wend < lang.length && lang.charCodeAt(wend) > 32) wend++;
        lang = lang.slice(0, wend);
        addBlock({ t: 3, lang, text: contentLines.join("\n") });
        i = j;
        continue;
      }
    }
    // HTML block.
    if (c0 === 60 && col <= 3) {
      const ht = htmlBlockType(src, ls, le);
      if (ht) {
        let tagName = null;
        if (ht === 1) {
          let np = idx + 1, ne = np;
          while (ne < le) {
            const cc = src.charCodeAt(ne);
            if (!((cc >= 65 && cc <= 90) || (cc >= 97 && cc <= 122) || (cc >= 48 && cc <= 57) || cc === 45)) break;
            ne++;
          }
          tagName = src.slice(np, ne).toLowerCase();
        }
        const endLine = htmlBlockEnd(src, starts, i, ht, tagName);
        const ele = lineEnd(src, starts, endLine);
        let text = src.slice(ls, ele);
        const hasNL = ele < src.length && src.charCodeAt(ele) === 10;
        let nextBlank = false, nextEmpty = false;
        if (endLine + 1 < n) {
          const nls = starts[endLine + 1], nle = lineEnd(src, starts, endLine + 1);
          nextBlank = isBlankLine(src, nls, nle);
          nextEmpty = nls >= nle;
        }
        // Marked's html regex: types 1-5 match only the newlines right
        // after the closing line, so a whitespace-only (tab/spaces) next
        // line does NOT strip the trailing newline -- only a truly empty
        // next line does (the match then holds 2+ trailing newlines and
        // its ge() strips them). Types 6/7 match through the blank line,
        // so any blank next line strips it.
        if (ht <= 5) {
          if (hasNL && !nextEmpty) text += "\n";
        } else if (hasNL && !nextBlank) text += "\n";
        addBlock({ t: 5, text });
        i = endLine + 1;
        continue;
      }
    }
    // Thematic break.
    if ((c0 === 45 || c0 === 42 || c0 === 95) && col <= 3 && hrLine(src, ls, le)) {
      addBlock({ t: 4 });
      i++;
      continue;
    }
    // List.
    if (col <= 3) {
      const m = listMarker(src, ls, le);
      if (m) {
        const l = collectList(src, starts, i, defs);
        addBlock(l.node);
        i = l.next;
        continue;
      }
    }
    // Indented code.
    if (col >= 4) {
      const codeLines = [];
      let j = i;
      while (j < n) {
        const cls = starts[j], cle = lineEnd(src, starts, j);
        if (isBlankLine(src, cls, cle)) {
          let k = j + 1, found = false;
          while (k < n) {
            const kls = starts[k], kle = lineEnd(src, starts, k);
            if (isBlankLine(src, kls, kle)) { k++; continue; }
            const { col: kcol } = lineIndent(src, kls, kle);
            if (kcol >= 4) found = true;
            break;
          }
          if (!found) break;
          // Blank lines inside a code block keep their content after the
          // indent removal (a 6-space line leaves 2 spaces).
          while (j < k) {
            const bls = starts[j], ble = lineEnd(src, starts, j);
            codeLines.push(src.slice(stripCodeIndent(src, bls, ble), ble));
            j++;
          }
          continue;
        }
        const { col: ccol } = lineIndent(src, cls, cle);
        if (ccol < 4) break;
        const cidx = stripCodeIndent(src, cls, cle);
        codeLines.push(src.slice(cidx, cle));
        j++;
      }
      while (codeLines.length > 0 && codeLines[codeLines.length - 1] === "") codeLines.pop();
      addBlock({ t: 2, text: codeLines.join("\n") });
      i = j;
      continue;
    }
    // Link reference definition.
    if (c0 === 91 && col <= 3) {
      const dnext = parseDef(src, starts, i, defs);
      if (dnext !== -1) {
        // A definition after a blank line still loosens a list item (the
        // blank line separates blocks even though the def adds no block).
        if (sawBlank) blocks.looseHint = true;
        sawBlank = false;
        i = dnext;
        continue;
      }
    }
    // Table (header + delimiter on the next line).
    const tb = tryTable(src, starts, i);
    if (tb) {
      addBlock(tb.node);
      i = tb.next;
      continue;
    }
    // Paragraph (or setext heading): collect lines until a blank line or a
    // block start. A setext underline line is absorbed as a heading when the
    // text so far is valid setext text.
    const para = parseParagraph(src, starts, i, top);
    addBlock(para.block);
    i = para.next;
  }
  return blocks;
}

// Collect a paragraph starting at line i. Returns {block, next}. If a line
// after the first is a setext underline and the text lines are valid setext
// text (no list markers among the continuation lines), the block is a
// heading instead. A whitespace-only line ends the paragraph -- except the
// LAST line of the source when the source has no trailing newline (marked's
// paragraph regex only treats whitespace as blank when a newline follows).
function parseParagraph(src, starts, i, top) {
  const n = starts.length;
  const endsWithNl = src.length > 0 && src.charCodeAt(src.length - 1) === 10;
  const paraLines = [];
  let j = i;
  while (j < n) {
    const pls = starts[j], ple = lineEnd(src, starts, j);
    if (isBlankLine(src, pls, ple) && (j < n - 1 || endsWithNl)) break;
    if (j > i) {
      const lvl = setextLevel(src, pls, ple);
      if (lvl !== 0) {
        let ok = true;
        for (let k = 1; k < paraLines.length; k++) {
          if (isListMarkerText(paraLines[k])) { ok = false; break; }
        }
        if (ok) {
          // Setext heading text is trimmed (both ends) by marked.
          return { block: { t: 1, level: lvl, text: paraLines.join("\n").trim() }, next: j + 1 };
        }
      }
      if (isBlockStart(src, pls, ple, top)) break;
      // Inside a list item, a continuation line indented 4+ columns is
      // indented code merged into the text: strip its code indent.
      if (!top) {
        const { col } = lineIndent(src, pls, ple);
        if (col >= 4) {
          paraLines.push(src.slice(stripCodeIndent(src, pls, ple), ple));
          j++;
          continue;
        }
      }
    }
    paraLines.push(src.slice(pls, ple));
    j++;
  }
  return { block: { t: 0, text: paraLines.join("\n") }, next: j };
}

// ---------- rendering ----------

function renderBlocks(blocks, doc, out) {
  for (const b of blocks) {
    if (b.t === 0) {
      out.push("<p>", inlineToHtml(b.text, doc, false), "</p>\n");
    } else if (b.t === 1) {
      out.push("<h", String(b.level), ">", inlineToHtml(b.text, doc, false), "</h", String(b.level), ">\n");
    } else if (b.t === 2) {
      // marked's code renderer: text with one trailing newline stripped,
      // then exactly one added back (empty stays empty).
      const ct = b.text;
      out.push("<pre><code>", escapeText(ct, true), ct.length ? (ct.charCodeAt(ct.length - 1) === 10 ? "" : "\n") : "", "</code></pre>\n");
    } else if (b.t === 3) {
      out.push("<pre><code");
      if (b.lang !== "") out.push(" class=\"language-", escapeText(b.lang, false), "\"");
      const ft = b.text;
      out.push(">", escapeText(ft, true), ft.length ? (ft.charCodeAt(ft.length - 1) === 10 ? "" : "\n") : "", "</code></pre>\n");
    } else if (b.t === 4) {
      out.push("<hr>\n");
    } else if (b.t === 5) {
      out.push(b.text);
    } else if (b.t === 6) {
      out.push("<blockquote>\n");
      renderBlocks(b.kids, doc, out);
      out.push("</blockquote>\n");
    } else if (b.t === 7) {
      if (b.ordered) {
        out.push("<ol");
        if (b.start !== 1) out.push(" start=\"", String(b.start), "\"");
        out.push(">\n");
      } else {
        out.push("<ul>\n");
      }
      for (const it of b.items) {
        out.push("<li>");
        renderItem(it, b.loose, doc, out);
        out.push("</li>\n");
      }
      out.push(b.ordered ? "</ol>\n" : "</ul>\n");
    } else if (b.t === 8) {
      out.push("<table>\n<thead>\n<tr>\n");
      for (let c = 0; c < b.head.length; c++) {
        out.push("<th");
        if (b.align[c]) out.push(" align=\"", b.align[c], "\"");
        out.push(">", inlineToHtml(b.head[c], doc, false), "</th>\n");
      }
      out.push("</tr>\n</thead>\n");
      if (b.rows.length > 0) {
        out.push("<tbody>");
        for (const row of b.rows) {
          out.push("<tr>\n");
          for (let c = 0; c < row.length; c++) {
            out.push("<td");
            if (b.align[c]) out.push(" align=\"", b.align[c], "\"");
            out.push(">", inlineToHtml(row[c], doc, false), "</td>\n");
          }
          out.push("</tr>\n");
        }
        out.push("</tbody>");
      }
      out.push("</table>\n");
    }
  }
}

// Render one list item. In a tight list, paragraphs render bare (no <p>); in
// a loose list they get <p> tags. A task checkbox is prepended to the first
// paragraph's inline content (or to the item's first text).
function renderItem(it, loose, doc, out) {
  const kids = it.kids;
  let first = true;
  for (let bi = 0; bi < kids.length; bi++) {
    const b = kids[bi];
    if (b.t === 0) {
      if (loose) {
        out.push("<p>");
        if (first && it.task) out.push(it.checked ? "<input checked=\"\" disabled=\"\" type=\"checkbox\"> " : "<input disabled=\"\" type=\"checkbox\"> ");
        out.push(inlineToHtml(b.text, doc, false), "</p>\n");
      } else {
        if (first && it.task) out.push(it.checked ? "<input checked=\"\" disabled=\"\" type=\"checkbox\"> " : "<input disabled=\"\" type=\"checkbox\"> ");
        // Tight paragraphs render bare, with no trailing newline; the next
        // block's output (if any) follows immediately.
        out.push(inlineToHtml(b.text, doc, false));
      }
    } else {
      renderBlocks([b], doc, out);
    }
    first = false;
  }
  if (kids.length === 0 && it.task) {
    out.push(it.checked ? "<input checked=\"\" disabled=\"\" type=\"checkbox\"> " : "<input disabled=\"\" type=\"checkbox\"> ");
  }
}

// ---------- entry point ----------

export function parse(markdown) {
  let src = markdown;
  if (src.indexOf("\r") !== -1) src = src.replace(/\r\n?/g, "\n");
  const defs = new Map();
  const blocks = parseBlocks(src, defs);
  const doc = { refs: defs, inLink: false };
  const out = [];
  renderBlocks(blocks, doc, out);
  return out.join("");
}
