// main.ts is mend, the CLI SPEC.md specifies. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

/** A file's text as lines, its line break, and whether it ends with one (SPEC.md section 3). */
interface FileState {
  lines: string[];
  br: '\r\n' | '\n';
  endsWithBreak: boolean;
}

function splitFile(text: string): FileState {
  if (text === '') return { lines: [], br: '\n', endsWithBreak: false };
  const nl = text.indexOf('\n');
  const br: '\r\n' | '\n' = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const endsWithBreak = text.endsWith(br);
  if (endsWithBreak) parts.pop();
  return { lines: parts, br, endsWithBreak };
}

function joinFile(f: FileState): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.endsWithBreak ? f.br : '');
}

const leadingWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
};

/** A line as a tier sees it (SPEC.md section 5). */
function tierKey(line: string, tier: number): string {
  if (tier === 0) return line;
  if (tier === 1) return line.replace(/[ \t]+$/, '');
  return line.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** Positions where O occurs in the file's lines at a tier, from `from` on (occurrences may overlap). */
function occurrencesAt(lines: string[], o: string[], tier: number, from = 0): number[] {
  const out: number[] = [];
  if (o.length === 0) return out;
  const keys = o.map((l) => tierKey(l, tier));
  for (let i = from; i + o.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (tierKey(lines[i + j]!, tier) !== keys[j]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier (0..2, or 0 only when strict) at which O occurs at least once, from `from` on. */
function findTier(lines: string[], o: string[], strict: boolean, from = 0): { tier: number; positions: number[] } | null {
  const maxTier = strict ? 0 : 2;
  for (let t = 0; t <= maxTier; t++) {
    const positions = occurrencesAt(lines, o, t, from);
    if (positions.length > 0) return { tier: t, positions };
  }
  return null;
}

interface OLine {
  text: string;
  ctx: boolean;
}
interface NLine {
  text: string;
  ctx: boolean;
}

/**
 * The lines after replacing O (at position `pos`, found at `tier`) by N.
 * A context line of N is written as the file's own matched line; at tier 2 every other line of N
 * that starts with P (the leading whitespace of O's first line) has that P replaced by F
 * (the leading whitespace of the file's first matched line). (SPEC.md section 5.)
 */
function applyAt(file: FileState, o: OLine[], n: NLine[], pos: number, tier: number): string[] {
  const oCtx: number[] = [];
  o.forEach((ol, i) => {
    if (ol.ctx) oCtx.push(i);
  });
  const fLead = o.length > 0 ? leadingWs(file.lines[pos] ?? '') : '';
  const pLead = o.length > 0 ? leadingWs(o[0]!.text) : '';
  let ctxSeen = 0;
  const repl: string[] = n.map((nl) => {
    if (nl.ctx) {
      const oi = oCtx[ctxSeen]!;
      ctxSeen += 1;
      return file.lines[pos + oi]!;
    }
    if (tier === 2 && nl.text !== '' && nl.text.trim() !== '' && nl.text.startsWith(pLead)) {
      return fLead + nl.text.slice(pLead.length);
    }
    return nl.text;
  });
  return [...file.lines.slice(0, pos), ...repl, ...file.lines.slice(pos + o.length)];
}

type Edit = (tree: Tree, moves: Array<[string, string]>) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------------------------------------------------------------------------
// Unified diffs (SPEC.md section 6)
// ---------------------------------------------------------------------------

type BodyItem = { kind: 'ctx' | 'old' | 'new'; text: string; noNewline: boolean };

interface Hunk {
  a: number;
  body: BodyItem[];
}

interface UnifiedSection {
  oldPath: string | null;
  newPath: string | null;
  isCreate: boolean;
  isDelete: boolean;
  /** Whether the section already has its ---/+++ header pair. */
  hasHeaderPair: boolean;
  hunks: Hunk[];
}

const HUNK_HEAD = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

function parseHeaderPath(line: string): string {
  // The text after the four characters, up to the first tab, with surrounding spaces removed.
  return line.slice(4).split('\t')[0]!.trim();
}

function stripAB(p: string): string {
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

/** Parse a unified diff into one edit per section (SPEC.md section 6). */
function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: UnifiedSection[] = [];
  let i = 0;
  let cur: UnifiedSection | null = null;
  const startSection = (oldP: string | null, newP: string | null, hasPair: boolean): UnifiedSection => {
    const s: UnifiedSection = { oldPath: oldP, newPath: newP, isCreate: false, isDelete: false, hasHeaderPair: hasPair, hunks: [] };
    sections.push(s);
    cur = s;
    return s;
  };
  const parseGitLine = (line: string, idx: number): [string, string] => {
    const m = /^diff --git a\/(.*?) b\/(.*)$/.exec(line);
    if (m === null) throw new Exit2(`error: parse ${idx + 1}`);
    return [m[1]!, m[2]!];
  };
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const [gOld, gNew] = parseGitLine(line, i);
      // The diff --git paths are used when nothing else names one.
      startSection(gOld, gNew, false);
      i += 1;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const oldRaw = parseHeaderPath(line);
      const newRaw = parseHeaderPath(lines[i + 1]!);
      const oldP = oldRaw === '/dev/null' ? null : stripAB(oldRaw);
      const newP = newRaw === '/dev/null' ? null : stripAB(newRaw);
      if (cur !== null && !cur.hasHeaderPair) {
        // This pair is the current section's header pair, not a new section.
        cur.oldPath = oldP;
        cur.newPath = newP;
        cur.hasHeaderPair = true;
      } else {
        startSection(oldP, newP, true);
      }
      i += 2;
      continue;
    }
    if (cur === null) {
      // Outside any section: ignored (prose, code fences).
      i += 1;
      continue;
    }
    // Inside a section's header (before its first hunk) or between hunks.
    if (line.startsWith('--- ')) {
      // A --- line inside a section's header must be followed by a +++ line.
      if (cur.hunks.length === 0) throw new Exit2(`error: parse ${i + 2}`);
      // Between hunks, a stray --- line is ignored.
      i += 1;
      continue;
    }
    if (line.startsWith('+++ ')) {
      // A +++ line without a --- line before it in this header: ignored (it names nothing alone).
      i += 1;
      continue;
    }
    if (line.startsWith('rename from ')) {
      // Rename names the paths when no ---/+++ pair does.
      if (!cur.hasHeaderPair) cur.oldPath = line.slice('rename from '.length).trim();
      i += 1;
      continue;
    }
    if (line.startsWith('rename to ')) {
      if (!cur.hasHeaderPair) cur.newPath = line.slice('rename to '.length).trim();
      i += 1;
      continue;
    }
    if (line.startsWith('new file mode')) {
      cur.isCreate = true;
      i += 1;
      continue;
    }
    if (line.startsWith('deleted file mode')) {
      cur.isDelete = true;
      i += 1;
      continue;
    }
    if (line.startsWith('@@')) {
      const m = HUNK_HEAD.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const hunk: Hunk = { a: Number(m[1]), body: [] };
      cur.hunks.push(hunk);
      i += 1;
      // Parse the hunk body.
      while (i < lines.length) {
        const bl = lines[i]!;
        if (bl.startsWith('diff --git ')) break;
        if (bl.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (bl.startsWith('\\')) {
          const prev = hunk.body[hunk.body.length - 1];
          if (prev !== undefined) prev.noNewline = true;
          i += 1;
          continue;
        }
        if (bl.startsWith(' ')) {
          hunk.body.push({ kind: 'ctx', text: bl.slice(1), noNewline: false });
          i += 1;
          continue;
        }
        if (bl.startsWith('-')) {
          hunk.body.push({ kind: 'old', text: bl.slice(1), noNewline: false });
          i += 1;
          continue;
        }
        if (bl.startsWith('+')) {
          hunk.body.push({ kind: 'new', text: bl.slice(1), noNewline: false });
          i += 1;
          continue;
        }
        if (bl === '') {
          hunk.body.push({ kind: 'ctx', text: '', noNewline: false });
          i += 1;
          continue;
        }
        break;
      }
      // Empty lines at the end of a body are not part of it.
      while (hunk.body.length > 0) {
        const lastItem = hunk.body[hunk.body.length - 1]!;
        if (lastItem.kind === 'ctx' && lastItem.text === '') hunk.body.pop();
        else break;
      }
      continue;
    }
    // index, old mode, new mode, similarity index, dissimilarity index, Index: and any other line: ignored.
    i += 1;
  }
  // A hunk before any section is a parse error; a @@ line outside a section is caught above only
  // when cur is null, so check for stray @@ lines that were skipped as prose.
  // (The loop above ignores @@ lines only inside a section; outside, a @@ line is a hunk before any
  // section.) Re-scan: any @@ line before the first section start is an error.
  {
    let firstSectionIdx = -1;
    for (let k = 0; k < lines.length; k++) {
      if (lines[k]!.startsWith('diff --git ') || (lines[k]!.startsWith('--- ') && (lines[k + 1] ?? '').startsWith('+++ '))) {
        firstSectionIdx = k;
        break;
      }
    }
    for (let k = 0; k < (firstSectionIdx < 0 ? lines.length : firstSectionIdx); k++) {
      if (lines[k]!.startsWith('@@')) throw new Exit2(`error: parse ${k + 1}`);
    }
  }
  return sections.map((s) => unifiedEdit(s, strict));
}

/** Whether a `\` line follows the hunk's last context or `+` line. */
function backslashAfterLast(hunk: Hunk): boolean {
  for (let i = hunk.body.length - 1; i >= 0; i--) {
    const item = hunk.body[i]!;
    if (item.kind === 'ctx' || item.kind === 'new') return item.noNewline;
  }
  return false;
}

function hunkO(hunk: Hunk): OLine[] {
  return hunk.body.filter((b) => b.kind === 'ctx' || b.kind === 'old').map((b) => ({ text: b.text, ctx: b.kind === 'ctx' }));
}
function hunkN(hunk: Hunk): NLine[] {
  return hunk.body.filter((b) => b.kind === 'ctx' || b.kind === 'new').map((b) => ({ text: b.text, ctx: b.kind === 'ctx' }));
}

function applyUnifiedHunk(file: FileState, hunk: Hunk, d: number, strict: boolean, path: string): FileState {
  const o = hunkO(hunk);
  const n = hunkN(hunk);
  if (o.length === 0) {
    const insertAt = Math.min(hunk.a + d, file.lines.length);
    const newLines = [...file.lines.slice(0, insertAt), ...n.map((x) => x.text), ...file.lines.slice(insertAt)];
    let endsWithBreak = file.endsWithBreak;
    if (insertAt === file.lines.length) endsWithBreak = !backslashAfterLast(hunk);
    return { lines: newLines, br: file.br, endsWithBreak };
  }
  const found = findTier(file.lines, o.map((x) => x.text), strict);
  if (found === null) throw new Fail('no-match', path);
  const target = hunk.a - 1 + d;
  let best = found.positions[0]!;
  let bestDist = Math.abs(best - target);
  for (const p of found.positions) {
    const dist = Math.abs(p - target);
    if (dist < bestDist) {
      best = p;
      bestDist = dist;
    }
  }
  const newLines = applyAt(file, o, n, best, found.tier);
  let endsWithBreak = file.endsWithBreak;
  if (best + o.length === file.lines.length) endsWithBreak = !backslashAfterLast(hunk);
  return { lines: newLines, br: file.br, endsWithBreak };
}

function unifiedEdit(s: UnifiedSection, strict: boolean): Edit {
  return (tree, moves) => {
    const oldP = s.oldPath;
    const newP = s.newPath;
    for (const p of [oldP, newP]) {
      if (p !== null && !safe(p)) throw new Fail('unsafe', p);
    }
    const isMove = oldP !== null && newP !== null && oldP !== newP;
    if (oldP === null && newP === null) {
      // Both paths /dev/null: nothing to name, a no-op edit.
      return;
    }
    if (s.isCreate || oldP === null) {
      // Creation: the new path does not exist; the file is the + lines of all its hunks.
      const np = newP!;
      if (tree.get(np) !== null) throw new Fail('exists', np);
      const plus: string[] = [];
      for (const h of s.hunks) for (const b of h.body) if (b.kind === 'new') plus.push(b.text);
      let endsWithBreak = true;
      outer: for (let hi = s.hunks.length - 1; hi >= 0; hi--) {
        const h = s.hunks[hi]!;
        for (let bi = h.body.length - 1; bi >= 0; bi--) {
          if (h.body[bi]!.kind === 'new') {
            endsWithBreak = !h.body[bi]!.noNewline;
            break outer;
          }
        }
      }
      tree.now.set(np, plus.length === 0 ? '' : plus.join('\n') + (endsWithBreak ? '\n' : ''));
      return;
    }
    if (s.isDelete || newP === null) {
      if (tree.get(oldP!) === null) throw new Fail('missing', oldP!);
      tree.now.set(oldP!, null);
      return;
    }
    if (isMove) {
      if (tree.get(oldP!) === null) throw new Fail('missing', oldP!);
      if (tree.get(newP!) !== null) throw new Fail('exists', newP!);
      let file = splitFile(tree.get(oldP!)!);
      let d = 0;
      for (const h of s.hunks) {
        file = applyUnifiedHunk(file, h, d, strict, oldP!);
        d += hunkN(h).length - hunkO(h).length;
      }
      tree.now.set(newP!, joinFile(file));
      tree.now.set(oldP!, null);
      moves.push([oldP!, newP!]);
      return;
    }
    // Change of the one path.
    if (tree.get(oldP!) === null) throw new Fail('missing', oldP!);
    let file = splitFile(tree.get(oldP!)!);
    let d = 0;
    for (const h of s.hunks) {
      file = applyUnifiedHunk(file, h, d, strict, oldP!);
      d += hunkN(h).length - hunkO(h).length;
    }
    tree.now.set(oldP!, joinFile(file));
  };
}

// ---------------------------------------------------------------------------
// SEARCH/REPLACE blocks (SPEC.md section 7)
// ---------------------------------------------------------------------------

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = 0;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchLine = i;
    let path: string | null = null;
    for (let j = searchLine - 1; j >= prevEnd; j--) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      path = prevPath;
      if (path === null) throw new Exit2(`error: parse ${searchLine + 1}`);
    }
    let eq = -1;
    let rep = -1;
    for (let j = searchLine + 1; j < lines.length; j++) {
      const t = lines[j]!.trimEnd();
      if (t === '=======') {
        eq = j;
        break;
      }
      if (t === '>>>>>>> REPLACE') break;
    }
    if (eq === -1) throw new Exit2(`error: parse ${searchLine + 1}`);
    for (let j = eq + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep === -1) throw new Exit2(`error: parse ${searchLine + 1}`);
    const oldLines = lines.slice(searchLine + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    edits.push(searchReplaceEdit(path, oldLines, newLines, strict));
    prevPath = path;
    prevEnd = rep + 1;
    i = rep + 1;
  }
  return edits;
}

function searchReplaceEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const file = splitFile(before);
    const found = findTier(file.lines, oldLines, strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.positions.length > 1) throw new Fail('ambiguous', path);
    const pos = found.positions[0]!;
    const o: OLine[] = oldLines.map((t) => ({ text: t, ctx: false }));
    const n: NLine[] = newLines.map((t) => ({ text: t, ctx: false }));
    const newLinesOut = applyAt(file, o, n, pos, found.tier);
    tree.now.set(path, joinFile({ lines: newLinesOut, br: file.br, endsWithBreak: file.endsWithBreak }));
  };
}

// ---------------------------------------------------------------------------
// V4A patches (SPEC.md section 8)
// ---------------------------------------------------------------------------

interface V4AChunk {
  anchor: string | null;
  body: BodyItem[];
  endOfFile: boolean;
}

interface V4ASection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  moveTo: string | null;
  addLines: string[];
  chunks: V4AChunk[];
  updateLine: number;
}

function parseV4A(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i += 1;
      continue;
    }
    let kind: 'add' | 'delete' | 'update' | null = null;
    let path = '';
    if (line.startsWith('*** Add File: ')) {
      kind = 'add';
      path = line.slice('*** Add File: '.length).trim();
    } else if (line.startsWith('*** Delete File: ')) {
      kind = 'delete';
      path = line.slice('*** Delete File: '.length).trim();
    } else if (line.startsWith('*** Update File: ')) {
      kind = 'update';
      path = line.slice('*** Update File: '.length).trim();
    } else {
      throw new Exit2(`error: parse ${i + 1}`);
    }
    const sectionStart = i;
    i += 1;
    // Collect the section's lines until the next section header or End Patch.
    const raw: Array<{ text: string; idx: number }> = [];
    while (i < last) {
      const l = lines[i]!;
      if (l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ')) break;
      raw.push({ text: l, idx: i });
      i += 1;
    }
    // Blank lines at the end of a section are not part of it.
    while (raw.length > 0 && blank(raw[raw.length - 1]!.text)) raw.pop();
    const sec: V4ASection = { kind, path, moveTo: null, addLines: [], chunks: [], updateLine: sectionStart + 1 };
    if (kind === 'add') {
      for (const r of raw) {
        if (r.text.startsWith('+')) sec.addLines.push(r.text.slice(1));
        else if (r.text === '') sec.addLines.push('');
        else throw new Exit2(`error: parse ${r.idx + 1}`);
      }
    } else if (kind === 'delete') {
      if (raw.length > 0) throw new Exit2(`error: parse ${raw[0]!.idx + 1}`);
    } else {
      // Update: optional *** Move to: as the first line, then chunks.
      let j = 0;
      if (j < raw.length && raw[j]!.text.startsWith('*** Move to: ')) {
        sec.moveTo = raw[j]!.text.slice('*** Move to: '.length).trim();
        j += 1;
      }
      let current: V4AChunk | null = null;
      const pushCurrent = (): void => {
        if (current !== null) {
          sec.chunks.push(current);
          current = null;
        }
      };
      for (; j < raw.length; j++) {
        const r = raw[j]!;
        const l = r.text;
        if (l.startsWith('@@')) {
          pushCurrent();
          const anchor = l.slice(2).trim();
          current = { anchor: anchor === '' ? null : anchor, body: [], endOfFile: false };
        } else if (l === '*** End of File') {
          if (current === null) throw new Exit2(`error: parse ${r.idx + 1}`);
          current.endOfFile = true;
          pushCurrent();
        } else if (l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || l === '') {
          if (current === null) {
            if (sec.chunks.length > 0) throw new Exit2(`error: parse ${r.idx + 1}`);
            current = { anchor: null, body: [], endOfFile: false };
          }
          if (l === '') current.body.push({ kind: 'ctx', text: '', noNewline: false });
          else if (l.startsWith(' ')) current.body.push({ kind: 'ctx', text: l.slice(1), noNewline: false });
          else if (l.startsWith('-')) current.body.push({ kind: 'old', text: l.slice(1), noNewline: false });
          else current.body.push({ kind: 'new', text: l.slice(1), noNewline: false });
        } else {
          throw new Exit2(`error: parse ${r.idx + 1}`);
        }
      }
      pushCurrent();
      if (sec.chunks.length === 0 && sec.moveTo === null) throw new Exit2(`error: parse ${sec.updateLine}`);
    }
    edits.push(v4aEdit(sec, strict));
  }
  return edits;
}

function applyV4AChunk(file: FileState, chunk: V4AChunk, cursor: number, strict: boolean, path: string): { file: FileState; cursor: number } {
  let start = cursor;
  if (chunk.anchor !== null) {
    const foundAnchor = findTier(file.lines, [chunk.anchor], strict, cursor);
    if (foundAnchor === null) throw new Fail('no-match', path);
    start = foundAnchor.positions[0]! + 1;
  }
  const o: OLine[] = chunk.body.filter((b) => b.kind === 'ctx' || b.kind === 'old').map((b) => ({ text: b.text, ctx: b.kind === 'ctx' }));
  const n: NLine[] = chunk.body.filter((b) => b.kind === 'ctx' || b.kind === 'new').map((b) => ({ text: b.text, ctx: b.kind === 'ctx' }));
  if (o.length === 0) {
    const insertAt = chunk.endOfFile ? file.lines.length : start;
    const newLines = [...file.lines.slice(0, insertAt), ...n.map((x) => x.text), ...file.lines.slice(insertAt)];
    return { file: { lines: newLines, br: file.br, endsWithBreak: file.endsWithBreak }, cursor: insertAt + n.length };
  }
  const found = findTier(file.lines, o.map((x) => x.text), strict, start);
  if (found === null) throw new Fail('no-match', path);
  let pos = found.positions[0]!;
  if (chunk.endOfFile) {
    const eofPos = found.positions.find((p) => p + o.length === file.lines.length);
    if (eofPos === undefined) throw new Fail('no-match', path);
    pos = eofPos;
  }
  const newLines = applyAt(file, o, n, pos, found.tier);
  return { file: { lines: newLines, br: file.br, endsWithBreak: file.endsWithBreak }, cursor: pos + n.length };
}

function v4aEdit(sec: V4ASection, strict: boolean): Edit {
  return (tree, moves) => {
    if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
    if (sec.kind === 'add') {
      if (tree.get(sec.path) !== null) throw new Fail('exists', sec.path);
      tree.now.set(sec.path, sec.addLines.length === 0 ? '' : sec.addLines.join('\n') + '\n');
      return;
    }
    if (sec.kind === 'delete') {
      if (tree.get(sec.path) === null) throw new Fail('missing', sec.path);
      tree.now.set(sec.path, null);
      return;
    }
    // Update.
    if (sec.moveTo !== null && !safe(sec.moveTo)) throw new Fail('unsafe', sec.moveTo);
    const before = tree.get(sec.path);
    if (before === null) throw new Fail('missing', sec.path);
    if (sec.moveTo !== null && tree.get(sec.moveTo) !== null) throw new Fail('exists', sec.moveTo);
    let file = splitFile(before);
    let cursor = 0;
    for (const chunk of sec.chunks) {
      const r = applyV4AChunk(file, chunk, cursor, strict, sec.path);
      file = r.file;
      cursor = r.cursor;
    }
    if (sec.moveTo !== null) {
      tree.now.set(sec.moveTo, joinFile(file));
      tree.now.set(sec.path, null);
      moves.push([sec.path, sec.moveTo]);
    } else {
      tree.now.set(sec.path, joinFile(file));
    }
  };
}

// ---------------------------------------------------------------------------
// Invocation (SPEC.md sections 1, 2 and 10)
// ---------------------------------------------------------------------------

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, strict);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else edits = parseV4A(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const moves: Array<[string, string]> = [];
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = moves.length;
    try {
      edit(tree, moves);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  interface Row {
    key: string;
    text: string;
  }
  const rows: Row[] = [];
  const consumed = new Set<string>();
  for (const [oldP, newP] of moves) {
    if (tree.original(oldP) !== null && tree.get(oldP) === null && tree.original(newP) === null && tree.get(newP) !== null) {
      rows.push({ key: newP, text: `R ${oldP} -> ${newP}` });
      consumed.add(oldP);
      consumed.add(newP);
    }
  }
  for (const p of [...tree.now.keys()]) {
    if (consumed.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const outLines = rows.map((r) => r.text);
  if (!check) {
    for (const p of [...tree.now.keys()]) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...outLines, `ok: ${outLines.length} ${outLines.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
