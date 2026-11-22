// mend: one patch tool for every AI edit format.
//
// Reads a patch in one of four formats (unified diff, SEARCH/REPLACE blocks,
// V4A, JSON tool calls), finds the lines each edit names at the first of three
// matching tiers, and writes every change or none. The whole contract is
// SPEC.md in this repository; this file implements all ten of its sections.
//
// Run as `node main.ts [--format=NAME] [--check] [--strict] [PATCH]` with the
// working directory as the root of the tree. Node 22, standard library only.
// When MAKEFUN_ENV_URL is set, the trial runner takes over instead (last lines).

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMAT_NAMES = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

/** A structural fault in the patch: exit 2 with `error: parse <line>`. */
class ParseFault extends Error {
  readonly lineNo: number;
  constructor(lineNo: number) {
    super(`error: parse ${lineNo}`);
    this.lineNo = lineNo;
  }
}

/** One edit failed: exit 1 with `error: <code> <path>`. */
class EditFault extends Error {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    super(`error: ${code} ${path}`);
    this.code = code;
    this.path = path;
  }
}

const isBlank = (s: string): boolean => s.trim() === '';

/** A patch's lines: split at \n, one trailing \r removed, no empty piece after a final \n. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/** SPEC section 3: a path is safe when it is not empty, does not start with /, holds no \, and none of its segments is empty, . or ... */
function safePath(p: string): boolean {
  if (p === '' || p.startsWith('/') || p.includes('\\')) return false;
  return p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

const stripTrailingWs = (s: string): string => s.replace(/[ \t]+$/, '');
const stripBothWs = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadingWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};

/** A file as lines: its line break, whether it ends with one, and its lines. */
interface FileState {
  lines: string[];
  br: string;
  ends: boolean;
}

function splitFile(text: string): FileState {
  if (text === '') return { lines: [], br: '\n', ends: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(br);
  const ends = text.endsWith(br);
  if (ends) lines.pop();
  return { lines, br, ends };
}

function joinFile(f: FileState): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.ends ? f.br : '');
}

/** The tree as the edits leave it. `now` holds changed paths (null: deleted); the rest is read from disk. */
class Tree {
  private readonly disk = new Map<string, string | null>();
  now = new Map<string, string | null>();
  moves: { old: string; new: string }[] = [];

  original(p: string): string | null {
    if (!this.disk.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.disk.set(p, v);
    }
    return this.disk.get(p)!;
  }

  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }

  set(p: string, v: string | null): void {
    this.now.set(p, v);
  }
}

type Edit = (tree: Tree) => void;

/** SPEC section 4: the first of these that holds, where a blank line is empty or only whitespace. */
function detectFormat(lines: string[]): string | null {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// ---------------------------------------------------------------------------
// Section 5: matching lines
// ---------------------------------------------------------------------------

/** Whether file line `a` equals patch line `b` at a tier. */
function lineMatches(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return stripTrailingWs(a) === stripTrailingWs(b);
  return stripBothWs(a) === stripBothWs(b);
}

/** Whether O occurs in `lines` at position `at`, at a tier. */
function occursAt(lines: string[], at: number, o: string[], tier: number): boolean {
  for (let k = 0; k < o.length; k++) {
    if (!lineMatches(lines[at + k]!, o[k]!, tier)) return false;
  }
  return true;
}

/** All positions where O occurs in `lines` at a tier. */
function occurrences(lines: string[], o: string[], tier: number): number[] {
  const out: number[] = [];
  for (let i = 0; i + o.length <= lines.length; i++) {
    if (occursAt(lines, i, o, tier)) out.push(i);
  }
  return out;
}

/** The first tier (0, 1, 2; or 0 only with --strict) at which O occurs, with its positions. */
function findTier(lines: string[], o: string[], strict: boolean): { tier: number; positions: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const positions = occurrences(lines, o, tier);
    if (positions.length > 0) return { tier, positions };
  }
  return null;
}

/** One line of a replacement: a context line (written as the file's own matched line) or a new line. */
interface NewLine {
  text: string;
  context: boolean;
  oIndex: number;
}

/**
 * Build the lines that replace a match: context lines are the file's own matched
 * lines; at tier 2 every other line is re-indented from O's first line to the
 * file's first matched line; at tiers 0 and 1 new lines are written as they are.
 */
function buildReplacement(fileLines: string[], at: number, o: string[], n: NewLine[], tier: number): string[] {
  if (tier !== 2) {
    return n.map((item) => (item.context ? fileLines[at + item.oIndex]! : item.text));
  }
  const f = leadingWs(fileLines[at]!);
  const p = leadingWs(o[0]!);
  return n.map((item) => {
    if (item.context) return fileLines[at + item.oIndex]!;
    const t = item.text;
    if (t === '' || t.trim() === '') return t;
    if (t.startsWith(p)) return f + t.slice(p.length);
    return t;
  });
}

/**
 * Split a hunk/chunk body into O (context and `-` lines) and N (context and `+`
 * lines, in body order), keeping for each context line of N its index in O.
 */
function splitBody(body: string[]): { o: string[]; n: NewLine[] } {
  const o: string[] = [];
  const n: NewLine[] = [];
  for (const line of body) {
    if (line.startsWith(' ')) {
      const t = line.slice(1);
      o.push(t);
      n.push({ text: t, context: true, oIndex: o.length - 1 });
    } else if (line.startsWith('-')) {
      o.push(line.slice(1));
    } else if (line.startsWith('+')) {
      n.push({ text: line.slice(1), context: false, oIndex: -1 });
    } else if (line === '') {
      o.push('');
      n.push({ text: '', context: true, oIndex: o.length - 1 });
    }
    // A `\` line refers to the body line before it; it is no line of O or N.
  }
  return { o, n };
}

// ---------------------------------------------------------------------------
// Section 9: JSON edits
// ---------------------------------------------------------------------------

/** One JSON edit object, or null when the value is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.path !== 'string') return null;
  const p = o.path;

  if (o.command === 'create') {
    if (typeof o.file_text !== 'string') return null;
    const text = o.file_text;
    return (tree) => {
      if (!safePath(p)) throw new EditFault('unsafe', p);
      if (tree.get(p) !== null) throw new EditFault('exists', p);
      tree.set(p, text);
    };
  }

  if (o.command === 'str_replace') {
    if (typeof o.old_str !== 'string' || o.old_str === '') return null;
    if (o.new_str !== undefined && typeof o.new_str !== 'string') return null;
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      if (!safePath(p)) throw new EditFault('unsafe', p);
      const before = tree.get(p);
      if (before === null) throw new EditFault('missing', p);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const plain = (s: string): string => (crlf ? s.split('\r\n').join('\n') : s);
      const t = plain(before);
      const old = plain(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new EditFault('no-match', p);
      if (count > 1) throw new EditFault('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + plain(newStr) + t.slice(at + old.length);
      tree.set(p, crlf ? out.split('\n').join('\r\n') : out);
    };
  }

  if (o.command === 'insert') {
    if (typeof o.insert_line !== 'number' || !Number.isInteger(o.insert_line)) return null;
    if (typeof o.new_str !== 'string') return null;
    const lineNo = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      if (!safePath(p)) throw new EditFault('unsafe', p);
      const before = tree.get(p);
      if (before === null) throw new EditFault('missing', p);
      const f = splitFile(before);
      if (lineNo < 0 || lineNo > f.lines.length) throw new EditFault('no-match', p);
      f.lines.splice(lineNo, 0, ...add);
      tree.set(p, joinFile(f));
    };
  }

  return null;
}

function parseJson(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new ParseFault(1);
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new ParseFault(first + 1);
    }
    if (!Array.isArray(v)) throw new ParseFault(first + 1);
    for (const item of v) {
      const e = jsonEdit(item);
      if (e === null) throw new ParseFault(first + 1);
      edits.push(e);
    }
  } else {
    lines.forEach((l, i) => {
      if (isBlank(l)) return;
      let e: Edit | null = null;
      try {
        e = jsonEdit(JSON.parse(l));
      } catch {
        e = null;
      }
      if (e === null) throw new ParseFault(i + 1);
      edits.push(e);
    });
  }
  if (edits.length === 0) throw new ParseFault(1);
  return edits;
}

// ---------------------------------------------------------------------------
// Section 6: unified diffs
// ---------------------------------------------------------------------------

interface UnifiedHunk {
  a: number;
  body: string[];
  noNewline: boolean;
}

interface UnifiedSection {
  diffOld: string | null;
  diffNew: string | null;
  pairOld: string | null;
  pairNew: string | null;
  renameFrom: string | null;
  renameTo: string | null;
  newFile: boolean;
  deletedFile: boolean;
  hunks: UnifiedHunk[];
}

function newUnifiedSection(): UnifiedSection {
  return {
    diffOld: null,
    diffNew: null,
    pairOld: null,
    pairNew: null,
    renameFrom: null,
    renameTo: null,
    newFile: false,
    deletedFile: false,
    hunks: [],
  };
}

/** The path after `--- ` / `+++ `: text after the four characters, up to the first tab, surrounding spaces removed, a leading a/ or b/ removed. */
function headerPath(raw: string): string {
  let p = raw.split('\t')[0]!.trim();
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

/** Whether a `\` line follows the hunk body's last context or `+` line. */
function backslashAfterLastAdded(body: string[]): boolean {
  for (let k = body.length - 1; k >= 0; k--) {
    const line = body[k]!;
    if (line.startsWith(' ') || line.startsWith('+') || line === '') {
      return k + 1 < body.length && body[k + 1]!.startsWith('\\');
    }
  }
  return false;
}

const HUNK_HEAD = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const DIFF_GIT = /^diff --git a\/(\S+) b\/(\S+)\s*$/;

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: UnifiedSection[] = [];
  let cur: UnifiedSection | null = null;
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = DIFF_GIT.exec(line);
      if (m === null) throw new ParseFault(i + 1);
      cur = newUnifiedSection();
      cur.diffOld = m[1]!;
      cur.diffNew = m[2]!;
      sections.push(cur);
      i += 1;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const oldP = headerPath(line.slice(4));
      const newP = headerPath(lines[i + 1]!.slice(4));
      if (cur !== null && cur.hunks.length === 0) {
        if (cur.pairOld === null) {
          cur.pairOld = oldP;
          cur.pairNew = newP;
        }
      } else {
        cur = newUnifiedSection();
        cur.pairOld = oldP;
        cur.pairNew = newP;
        sections.push(cur);
      }
      i += 2;
      continue;
    }
    if (line.startsWith('--- ')) {
      if (cur !== null && cur.hunks.length === 0) throw new ParseFault(i + 2);
      i += 1;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new ParseFault(i + 1);
      const m = HUNK_HEAD.exec(line);
      if (m === null) throw new ParseFault(i + 1);
      let j = i + 1;
      const body: string[] = [];
      while (j < n) {
        const b = lines[j]!;
        // The body ends at a `diff --git ` line, or at a `--- ` line followed by a `+++ ` line,
        // even though those start with `-` / `+` like body lines.
        if (b.startsWith('diff --git ')) break;
        if (b.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
        if (b === '' || b.startsWith(' ') || b.startsWith('-') || b.startsWith('+') || b.startsWith('\\')) {
          body.push(b);
          j += 1;
        } else break;
      }
      while (body.length > 0 && body[body.length - 1] === '') body.pop();
      cur.hunks.push({ a: Number(m[1]), body, noNewline: backslashAfterLastAdded(body) });
      i = j;
      continue;
    }
    if (cur !== null && cur.hunks.length === 0) {
      if (line.startsWith('rename from ')) cur.renameFrom = line.slice(12).trim();
      else if (line.startsWith('rename to ')) cur.renameTo = line.slice(10).trim();
      else if (line.startsWith('new file mode')) cur.newFile = true;
      else if (line.startsWith('deleted file mode')) cur.deletedFile = true;
      i += 1;
      continue;
    }
    i += 1;
  }
  if (sections.length === 0) throw new ParseFault(1);
  return sections.map((s) => unifiedEdit(s, strict));
}

/** Apply one section's hunks, in order, to a file's text; throws EditFault('no-match') when a hunk finds nothing. */
function applyUnifiedHunks(text: string, hunks: UnifiedHunk[], strict: boolean, path: string): string {
  const f = splitFile(text);
  let d = 0;
  for (const hunk of hunks) {
    const { o, n } = splitBody(hunk.body);
    if (o.length === 0) {
      const at = Math.min(Math.max(hunk.a + d, 0), f.lines.length);
      const atEnd = at === f.lines.length;
      const ins = n.map((item) => item.text);
      f.lines.splice(at, 0, ...ins);
      if (atEnd) f.ends = !hunk.noNewline;
      d += n.length;
      continue;
    }
    const found = findTier(f.lines, o, strict);
    if (found === null) throw new EditFault('no-match', path);
    const target = hunk.a - 1 + d;
    let best = found.positions[0]!;
    let bestDist = Math.abs(best - target);
    for (const pos of found.positions) {
      const dist = Math.abs(pos - target);
      if (dist < bestDist) {
        best = pos;
        bestDist = dist;
      }
    }
    const atEnd = best + o.length === f.lines.length;
    const rep = buildReplacement(f.lines, best, o, n, found.tier);
    f.lines.splice(best, o.length, ...rep);
    if (atEnd) f.ends = !hunk.noNewline;
    d += n.length - o.length;
  }
  return joinFile(f);
}

function unifiedEdit(sec: UnifiedSection, strict: boolean): Edit {
  const oldRaw = sec.pairOld ?? sec.renameFrom ?? sec.diffOld;
  const newRaw = sec.pairNew ?? sec.renameTo ?? sec.diffNew;
  const oldP = oldRaw === '/dev/null' ? null : oldRaw;
  const newP = newRaw === '/dev/null' ? null : newRaw;
  return (tree) => {
    if (oldP !== null && !safePath(oldP)) throw new EditFault('unsafe', oldP);
    if (newP !== null && !safePath(newP)) throw new EditFault('unsafe', newP);
    if (oldP === null || sec.newFile) {
      // A creation: the new path does not exist; the file is the `+` lines of all its hunks.
      if (newP === null) throw new EditFault('unsafe', '/dev/null');
      if (tree.get(newP) !== null) throw new EditFault('exists', newP);
      const plus: string[] = [];
      let ends = false;
      let sawPlus = false;
      for (const hunk of sec.hunks) {
        for (let k = 0; k < hunk.body.length; k++) {
          const line = hunk.body[k]!;
          if (line.startsWith('+')) {
            plus.push(line.slice(1));
            sawPlus = true;
            ends = !(k + 1 < hunk.body.length && hunk.body[k + 1]!.startsWith('\\'));
          }
        }
      }
      tree.set(newP, sawPlus ? plus.join('\n') + (ends ? '\n' : '') : '');
      return;
    }
    if (newP === null || sec.deletedFile) {
      // A deletion: the old path exists; its hunks are not read.
      if (tree.get(oldP) === null) throw new EditFault('missing', oldP);
      tree.set(oldP, null);
      return;
    }
    if (oldP !== newP) {
      // A move: the hunks apply to the old file's lines; the result is written at the new path.
      if (tree.get(oldP) === null) throw new EditFault('missing', oldP);
      if (tree.get(newP) !== null) throw new EditFault('exists', newP);
      const out = applyUnifiedHunks(tree.get(oldP)!, sec.hunks, strict, oldP);
      tree.set(newP, out);
      tree.set(oldP, null);
      tree.moves.push({ old: oldP, new: newP });
      return;
    }
    // A change of the one path.
    if (tree.get(oldP) === null) throw new EditFault('missing', oldP);
    tree.set(oldP, applyUnifiedHunks(tree.get(oldP)!, sec.hunks, strict, oldP));
  };
}

// ---------------------------------------------------------------------------
// Section 7: SEARCH/REPLACE blocks
// ---------------------------------------------------------------------------

interface SearchBlock {
  path: string;
  old: string[];
  nw: string[];
}

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const blocks: SearchBlock[] = [];
  let prevEnd = 0;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() === '<<<<<<< SEARCH') {
      let path: string | null = null;
      for (let j = i - 1; j >= prevEnd; j--) {
        const l = lines[j]!;
        if (l.trim() === '') continue;
        if (l.trim().startsWith('```')) continue;
        path = l.trim();
        break;
      }
      if (path === null) {
        if (blocks.length > 0) path = blocks[blocks.length - 1]!.path;
        else throw new ParseFault(i + 1);
      }
      let sep = -1;
      for (let j = i + 1; j < lines.length; j++) {
        if (lines[j]!.trimEnd() === '=======') {
          sep = j;
          break;
        }
      }
      if (sep < 0) throw new ParseFault(i + 1);
      let end = -1;
      for (let j = sep + 1; j < lines.length; j++) {
        if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
          end = j;
          break;
        }
      }
      if (end < 0) throw new ParseFault(i + 1);
      blocks.push({ path, old: lines.slice(i + 1, sep), nw: lines.slice(sep + 1, end) });
      prevEnd = end + 1;
      i = end + 1;
    } else {
      i += 1;
    }
  }
  if (blocks.length === 0) throw new ParseFault(1);
  return blocks.map((b) => searchReplaceEdit(b, strict));
}

function searchReplaceEdit(b: SearchBlock, strict: boolean): Edit {
  return (tree) => {
    if (!safePath(b.path)) throw new EditFault('unsafe', b.path);
    if (b.old.length === 0) {
      if (tree.get(b.path) !== null) throw new EditFault('exists', b.path);
      tree.set(b.path, b.nw.length === 0 ? '' : b.nw.join('\n') + '\n');
      return;
    }
    const cur = tree.get(b.path);
    if (cur === null) throw new EditFault('missing', b.path);
    const f = splitFile(cur);
    const found = findTier(f.lines, b.old, strict);
    if (found === null) throw new EditFault('no-match', b.path);
    if (found.positions.length > 1) throw new EditFault('ambiguous', b.path);
    const pos = found.positions[0]!;
    const n: NewLine[] = b.nw.map((t) => ({ text: t, context: false, oIndex: -1 }));
    const rep = buildReplacement(f.lines, pos, b.old, n, found.tier);
    f.lines.splice(pos, b.old.length, ...rep);
    tree.set(b.path, joinFile(f));
  };
}

// ---------------------------------------------------------------------------
// Section 8: V4A patches
// ---------------------------------------------------------------------------

interface V4aChunk {
  anchor: string | null;
  body: string[];
  eof: boolean;
}

interface V4aSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  lineNo: number;
  fileLines: string[];
  moveTo: string | null;
  chunks: V4aChunk[];
}

function v4aSectionKind(line: string): 'add' | 'delete' | 'update' | null {
  if (line.startsWith('*** Add File: ')) return 'add';
  if (line.startsWith('*** Delete File: ')) return 'delete';
  if (line.startsWith('*** Update File: ')) return 'update';
  return null;
}

function parseV4a(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => l.trim() !== '');
  if (first < 0) throw new ParseFault(1);
  if (lines[first]!.trim() !== '*** Begin Patch') throw new ParseFault(first + 1);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i]!.trim() !== '') {
      last = i;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new ParseFault(lines.length + 1);

  const sections: V4aSection[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (line.trim() === '') {
      i += 1;
      continue;
    }
    const kind = v4aSectionKind(line);
    if (kind === null) throw new ParseFault(i + 1);
    const prefixLen = kind === 'add' ? 14 : 17;
    const path = line.slice(prefixLen).trim();
    const sectionLineNo = i + 1;
    // The section's extent: up to the next section start, an End Patch line, or the patch's End Patch.
    let j = i + 1;
    while (j < last && v4aSectionKind(lines[j]!) === null && lines[j]!.trim() !== '*** End Patch') j += 1;
    const extent: { text: string; no: number }[] = [];
    for (let k = i + 1; k < j; k++) extent.push({ text: lines[k]!, no: k + 1 });
    // Blank lines at the end of a section are not part of it.
    while (extent.length > 0 && extent[extent.length - 1]!.text.trim() === '') extent.pop();

    if (kind === 'add') {
      const fileLines: string[] = [];
      for (const { text, no } of extent) {
        if (text.startsWith('+')) fileLines.push(text.slice(1));
        else if (text === '') fileLines.push('');
        else throw new ParseFault(no);
      }
      sections.push({ kind, path, lineNo: sectionLineNo, fileLines, moveTo: null, chunks: [] });
    } else if (kind === 'delete') {
      if (extent.length > 0) throw new ParseFault(extent[0]!.no);
      sections.push({ kind, path, lineNo: sectionLineNo, fileLines: [], moveTo: null, chunks: [] });
    } else {
      let moveTo: string | null = null;
      let idx = 0;
      if (extent.length > 0 && extent[0]!.text.startsWith('*** Move to: ')) {
        moveTo = extent[0]!.text.slice(13).trim();
        idx = 1;
      }
      const chunks: V4aChunk[] = [];
      let cur: V4aChunk | null = null;
      let started = false;
      for (let k = idx; k < extent.length; k++) {
        const { text: l, no } = extent[k]!;
        if (l.startsWith('@@')) {
          if (cur !== null) chunks.push(cur);
          const anchor = l.slice(2).trim();
          cur = { anchor: anchor === '' ? null : anchor, body: [], eof: false };
          started = true;
        } else if (l.trim() === '*** End of File') {
          if (cur === null) throw new ParseFault(no);
          cur.eof = true;
          chunks.push(cur);
          cur = null;
        } else if (l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || l === '') {
          if (cur === null) {
            if (!started) {
              cur = { anchor: null, body: [], eof: false };
              started = true;
            } else if (l.trim() === '') {
              continue;
            } else {
              throw new ParseFault(no);
            }
          }
          cur.body.push(l);
        } else {
          throw new ParseFault(no);
        }
      }
      if (cur !== null) chunks.push(cur);
      if (chunks.length === 0 && moveTo === null) throw new ParseFault(sectionLineNo);
      sections.push({ kind, path, lineNo: sectionLineNo, fileLines: [], moveTo, chunks });
    }
    i = j;
  }
  if (sections.length === 0) throw new ParseFault(1);
  return sections.map((s) => v4aEdit(s, strict));
}

function v4aEdit(sec: V4aSection, strict: boolean): Edit {
  if (sec.kind === 'add') {
    return (tree) => {
      if (!safePath(sec.path)) throw new EditFault('unsafe', sec.path);
      if (tree.get(sec.path) !== null) throw new EditFault('exists', sec.path);
      tree.set(sec.path, sec.fileLines.length === 0 ? '' : sec.fileLines.join('\n') + '\n');
    };
  }
  if (sec.kind === 'delete') {
    return (tree) => {
      if (!safePath(sec.path)) throw new EditFault('unsafe', sec.path);
      if (tree.get(sec.path) === null) throw new EditFault('missing', sec.path);
      tree.set(sec.path, null);
    };
  }
  return (tree) => {
    if (!safePath(sec.path)) throw new EditFault('unsafe', sec.path);
    if (sec.moveTo !== null && !safePath(sec.moveTo)) throw new EditFault('unsafe', sec.moveTo);
    const cur = tree.get(sec.path);
    if (cur === null) throw new EditFault('missing', sec.path);
    if (sec.moveTo !== null && tree.get(sec.moveTo) !== null) throw new EditFault('exists', sec.moveTo);
    const f = splitFile(cur);
    let cursor = 0;
    for (const chunk of sec.chunks) {
      if (chunk.anchor !== null) {
        let found = -1;
        const tiers = strict ? [0] : [0, 1, 2];
        for (const tier of tiers) {
          for (let j = cursor; j < f.lines.length; j++) {
            if (lineMatches(f.lines[j]!, chunk.anchor, tier)) {
              found = j;
              break;
            }
          }
          if (found >= 0) break;
        }
        if (found < 0) throw new EditFault('no-match', sec.path);
        cursor = found + 1;
      }
      const { o, n } = splitBody(chunk.body);
      if (o.length === 0) {
        const at = chunk.eof ? f.lines.length : cursor;
        f.lines.splice(at, 0, ...n.map((item) => item.text));
        cursor = at + n.length;
        continue;
      }
      let foundPos = -1;
      let foundTier = 0;
      const tiers = strict ? [0] : [0, 1, 2];
      for (const tier of tiers) {
        for (let j = cursor; j + o.length <= f.lines.length; j++) {
          if (chunk.eof && j + o.length !== f.lines.length) continue;
          if (occursAt(f.lines, j, o, tier)) {
            foundPos = j;
            foundTier = tier;
            break;
          }
        }
        if (foundPos >= 0) break;
      }
      if (foundPos < 0) throw new EditFault('no-match', sec.path);
      const rep = buildReplacement(f.lines, foundPos, o, n, foundTier);
      f.lines.splice(foundPos, o.length, ...rep);
      cursor = foundPos + n.length;
    }
    const out = joinFile(f);
    if (sec.moveTo !== null) {
      tree.set(sec.moveTo, out);
      tree.set(sec.path, null);
      tree.moves.push({ old: sec.path, new: sec.moveTo });
    } else {
      tree.set(sec.path, out);
    }
  };
}

// ---------------------------------------------------------------------------
// Sections 1, 2 and 10: invocation, output and exit codes, order and atomicity
// ---------------------------------------------------------------------------

function runCli(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') {
      ended = true;
    } else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=')) {
        const v = a.slice(9);
        if (format !== null || !FORMAT_NAMES.includes(v)) return { code: 2, out: ['error: usage'] };
        format = v;
      } else if (a === '--check') {
        if (check) return { code: 2, out: ['error: usage'] };
        check = true;
      } else if (a === '--strict') {
        if (strict) return { code: 2, out: ['error: usage'] };
        strict = true;
      } else {
        return { code: 2, out: ['error: usage'] };
      }
    } else {
      pos.push(a);
    }
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };

  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
    text = '';
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detectFormat(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };

  let edits: Edit[];
  try {
    if (kind === 'json') edits = parseJson(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, strict);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else edits = parseV4a(lines, strict);
  } catch (e) {
    if (e instanceof ParseFault) return { code: 2, out: [`error: parse ${e.lineNo}`] };
    throw e;
  }

  const tree = new Tree();
  const fails: EditFault[] = [];
  for (const edit of edits) {
    const snapshot = new Map(tree.now);
    const movesLen = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof EditFault)) throw e;
      tree.now.clear();
      for (const [k, v] of snapshot) tree.now.set(k, v);
      tree.moves.length = movesLen;
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return {
      code: 1,
      out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`],
    };
  }

  // What changed, in byte order of the paths (UTF-8); a move's R line sorts by its new path.
  const rows: { key: string; text: string }[] = [];
  const suppressD = new Set<string>();
  const suppressA = new Set<string>();
  for (const mv of tree.moves) {
    if (tree.original(mv.old) !== null && tree.get(mv.old) === null && tree.original(mv.new) === null && tree.get(mv.new) !== null) {
      rows.push({ key: mv.new, text: `R ${mv.old} -> ${mv.new}` });
      suppressD.add(mv.old);
      suppressA.add(mv.new);
    }
  }
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (was === null && suppressA.has(p)) continue;
    if (now === null && suppressD.has(p)) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key, 'utf8'), Buffer.from(b.key, 'utf8')));

  if (!check) {
    for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8')))) {
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
  return { code: 0, out: [...rows.map((r) => r.text), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = runCli(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
