/*! mermaid-contour: the Contour notation (the six standard views V1 to V6) as an external Mermaid diagram type.
 *  Standalone: depends only on mermaid.registerExternalDiagrams(). The geometry is a port of
 *  scripts/render_landscape.py (inches, origin bottom left) so that a diagram drawn here matches the
 *  book's figure: 1 inch = 100 SVG user units, 1 point = 100/72 units.
 *
 *  This is the interactive, web-only form of the views. The figures of the book are still rendered by
 *  scripts/render_landscape.py from landscape/models/; scripts/contour_text.py writes the Contour text of
 *  the same models, and scripts/render_contour.mjs renders it. See landscape/contour/README.md.
 *
 *  Load as a module (`import { registerContour } from './mermaid-contour.mjs'`) or as
 *  <script type="module"> after Mermaid, in which case it registers itself with window.mermaid.
 *
 *  Syntax
 *    contour
 *      view landscape|year|supply|decisions|evidence|compare     (default: one panel V1, two panels V6)
 *      title <text>            subtitle <text>            footer <text>      (footer may repeat)
 *      panel "Organisation"                                (V2: panel 1 = start, panel 2 = end; V6: two organisations)
 *        unit ID "Name" level=0..4 rev=R1..R4 reach=S|M|L|XL mode=0..5 [identity=person|own]
 *             [policy=enforced|planned|none] [tier=T0..T4] [evidence=automatic|attested|none]
 *             [status=active|planned|pilot|paused|retired] [kinds=logs,tests,gates,attestations]
 *             [hosting=own-premises|eu-supplier|eea-supplier|non-eu-supplier|unknown] [operated_by=self|supplier]
 *             [suppliers=id,id]
 *          action "rank the queue" 0                       (V4: one line per action class of the unit above)
 *      supplier ID "Label" "Location" role=model|hosting|application|operations jurisdiction=EU|EEA|non-EU   (V3)
 */

// ---------------------------------------------------------------------------
// Scales and palette (docs/NOTATION.md, docs/chart_palette.json)
// ---------------------------------------------------------------------------
const LEVEL_NAMES = ['Level 0 Advisory', 'Level 1 Assisted', 'Level 2 Supervised', 'Level 3 Bounded', 'Level 4 Autonomous'];
const REV_NAMES = { R1: 'Reversible at once', R2: 'Reversible with effort', R3: 'Hard to reverse', R4: 'Irreversible' };
const REV_ORDER = ['R1', 'R2', 'R3', 'R4']; // bottom row to top row
const REACH_RATIO = { S: 1.0, M: 1.6, L: 2.4, XL: 3.4 };
const REACH_LABELS = { S: 'S under 100', M: 'M 100 to 999', L: 'L 1,000 to 9,999', XL: 'XL 10,000 and more' };
const PAL = {
  background: '#F8FAFF', ink: '#182033', muted: '#4F5B71', grid: '#DFE5EE', people: '#6B7280',
  emptyCorner: '#FBE9E7', warning: '#C0392B', ice: '#E0F2FE', supplier: '#A3927F', nonEu: '#8C6D4E', automatic: '#182033', attested: '#6B7280',
  modes: [
    ['Mode 0 Ambient AI', '#7890B0'], ['Mode 1 Conversational assistants', '#3B82F6'],
    ['Mode 2 Embedded workplace assistants', '#40A090'], ['Mode 3 Agentic work tools', '#C88000'],
    ['Mode 4 Built AI applications', '#1B3A7A'], ['Mode 5 Autonomous production agents', '#B2367D'],
  ],
  ramp: ['#DCE6F7', '#AEC3E8', '#7897D3', '#4466B4', '#1B3A7A'],
};
const FONT = "Inter, 'DejaVu Sans', Arial, sans-serif";

const ENUMS = {
  rev: REV_ORDER, reach: ['S', 'M', 'L', 'XL'], identity: ['person', 'own'],
  policy: ['enforced', 'planned', 'none'], tier: ['T0', 'T1', 'T2', 'T3', 'T4'],
  evidence: ['automatic', 'attested', 'none'], status: ['active', 'planned', 'pilot', 'paused', 'retired'],
};
const SUPPLIER_ROLE_NAMES = { model: 'Model provider', hosting: 'Hosting', application: 'Application', operations: 'Operations' };
const VIEWS = ['landscape', 'year', 'supply', 'decisions', 'evidence', 'compare'];
const KNOWN = ['level', 'rev', 'reach', 'mode', 'identity', 'policy', 'tier', 'evidence', 'status', 'kinds', 'hosting', 'operated_by', 'suppliers'];
const EVIDENCE_COLUMNS = [['logs', 'Logs'], ['tests', 'Tests and evaluations'], ['gates', 'Gates and policies as code'], ['attestations', 'Attestations'], ['none', 'None']];
const AUTOMATIC_KINDS = ['logs', 'tests', 'gates'];
const HOSTING = ['own-premises', 'eu-supplier', 'eea-supplier', 'non-eu-supplier', 'unknown'];
ENUMS.hosting = HOSTING;
ENUMS.operated_by = ['self', 'supplier'];
ENUMS.role = ['model', 'hosting', 'application', 'operations'];
ENUMS.jurisdiction = ['EU', 'EEA', 'non-EU'];

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------
const STR = String.raw`"((?:[^"\\]|\\.)*)"`; // a double-quoted string; \" and \\ escape
const unquote = (v) => (v == null ? v : v.replace(/\\(.)/g, '$1'));

/** Remove a trailing `%% comment` (it must follow whitespace or start the line) but never inside quotes. */
function stripComment(raw) {
  let quoted = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (quoted && ch === '\\') { i++; continue; }
    if (ch === '"') quoted = !quoted;
    else if (!quoted && ch === '%' && raw[i + 1] === '%' && (i === 0 || /\s/.test(raw[i - 1]))) return raw.slice(0, i);
  }
  return raw;
}

/** Parse the text of a diagram into { view, title, subtitle, footer[], panels[{name, units[]}], suppliers[] }. */
export function parseContour(text) {
  const model = { view: null, title: '', subtitle: '', footer: [], panels: [], suppliers: [] };
  let seenHeader = false, implicitPanel = false, ids = new Set();
  const attrs = (rest, at, id, known) => {
    const a = Object.create(null);
    const stripped = rest.replace(/(\w+)=([\w,.-]+)/g, (_, k, v) => {
      if (k in a) throw new Error(at + `${id}: ${k} is given twice`);
      a[k] = v; return '';
    });
    if (stripped.trim()) throw new Error(at + `${id}: cannot read "${stripped.trim()}"`);
    for (const k of Object.keys(a)) if (!known.includes(k)) throw new Error(at + `${id}: unknown attribute ${k} (known: ${known.join(', ')})`);
    return a;
  };
  const checker = (a, at, id) => ({
    int(k, lo, hi) {
      const n = /^\d+$/.test(a[k]) ? Number(a[k]) : NaN;
      if (!Number.isInteger(n) || n < lo || n > hi) throw new Error(at + `${id}: ${k}=${a[k]} must be ${lo} to ${hi}`);
      return n;
    },
    one(k, dflt) {
      const v = a[k] ?? dflt;
      if (!ENUMS[k].includes(v)) throw new Error(at + `${id}: ${k}=${v} must be one of ${ENUMS[k].join(', ')}`);
      return v;
    },
  });
  let last = null;
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = stripComment(raw).trim();
    if (!line) return;
    const at = `Contour, line ${i + 1}: `;
    if (!seenHeader) {
      if (!/^contour(-beta)?$/.test(line)) throw new Error(at + 'expected "contour"');
      seenHeader = true; return;
    }
    let m = line.match(/^view\s+(\w+)$/);
    if (m) {
      if (!VIEWS.includes(m[1])) throw new Error(at + `view must be one of ${VIEWS.join(', ')}`);
      model.view = m[1]; return;
    }
    m = line.match(/^(title|subtitle|footer)\s+(.+)$/);
    if (m) {
      // Text that holds `%%` or starts with a quote is written as a quoted string.
      const quoted = m[2].match(new RegExp(`^${STR}$`));
      const value = quoted ? unquote(quoted[1]) : m[2];
      if (m[1] === 'footer') model.footer.push(value); else model[m[1]] = value;
      return;
    }
    m = line.match(new RegExp(`^panel\\s+${STR}$`));
    if (m) {
      if (implicitPanel) throw new Error(at + 'units before the first panel line belong to no panel; put a panel line first');
      model.panels.push({ name: unquote(m[1]), units: [] }); last = null; ids = new Set(); return;
    }
    m = line.match(new RegExp(`^supplier\\s+([\\w][\\w-]*)\\s+${STR}(?:\\s+${STR})?(?:\\s+(.*))?$`));
    if (m) {
      const [, id, label, location, rest = ''] = m;
      const a = attrs(rest, at, id, ['role', 'jurisdiction']);
      const c = checker(a, at, id);
      if (model.suppliers.some((x) => x.id === id)) throw new Error(at + `supplier ${id} is declared twice`);
      model.suppliers.push({ id, label: unquote(label), location: unquote(location) || null, role: c.one('role'), jurisdiction: c.one('jurisdiction') });
      return;
    }
    m = line.match(new RegExp(`^action\\s+${STR}\\s+(\\d+)$`));
    if (m) {
      if (!last) throw new Error(at + 'an action line belongs under a unit');
      if (Number(m[2]) > 4) throw new Error(at + `${last.id}: action level must be 0 to 4`);
      last.actions.push([unquote(m[1]), Number(m[2])]); return;
    }
    m = line.match(new RegExp(`^unit\\s+([\\w][\\w-]*)\\s+${STR}(?:\\s+(.*))?$`));
    if (!m) throw new Error(at + `cannot read "${line}". Expected: unit ID "Name" key=value ...`);
    const [, id, rawName, rest = ''] = m;
    const name = unquote(rawName);
    const a = attrs(rest, at, id, KNOWN);
    for (const k of ['level', 'rev', 'reach', 'mode']) if (!(k in a)) throw new Error(at + `${id} lacks ${k}`);
    const c = checker(a, at, id);
    if (!model.panels.length) { model.panels.push({ name: '', units: [] }); implicitPanel = true; }
    if (ids.has(id)) throw new Error(at + `${id} is declared twice in this panel`);
    ids.add(id);
    const kinds = a.kinds ? a.kinds.split(',') : [];
    for (const k of kinds) if (!EVIDENCE_COLUMNS.some(([key]) => key === k && key !== 'none')) throw new Error(at + `${id}: kinds has "${k}", expected logs, tests, gates or attestations`);
    // Absences are drawn as absences: a missing value is "none", never a guess.
    last = {
      id, name, level: c.int('level', 0, 4), reversibility: c.one('rev'), reach: c.one('reach'), mode: c.int('mode', 0, 5),
      identity: c.one('identity', 'person'), policy: c.one('policy', 'none'), tier: c.one('tier', 'T0'),
      evidence: c.one('evidence', 'none'), status: c.one('status', 'active'), kinds,
      hosting: c.one('hosting', 'unknown'), operatedBy: c.one('operated_by', 'self'),
      suppliers: a.suppliers ? a.suppliers.split(',') : [], actions: [],
    };
    model.panels[model.panels.length - 1].units.push(last);
  });
  if (!seenHeader) throw new Error('Contour: empty diagram');
  if (model.panels.length > 2) throw new Error('Contour: at most two panels (V2 start and end, V6 two organisations)');
  const view = model.view || (model.panels.length === 2 ? 'compare' : 'landscape');
  if ((view === 'compare' || view === 'year') && model.panels.length !== 2) throw new Error(`Contour: view ${view} needs two panels`);
  if (view !== 'compare' && view !== 'year' && model.panels.length > 1) throw new Error(`Contour: view ${view} takes one panel`);
  if (!model.panels.length) model.panels.push({ name: '', units: [] }); // a view without units is an empty view
  model.view = view;
  return model;
}

// ---------------------------------------------------------------------------
// Geometry, in inches (scripts/render_landscape.py)
// ---------------------------------------------------------------------------
const UNIT_RADIUS = 0.075;
const SQUARE_FACTOR = Math.sqrt(Math.PI) / 2;
const DIAMOND_HALF = 0.055, SEAT_RADIUS = 0.07, SEAT_GAP = 0.02, BASELINE_GAP = 0.045;
const LABEL_GAP = 0.02, LABEL_HEIGHT = 0.13, CHAR_WIDTH = 0.07, LINE_PITCH = 0.15;
const CELL_V1 = 1.46, CELL_V6 = 1.28, MARK_SCALE_V6 = CELL_V6 / CELL_V1;
const LEGEND_WIDTH = 2.0, LEGEND_WIDTH_V6 = 1.7, ROW_LABEL_WIDTH = 0.5, COL_LABEL_HEIGHT = 0.45;
const TITLE_BAND = 0.55, FOOTER_BAND = 0.46, FOOTER_LINE = 0.14, LEGEND_TOP = 0.3;
const LEGEND_BOTTOM = FOOTER_BAND + 0.04, MARGIN = 0.3, SIZE_BLOCK_HEIGHT = 0.66;
const FONT_SIZE = 9, TITLE_SIZE = 14;
const ITEM_GAP_X = 0.04, ITEM_GAP_Y = 0.04;
const IN = 100, PT = IN / 72;
const round = (v, d) => { const f = 10 ** d; return Math.round(v * f) / f; };

const radius = (u, scale = 1) => UNIT_RADIUS * REACH_RATIO[u.reach] * scale;
const halfExtent = (u, scale = 1) => (u.identity === 'person' ? radius(u, scale) : radius(u, scale) * SQUARE_FACTOR);
const hollow = (u) => u.status === 'paused' || u.status === 'retired';
const redRule = (u) => u.level === 3 && u.policy !== 'enforced';
const cpLen = (s) => [...s].length; // Python counts code points, JavaScript UTF-16 units
const cpSlice = (s, a, b) => [...s].slice(a, b).join('');
const textWidth = (s, size = FONT_SIZE) => cpLen(s) * CHAR_WIDTH * (size / FONT_SIZE);

// WCAG contrast, to choose white or ink text on a fill
const lum = (c) => {
  const ch = (v) => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; };
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
  return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
};
const contrast = (a, b) => { const [la, lb] = [lum(a), lum(b)]; return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05); };
const textOn = (fill) => (contrast(fill, '#FFFFFF') >= contrast(fill, PAL.ink) ? '#FFFFFF' : PAL.ink);
const modeColour = (m) => PAL.modes[m][1];

// Python 3.12's textwrap.TextWrapper.wordsep_re (letters = [^\d\W], word punctuation = [\w!"'&.,?]), with
// Unicode classes in place of Python's Unicode-aware \w.
const W = String.raw`[\p{L}\p{N}_]`, LT = String.raw`[\p{L}_]`, WP = String.raw`[\p{L}\p{N}_!"'&.,?]`, WS = String.raw`[\t\n\x0b\x0c\r ]`;
const WORDSEP = new RegExp(
  `(${WS}+|(?<=${WP})-{2,}(?=${W})|[^\\t\\n\\x0b\\x0c\\r ]+?(?:-(?:(?<=${LT}{2}-)|(?<=${LT}-${LT}-))(?=${LT}-?${LT})|(?=${WS}|$)|(?<=${WP})(?=-{2,}${W})))`,
  'u',
);

/** Python's textwrap.wrap(text, width) with its defaults (drop_whitespace, break_long_words, break_on_hyphens). */
function pyWrap(text, width) {
  let col = 0, expanded = '';
  for (const ch of text) { // expandtabs(8)
    if (ch === '\t') { const n = 8 - (col % 8); expanded += ' '.repeat(n); col += n; } else { expanded += ch; col = ch === '\n' || ch === '\r' ? 0 : col + 1; }
  }
  const chunks = expanded.replace(/[\t\n\x0b\x0c\r]/g, ' ').split(WORDSEP).filter(Boolean).map((c) => [...c]);
  const lines = [];
  let i = 0;
  const blank = (c) => c.join('').trim() === '';
  while (i < chunks.length) {
    let cur = [], curLen = 0;
    if (i < chunks.length && blank(chunks[i]) && lines.length) i++;
    while (i < chunks.length) {
      const l = chunks[i].length;
      if (curLen + l <= width) { cur.push(chunks[i++]); curLen += l; } else break;
    }
    if (i < chunks.length && chunks[i].length > width) {
      const space = width < 1 ? 1 : width - curLen;
      const chunk = chunks[i];
      let end = space;
      if (chunk.length > space) { // break after the last hyphen if letters precede it
        const hyphen = chunk.slice(0, space).lastIndexOf('-');
        if (hyphen > 0 && chunk.slice(0, hyphen).some((c) => c !== '-')) end = hyphen + 1;
      }
      cur.push(chunk.slice(0, end)); chunks[i] = chunk.slice(end);
      curLen = cur.reduce((n, c) => n + c.length, 0);
    }
    if (cur.length && blank(cur[cur.length - 1])) { curLen -= cur[cur.length - 1].length; cur.pop(); }
    if (cur.length) lines.push(cur.map((c) => c.join('')).join(''));
  }
  return lines;
}

/** scripts/render_landscape.py wrap_to_width: wrap to a width in inches, optionally to at most `maxLines`. */
export function wrapToWidth(s, width, size = FONT_SIZE, maxLines = null) {
  const chars = Math.max(8, Math.floor(width / (CHAR_WIDTH * size / FONT_SIZE)));
  let lines = pyWrap(s, chars);
  if (!lines.length) lines = [''];
  if (maxLines && lines.length > maxLines) {
    lines = lines.slice(0, maxLines);
    lines[maxLines - 1] = cpSlice(lines[maxLines - 1], 0, Math.max(1, chars - 1)).trimEnd() + '…';
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Canvas: primitives in inches, y up; stacked by z-order like matplotlib
// ---------------------------------------------------------------------------
const NS = 'http://www.w3.org/2000/svg';
let patternCounter = 0;
class Canvas {
  constructor(width, height) { this.width = width; this.height = height; this.items = []; this.defs = []; }
  /** matplotlib's hatch '////': 12 diagonal lines per inch tile, anchored at the canvas's bottom left. */
  hatchPattern(colour) {
    this.patterns ??= new Map();
    if (this.patterns.has(colour)) return this.patterns.get(colour);
    const id = `contour-hatch-${++patternCounter}`;
    this.patterns.set(colour, id);
    const pat = document.createElementNS(NS, 'pattern');
    for (const [k, v] of Object.entries({ id, patternUnits: 'userSpaceOnUse', x: 0, y: round((this.height * IN) % IN, 2), width: IN, height: IN })) pat.setAttribute(k, v);
    for (let j = 0; j <= 24; j++) {
      const c = (IN * j) / 12, l = document.createElementNS(NS, 'line');
      for (const [k, v] of Object.entries({ x1: -IN, y1: round(c + IN, 2), x2: 2 * IN, y2: round(c - 2 * IN, 2), stroke: colour, 'stroke-width': round(0.8 * PT, 2) })) l.setAttribute(k, v);
      pat.appendChild(l);
    }
    this.defs.push(pat);
    return id;
  }
  X(x) { return round(x * IN, 2); }
  Y(y) { return round((this.height - y) * IN, 2); }
  push(z, tag, attrs, text) {
    const el = document.createElementNS(NS, tag);
    for (const k in attrs) if (attrs[k] != null) el.setAttribute(k, attrs[k]);
    if (text != null) el.textContent = text;
    this.items.push({ z, i: this.items.length, el });
    return el;
  }
  text(x, y, s, { size = FONT_SIZE, colour = PAL.ink, ha = 'left', va = 'center', weight = 'normal', rotation = 0, zorder = 8, style = 'normal' } = {}) {
    // matplotlib aligns text by a line box [baseline - A, baseline + D] with the font's typographic
    // ascent and descent (Inter: A = 0.969 em, D = 0.241 em, measured against matplotlib 3.11);
    // browsers use other baselines. Put the alphabetic baseline where matplotlib puts it, so that
    // text lands on the same pixels.
    const A = 0.96875, D = 0.2412, fs = size * PT;
    const X = this.X(x), Y = this.Y(y);
    const baseline = Y + { center: (A - D) / 2, top: A, bottom: -D }[va] * fs;
    this.push(zorder, 'text', {
      x: X, y: round(baseline, 2), 'font-size': round(fs, 2), fill: colour, 'font-family': FONT,
      'text-anchor': { left: 'start', center: 'middle', right: 'end' }[ha],
      'font-weight': weight === 'bold' ? 700 : null, 'font-style': style === 'italic' ? 'italic' : null,
      transform: rotation ? `rotate(${-rotation} ${X} ${Y})` : null,
    }, s);
  }
  line(xs, ys, { colour, lw = 1, dashes = null, zorder = 3, capstyle = 'butt' }) {
    this.push(zorder, 'polyline', {
      points: xs.map((x, k) => `${this.X(x)},${this.Y(ys[k])}`).join(' '), fill: 'none', stroke: colour,
      'stroke-width': round(lw * PT, 2), 'stroke-linecap': capstyle, 'stroke-linejoin': 'round',
      'stroke-dasharray': dashes ? dashes.map((d) => round(d * lw * PT, 2)).join(' ') : null,
    });
  }
  rect(x, y, w, h, { face = 'none', edge = 'none', lw = 1, zorder = 1, rounding = 0, hatch = null, dashes = null } = {}) {
    if (hatch) {
      const id = this.hatchPattern(hatch);
      this.rect(x, y, w, h, { face: `url(#${id})`, zorder: zorder + 0.001 });
    }
    this.push(zorder, 'rect', {
      x: this.X(x), y: this.Y(y + h), width: round(w * IN, 2), height: round(h * IN, 2), fill: face, stroke: edge,
      'stroke-width': edge === 'none' ? null : round(lw * PT, 2), rx: rounding ? round(rounding * IN, 2) : null,
      'stroke-dasharray': dashes ? dashes.map((d) => round(d * lw * PT, 2)).join(' ') : null,
    });
  }
  circle(x, y, r, { face, edge, lw = 1, zorder = 4 }) {
    this.push(zorder, 'circle', { cx: this.X(x), cy: this.Y(y), r: round(r * IN, 2), fill: face, stroke: edge, 'stroke-width': lw ? round(lw * PT, 2) : null });
  }
  roundedSquare(x, y, half, { face, edge, lw = 1, zorder = 4 }) {
    this.rect(x - half, y - half, 2 * half, 2 * half, { face, edge, lw, zorder, rounding: 0.3 * half });
  }
  diamond(x, y, half, { filled, colour, zorder = 6 }) {
    const p = [[x - half, y], [x, y + half], [x + half, y], [x, y - half]];
    this.push(zorder, 'polygon', {
      points: p.map(([a, b]) => `${this.X(a)},${this.Y(b)}`).join(' '), fill: filled ? colour : PAL.background,
      stroke: colour, 'stroke-width': round(PT, 2),
    });
  }
  flush(svg) {
    if (this.defs.length) { const d = document.createElementNS(NS, 'defs'); this.defs.forEach((p) => d.appendChild(p)); svg.appendChild(d); }
    this.items.sort((a, b) => a.z - b.z || a.i - b.i).forEach(({ el }) => svg.appendChild(el));
  }
}

// ---------------------------------------------------------------------------
// Marks
// ---------------------------------------------------------------------------
const labelBeside = (u) => u.reach === 'S' || u.reach === 'M';

function markFootprint(u, { seat = true, label = true, isNew = false, scale = 1 } = {}) {
  const e = halfExtent(u, scale);
  let left = e + DIAMOND_HALF + 0.01, right = e + 0.02;
  const up = e + (seat && u.tier !== 'T0' ? SEAT_GAP + 2 * SEAT_RADIUS : 0.03);
  let down = e + BASELINE_GAP + 0.03;
  if (label && labelBeside(u)) {
    right = e + LABEL_GAP + 0.02 + textWidth(u.id) + 0.08 + (isNew ? textWidth('new') + 0.2 : 0);
    down = Math.max(down, LABEL_HEIGHT / 2);
  } else if (label) {
    const half = textWidth(u.id) / 2 + 0.04;
    left = Math.max(left, half); right = Math.max(right, half);
    down += LABEL_GAP + LABEL_HEIGHT + (isNew ? LABEL_HEIGHT : 0);
  }
  return { left, right, up, down, width: left + right };
}

function ghostFootprint(u, scale = 1) {
  const e = halfExtent(u, scale) + 0.02;
  return { left: e, right: e, up: e, down: e, width: 2 * e };
}

const digitSize = (r) => Math.max(FONT_SIZE, Math.min(12.0, 4.0 + r * 32.0));

function drawShape(cv, x, y, u, half, o) {
  if (u.identity === 'person') cv.circle(x, y, half, o); else cv.roundedSquare(x, y, half, o);
}

function drawMark(cv, x, y, u, { label = true, scale = 1, hollowOverride = null, crossedOverride = null, isNew = false } = {}) {
  const colour = modeColour(u.mode), hol = hollowOverride ?? hollow(u), e = halfExtent(u, scale);
  drawShape(cv, x, y, u, e, { face: hol ? PAL.background : colour, edge: colour, lw: 1.4, zorder: 4 });
  if (redRule(u)) drawShape(cv, x, y, u, e + 0.03, { face: 'none', edge: PAL.warning, lw: 1.3, zorder: 3.5 });
  cv.text(x, y, String(u.mode), { size: digitSize(radius(u, scale)), colour: hol ? colour : textOn(colour), ha: 'center', weight: 'bold', zorder: 5 });
  if (crossedOverride ?? u.status === 'retired') {
    const d = e * 0.75;
    cv.line([x - d, x + d], [y - d, y + d], { colour: PAL.ink, lw: 1.3, zorder: 5.5 });
    cv.line([x - d, x + d], [y + d, y - d], { colour: PAL.ink, lw: 1.3, zorder: 5.5 });
  }
  if (u.policy !== 'none') cv.diamond(x - e, y, DIAMOND_HALF, { filled: u.policy === 'enforced', colour: PAL.ink });
  if (u.tier !== 'T0') {
    const cy = y + e + SEAT_GAP + SEAT_RADIUS;
    cv.circle(x, cy, SEAT_RADIUS, { face: PAL.people, edge: PAL.people, lw: 0, zorder: 4 });
    cv.text(x, cy, u.tier[1], { colour: '#FFFFFF', ha: 'center', weight: 'bold', zorder: 5 });
  }
  const yBase = y - e - BASELINE_GAP;
  if (u.evidence !== 'none') {
    const half = Math.max(0.8 * e, 0.1);
    if (u.evidence === 'automatic') cv.line([x - half, x + half], [yBase, yBase], { colour: PAL.automatic, lw: 1.8, zorder: 4 });
    else cv.line([x - half, x + half], [yBase, yBase], { colour: PAL.attested, lw: 1.8, dashes: [3, 2], zorder: 4 });
  }
  cv.push(9, 'desc', { 'data-unit': u.id, 'data-x': round(x, 4), 'data-y': round(y, 4) });
  let tickX, tickY;
  if (label && labelBeside(u)) {
    const lx = x + e + LABEL_GAP + 0.02;
    cv.text(lx, y, u.id, { colour: PAL.muted });
    [tickX, tickY] = [lx + textWidth(u.id) + 0.16, y];
  } else if (label) {
    cv.text(x, yBase - 0.02 - LABEL_GAP, u.id, { colour: PAL.muted, ha: 'center', va: 'top' });
    [tickX, tickY] = [x - 0.14, yBase - 0.02 - LABEL_GAP - LABEL_HEIGHT - 0.06];
  } else [tickX, tickY] = [x + e + 0.08, y];
  if (isNew) { // a small tick and the word "new" beside or under the label
    cv.line([tickX - 0.05, tickX - 0.02, tickX + 0.04], [tickY, tickY - 0.04, tickY + 0.055], { colour, lw: 1.6, zorder: 6, capstyle: 'round' });
    cv.text(tickX + 0.08, tickY, 'new', { colour });
  }
}

function drawGhost(cv, x, y, u, scale = 1) {
  drawShape(cv, x, y, u, halfExtent(u, scale), { face: 'none', edge: modeColour(u.mode), lw: 1.0, zorder: 2.5 });
}

// ---------------------------------------------------------------------------
// Layout of several marks in one cell
// ---------------------------------------------------------------------------
function packRows(items, maxW) {
  const rows = [[]];
  let used = 0;
  for (const it of items) {
    const w = it.fp.width;
    if (rows[rows.length - 1].length && used + ITEM_GAP_X + w > maxW) { rows.push([]); used = 0; }
    if (rows[rows.length - 1].length) used += ITEM_GAP_X;
    rows[rows.length - 1].push(it);
    used += w;
  }
  return rows;
}
const rowsExtent = (rows) => [
  Math.max(...rows.map((r) => r.reduce((s, it) => s + it.fp.width, 0) + ITEM_GAP_X * (r.length - 1))),
  rows.reduce((s, r) => s + Math.max(...r.map((it) => it.fp.up)) + Math.max(...r.map((it) => it.fp.down)), 0) + ITEM_GAP_Y * (rows.length - 1),
];

function layoutInCell(items, cellW, cellH, edge = null) {
  if (!items.length) return {};
  const ordered = [...items].sort((a, b) => {
    const ka = -(a.fp.width * (a.fp.up + a.fp.down)), kb = -(b.fp.width * (b.fp.up + b.fp.down));
    return ka - kb || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  });
  const pad = 0.05;
  const candidates = [[[...ordered]]];
  for (const f of [1.3, 1.2, 1.1, 1.0, 0.9, 0.8, 0.6, 0.45]) candidates.push(packRows(ordered, (cellW - 2 * pad) * f));
  candidates.push(ordered.map((it) => [it]));
  const overflow = (rows) => {
    const [w, h] = rowsExtent(rows);
    return [round(3 * Math.max(w - (cellW - 2 * pad), 0) + Math.max(h - (cellH - 2 * pad), 0), 4), rows.length];
  };
  let best = candidates[0], bo = overflow(best);
  for (const c of candidates.slice(1)) {
    const o = overflow(c);
    if (o[0] < bo[0] || (o[0] === bo[0] && o[1] < bo[1])) { best = c; bo = o; }
  }
  const [, height] = rowsExtent(best);
  const pos = Object.create(null);
  let cy = height / 2;
  for (const row of best) {
    const up = Math.max(...row.map((it) => it.fp.up)), down = Math.max(...row.map((it) => it.fp.down));
    const rowW = row.reduce((s, it) => s + it.fp.width, 0) + ITEM_GAP_X * (row.length - 1);
    let cx = -rowW / 2;
    for (const it of row) { pos[it.key] = [round(cx + it.fp.left, 6), round(cy - up, 6)]; cx += it.fp.width + ITEM_GAP_X; }
    cy -= up + down + ITEM_GAP_Y;
  }
  if (edge === 'top' || edge === 'bottom') {
    const excess = height / 2 - (cellH / 2 - pad);
    if (excess > 0) {
      const shift = edge === 'top' ? -excess : excess;
      for (const k in pos) pos[k] = [pos[k][0], round(pos[k][1] + shift, 6)];
    }
  }
  return pos;
}

// ---------------------------------------------------------------------------
// The grid
// ---------------------------------------------------------------------------
const gridCentre = (g, level, rev) => [g.x0 + (level + 0.5) * g.cell, g.y0 + (REV_ORDER.indexOf(rev) + 0.5) * g.cell];

function drawGrid(cv, g, { rowLabels = true } = {}) {
  const { x0, y0, cell: c } = g;
  cv.rect(x0 + 4 * c, y0 + 3 * c, c, c, { face: PAL.emptyCorner, zorder: 0.5 });
  cv.text(x0 + 4.5 * c, y0 + 4 * c - 0.1, 'the empty corner', { colour: PAL.warning, ha: 'center', va: 'top', zorder: 1, style: 'italic' });
  for (let i = 0; i < 6; i++) cv.line([x0 + i * c, x0 + i * c], [y0, y0 + 4 * c], { colour: PAL.grid, lw: i === 0 || i === 5 ? 0.8 : 0.6, zorder: 1 });
  for (let j = 0; j < 5; j++) cv.line([x0, x0 + 5 * c], [y0 + j * c, y0 + j * c], { colour: PAL.grid, lw: j === 0 || j === 4 ? 0.8 : 0.6, zorder: 1 });
  LEVEL_NAMES.forEach((name, i) => {
    const [a, b, ...rest] = name.split(' ');
    const cx = x0 + (i + 0.5) * c;
    cv.text(cx, y0 - 0.09, `${a} ${b}`, { size: FONT_SIZE + 0.5, ha: 'center', va: 'top', weight: 'bold' });
    cv.text(cx, y0 - 0.25, rest.join(' '), { colour: PAL.muted, ha: 'center', va: 'top' });
  });
  if (rowLabels) REV_ORDER.forEach((tier, j) => {
    const cy = y0 + (j + 0.5) * c;
    cv.text(x0 - 0.3, cy, tier, { size: FONT_SIZE + 0.5, ha: 'center', weight: 'bold', rotation: 90 });
    cv.text(x0 - 0.14, cy, REV_NAMES[tier], { colour: PAL.muted, ha: 'center', rotation: 90 });
  });
}

function placeUnits(units, g, scale) {
  const byCell = new Map();
  for (const u of [...units].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    const k = `${u.level},${u.reversibility}`;
    if (!byCell.has(k)) byCell.set(k, []);
    byCell.get(k).push({ key: u.id, fp: markFootprint(u, { scale }), u });
  }
  const out = Object.create(null);
  for (const items of byCell.values()) {
    const { level, reversibility } = items[0].u;
    const [cx, cy] = gridCentre(g, level, reversibility);
    const edge = { R4: 'top', R1: 'bottom' }[reversibility] ?? null;
    const p = layoutInCell(items, g.cell, g.cell, edge);
    for (const k in p) out[k] = [cx + p[k][0], cy + p[k][1]];
  }
  return out;
}

function drawPanel(cv, g, units, { rowLabels = true, scale = 1 } = {}) {
  drawGrid(cv, g, { rowLabels });
  const pos = placeUnits(units, g, scale);
  for (const u of [...units].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) { // Python draws in id order
    const [x, y] = pos[u.id];
    drawMark(cv, x, y, u, { scale });
  }
  return pos;
}

// ---------------------------------------------------------------------------
// Legend and summary strip
// ---------------------------------------------------------------------------
function legendItems(width, { trail = false, containers = false } = {}) {
  const swW = 0.24, textW = width - swW;
  const items = [];
  const header = (t) => items.push({ lines: [t], header: true });
  const line = (t, swatch = null) => items.push({ lines: wrapToWidth(t, swatch ? textW : width), swatch });
  const modeSw = (m) => (cv, x, y) => {
    const c = modeColour(m);
    cv.circle(x + 0.075, y, 0.07, { face: c, edge: c, lw: 0 });
    cv.text(x + 0.075, y, String(m), { colour: textOn(c), ha: 'center', weight: 'bold' });
  };
  header('Columns: autonomy level');
  LEVEL_NAMES.forEach((n) => line(n));
  header('Rows: reversibility');
  [...REV_ORDER].reverse().forEach((t) => line(`${t} ${REV_NAMES[t]}`));
  header('Size: reach (people a year)');
  items.push({ lines: ['__sizes__'], height: SIZE_BLOCK_HEIGHT });
  header('Colour: usage mode');
  PAL.modes.forEach(([name], m) => line(name, modeSw(m)));
  header('Shape: identity');
  line("a person's identity", (cv, x, y) => cv.circle(x + 0.075, y, 0.07, { face: PAL.background, edge: PAL.ink, lw: 1.2 }));
  line('an identity of its own', (cv, x, y) => cv.roundedSquare(x + 0.075, y, 0.07 * SQUARE_FACTOR + 0.005, { face: PAL.background, edge: PAL.ink, lw: 1.2 }));
  header('Diamond: policy point');
  line('enforced', (cv, x, y) => cv.diamond(x + 0.075, y, DIAMOND_HALF, { filled: true, colour: PAL.ink }));
  line('planned; absent: none', (cv, x, y) => cv.diamond(x + 0.075, y, DIAMOND_HALF, { filled: false, colour: PAL.ink }));
  header('Seat: decision tier');
  line('T1 to T4; absent: T0', (cv, x, y) => {
    cv.circle(x + 0.075, y, SEAT_RADIUS, { face: PAL.people, edge: PAL.people, lw: 0 });
    cv.text(x + 0.075, y, '2', { colour: '#FFFFFF', ha: 'center', weight: 'bold' });
  });
  header('Baseline: evidence');
  line('automatic', (cv, x, y) => cv.line([x, x + 0.18], [y, y], { colour: PAL.automatic, lw: 1.8 }));
  line('attested; absent: none', (cv, x, y) => cv.line([x, x + 0.18], [y, y], { colour: PAL.attested, lw: 1.8, dashes: [3, 2] }));
  if (containers) {
    const box = (colour, dashes) => (cv, x, y) => cv.rect(x, y - 0.06, 0.2, 0.12, { face: 'none', edge: colour, lw: 1.0, dashes, rounding: 0.03 });
    header('Containers');
    line('own boundary', box(PAL.ink, null));
    line('supplier, by role', box(PAL.supplier, [4, 2]));
    line('non-EU jurisdiction', box(PAL.nonEu, [1.2, 1.6]));
    line('model from a supplier', (cv, x, y) => {
      cv.rect(x, y - 0.055, 0.2, 0.11, { face: PAL.background, edge: PAL.supplier, lw: 0.8, rounding: 0.03 });
      cv.line([x - 0.04, x], [y, y], { colour: PAL.supplier, lw: 0.8 });
    });
  }
  if (trail) {
    const c4 = modeColour(4);
    header('Trail');
    line('earlier, trail, later', (cv, x, y) => {
      cv.circle(x + 0.04, y, 0.04, { face: 'none', edge: c4, lw: 1.0 });
      cv.line([x + 0.08, x + 0.15], [y, y], { colour: c4, lw: 1.0 });
      cv.circle(x + 0.19, y, 0.045, { face: c4, edge: c4, lw: 1.0 });
    });
    line('new in the period', (cv, x, y) => cv.line([x + 0.03, x + 0.07, x + 0.16], [y, y - 0.045, y + 0.06], { colour: c4, lw: 1.6, capstyle: 'round' }));
    line('retired', (cv, x, y) => {
      cv.circle(x + 0.075, y, 0.065, { face: PAL.background, edge: c4, lw: 1.2 });
      const d = 0.045;
      cv.line([x + 0.075 - d, x + 0.075 + d], [y - d, y + d], { colour: PAL.ink, lw: 1.1 });
      cv.line([x + 0.075 - d, x + 0.075 + d], [y + d, y - d], { colour: PAL.ink, lw: 1.1 });
    });
  }
  return items;
}

function drawLegend(cv, x, top, bottom, width, scale = 1, opts = {}) {
  const items = legendItems(width, opts), sectionGap = 0.05;
  const total = (pitch) => items.reduce((s, it) => s + (it.header ? sectionGap : 0) + (it.height ?? pitch * it.lines.length), 0);
  let pitch = LINE_PITCH;
  while (total(pitch) > top - bottom && pitch > 0.135) pitch -= 0.005;
  if (total(pitch) > top - bottom) throw new Error(`Contour: the legend needs ${total(pitch).toFixed(2)} in, ${(top - bottom).toFixed(2)} in available`);
  cv.line([x - 0.12, x - 0.12], [bottom, top], { colour: PAL.grid, lw: 0.8 });
  let y = top;
  for (const it of items) {
    if (it.header) { y -= sectionGap; cv.text(x, y - pitch / 2, it.lines[0], { weight: 'bold' }); y -= pitch; continue; }
    if (it.lines[0] === '__sizes__') {
      const blockH = it.height, rXL = UNIT_RADIUS * REACH_RATIO.XL * scale, cx = x + rXL + 0.02;
      const bottomY = y - blockH + 0.04, labelX = cx + rXL + 0.22;
      ['S', 'M', 'L', 'XL'].forEach((reach, k) => {
        const r = UNIT_RADIUS * REACH_RATIO[reach] * scale, ly = bottomY + 0.05 + k * 0.155;
        cv.circle(cx, bottomY + r, r, { face: 'none', edge: PAL.ink, lw: 1 });
        const topY = bottomY + 2 * r;
        cv.line([cx, cx + rXL + 0.08, labelX - 0.04], [topY, topY, ly], { colour: PAL.grid, lw: 0.7, zorder: 2 });
        cv.text(labelX, ly, REACH_LABELS[reach]);
      });
      y -= blockH; continue;
    }
    if (it.swatch) it.swatch(cv, x, y - pitch / 2);
    const tx = it.swatch ? x + 0.24 : x;
    it.lines.forEach((t, k) => cv.text(tx, y - pitch / 2 - k * pitch, t));
    y -= pitch * it.lines.length;
  }
}

function drawSummary(cv, x, top, units) {
  const per = (f, n) => Array.from({ length: n }, (_, i) => units.filter((u) => f(u) === i).length);
  const perMode = per((u) => u.mode, 6), perLevel = per((u) => u.level, 5);
  cv.text(x, top - 0.08, `Units drawn: ${units.length}`, { weight: 'bold' });
  const step = 0.42, start = x + 0.95, yMode = top - 0.34, yLevel = top - 0.6;
  cv.text(x, yMode, 'Per mode', { colour: PAL.muted });
  for (let m = 0; m < 6; m++) {
    const cx = start + m * step, c = modeColour(m);
    cv.circle(cx, yMode, 0.07, { face: c, edge: c, lw: 0 });
    cv.text(cx, yMode, String(m), { colour: textOn(c), ha: 'center', weight: 'bold' });
    cv.text(cx + 0.11, yMode, String(perMode[m]));
  }
  cv.text(x, yLevel, 'Per level', { colour: PAL.muted });
  for (let l = 0; l < 5; l++) {
    const cx = start + l * step, c = PAL.ramp[l];
    cv.rect(cx - 0.07, yLevel - 0.065, 0.14, 0.13, { face: c, edge: PAL.ink, lw: 0.5 });
    cv.text(cx, yLevel, String(l), { colour: textOn(c), ha: 'center', weight: 'bold' });
    cv.text(cx + 0.11, yLevel, String(perLevel[l]));
  }
  const n = (f) => units.filter(f).length;
  cv.text(x, top - 0.84, `Filled diamond ${n((u) => u.policy === 'enforced')} · Seat ${n((u) => u.tier !== 'T0')} · Solid baseline ${n((u) => u.evidence === 'automatic')} of ${units.length}`);
}

// ---------------------------------------------------------------------------
// V4 The decision-rights view and V5 The evidence view
// ---------------------------------------------------------------------------
const MINI_RADIUS = 0.075, ROW_PITCH = 0.24, ACTION_PITCH = 0.145, ROW_PITCH_EVIDENCE = 0.3, LABEL_AREA = 3.2;
const FIG_W = 11, FIG_H = 7.5;
const firstPanel = (model) => model.panels[0] ?? { name: '', units: [] };

function truncateToWidth(s, width, size = FONT_SIZE) {
  const chars = Math.max(4, Math.floor(width / (CHAR_WIDTH * size / FONT_SIZE)));
  return cpLen(s) <= chars ? s : cpSlice(s, 0, chars - 1).trimEnd() + '…';
}

function drawMiniMark(cv, x, y, u, radius = MINI_RADIUS) {
  const colour = modeColour(u.mode), hol = hollow(u);
  const half = u.identity === 'person' ? radius : radius * SQUARE_FACTOR;
  drawShape(cv, x, y, u, half, { face: hol ? PAL.background : colour, edge: colour, lw: 1.2, zorder: 4 });
  cv.text(x, y, String(u.mode), { colour: hol ? colour : textOn(colour), ha: 'center', weight: 'bold', zorder: 5 });
  if (u.status === 'retired') {
    const d = half * 0.75;
    cv.line([x - d, x + d], [y - d, y + d], { colour: PAL.ink, lw: 1.1, zorder: 5.5 });
    cv.line([x - d, x + d], [y + d, y - d], { colour: PAL.ink, lw: 1.1, zorder: 5.5 });
  }
}

const rowOrder = (units) => [...units].sort((a, b) => b.level - a.level || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

function rowLabel(cv, y, u, nameRight) {
  drawMiniMark(cv, MARGIN + 0.1, y, u);
  cv.text(MARGIN + 0.28, y, u.id, { weight: 'bold' });
  cv.text(MARGIN + 1.02, y, `${u.reversibility} ${u.reach}`, { colour: PAL.muted });
  const nameX = MARGIN + 1.5;
  cv.text(nameX, y, truncateToWidth(u.name, nameRight - nameX), { colour: PAL.muted });
}

function drawLevelBar(cv, gridLeft, cw, y, level, thickness, outline, lw) {
  for (let k = 0; k <= level; k++) cv.rect(gridLeft + k * cw, y - thickness / 2, cw, thickness, { face: PAL.ramp[k], zorder: 2 });
  if (outline) cv.rect(gridLeft, y - thickness / 2, (level + 1) * cw, thickness, { face: 'none', edge: outline, lw, zorder: 2.5 });
}

function layoutDecisions(model) {
  const units = rowOrder(firstPanel(model).units);
  const needed = TITLE_BAND + COL_LABEL_HEIGHT + units.length * ROW_PITCH + units.reduce((s, u) => s + u.actions.length, 0) * ACTION_PITCH + 0.15 + FOOTER_BAND;
  const cv = new Canvas(FIG_W, Math.max(FIG_H, Math.ceil(needed * 2) / 2));
  cv.push(-1, 'rect', { x: 0, y: 0, width: cv.width * IN, height: cv.height * IN, fill: PAL.background });
  drawTitleFooter(cv, model);
  const gridLeft = MARGIN + LABEL_AREA, gridRight = cv.width - MARGIN - LEGEND_WIDTH - 0.3 - 0.3;
  const cw = (gridRight - gridLeft) / 5, top = cv.height - TITLE_BAND - COL_LABEL_HEIGHT;
  LEVEL_NAMES.forEach((name, i) => {
    const [a, b, ...rest] = name.split(' '), cx = gridLeft + (i + 0.5) * cw;
    cv.text(cx, top + 0.3, `${a} ${b}`, { size: FONT_SIZE + 0.5, ha: 'center', weight: 'bold' });
    cv.text(cx, top + 0.14, rest.join(' '), { colour: PAL.muted, ha: 'center' });
  });
  let y = top;
  const bottom = top - (units.length * ROW_PITCH + units.reduce((s, u) => s + u.actions.length, 0) * ACTION_PITCH);
  for (let i = 0; i < 6; i++) cv.line([gridLeft + i * cw, gridLeft + i * cw], [bottom, top], { colour: PAL.grid, lw: 0.6, zorder: 1 });
  cv.line([MARGIN, gridRight], [top, top], { colour: PAL.grid, lw: 0.8, zorder: 1 });
  for (const u of units) {
    const blockH = ROW_PITCH + u.actions.length * ACTION_PITCH, rowY = y - ROW_PITCH / 2;
    if (u.reversibility === 'R3' || u.reversibility === 'R4') cv.rect(gridLeft + 4 * cw, y - blockH, cw, blockH, { face: PAL.emptyCorner, zorder: 0.5 });
    rowLabel(cv, rowY, u, gridLeft - 0.1);
    drawLevelBar(cv, gridLeft, cw, rowY, u.level, 0.13, redRule(u) ? PAL.warning : PAL.ink, redRule(u) ? 1.3 : 0.5);
    const ceiling = gridLeft + (u.level + 1) * cw;
    if (u.policy !== 'none') cv.diamond(ceiling, rowY, DIAMOND_HALF, { filled: u.policy === 'enforced', colour: PAL.ink });
    if (u.tier !== 'T0') {
      const sx = ceiling + DIAMOND_HALF + 0.03 + SEAT_RADIUS;
      cv.circle(sx, rowY, SEAT_RADIUS, { face: PAL.people, edge: PAL.people, lw: 0, zorder: 4 });
      cv.text(sx, rowY, u.tier[1], { colour: '#FFFFFF', ha: 'center', weight: 'bold', zorder: 5 });
    }
    let ay = y - ROW_PITCH;
    for (const [action, level] of u.actions) {
      const aY = ay - ACTION_PITCH / 2;
      cv.text(MARGIN + 0.5, aY, truncateToWidth(action, gridLeft - 0.1 - (MARGIN + 0.5)), { colour: PAL.muted });
      drawLevelBar(cv, gridLeft, cw, aY, level, 0.05, null, 0);
      ay -= ACTION_PITCH;
    }
    y -= blockH;
    cv.line([MARGIN, gridRight], [y, y], { colour: PAL.grid, lw: 0.6, zorder: 1 });
  }
  drawLegend(cv, cv.width - MARGIN - LEGEND_WIDTH, cv.height - LEGEND_TOP, LEGEND_BOTTOM, LEGEND_WIDTH);
  return cv;
}

function layoutEvidence(model) {
  const units = rowOrder(firstPanel(model).units);
  const needed = TITLE_BAND + COL_LABEL_HEIGHT + 0.12 + units.length * ROW_PITCH_EVIDENCE + 0.15 + FOOTER_BAND;
  const cv = new Canvas(FIG_W, Math.max(FIG_H, Math.ceil(needed * 2) / 2));
  cv.push(-1, 'rect', { x: 0, y: 0, width: cv.width * IN, height: cv.height * IN, fill: PAL.background });
  drawTitleFooter(cv, model);
  const gridLeft = MARGIN + LABEL_AREA, gridRight = cv.width - MARGIN - LEGEND_WIDTH - 0.3;
  const cw = (gridRight - gridLeft) / EVIDENCE_COLUMNS.length, top = cv.height - TITLE_BAND - COL_LABEL_HEIGHT - 0.12;
  EVIDENCE_COLUMNS.forEach(([, name], i) => {
    const cx = gridLeft + (i + 0.5) * cw;
    wrapToWidth(name, cw - 0.08).forEach((t, k) => cv.text(cx, top + 0.46 - k * 0.15, t, { ha: 'center', weight: 'bold' }));
  });
  const bottom = top - units.length * ROW_PITCH_EVIDENCE;
  for (let i = 0; i <= EVIDENCE_COLUMNS.length; i++) cv.line([gridLeft + i * cw, gridLeft + i * cw], [bottom, top], { colour: PAL.grid, lw: 0.6, zorder: 1 });
  cv.line([MARGIN, gridRight], [top, top], { colour: PAL.grid, lw: 0.8, zorder: 1 });
  let y = top;
  const insetX = 0.1, insetY = 0.055;
  for (const u of units) {
    const rowY = y - ROW_PITCH_EVIDENCE / 2;
    rowLabel(cv, rowY, u, gridLeft - 0.1);
    const baseY = rowY - MINI_RADIUS - 0.045;
    if (u.evidence === 'automatic') cv.line([MARGIN + 0.02, MARGIN + 0.18], [baseY, baseY], { colour: PAL.automatic, lw: 1.6 });
    else if (u.evidence === 'attested') cv.line([MARGIN + 0.02, MARGIN + 0.18], [baseY, baseY], { colour: PAL.attested, lw: 1.6, dashes: [3, 2] });
    EVIDENCE_COLUMNS.forEach(([kind], i) => {
      const x0 = gridLeft + i * cw, cellY = rowY - ROW_PITCH_EVIDENCE / 2 + insetY, cellH = ROW_PITCH_EVIDENCE - 2 * insetY;
      if (kind === 'none') {
        if (u.evidence === 'none') {
          cv.rect(x0 + insetX, cellY, cw - 2 * insetX, cellH, { face: 'none', edge: PAL.warning, lw: 1.0, zorder: 2 });
          cv.text(x0 + cw / 2, rowY, 'none', { colour: PAL.warning, ha: 'center', weight: 'bold', zorder: 5 });
        }
        return;
      }
      if (!u.kinds.includes(kind)) return;
      if (AUTOMATIC_KINDS.includes(kind)) cv.rect(x0 + insetX, cellY, cw - 2 * insetX, cellH, { face: PAL.automatic, zorder: 2 });
      else cv.rect(x0 + insetX, cellY, cw - 2 * insetX, cellH, { face: PAL.background, edge: PAL.attested, lw: 0.8, hatch: PAL.attested, zorder: 2 });
    });
    if (!u.kinds.length && u.evidence !== 'none') cv.text(gridLeft + 2 * cw, rowY, `${u.evidence}: kinds not recorded`, { colour: PAL.muted, ha: 'center', style: 'italic' });
    y -= ROW_PITCH_EVIDENCE;
    cv.line([MARGIN, gridRight], [y, y], { colour: PAL.grid, lw: 0.6, zorder: 1 });
  }
  drawLegend(cv, cv.width - MARGIN - LEGEND_WIDTH, cv.height - LEGEND_TOP, LEGEND_BOTTOM, LEGEND_WIDTH);
  return cv;
}

// ---------------------------------------------------------------------------
// V3 The supply and sovereignty view
// ---------------------------------------------------------------------------
const BOX_PAD = 0.1, BOX_TITLE_LINE = 0.15, BOX_GAP = 0.12, ITEM_GAP = 0.08;

function flow(items, maxW, widthOf, gap) {
  const rows = [[]];
  let used = 0;
  for (const it of items) {
    const w = widthOf(it);
    if (rows[rows.length - 1].length && used + gap + w > maxW) { rows.push([]); used = 0; }
    if (rows[rows.length - 1].length) used += gap;
    rows[rows.length - 1].push(it);
    used += w;
  }
  return rows;
}

class Box {
  constructor(title, style, { subtitle = '', fillWidth = false, children = [] } = {}) {
    Object.assign(this, { title, style, subtitle, fillWidth, children, leaves: [], minWidth: 1.6, w: 0, h: 0, x: 0, y: 0, titleLines: [], rows: [] });
  }
  fitTitle(width) {
    const inner = width - 2 * BOX_PAD;
    this.titleLines = [];
    if (this.title) this.titleLines.push(truncateToWidth(this.title, inner));
    if (this.subtitle) this.titleLines.push(...wrapToWidth(this.subtitle, inner, FONT_SIZE, 2));
  }
  titleH() { return BOX_TITLE_LINE * this.titleLines.length + (this.titleLines.length ? 0.04 : 0); }
  measure(maxW) {
    const innerW = maxW - 2 * BOX_PAD;
    this.fitTitle(maxW);
    let contentW, contentH;
    if (this.leaves.length) {
      this.rows = flow(this.leaves, innerW, (l) => l.fp.width, ITEM_GAP);
      contentW = Math.max(...this.rows.map((r) => r.reduce((s, l) => s + l.fp.width, 0) + ITEM_GAP * (r.length - 1)));
      contentH = this.rows.reduce((s, r) => s + Math.max(...r.map((l) => l.fp.up + l.fp.down)), 0) + ITEM_GAP * (this.rows.length - 1);
    } else if (this.children.length) {
      this.children.forEach((c) => c.measure(innerW));
      this.rows = flow(this.children, innerW, (c) => c.w, BOX_GAP);
      contentW = Math.max(...this.rows.map((r) => r.reduce((s, c) => s + c.w, 0) + BOX_GAP * (r.length - 1)));
      contentH = this.rows.reduce((s, r) => s + Math.max(...r.map((c) => c.h)), 0) + BOX_GAP * (this.rows.length - 1);
    } else { contentW = 0.6; contentH = 0.2; }
    const wanted = Math.max(contentW, Math.min(1.9, Math.max(this.title ? textWidth(this.title) : 0, this.subtitle ? textWidth(this.subtitle) / 2 + 0.3 : 0)));
    const natural = Math.max(this.minWidth, wanted + 2 * BOX_PAD);
    this.w = this.fillWidth ? maxW : Math.min(maxW, natural);
    this.fitTitle(this.w);
    this.h = contentH + 2 * BOX_PAD + this.titleH();
  }
  arrange(x, yTop, pos) {
    this.x = x; this.y = yTop;
    let cy = yTop - BOX_PAD - this.titleH();
    if (this.leaves.length) {
      for (const row of this.rows) {
        const rowH = Math.max(...row.map((l) => l.fp.up + l.fp.down)), rowUp = Math.max(...row.map((l) => l.fp.up));
        let cx = x + BOX_PAD;
        for (const leaf of row) { pos[leaf.key] = [cx + leaf.fp.left, cy - rowUp]; cx += leaf.fp.width + ITEM_GAP; }
        cy -= rowH + ITEM_GAP;
      }
    } else {
      const innerW = this.w - 2 * BOX_PAD;
      for (const row of this.rows) {
        const rowH = Math.max(...row.map((c) => c.h));
        const extra = innerW - (row.reduce((s, c) => s + c.w, 0) + BOX_GAP * (row.length - 1));
        let cx = x + BOX_PAD;
        for (const child of row) {
          child.w += Math.max(0, extra) / row.length;
          child.fitTitle(child.w);
          child.arrange(cx, cy, pos);
          cx += child.w + BOX_GAP;
        }
        cy -= rowH + BOX_GAP;
      }
    }
  }
  draw(cv) {
    const [colour, dashes, lw, face] = {
      solid: [PAL.ink, null, 1.2, 'none'], dashed: [PAL.supplier, [4, 2], 1.0, 'none'],
      dotted: [PAL.nonEu, [1.2, 1.6], 1.1, 'none'], area: [PAL.grid, null, 0.8, PAL.ice],
    }[this.style];
    cv.rect(this.x, this.y - this.h, this.w, this.h, { face, edge: colour, lw, dashes, zorder: 1, rounding: 0.08 });
    const titleColour = this.style === 'area' || this.style === 'solid' ? PAL.ink : colour;
    this.titleLines.forEach((t, k) => {
      const first = k === 0 && !!this.title;
      cv.text(this.x + BOX_PAD, this.y - BOX_PAD - 0.04 - k * BOX_TITLE_LINE, t, { colour: first ? titleColour : PAL.muted, weight: first ? 'bold' : 'normal' });
    });
    this.children.forEach((c) => c.draw(cv));
  }
}

function layoutSupply(model) {
  const units = firstPanel(model).units;
  const suppliers = new Map(model.suppliers.map((s) => [s.id, s]));
  const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  const markLeaf = (u) => ({ key: u.id, fp: markFootprint(u), draw: (c, x, y) => drawMark(c, x, y, u) });
  const chipLeaf = (sup) => ({
    key: `chip:${sup.id}`, fp: { left: 0.3, right: 0.3, up: 0.12, down: 0.12, width: 0.6 },
    draw: (c, x, y) => {
      c.rect(x - 0.28, y - 0.1, 0.56, 0.2, { face: PAL.background, edge: PAL.supplier, lw: 0.9, rounding: 0.05, zorder: 4 });
      c.text(x, y, 'model', { colour: PAL.supplier, ha: 'center', weight: 'bold', zorder: 5 });
    },
  });
  const own = new Box(firstPanel(model).name, 'solid', { subtitle: 'own premises, tenant and data centre', fillWidth: true });
  const euBoxes = new Map(), nonEuGroups = new Map(), chipLinks = [];
  const setdefault = (map, key, make) => { if (!map.has(key)) map.set(key, make()); return map.get(key); };
  const supplierBox = (sup) => {
    const title = `Supplier: ${SUPPLIER_ROLE_NAMES[sup.role].toLowerCase()} (${sup.jurisdiction})`;
    if (sup.jurisdiction === 'EU' || sup.jurisdiction === 'EEA') return setdefault(euBoxes, sup.id, () => new Box(title, 'dashed', { subtitle: sup.label }));
    const group = sup.location || 'outside the EU and the EEA';
    return setdefault(setdefault(nonEuGroups, group, () => new Map()), sup.id, () => new Box(title, 'dashed', { subtitle: sup.label }));
  };
  const genericBox = (hosting) => {
    if (hosting === 'eu-supplier' || hosting === 'eea-supplier')
      return setdefault(euBoxes, `generic:${hosting}`, () => new Box(`Supplier: unnamed (${hosting === 'eu-supplier' ? 'EU' : 'EEA'})`, 'dashed'));
    const group = hosting === 'non-eu-supplier' ? 'outside the EU and the EEA' : 'jurisdiction unknown';
    return setdefault(setdefault(nonEuGroups, group, () => new Map()), `generic:${hosting}`, () => new Box('Supplier: unnamed (non-EU)', 'dashed'));
  };
  const placement = (u) => {
    for (const role of ['hosting', 'application', 'operations', 'model'])
      for (const sid of u.suppliers) { const sup = suppliers.get(sid); if (sup && sup.role === role) return sup; }
    return null;
  };
  for (const u of units) {
    let placedIn = null;
    if (u.hosting === 'own-premises') own.leaves.push(markLeaf(u));
    else {
      placedIn = placement(u);
      (placedIn ? supplierBox(placedIn) : genericBox(u.hosting)).leaves.push(markLeaf(u));
    }
    for (const sid of u.suppliers) {
      const sup = suppliers.get(sid);
      if (sup && sup.role === 'model' && sup !== placedIn) {
        const box = supplierBox(sup);
        if (!box.leaves.some((l) => l.key === `chip:${sup.id}`)) box.leaves.push(chipLeaf(sup));
        chipLinks.push([u.id, `chip:${sup.id}`]);
      }
    }
  }
  const euArea = new Box('EU and EEA', 'area', { fillWidth: true });
  euArea.children.push(own, ...[...euBoxes.keys()].sort(cmp).map((k) => euBoxes.get(k)));
  const nonEuBoxes = [...nonEuGroups.keys()].sort(cmp).map((group) => {
    const boxes = nonEuGroups.get(group);
    return new Box(`Non-EU jurisdiction: ${group}`, 'dotted', { children: [...boxes.keys()].sort(cmp).map((k) => boxes.get(k)) });
  });

  const plotLeft = MARGIN, plotRight = FIG_W - MARGIN - LEGEND_WIDTH - 0.3, plotBottom = FOOTER_BAND + 0.1;
  const columnGap = 0.2, totalW = plotRight - plotLeft;
  const measureColumns = (rightW) => {
    const leftW = totalW - rightW - (nonEuBoxes.length ? columnGap : 0);
    euArea.measure(leftW);
    nonEuBoxes.forEach((b) => b.measure(rightW));
    const ordered = [...nonEuBoxes].sort((a, b) => round(-a.w, 3) - round(-b.w, 3) || cmp(a.title, b.title));
    const rows = nonEuBoxes.length ? flow(ordered, rightW, (b) => b.w, BOX_GAP) : [];
    const rightH = rows.reduce((s, r) => s + Math.max(...r.map((b) => b.h)), 0) + BOX_GAP * Math.max(0, rows.length - 1);
    return [leftW, euArea.h, rightH, rows];
  };
  let rightW = 0;
  if (nonEuBoxes.length) {
    const n = Math.floor((totalW - 2.6 - 2.6) / 0.1) + 1;
    const candidates = Array.from({ length: n }, (_, k) => round(2.6 + 0.1 * k, 1));
    let best = null;
    for (const w of candidates) {
      const m = measureColumns(w), key = [round(Math.max(m[1], m[2]), 3), w];
      if (!best || key[0] < best.key[0] || (key[0] === best.key[0] && key[1] < best.key[1])) best = { key, w };
    }
    rightW = best.w;
  }
  const [leftW, leftH, rightH, rows] = measureColumns(rightW);
  const needed = Math.max(leftH, rightH);
  let height = FIG_H;
  if (FIG_H - TITLE_BAND - 0.05 - needed < plotBottom) height = Math.ceil((needed + TITLE_BAND + 0.05 + FOOTER_BAND + 0.1) * 2) / 2;
  const cv = new Canvas(FIG_W, height);
  cv.push(-1, 'rect', { x: 0, y: 0, width: cv.width * IN, height: cv.height * IN, fill: PAL.background });
  drawTitleFooter(cv, model);
  const plotTop = cv.height - TITLE_BAND - 0.05;
  const pos = Object.create(null);
  euArea.arrange(plotLeft, plotTop, pos);
  let cy = plotTop;
  const rightX = plotLeft + leftW + columnGap;
  for (const row of rows) {
    const extra = rightW - (row.reduce((s, b) => s + b.w, 0) + BOX_GAP * (row.length - 1));
    let cx = rightX;
    for (const box of row) { box.w += Math.max(0, extra) / row.length; box.fitTitle(box.w); box.arrange(cx, cy, pos); cx += box.w + BOX_GAP; }
    cy -= Math.max(...row.map((b) => b.h)) + BOX_GAP;
  }
  euArea.draw(cv);
  nonEuBoxes.forEach((b) => b.draw(cv));
  for (const [uid, chip] of chipLinks) cv.line([pos[uid][0], pos[chip][0]], [pos[uid][1], pos[chip][1]], { colour: PAL.supplier, lw: 0.8, zorder: 2 });
  const drawLeaves = (box) => {
    box.leaves.forEach((l) => l.draw(cv, ...pos[l.key]));
    box.children.forEach(drawLeaves);
  };
  drawLeaves(euArea);
  nonEuBoxes.forEach(drawLeaves);
  drawLegend(cv, cv.width - MARGIN - LEGEND_WIDTH, cv.height - LEGEND_TOP, LEGEND_BOTTOM, LEGEND_WIDTH, 1, { containers: true });
  return cv;
}

// ---------------------------------------------------------------------------
// V2 The landscape over time
// ---------------------------------------------------------------------------
function layoutYear(model) {
  const cv = new Canvas(FIG_W, FIG_H);
  cv.push(-1, 'rect', { x: 0, y: 0, width: cv.width * IN, height: cv.height * IN, fill: PAL.background });
  drawTitleFooter(cv, model);
  const stripH = 0.2;
  const x0 = MARGIN + ROW_LABEL_WIDTH, top = cv.height - TITLE_BAND, bottom = FOOTER_BAND + stripH;
  const block = 4 * CELL_V1 + COL_LABEL_HEIGHT;
  const y0 = round(bottom + COL_LABEL_HEIGHT + (top - bottom - block) / 2, 4);
  const grid = { x0, y0, cell: CELL_V1 };
  const before = new Map(model.panels[0].units.map((u) => [u.id, u]));
  const after = new Map(model.panels[1].units.map((u) => [u.id, u]));
  drawGrid(cv, grid);
  const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  const moved = new Set([...before.keys()].filter((id) => after.has(id) && (before.get(id).level !== after.get(id).level || before.get(id).reversibility !== after.get(id).reversibility)));
  const byCell = new Map();
  const add = (u, key, fp) => { const k = `${u.level},${u.reversibility}`; if (!byCell.has(k)) byCell.set(k, []); byCell.get(k).push({ key, fp, u }); };
  const ids = [...new Set([...before.keys(), ...after.keys()])].sort(cmp);
  for (const id of ids) {
    if (after.has(id)) add(after.get(id), id, markFootprint(after.get(id), { isNew: !before.has(id) }));
    else add(before.get(id), id, markFootprint(before.get(id)));
  }
  for (const id of [...moved].sort(cmp)) add(before.get(id), `${id}@start`, ghostFootprint(before.get(id)));
  const pos = Object.create(null);
  for (const items of byCell.values()) {
    const { level, reversibility } = items[0].u;
    const [cx, cy] = gridCentre(grid, level, reversibility);
    const p = layoutInCell(items, grid.cell, grid.cell, { R4: 'top', R1: 'bottom' }[reversibility] ?? null);
    for (const k in p) pos[k] = [cx + p[k][0], cy + p[k][1]];
  }
  for (const id of ids) {
    const [x, y] = pos[id];
    if (after.has(id)) {
      drawMark(cv, x, y, after.get(id), { isNew: !before.has(id) });
      if (moved.has(id)) {
        const [gx, gy] = pos[`${id}@start`];
        drawGhost(cv, gx, gy, before.get(id));
        cv.line([gx, x], [gy, y], { colour: modeColour(after.get(id).mode), lw: 1.0, zorder: 2.6 });
      }
    } else drawMark(cv, x, y, before.get(id), { hollowOverride: true, crossedOverride: true });
  }
  const stripY = y0 - COL_LABEL_HEIGHT - 0.1;
  cv.line([x0, x0 + 5 * CELL_V1], [stripY + 0.1, stripY + 0.1], { colour: PAL.grid, lw: 0.8 });
  cv.text(x0, stripY, `${model.panels[0].name}  →  ${model.panels[1].name}`, { weight: 'bold' });
  drawLegend(cv, cv.width - MARGIN - LEGEND_WIDTH, cv.height - LEGEND_TOP, LEGEND_BOTTOM, LEGEND_WIDTH, 1, { trail: true });
  return cv;
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------
function drawTitleFooter(cv, model) {
  if (model.title) cv.text(MARGIN, cv.height - 0.22, model.title, { size: TITLE_SIZE, weight: 'bold' });
  if (model.subtitle) cv.text(MARGIN, cv.height - 0.47, model.subtitle, { colour: PAL.muted });
  [...model.footer].reverse().forEach((t, k) => cv.text(MARGIN, 0.09 + k * FOOTER_LINE, t, { colour: PAL.muted }));
}

/** Build the canvas: one panel is V1 (11 × 7.5 in), two panels are V6 (16 × 8 in). */
function layoutLandscapeOrCompare(model) {
  const panels = model.panels.length ? model.panels : [{ name: '', units: [] }];
  const cv = new Canvas(...(panels.length === 2 ? [16, 8] : [11, 7.5]));
  cv.push(-1, 'rect', { x: 0, y: 0, width: cv.width * IN, height: cv.height * IN, fill: PAL.background });
  drawTitleFooter(cv, model);
  if (panels.length === 1) {
    const x0 = MARGIN + ROW_LABEL_WIDTH, top = cv.height - TITLE_BAND, bottom = FOOTER_BAND;
    const block = 4 * CELL_V1 + COL_LABEL_HEIGHT;
    const y0 = round(bottom + COL_LABEL_HEIGHT + (top - bottom - block) / 2, 4);
    drawPanel(cv, { x0, y0, cell: CELL_V1 }, panels[0].units);
    drawLegend(cv, cv.width - MARGIN - LEGEND_WIDTH, cv.height - LEGEND_TOP, LEGEND_BOTTOM, LEGEND_WIDTH);
    return cv;
  }
  const cell = CELL_V6, panelW = 5 * cell, legendGap = 0.2, panelTitleH = 0.3, summaryH = 0.95;
  const xLeft = MARGIN + ROW_LABEL_WIDTH, legendX = xLeft + panelW + legendGap + 0.12;
  const xRight = legendX + LEGEND_WIDTH_V6 + legendGap;
  const block = panelTitleH + 4 * cell + COL_LABEL_HEIGHT + summaryH;
  const top = cv.height - TITLE_BAND, bottom = FOOTER_BAND;
  const y0 = round(bottom + summaryH + COL_LABEL_HEIGHT + (top - bottom - block) / 2, 4);
  [[panels[0], xLeft, true], [panels[1], xRight, false]].forEach(([p, x0, labels]) => {
    const g = { x0, y0, cell };
    cv.text(x0, y0 + 4 * cell + 0.14, `${p.name} · ${p.units.length} units`, { size: FONT_SIZE + 2, weight: 'bold' });
    drawPanel(cv, g, p.units, { rowLabels: labels, scale: MARK_SCALE_V6 });
    drawSummary(cv, x0, y0 - COL_LABEL_HEIGHT - 0.05, p.units);
  });
  drawLegend(cv, legendX, cv.height - LEGEND_TOP, LEGEND_BOTTOM, LEGEND_WIDTH_V6, MARK_SCALE_V6);
  return cv;
}

export function layoutContour(model) {
  const view = model.view || (model.panels.length === 2 ? 'compare' : 'landscape');
  switch (view) {
    case 'decisions': return layoutDecisions(model);
    case 'evidence': return layoutEvidence(model);
    case 'year': return layoutYear(model);
    case 'supply': return layoutSupply(model);
    case 'landscape': case 'compare': return layoutLandscapeOrCompare(model);
    default: throw new Error(`Contour: view ${view} is not implemented`);
  }
}

export function drawContour(svgEl, model) {
  // Mermaid has already put its <style> in the svg; keep it, clear everything else.
  for (const child of [...svgEl.children]) if (child.tagName.toLowerCase() !== 'style') child.remove();
  const cv = layoutContour(model);
  const w = cv.width * IN, h = cv.height * IN;
  svgEl.setAttribute('viewBox', `0 0 ${w} ${h}`);
  svgEl.setAttribute('width', w);
  svgEl.setAttribute('height', h);
  svgEl.style.maxWidth = '100%';
  cv.flush(svgEl);
}

const db = {
  model: { view: null, title: '', subtitle: '', footer: [], panels: [], suppliers: [] },
  clear() { this.model = { view: null, title: '', subtitle: '', footer: [], panels: [], suppliers: [] }; },
  getDiagramTitle() { return this.model.title; }, setDiagramTitle() {},
  getAccTitle() { return ''; }, setAccTitle() {}, getAccDescription() { return ''; }, setAccDescription() {},
};

/** The external diagram definition, to hand to mermaid.registerExternalDiagrams. */
export const contour = {
  id: 'contour',
  detector: (txt) => /^\s*contour(-beta)?\b/.test(txt),
  loader: async () => ({
    id: 'contour',
    diagram: {
      db,
      parser: { parse(text) { db.model = parseContour(text); }, parser: { yy: db } },
      renderer: {
        draw(_text, id) {
          const el = document.getElementById(id);
          if (!el) throw new Error('Contour: svg element not found');
          drawContour(el, db.model);
        },
      },
      styles: () => '',
    },
  }),
};

/** Register with a Mermaid instance (ESM default export, or window.mermaid). */
const registered = new WeakSet();
export async function registerContour(mermaid = globalThis.mermaid) {
  if (!mermaid?.registerExternalDiagrams) throw new Error('mermaid-contour: Mermaid 10.1 or later is required');
  if (registered.has(mermaid)) return;
  registered.add(mermaid);
  await mermaid.registerExternalDiagrams([contour], { lazyLoad: false });
}

// Browser use as a plain module script: expose the API and register with an already loaded Mermaid.
if (typeof globalThis.document !== 'undefined') {
  globalThis.mermaidContour = { contour, registerContour, parseContour, layoutContour };
  if (globalThis.mermaid?.registerExternalDiagrams) registerContour(globalThis.mermaid).catch((e) => console.warn('mermaid-contour: registration failed', e));
}
