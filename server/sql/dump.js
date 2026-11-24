// Load a SQL dump (SQLite, PostgreSQL plain pg_dump, MySQL mysqldump, or a SQL Server script) into a fresh SQLite file, best effort.
//
//   loadDump(text, dbPath) -> { dialect, tables: [{ name, rows }], skipped: [{ sql, reason }], notes: [] }
//
// How: a small scanner splits the dump into statements (quotes, comments, $$-strings, COPY ... FROM stdin
// data blocks and MySQL DELIMITER are understood), each statement is translated token by token to SQLite
// (identifier quoting, string escapes, types, AUTO_INCREMENT / ENGINE= / casts dropped), and the result runs
// in phases: tables first (PostgreSQL's trailing `ALTER TABLE ... ADD CONSTRAINT` primary/foreign keys are
// folded into CREATE TABLE), then data, then indexes and views. Anything that can't be translated or fails
// is reported in `skipped` instead of aborting the load.
import { DatabaseSync, constants as SQ } from 'node:sqlite';
import fs from 'node:fs';

// ---------------------------------------------------------------- scanner
const isWordStart = c => /[A-Za-z_\u0080-￿]/.test(c);
const isWord = c => /[A-Za-z0-9_$\u0080-￿]/.test(c);

/** One token at text[pos]. Types: ws, comment, string, ident, word, number, punct. */
function scanToken(text, pos, dialect) {
  const c = text[pos], n = text[pos + 1];
  if (/\s/.test(c)) { let e = pos; while (e < text.length && /\s/.test(text[e])) e++; return { t: 'ws', v: text.slice(pos, e), end: e }; }
  if (c === '-' && n === '-') { let e = text.indexOf('\n', pos); e = e < 0 ? text.length : e; return { t: 'comment', v: text.slice(pos, e), end: e }; }
  if (c === '#' && dialect === 'mysql') { let e = text.indexOf('\n', pos); e = e < 0 ? text.length : e; return { t: 'comment', v: text.slice(pos, e), end: e }; }
  if (c === '/' && n === '*') {
    let e = text.indexOf('*/', pos + 2); e = e < 0 ? text.length : e + 2;
    return { t: 'comment', v: text.slice(pos, e), end: e }; // MySQL /*!40101 ... */ conditional code is dropped too
  }
  // strings: '...' ('' escapes; MySQL and PostgreSQL E'...' also use backslash escapes; SQL Server N'...')
  if ((c === 'N' || c === 'n') && n === "'" && dialect === 'mssql') {
    let i = pos + 2, val = '';
    while (i < text.length) {
      if (text[i] === "'") { if (text[i + 1] === "'") { val += "'"; i += 2; continue; } i++; break; }
      val += text[i++];
    }
    return { t: 'string', v: val, end: i };
  }
  if (c === "'" || ((c === 'E' || c === 'e') && n === "'" && dialect === 'postgres')) {
    const backslash = dialect === 'mysql' || c !== "'";
    let i = c === "'" ? pos + 1 : pos + 2, val = '';
    while (i < text.length) {
      const ch = text[i];
      if (backslash && ch === '\\' && i + 1 < text.length) { val += unBackslash(text[i + 1]); i += 2; continue; }
      if (ch === "'") { if (text[i + 1] === "'") { val += "'"; i += 2; continue; } i++; break; }
      val += ch; i++;
    }
    return { t: 'string', v: val, end: i };
  }
  if (c === '"' && dialect === 'mysql') { // MySQL (without ANSI_QUOTES): "..." is a string
    let i = pos + 1, val = '';
    while (i < text.length) {
      const ch = text[i];
      if (ch === '\\' && i + 1 < text.length) { val += unBackslash(text[i + 1]); i += 2; continue; }
      if (ch === '"') { if (text[i + 1] === '"') { val += '"'; i += 2; continue; } i++; break; }
      val += ch; i++;
    }
    return { t: 'string', v: val, end: i };
  }
  if (c === '"' || c === '`' || c === '[') { // quoted identifiers ([x] only in SQLite / SQL Server style)
    if (c === '[' && dialect !== 'sqlite' && dialect !== 'mssql') return { t: 'punct', v: c, end: pos + 1 };
    const close = c === '[' ? ']' : c;
    let i = pos + 1, val = '';
    while (i < text.length) {
      if (text[i] === close) { if (close !== ']' && text[i + 1] === close) { val += close; i += 2; continue; } i++; break; }
      val += text[i++];
    }
    return { t: 'ident', v: val, end: i };
  }
  if (c === '$' && dialect === 'postgres') { // $tag$ ... $tag$
    const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(text.slice(pos, pos + 64));
    if (m) {
      const close = text.indexOf(m[0], pos + m[0].length);
      const e = close < 0 ? text.length : close + m[0].length;
      return { t: 'string', v: text.slice(pos + m[0].length, close < 0 ? text.length : close), end: e };
    }
  }
  if (c === '0' && (n === 'x' || n === 'X')) { // hex / binary literal, can be megabytes long
    let e = pos + 2; while (e < text.length && /[0-9a-fA-F]/.test(text[e])) e++;
    return { t: 'number', v: text.slice(pos, e), end: e };
  }
  if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(n))) {
    const m = /^(0x[0-9a-fA-F]+|\d*\.?\d+(?:[eE][+-]?\d+)?)/.exec(text.slice(pos, pos + 64));
    return { t: 'number', v: m[0], end: pos + m[0].length };
  }
  if (isWordStart(c)) { let e = pos + 1; while (e < text.length && isWord(text[e])) e++; return { t: 'word', v: text.slice(pos, e), end: e }; }
  if (c === ':' && n === ':') return { t: 'punct', v: '::', end: pos + 2 };
  return { t: 'punct', v: c, end: pos + 1 };
}

function unBackslash(ch) {
  return { n: '\n', r: '\r', t: '\t', 0: '', b: '\b', Z: '\x1a', f: '\f', v: '\v' }[ch] ?? ch;
}

export function detectDialect(text) {
  const head = text.slice(0, 200000);
  let pg = 0, my = 0, lite = 0, ms = 0;
  if (/^[ \t]*GO[ \t]*\r?$/mi.test(head)) ms += 5;
  if (/SET\s+(NOCOUNT|IDENTITY_INSERT|ANSI_NULLS|QUOTED_IDENTIFIER|DATEFORMAT|ANSI_PADDING)\b/i.test(head)) ms += 3;
  if (/\bnvarchar\b|\[dbo\]|\bsysobjects\b|\bIDENTITY\s*\(\s*\d+\s*,|\bN'/i.test(head)) ms += 2;
  if (/PostgreSQL database dump|pg_dump/i.test(head)) pg += 5;
  if (/^COPY\s+\S+.*FROM\s+stdin;/mi.test(head)) pg += 5;
  if (/SET\s+(search_path|standard_conforming_strings|client_encoding)\b|::regclass|pg_catalog\./i.test(head)) pg += 3;
  if (/MySQL dump|mysqldump|MariaDB dump/i.test(head)) my += 5;
  if (/ENGINE\s*=|\/\*!\d{5}|LOCK TABLES|`/i.test(head)) my += 3;
  if (/AUTO_INCREMENT/i.test(head)) my += 1;
  if (/PRAGMA\s+foreign_keys|BEGIN TRANSACTION;|sqlite_sequence/i.test(head)) lite += 3;
  if (ms >= 5 && ms > pg && ms > my && ms > lite) return 'mssql';
  if (pg > my && pg > lite) return 'postgres';
  if (my > pg && my > lite) return 'mysql';
  return 'sqlite';
}

// SQL Server scripts: batches end at a line "GO", statements inside a batch often have no ';' at all.
// A statement therefore also ends where a statement keyword starts a new line (outside parentheses).
// CREATE VIEW / PROCEDURE / FUNCTION / TRIGGER always fill a whole batch, so they run to the next GO.
const MSSQL_STMT = new Set(['INSERT', 'UPDATE', 'DELETE', 'CREATE', 'ALTER', 'DROP', 'SET', 'IF', 'ELSE', 'EXEC', 'EXECUTE',
  'DECLARE', 'PRINT', 'USE', 'GRANT', 'REVOKE', 'DENY', 'BEGIN', 'COMMIT', 'ROLLBACK', 'TRUNCATE', 'MERGE', 'WHILE', 'RAISERROR']);
const MSSQL_BATCH = /^(CREATE|ALTER)\s+(OR\s+ALTER\s+)?(VIEW|PROC|PROCEDURE|FUNCTION|TRIGGER)\b/i;

function splitMssql(text) {
  const out = [];
  let pos = 0, tokens = [], start = -1, end = 0, depth = 0, nsig = 0, first = '', batch = false, prev = null, atLineStart = true;
  const flush = () => {
    if (start >= 0) { const st = { tokens: trimWs(tokens), raw: text.slice(start, end).trim() }; if (st.tokens.length) out.push(st); }
    tokens = []; start = -1; depth = 0; nsig = 0; first = ''; batch = false; prev = null;
  };
  while (pos < text.length) {
    const tok = scanToken(text, pos, 'mssql');
    pos = tok.end;
    if (tok.t === 'ws') { if (tok.v.includes('\n')) atLineStart = true; if (start >= 0) tokens.push(tok); continue; }
    if (tok.t === 'comment') continue;
    const up = tok.t === 'word' ? tok.v.toUpperCase() : '';
    if (atLineStart && up === 'GO') {
      let le = text.indexOf('\n', pos); if (le < 0) le = text.length;
      if (/^[ \t]*(\d+)?[ \t]*(--.*)?\r?$/.test(text.slice(pos, le))) { flush(); pos = le; continue; }
    }
    if (tok.t === 'punct' && tok.v === ';' && !batch) { flush(); atLineStart = false; continue; }
    if (start >= 0 && atLineStart && depth === 0 && MSSQL_STMT.has(up) && !batch &&
        !W(prev, 'ON') && !(up === 'SET' && (first === 'UPDATE' || first === 'MERGE' || W(prev, 'DELETE', 'UPDATE')))) flush();
    if (start < 0) { start = tok.end - tok.v.length; first = up; }
    tokens.push(tok);
    if (tok.t === 'punct' && tok.v === '(') depth++;
    if (tok.t === 'punct' && tok.v === ')') depth--;
    if (++nsig <= 6 && !batch) batch = MSSQL_BATCH.test(text.slice(start, tok.end));
    prev = tok; end = tok.end; atLineStart = false;
  }
  flush();
  return out;
}

const DATE_MDY = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})(?:\s+(\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?))?$/;
/** '7/4/1996' -> '1996-07-04' (SET DATEFORMAT mdy, SQL Server's default; dmy swaps day and month). */
function isoDate(s, order) {
  const m = DATE_MDY.exec(s);
  if (!m) return null;
  let [mo, d] = order === 'dmy' ? [m[2], m[1]] : [m[1], m[2]];
  if (+mo < 1 || +mo > 12 || +d < 1 || +d > 31) return null;
  return `${m[3]}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}${m[4] ? ' ' + m[4] : ''}`;
}

/**
 * Split a dump into statements: [{ tokens, raw, copy? }] where copy = { rows: [[...fields]] } for
 * PostgreSQL COPY ... FROM stdin blocks. psql meta-commands (\connect, \restrict) become { meta }.
 */
export function splitStatements(text, dialect) {
  text = text.replace(/^﻿/, '');
  if (dialect === 'mssql') return splitMssql(text);
  const out = [];
  let pos = 0, delimiter = ';';
  while (pos < text.length) {
    // skip blanks and comments between statements
    let tok = scanToken(text, pos, dialect);
    if (tok.t === 'ws' || tok.t === 'comment') { pos = tok.end; continue; }
    const lineEnd = (() => { const e = text.indexOf('\n', pos); return e < 0 ? text.length : e; })();
    if (text[pos] === '\\') { out.push({ meta: text.slice(pos, lineEnd).trim() }); pos = lineEnd; continue; }
    const dm = dialect === 'mysql' && /^DELIMITER\s+(\S+)/i.exec(text.slice(pos, lineEnd));
    if (dm) { delimiter = dm[1]; pos = lineEnd; continue; }
    const start = pos, tokens = [];
    let ended = false;
    while (pos < text.length) {
      if (text.startsWith(delimiter, pos)) { pos += delimiter.length; ended = true; break; }
      tok = scanToken(text, pos, dialect);
      if (tok.t !== 'comment') tokens.push(tok);
      pos = tok.end;
    }
    const raw = text.slice(start, ended ? pos - delimiter.length : pos).trim();
    const st = { tokens: trimWs(tokens), raw };
    if (dialect === 'postgres' && /^COPY\s[\s\S]*\bFROM\s+stdin\b/i.test(raw)) {
      // data lines follow until a line "\."
      let nl = text.indexOf('\n', pos);
      pos = nl < 0 ? text.length : nl + 1;
      const rows = [];
      while (pos < text.length) {
        let e = text.indexOf('\n', pos);
        if (e < 0) e = text.length;
        const line = text.slice(pos, e).replace(/\r$/, '');
        pos = e + 1;
        if (line === '\\.') break;
        rows.push(line.split('\t').map(copyField));
      }
      st.copy = { rows };
    }
    if (st.tokens.length) out.push(st);
  }
  return out;
}

function trimWs(tokens) {
  let a = 0, b = tokens.length;
  while (a < b && tokens[a].t === 'ws') a++;
  while (b > a && tokens[b - 1].t === 'ws') b--;
  return tokens.slice(a, b);
}

/** One field of a COPY text-format line: \N is NULL, backslash escapes as PostgreSQL writes them. */
export function copyField(f) {
  if (f === '\\N') return null;
  if (!f.includes('\\')) return f;
  let out = '';
  for (let i = 0; i < f.length; i++) {
    const c = f[i];
    if (c !== '\\' || i + 1 >= f.length) { out += c; continue; }
    const n = f[++i];
    if (/[0-7]/.test(n)) { let o = n; while (o.length < 3 && /[0-7]/.test(f[i + 1])) o += f[++i]; out += String.fromCharCode(parseInt(o, 8)); }
    else if (n === 'x' && /[0-9a-fA-F]/.test(f[i + 1])) { let h = ''; while (h.length < 2 && /[0-9a-fA-F]/.test(f[i + 1])) h += f[++i]; out += String.fromCharCode(parseInt(h, 16)); }
    else out += { b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v' }[n] ?? n;
  }
  return out;
}

// ---------------------------------------------------------------- token helpers
const W = (tok, ...words) => tok && tok.t === 'word' && words.includes(tok.v.toUpperCase());
const sig = tokens => tokens.filter(t => t.t !== 'ws');
const qid = s => `"${String(s).replace(/"/g, '""')}"`;
const qstr = s => `'${String(s).replace(/\0/g, '').replace(/'/g, "''")}'`;

/** Render tokens as SQLite text: identifiers double-quoted, strings re-escaped, casts and schema prefixes dropped. */
function render(tokens, { concatPlus = false } = {}) {
  let ts = dropSchemaPrefixes(unwrapStringCasts(dropCasts(concatPlus ? convertToCast(tokens) : tokens)));
  // SQL Server joins strings with +; in SQLite 'a' + 'b' is 0. Only + right next to a string literal is changed.
  if (concatPlus) ts = ts.map((t, i) => {
    if (t.t !== 'punct' || t.v !== '+') return t;
    const near = d => { let k = i + d; while (ts[k]?.t === 'ws') k += d; return ts[k]; };
    return near(-1)?.t === 'string' || near(1)?.t === 'string' ? { t: 'punct', v: '||' } : t;
  });
  // tokens may come without their whitespace (signature slices): put a space back where two words would merge,
  // and never let two punctuation marks form a comment (-- or /*)
  const wordish = t => t && (t.t === 'word' || t.t === 'ident' || t.t === 'string' || t.t === 'number');
  let s = '', prev = null;
  for (let i = 0; i < ts.length; i++) {
    const t = ts[i];
    if (t.t === 'ws') { s += ' '; prev = null; continue; }
    if (t.t === 'word' && /^_[a-z0-9]+$/i.test(t.v) && (ts[i + 1]?.t === 'string' || (ts[i + 1]?.t === 'ws' && ts[i + 2]?.t === 'string'))) continue; // MySQL _binary 'x'
    if (prev && ((wordish(prev) && wordish(t)) || prev.v === ',' || (prev.t === 'punct' && t.t === 'punct' && /^(--|\/\*)$/.test(prev.v + t.v)))) s += ' ';
    // long 0x... literals are binary data (SQL Server image/varbinary, MySQL blobs): SQLite reads them as X'...'
    const hex = t.t === 'number' && /^0x[0-9a-f]{17,}$/i.test(t.v) ? t.v.slice(2) : null;
    s += t.t === 'ident' ? qid(t.v) : t.t === 'string' ? qstr(t.v) : hex ? `X'${hex.length % 2 ? '0' + hex : hex}'` : t.v;
    prev = t;
  }
  return s.trim(); // (whitespace tokens are already single spaces; string literals keep their tabs/newlines)
}

const TYPE_CONT = new Set(['VARYING', 'PRECISION', 'WITHOUT', 'WITH', 'TIME', 'ZONE', 'UNSIGNED']);
/** Remove PostgreSQL casts: 'x'::text, nextval('s'::regclass), '{}'::character varying[] */
function dropCasts(tokens) {
  const out = [];
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].t === 'punct' && tokens[i].v === '::') {
      let j = i + 1;
      while (tokens[j]?.t === 'ws') j++;
      if (tokens[j]?.t === 'word' || tokens[j]?.t === 'ident') {
        j++;
        while (tokens[j]?.t === 'punct' && tokens[j].v === '.' && tokens[j + 1]) j += 2;  // pg_catalog.text
        for (;;) {
          let k = j; while (tokens[k]?.t === 'ws') k++;
          if (W(tokens[k], ...TYPE_CONT)) { j = k + 1; continue; }
          if (tokens[k]?.v === '(') { j = skipParens(tokens, k); continue; }
          if (tokens[k]?.v === '[' && tokens[k + 1]?.v === ']') { j = k + 2; continue; }
          break;
        }
        i = j - 1;
        continue;
      }
    }
    out.push(tokens[i]);
  }
  return out;
}

/**
 * CAST('2020-01-01T00:00:00' AS DateTime) -> '2020-01-01T00:00:00'. SQLite would turn a string cast to an unknown
 * type into a number (2020); a string cast to a text-like type is just the string.
 */
function unwrapStringCasts(tokens) {
  const out = [];
  for (let i = 0; i < tokens.length; i++) {
    if (W(tokens[i], 'CAST', 'TRY_CAST')) {
      const s = []; // significant tokens with their index
      for (let k = i + 1; k < tokens.length && s.length < 5; k++) if (tokens[k].t !== 'ws') s.push([tokens[k], k]);
      if (s[0]?.[0].v === '(' && s[1]?.[0].t === 'string' && W(s[2]?.[0], 'AS') && (s[3]?.[0].t === 'word' || s[3]?.[0].t === 'ident') &&
          mapType(s[3][0].v) === 'TEXT') {
        let k = s[3][1] + 1;
        while (tokens[k]?.t === 'ws') k++;
        if (tokens[k]?.v === '(') { k = skipParens(tokens, k); while (tokens[k]?.t === 'ws') k++; }
        if (tokens[k]?.v === ')') { out.push(s[1][0]); i = k; continue; }
      }
    }
    out.push(tokens[i]);
  }
  return out;
}

/** SQL Server CONVERT(money, expr [, style]) -> CAST(expr AS NUMERIC) (SQLite type names). */
function convertToCast(tokens) {
  const out = [];
  for (let i = 0; i < tokens.length; i++) {
    let p = i + 1; while (tokens[p]?.t === 'ws') p++;
    if (W(tokens[i], 'CONVERT', 'TRY_CONVERT') && tokens[p]?.v === '(') {
      const e = skipParens(tokens, p);
      const args = splitCommas(tokens.slice(p + 1, e - 1));
      if (args.length >= 2) {
        const type = mapType(args[0].map(t => t.v).join(''));
        out.push({ t: 'word', v: 'CAST' }, { t: 'punct', v: '(' }, ...convertToCast(args[1]), { t: 'ws', v: ' ' },
          { t: 'word', v: 'AS' }, { t: 'ws', v: ' ' }, { t: 'word', v: type }, { t: 'punct', v: ')' });
        i = e - 1;
        continue;
      }
    }
    out.push(tokens[i]);
  }
  return out;
}

/** public.customers -> customers ("schema"."table" too). Only for the well-known default schemas. */
function dropSchemaPrefixes(tokens) {
  const out = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if ((t.t === 'word' || t.t === 'ident') && /^(public|dbo|main|pg_catalog)$/i.test(t.v) && tokens[i + 1]?.v === '.' &&
        (tokens[i + 2]?.t === 'word' || tokens[i + 2]?.t === 'ident')) { i++; continue; }
    out.push(t);
  }
  return out;
}

/** index just past the matching ')' for tokens[i] === '(' */
function skipParens(tokens, i) {
  let depth = 0;
  for (; i < tokens.length; i++) {
    if (tokens[i].t !== 'punct') continue;
    if (tokens[i].v === '(') depth++;
    else if (tokens[i].v === ')' && --depth === 0) return i + 1;
  }
  return tokens.length;
}

/** Split tokens at top-level commas. */
function splitCommas(tokens) {
  const parts = [[]];
  let depth = 0;
  for (const t of tokens) {
    if (t.t === 'punct' && t.v === '(') depth++;
    if (t.t === 'punct' && t.v === ')') depth--;
    if (t.t === 'punct' && t.v === ',' && depth === 0) { parts.push([]); continue; }
    parts.at(-1).push(t);
  }
  return parts.map(trimWs).filter(p => p.length);
}

/** Read a possibly schema-qualified name starting at sig index i: returns [name, nextIndex]. */
function readName(s, i) {
  let name = s[i]?.v, j = i + 1;
  while (s[j]?.v === '.' && (s[j + 1]?.t === 'word' || s[j + 1]?.t === 'ident')) { name = s[j + 1].v; j += 2; }
  return [name, j];
}

// ---------------------------------------------------------------- types
const BOOL_TYPES = /^(bool|boolean)$/;
export function mapType(typeText) {
  const t = typeText.toLowerCase().replace(/\s+/g, ' ').trim();
  const base = t.replace(/\(.*$/, '').replace(/\[\]$/, '').trim();
  if (/\[\]$/.test(t)) return 'TEXT'; // arrays: keep the text form
  if (BOOL_TYPES.test(base) || /^tinyint\(1\)/.test(t)) return 'INTEGER';
  if (/^(int|integer|int2|int4|int8|smallint|bigint|tinyint|mediumint|serial|bigserial|smallserial|serial4|serial8|year|bit)( unsigned)?$/.test(base)) return 'INTEGER';
  if (/^(real|float|float4|float8|double|double precision)( unsigned)?$/.test(base)) return 'REAL';
  if (/^(numeric|decimal|dec|money|smallmoney|fixed)( unsigned)?$/.test(base)) return 'NUMERIC';
  if (/^(bytea|blob|tinyblob|mediumblob|longblob|binary|varbinary|bit varying|image|rowversion)$/.test(base)) return 'BLOB';
  return 'TEXT'; // char/varchar/text/enum/json/uuid/date/time/timestamp/... and unknown types
}

// ---------------------------------------------------------------- CREATE TABLE
const COL_STOP = new Set(['NOT', 'NULL', 'DEFAULT', 'PRIMARY', 'UNIQUE', 'REFERENCES', 'CHECK', 'COLLATE', 'CHARACTER', 'CHARSET',
  'AUTO_INCREMENT', 'AUTOINCREMENT', 'COMMENT', 'GENERATED', 'CONSTRAINT', 'ON', 'SIGNED', 'ZEROFILL', 'IDENTITY', 'VISIBLE', 'INVISIBLE', 'KEY']);
const ACTIONS = new Set(['CASCADE', 'RESTRICT', 'NO', 'ACTION', 'SET', 'NULL', 'DEFAULT']);

function columnDef(item, notes, table) {
  const s = sig(item);
  const name = s[0].v;
  let i = 1;
  const typeToks = [];
  const stopAt = k => s[k].t === 'word' && COL_STOP.has(s[k].v.toUpperCase()) &&
    !(W(s[k], 'CHARACTER') && !W(s[k + 1], 'SET')); // "character varying(60)" is a type, "CHARACTER SET x" is not
  while (i < s.length && !stopAt(i)) {
    if (s[i].v === '(') { const j = skipParens(s, i); typeToks.push(...s.slice(i, j)); i = j; continue; }
    typeToks.push(s[i]); i++;
  }
  const typeText = typeToks.map(t => (t.t === 'string' ? `'${t.v}'` : t.v)).join(' ').replace(/ \( /g, '(').replace(/ \)/g, ')');
  const type = typeToks.length ? mapType(typeText) : '';
  const isBool = BOOL_TYPES.test(typeText.toLowerCase().trim()) || /^tinyint\s*\(\s*1\s*\)/i.test(typeText);
  const parts = [qid(name), type].filter(Boolean);
  let pk = false;
  while (i < s.length) {
    const u = s[i].t === 'word' ? s[i].v.toUpperCase() : '';
    if (u === 'NOT' && W(s[i + 1], 'NULL')) { parts.push('NOT NULL'); i += 2; continue; }
    if (u === 'NULL') { i++; continue; }
    if (u === 'PRIMARY' && W(s[i + 1], 'KEY')) { parts.push('PRIMARY KEY'); pk = true; i += 2; continue; }
    if (u === 'UNIQUE') { parts.push('UNIQUE'); i++; if (W(s[i], 'KEY')) i++; continue; }
    if (u === 'KEY') { i++; continue; } // MySQL "id int KEY"
    if (u === 'DEFAULT') {
      i++;
      let neg = '';
      // SQL Server writes DEFAULT (0), DEFAULT ((0)), DEFAULT (getdate()): look inside the parentheses
      while (s[i]?.v === '(' && s[i + 1] && s[i + 1].v !== ')') {
        const e = skipParens(s, i), inner = s.slice(i + 1, e - 1);
        const simple = inner.length === 1 || (inner.length === 2 && /^[-+]$/.test(inner[0].v) && inner[1].t === 'number') ||
          (inner[0]?.t === 'word' && inner[1]?.v === '(' && skipParens(inner, 1) === inner.length) || inner[0]?.v === '(';
        if (!simple) break;
        s.splice(i, e - i, ...inner); // (s is a private copy)
      }
      if (s[i]?.v === '-' || s[i]?.v === '+') neg = s[i++].v === '-' ? '-' : '';
      const v = s[i];
      if (!v) break;
      if (v.t === 'word' && /^nextval$/i.test(v.v)) { i = s[i + 1]?.v === '(' ? skipParens(s, i + 1) : i + 1; }
      else if (v.t === 'word' && /^(now|current_timestamp|localtimestamp|current_date|current_time|getdate)$/i.test(v.v)) {
        parts.push(/date$/i.test(v.v) ? 'DEFAULT CURRENT_DATE' : /time$/i.test(v.v) ? 'DEFAULT CURRENT_TIME' : 'DEFAULT CURRENT_TIMESTAMP');
        i = s[i + 1]?.v === '(' ? skipParens(s, i + 1) : i + 1;
      } else if (v.t === 'string') { parts.push(`DEFAULT ${qstr(v.v)}`); i++; }
      else if (v.t === 'number') { parts.push(`DEFAULT ${neg}${v.v}`); i++; }
      else if (v.t === 'word' && /^(null|true|false)$/i.test(v.v)) { parts.push(`DEFAULT ${v.v.toUpperCase() === 'TRUE' ? 1 : v.v.toUpperCase() === 'FALSE' ? 0 : 'NULL'}`); i++; }
      else if (v.v === '(') { i = skipParens(s, i); notes.push(`${table}.${name}: dropped expression default`); }
      else { i = s[i + 1]?.v === '(' ? skipParens(s, i + 1) : i + 1; notes.push(`${table}.${name}: dropped default ${v.v}`); }
      // casts after the default value
      while (s[i]?.v === '::') { i += 2; while (W(s[i], ...TYPE_CONT)) i++; if (s[i]?.v === '(') i = skipParens(s, i); if (s[i]?.v === '[') i += 2; }
      continue;
    }
    if (u === 'REFERENCES') {
      const [ref, j] = readName(s, i + 1);
      let txt = `REFERENCES ${qid(ref)}`;
      i = j;
      if (s[i]?.v === '(') { const k = skipParens(s, i); txt += ` (${splitCommas(s.slice(i + 1, k - 1)).map(p => qid(p[0].v)).join(', ')})`; i = k; }
      while (W(s[i], 'ON') && W(s[i + 1], 'DELETE', 'UPDATE')) {
        let act = `ON ${s[i + 1].v.toUpperCase()}`; i += 2;
        while (s[i] && W(s[i], ...ACTIONS)) { act += ' ' + s[i].v.toUpperCase(); i++; }
        txt += ' ' + act;
      }
      parts.push(txt);
      continue;
    }
    if (u === 'CHECK') { i = s[i + 1]?.v === '(' ? skipParens(s, i + 1) : i + 1; continue; }
    if (u === 'COLLATE' || u === 'CHARSET' || u === 'COMMENT') { i += 2; continue; }
    if (u === 'CHARACTER' && W(s[i + 1], 'SET')) { i += 3; continue; }
    if (u === 'ON' && W(s[i + 1], 'UPDATE')) { i += 3; if (s[i]?.v === '(') i = skipParens(s, i); continue; }
    if (u === 'GENERATED') { // GENERATED ... AS IDENTITY (...) | GENERATED ALWAYS AS (expr) STORED
      i++;
      while (i < s.length && !W(s[i], 'AS')) i++;
      i++;
      if (W(s[i], 'IDENTITY')) { i++; if (s[i]?.v === '(') i = skipParens(s, i); }
      else if (s[i]?.v === '(') { i = skipParens(s, i); if (W(s[i], 'STORED', 'VIRTUAL')) i++; notes.push(`${table}.${name}: generated column kept as a plain column`); }
      continue;
    }
    if (u === 'CONSTRAINT') { i += 2; continue; }
    if (u === 'IDENTITY') { i++; if (s[i]?.v === '(') i = skipParens(s, i); continue; } // SQL Server IDENTITY (1, 1)
    i++; // AUTO_INCREMENT, UNSIGNED, SIGNED, ZEROFILL, VISIBLE, IDENTITY, anything unknown
  }
  return { sql: parts.join(' '), name, isBool, pk, type };
}

function colList(tokens) { // ( a, b DESC, `c`(10) ) -> "a", "b" DESC, "c"
  return splitCommas(tokens).map(p => {
    const s = sig(p);
    const dir = s.find(t => W(t, 'ASC', 'DESC'));
    return qid(s[0].v) + (dir ? ' ' + dir.v.toUpperCase() : '');
  }).join(', ');
}

/** A table-level constraint item (from CREATE TABLE or ALTER TABLE ADD ...). Returns { kind, sql } or null. */
function tableConstraint(s) {
  let i = 0;
  if (W(s[0], 'CONSTRAINT')) i = 2;
  if (W(s[i], 'ADD')) i++;
  const u = s[i]?.t === 'word' ? s[i].v.toUpperCase() : '';
  const parenAt = k => { while (k < s.length && s[k].v !== '(') k++; return k; };
  if (u === 'PRIMARY' || u === 'UNIQUE') {
    const p = parenAt(i), e = skipParens(s, p);
    return { kind: u === 'PRIMARY' ? 'pk' : 'unique', sql: `${u === 'PRIMARY' ? 'PRIMARY KEY' : 'UNIQUE'} (${colList(s.slice(p + 1, e - 1))})` };
  }
  if (u === 'FOREIGN') {
    const p = parenAt(i), e = skipParens(s, p);
    const r = s.findIndex((t, k) => k >= e && W(t, 'REFERENCES'));
    if (r < 0) return null;
    const [ref, j] = readName(s, r + 1);
    let sql = `FOREIGN KEY (${colList(s.slice(p + 1, e - 1))}) REFERENCES ${qid(ref)}`, k = j;
    if (s[k]?.v === '(') { const e2 = skipParens(s, k); sql += ` (${colList(s.slice(k + 1, e2 - 1))})`; k = e2; }
    while (k < s.length) {
      if (W(s[k], 'ON') && W(s[k + 1], 'DELETE', 'UPDATE')) {
        let act = ` ON ${s[k + 1].v.toUpperCase()}`; k += 2;
        while (s[k] && W(s[k], ...ACTIONS)) { act += ' ' + s[k].v.toUpperCase(); k++; }
        sql += act;
      } else k++;
    }
    return { kind: 'fk', sql };
  }
  if (u === 'KEY' || u === 'INDEX') {
    const p = parenAt(i), e = skipParens(s, p);
    const name = p > i + 1 ? s[i + 1].v : null;
    return { kind: 'index', name, cols: colList(s.slice(p + 1, e - 1)) };
  }
  if (u === 'CHECK' || u === 'FULLTEXT' || u === 'SPATIAL' || u === 'EXCLUDE' || u === 'LIKE') return { kind: 'drop', what: u };
  return null;
}

function parseCreateTable(st, notes) {
  const s = sig(st.tokens);
  let i = 1;
  while (W(s[i], 'TEMPORARY', 'TEMP', 'UNLOGGED', 'GLOBAL', 'LOCAL')) i++;
  i++; // TABLE
  if (W(s[i], 'IF') && W(s[i + 1], 'NOT') && W(s[i + 2], 'EXISTS')) i += 3;
  const [name, j] = readName(s, i);
  if (s[j]?.v !== '(') return null; // CREATE TABLE ... AS SELECT / PARTITION OF: not supported
  const e = skipParens(s, j);
  const items = splitCommas(s.slice(j + 1, e - 1));
  const cols = [], constraints = [], indexes = [];
  for (const item of items) {
    const it = sig(item);
    const first = it[0];
    // quoted names (`key`, "check") are columns; bare keywords start a table constraint
    const isConstraint = first.t === 'word' && ['CONSTRAINT', 'PRIMARY', 'UNIQUE', 'FOREIGN', 'KEY', 'INDEX', 'CHECK', 'FULLTEXT', 'SPATIAL', 'EXCLUDE', 'LIKE']
      .includes(first.v.toUpperCase());
    if (isConstraint) {
      const c = tableConstraint(it);
      if (!c) { notes.push(`${name}: dropped constraint ${render(item).slice(0, 60)}`); continue; }
      if (c.kind === 'index') indexes.push({ unique: false, name: c.name || `${name}_${indexes.length}_idx`, cols: c.cols });
      else if (c.kind === 'drop') notes.push(`${name}: dropped ${c.what} constraint`);
      else constraints.push(c);
      continue;
    }
    cols.push(columnDef(item, notes, name));
  }
  return { name, cols, constraints, indexes };
}

function createTableSql(t) {
  // a column-level PRIMARY KEY and a table-level one can't both exist
  const hasColPk = t.cols.some(c => c.pk);
  const cons = t.constraints.filter(c => !(c.kind === 'pk' && hasColPk));
  const seen = new Set();
  const uniq = cons.filter(c => (seen.has(c.sql) ? false : seen.add(c.sql)));
  return `CREATE TABLE ${qid(t.name)} (\n  ${[...t.cols.map(c => c.sql), ...uniq.map(c => c.sql)].join(',\n  ')}\n)`;
}

// ---------------------------------------------------------------- statement plan
const SKIP_START = [
  [/^(SET|RESET)\b/i, 'session setting'],
  [/^(LOCK|UNLOCK)\s+TABLES?\b/i, 'table lock'],
  [/^(START\s+TRANSACTION|BEGIN|COMMIT|ROLLBACK|END)\b/i, 'transaction control (the loader uses its own)'],
  [/^USE\b/i, 'USE database'],
  [/^PRAGMA\b/i, 'PRAGMA'],
  [/^(CREATE|DROP)\s+(DATABASE|SCHEMA|EXTENSION|SEQUENCE|FUNCTION|PROCEDURE|TRIGGER|TYPE|DOMAIN|AGGREGATE|OPERATOR|RULE|POLICY|PUBLICATION|SUBSCRIPTION|EVENT|ROLE|USER)\b/i, 'object type not supported in SQLite'],
  [/^(CREATE|ALTER)\s+(OR\s+(REPLACE|ALTER)\s+)?(DEFINER\s*=\s*\S+\s+)?(FUNCTION|PROCEDURE|PROC|TRIGGER|AGGREGATE)\b/i, 'routine/trigger not supported'],
  [/^(IF|ELSE|EXEC|EXECUTE|DECLARE|PRINT|WHILE|RAISERROR)\b/i, 'procedural statement (IF / EXEC / DECLARE …)'],
  [/^TRUNCATE\b/i, 'TRUNCATE (the sandbox starts empty)'],
  [/^(CREATE|DROP)\s+(LOGIN|SYNONYM|STATISTICS|FULLTEXT|XML\s+SCHEMA|PARTITION|ASSEMBLY)\b/i, 'object type not supported in SQLite'],
  [/^ALTER\s+TABLE\s+\S+(\s+\S+)?\s+(WITH\s+)?(NO)?CHECK\s+CONSTRAINT\b/i, 'constraint checking switch'],
  [/^ALTER\s+(AUTHORIZATION|INDEX|LOGIN|USER|ROLE)\b/i, 'ALTER of an unsupported object'],
  [/^ALTER\s+(SEQUENCE|FUNCTION|SCHEMA|TYPE|DATABASE|DEFAULT\s+PRIVILEGES|EXTENSION|PROCEDURE|VIEW|MATERIALIZED)\b/i, 'ALTER of an unsupported object'],
  [/^(GRANT|REVOKE)\b/i, 'permissions'],
  [/^COMMENT\s+ON\b/i, 'comment'],
  [/^SELECT\s+(pg_catalog\.)?(setval|set_config)\b/i, 'sequence/config call'],
  [/^(ANALYZE|VACUUM|OPTIMIZE|FLUSH|REFRESH)\b/i, 'maintenance'],
  [/^CREATE\s+MATERIALIZED\s+VIEW\b/i, 'materialized view'],
];

/**
 * Translate a dump into a plan: { dialect, tables: Map, data: [], post: [], skipped: [], notes: [] }.
 * Exported for the tests (no database needed).
 */
export function planDump(text, dialect = detectDialect(text)) {
  const plan = { dialect, tables: new Map(), order: [], data: [], post: [], skipped: [], notes: [] };
  const skip = (st, reason) => plan.skipped.push({ sql: (st.raw || st.meta || '').replace(/\s+/g, ' ').slice(0, 200), reason });
  const tableOf = name => plan.tables.get(String(name).toLowerCase());
  const ms = dialect === 'mssql';
  let dateOrder = 'mdy', datesFixed = 0;
  for (const st of splitStatements(text, dialect)) {
    if (st.meta) { skip(st, 'psql meta-command'); continue; }
    const raw = st.raw.replace(/^\s+/, '');
    const s = sig(st.tokens);
    if (!s.length) continue;
    const df = ms && /^SET\s+DATEFORMAT\s+(\w+)/i.exec(raw);
    if (df) dateOrder = df[1].toLowerCase();
    const hit = SKIP_START.find(([re]) => re.test(raw));
    if (hit) { skip(st, hit[1]); continue; }

    if (dialect === 'sqlite') { // already SQLite: run as written, in order
      if (/^CREATE\s+TABLE\s+(IF\s+NOT\s+EXISTS\s+)?["`[]?sqlite_/i.test(raw)) { skip(st, 'SQLite internal table'); continue; }
      if (/^(INSERT|DELETE)\s+(INTO\s+|FROM\s+)?["`[]?sqlite_sequence/i.test(raw)) { skip(st, 'SQLite internal table'); continue; }
      plan.data.push({ sql: render(st.tokens), raw: st.raw });
      continue;
    }

    if (/^CREATE\s+(TEMPORARY\s+|TEMP\s+|UNLOGGED\s+|GLOBAL\s+|LOCAL\s+)*TABLE\b/i.test(raw)) {
      const t = parseCreateTable(st, plan.notes);
      if (!t) { skip(st, 'CREATE TABLE form not supported (AS SELECT / PARTITION OF)'); continue; }
      const key = t.name.toLowerCase();
      if (!plan.tables.has(key)) plan.order.push(key);
      plan.tables.set(key, t);
      for (const ix of t.indexes) plan.post.push({ index: { name: ix.name, table: t.name, make: n => `CREATE INDEX ${qid(n)} ON ${qid(t.name)} (${ix.cols})` }, raw: `index ${ix.name}` });
      continue;
    }
    if (/^DROP\s+(TABLE|VIEW|INDEX)\b/i.test(raw)) { skip(st, 'DROP (the sandbox starts empty)'); continue; }
    if (/^ALTER\s+TABLE\b/i.test(raw)) {
      let i = 2;
      while (W(s[i], 'ONLY', 'IF', 'EXISTS')) i++;
      const [name, j] = readName(s, i);
      const t = tableOf(name);
      let k = j;
      if (W(s[k], 'WITH') && W(s[k + 1], 'CHECK', 'NOCHECK')) k += 2; // SQL Server: ALTER TABLE x WITH CHECK ADD CONSTRAINT ...
      const actions = splitCommas(s.slice(k));
      const left = [];
      let adding = false;
      for (const a of actions) {
        const as = sig(a);
        if (W(as[0], 'ADD')) adding = true;
        else if (!(adding && W(as[0], 'CONSTRAINT'))) adding = false; // SQL Server: ADD CONSTRAINT a ..., CONSTRAINT b ...
        if (adding) {
          const c = tableConstraint(W(as[0], 'ADD') ? as.slice(1) : as);
          if (c && t && (c.kind === 'pk' || c.kind === 'fk' || c.kind === 'unique')) { t.constraints.push(c); continue; }
          if (c && c.kind === 'index' && t) {
            const uniq = W(as[1], 'UNIQUE');
            plan.post.push({ index: { name: c.name || `${name}_idx`, table: t.name, make: n => `CREATE ${uniq ? 'UNIQUE ' : ''}INDEX ${qid(n)} ON ${qid(t.name)} (${c.cols})` }, raw: render(a) });
            continue;
          }
        }
        left.push(render(a));
      }
      if (left.length) {
        const txt = left.join(', ');
        skip({ raw: `ALTER TABLE ${name} ${txt}` }, !t ? 'ALTER TABLE on an unknown table'
          : /^OWNER\s+TO\b/i.test(txt) ? 'ownership'
          : /nextval/i.test(txt) ? 'sequence default (SQLite numbers INTEGER PRIMARY KEY rows itself)'
          : 'ALTER TABLE action not supported (only ADD PRIMARY/FOREIGN KEY/UNIQUE/INDEX)');
      }
      continue;
    }
    if (/^CREATE\s+(UNIQUE\s+)?((NON)?CLUSTERED\s+)?INDEX\b/i.test(raw)) {
      // CREATE [UNIQUE] [CLUSTERED] INDEX [CONCURRENTLY] [IF NOT EXISTS] name ON [ONLY] tbl [USING btree] (cols) [USING BTREE]
      const unique = W(s[1], 'UNIQUE');
      let i = s.findIndex(t => W(t, 'INDEX')) + 1;
      while (W(s[i], 'CONCURRENTLY', 'IF', 'NOT', 'EXISTS')) i++;
      const ixName = s[i].v;
      const on = s.findIndex((t, k) => k > i && W(t, 'ON'));
      let k = on + 1;
      if (W(s[k], 'ONLY')) k++;
      const [tbl, k2] = readName(s, k);
      let p = k2;
      while (p < s.length && s[p].v !== '(') p++;
      const e = skipParens(s, p);
      const where = s.findIndex((t, x) => x >= e && W(t, 'WHERE'));
      if (p >= s.length) { skip(st, 'index form not supported'); continue; }
      // SQL Server WHERE filters end before WITH (...) / ON [PRIMARY]
      const whereEnd = where > 0 ? (k => (k < 0 ? s.length : k))(s.findIndex((t, x) => x > where && W(t, 'WITH', 'ON', 'INCLUDE'))) : 0;
      const rest = ` ON ${qid(tbl)} (${colList(s.slice(p + 1, e - 1))})` + (where > 0 ? ' ' + render(s.slice(where, whereEnd)) : '');
      plan.post.push({ index: { name: ixName, table: tbl, make: n => `CREATE ${unique ? 'UNIQUE ' : ''}INDEX ${qid(n)}${rest}` }, raw: st.raw });
      continue;
    }
    if (/^(CREATE|ALTER)\s+(OR\s+(REPLACE|ALTER)\s+)?(ALGORITHM\s*=\s*\w+\s+)?(DEFINER\s*=\s*\S+\s+)?(SQL\s+SECURITY\s+\w+\s+)?VIEW\b/i.test(raw)) {
      const v = s.findIndex(t => W(t, 'VIEW'));
      const [vname, j] = readName(s, v + 1);
      const as = s.findIndex((t, k) => k >= j && W(t, 'AS'));
      // dates in the data are ISO now, so date literals in SQL Server views ('19970101', '7/4/1996') must be too
      const body = ms ? s.slice(as + 1).map(t => {
        if (t.t !== 'string') return t;
        const m = /^(\d{4})(\d{2})(\d{2})$/.exec(t.v);
        const iso = m && +m[2] >= 1 && +m[2] <= 12 && +m[3] >= 1 && +m[3] <= 31 ? `${m[1]}-${m[2]}-${m[3]}` : isoDate(t.v, dateOrder);
        return iso ? { ...t, v: iso } : t;
      }) : s.slice(as + 1);
      plan.post.push({ view: vname, sql: `CREATE VIEW ${qid(vname)} AS ${render(body, { concatPlus: ms }).replace(/\s+WITH\s+(CASCADED\s+|LOCAL\s+)?CHECK\s+OPTION\s*$/i, '')}`, raw: st.raw });
      continue;
    }
    if (/^COPY\b/i.test(raw)) {
      if (!st.copy) { skip(st, 'COPY from a file (only FROM stdin data is in the dump)'); continue; }
      const [name, j] = readName(s, 1);
      let cols = null;
      if (s[j]?.v === '(') cols = splitCommas(s.slice(j + 1, skipParens(s, j) - 1)).map(p => sig(p)[0].v);
      plan.data.push({ copy: { table: name, cols, rows: st.copy.rows }, raw: `COPY ${name} (${st.copy.rows.length} rows)` });
      continue;
    }
    if (/^(INSERT|REPLACE)\b/i.test(raw)) {
      let toks = st.tokens;
      const ignore = W(s[1], 'IGNORE');
      toks = toks.filter(t => !(t === s[1] && ignore) && !W(t, 'LOW_PRIORITY', 'DELAYED', 'HIGH_PRIORITY'));
      if (ms) toks = toks.map(t => { // SQL Server dates follow SET DATEFORMAT: store them as ISO text
        const iso = t.t === 'string' && isoDate(t.v, dateOrder);
        if (iso) datesFixed++;
        return iso ? { ...t, v: iso } : t;
      });
      let sql = render(toks);
      if (ignore) sql = sql.replace(/^INSERT/i, 'INSERT OR IGNORE');
      if (!/^(INSERT|REPLACE)\s+(OR\s+\w+\s+)?INTO\b/i.test(sql)) sql = sql.replace(/^(INSERT|REPLACE)(\s+OR\s+\w+)?\s+/i, '$1$2 INTO '); // INSERT "t" (...) without INTO
      sql = sql.replace(/\s+ON\s+DUPLICATE\s+KEY\s+UPDATE\s[\s\S]*$/i, '').replace(/\bOVERRIDING\s+(SYSTEM|USER)\s+VALUE\b/i, '');
      plan.data.push({ sql, raw: st.raw });
      continue;
    }
    if (/^(UPDATE|DELETE)\b/i.test(raw)) { plan.data.push({ sql: render(st.tokens), raw: st.raw }); continue; }
    skip(st, 'statement type not recognised');
  }
  if (datesFixed) plan.notes.push(`${datesFixed} dates written as YYYY-MM-DD (from SET DATEFORMAT ${dateOrder})`);
  return plan;
}

// ---------------------------------------------------------------- execution
/** Load a dump into a NEW SQLite file at dbPath (overwritten). */
export function loadDump(text, dbPath, { dialect } = {}) {
  const plan = planDump(text, dialect || detectDialect(text));
  for (const f of [dbPath, dbPath + '-journal', dbPath + '-wal', dbPath + '-shm']) fs.rmSync(f, { force: true });
  const db = new DatabaseSync(dbPath, { enableForeignKeyConstraints: false, allowExtension: false });
  // a dump is untrusted input: it may only build this one file (no ATTACH to write other files, no file functions)
  try { db.enableDefensive(true); } catch {}
  db.setAuthorizer((code, a1, a2) => code === SQ.SQLITE_ATTACH || code === SQ.SQLITE_DETACH ? SQ.SQLITE_DENY
    : code === SQ.SQLITE_FUNCTION && /^(load_extension|readfile|writefile|edit|fts3_tokenizer)$/i.test(String(a2)) ? SQ.SQLITE_DENY : SQ.SQLITE_OK);
  const failed = (raw, err) => plan.skipped.push({ sql: String(raw).replace(/\s+/g, ' ').slice(0, 200), reason: `failed: ${err.message}` });
  const bools = new Map(); // table -> set of boolean columns (COPY writes t/f)
  try {
    db.exec('BEGIN');
    for (const key of plan.order) {
      const t = plan.tables.get(key);
      try { db.exec(createTableSql(t)); bools.set(key, new Set(t.cols.filter(c => c.isBool).map(c => c.name.toLowerCase()))); }
      catch (err) { failed(createTableSql(t), err); }
    }
    for (const d of plan.data) {
      if (d.copy) {
        const { table, rows } = d.copy;
        let cols = d.copy.cols;
        try {
          if (!cols) cols = db.prepare(`SELECT name FROM pragma_table_info(?)`).all(table).map(r => r.name);
          const ins = db.prepare(`INSERT INTO ${qid(table)} (${cols.map(qid).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`);
          const b = bools.get(table.toLowerCase()) || new Set();
          const isB = cols.map(c => b.has(c.toLowerCase()));
          let bad = 0;
          for (const r of rows) {
            const vals = r.map((v, k) => (isB[k] && (v === 't' || v === 'f') ? (v === 't' ? 1 : 0) : v));
            while (vals.length < cols.length) vals.push(null);
            try { ins.run(...vals.slice(0, cols.length)); } catch (err) { if (bad++ < 3) failed(`COPY ${table} row: ${r.join(' | ')}`, err); }
          }
          if (bad > 3) plan.notes.push(`${table}: ${bad} COPY rows failed (first 3 listed)`);
        } catch (err) { failed(d.raw, err); }
        continue;
      }
      try { db.exec(d.sql); } catch (err) { failed(d.raw, err); }
    }
    // indexes and tables share one namespace in SQLite (SQL Server and MySQL index names are per table)
    const names = new Set(db.prepare("SELECT lower(name) AS n FROM sqlite_master").all().map(r => r.n));
    for (const p of plan.post) {
      let sql = p.sql;
      if (p.index) {
        let n = p.index.name;
        if (names.has(n.toLowerCase())) n = `${p.index.table}_${n}`;
        for (let k = 2; names.has(n.toLowerCase()); k++) n = `${p.index.table}_${p.index.name}_${k}`;
        names.add(n.toLowerCase());
        sql = p.index.make(n);
      }
      try { db.exec(sql); } catch (err) { failed(p.raw, err); continue; }
      if (p.view) { // a view that uses functions SQLite doesn't have (YEAR(), CONVERT(), TOP ...) is dropped, not left broken
        try { db.prepare(`SELECT * FROM ${qid(p.view)} LIMIT 0`); names.add(p.view.toLowerCase()); }
        catch (err) { db.exec(`DROP VIEW ${qid(p.view)}`); failed(p.raw, new Error(`view not loaded: ${err.message}`)); }
      }
    }
    db.exec('COMMIT');
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch {}
    db.close();
    throw err;
  }
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()
    .map(r => ({ name: r.name, rows: Number(db.prepare(`SELECT count(*) AS n FROM ${qid(r.name)}`).get().n) }));
  db.close();
  return { dialect: plan.dialect, tables, skipped: plan.skipped, notes: plan.notes };
}
