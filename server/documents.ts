/**
 * Documents the agent can hand to the person as files (DOCX and PDF).
 *
 * The model never writes a file. It returns a small structured `document` (title + blocks) in plain text;
 * this module validates and cleans it, and builds the file on demand. Nothing is stored on the server.
 * PDF uses an embedded DejaVu Sans font so Cyrillic, Latin and Greek render correctly.
 */
import path from 'node:path';
import { createRequire } from 'node:module';
import PDFDocument from 'pdfkit';
import {
  AlignmentType, BorderStyle, Document, Footer, HeadingLevel, LevelFormat, Packer, PageNumber,
  Paragraph, ShadingType, Table, TableCell, TableRow, TextRun, WidthType,
} from 'docx';

export type DocBlock =
  | { type: 'heading'; text: string }
  | { type: 'paragraph'; text: string }
  | { type: 'bullets'; items: string[] }
  | { type: 'numbered'; items: string[] }
  | { type: 'table'; headers: string[]; rows: string[][] };

export interface DocumentSpec { title: string; /** English file name without extension (letters, digits, dashes). */ fileName?: string; blocks: DocBlock[] }

const LIMITS = {
  title: 200, heading: 300, paragraph: 6000, item: 1500, cell: 600,
  blocks: 150, items: 60, cols: 12, rows: 200, totalChars: 120000,
};

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\ufffe\uffff]/g;

const str = (v: unknown, max: number, clean: (s: string) => string): string =>
  clean(String(v ?? '').replace(CONTROL, '')).slice(0, max).trim();

/**
 * Turns whatever the model (or a client) sent into a safe DocumentSpec, or null if nothing usable is left.
 * Idempotent: sanitizing an already clean document returns the same document.
 */
export function sanitizeDocument(raw: unknown, clean: (s: string) => string = (s) => s): DocumentSpec | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const title = str(r.title, LIMITS.title, clean).replace(/\s*\n+\s*/g, ' ');
  const src = Array.isArray(r.blocks) ? r.blocks : [];
  const blocks: DocBlock[] = [];
  let total = title.length;
  const room = (n: number) => { total += n; return total <= LIMITS.totalChars; };

  const list = (v: unknown): string[] =>
    (Array.isArray(v) ? v : []).slice(0, LIMITS.items).map((x) => str(x, LIMITS.item, clean)).filter(Boolean);

  for (const b of src.slice(0, LIMITS.blocks)) {
    if (!b || typeof b !== 'object') continue;
    const o = b as Record<string, unknown>;
    const type = String(o.type || '').toLowerCase();
    if (type === 'heading') {
      const text = str(o.text, LIMITS.heading, clean).replace(/\s*\n+\s*/g, ' ');
      if (text && room(text.length)) blocks.push({ type: 'heading', text });
    } else if (type === 'paragraph' || type === 'text') {
      const text = str(o.text, LIMITS.paragraph, clean);
      if (text && room(text.length)) blocks.push({ type: 'paragraph', text });
    } else if (type === 'bullets' || type === 'numbered') {
      const items = list(o.items);
      if (items.length && room(items.join('').length)) blocks.push({ type, items } as DocBlock);
    } else if (type === 'table') {
      const headers = (Array.isArray(o.headers) ? o.headers : []).slice(0, LIMITS.cols).map((h) => str(h, LIMITS.cell, clean));
      if (!headers.length || headers.every((h) => !h)) continue;
      const rows = (Array.isArray(o.rows) ? o.rows : []).slice(0, LIMITS.rows)
        .map((row) => headers.map((_, c) => str(Array.isArray(row) ? row[c] : '', LIMITS.cell, clean)))
        .filter((row) => row.some(Boolean));
      if (room(headers.join('').length + rows.flat().join('').length)) blocks.push({ type: 'table', headers, rows });
    }
  }
  if (!blocks.length) return null;
  const fileName = fileSlug(r.fileName);
  return { title: title || 'Document', ...(fileName ? { fileName } : {}), blocks };
}

const TRANSLIT: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n',
  о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'shch', ъ: '', ы: 'y',
  ь: '', э: 'e', ю: 'yu', я: 'ya', і: 'i', ї: 'yi', є: 'ye', ґ: 'g',
};

/** Lower-case ASCII slug: Cyrillic is transliterated, accents are dropped, everything else becomes a dash. */
export function fileSlug(raw: unknown): string {
  const s = String(raw ?? '').toLowerCase()
    .replace(/[\u0400-\u04ff]/g, (ch) => TRANSLIT[ch] ?? '')
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return s.slice(0, 60).replace(/-+$/, '');
}

/** File names are always English letters, digits and dashes: the agent's suggested name, else the title transliterated. */
export function documentFileName(spec: { title?: string; fileName?: string } | string, ext: 'docx' | 'pdf'): string {
  const title = typeof spec === 'string' ? spec : spec.title;
  const given = typeof spec === 'string' ? '' : spec.fileName;
  return `${fileSlug(given) || fileSlug(title) || 'document'}.${ext}`;
}

/* ============================== DOCX ============================== */

const A4_CONTENT_DXA = 9026; // A4 width 11906 minus 1-inch margins
const FONT = 'Arial';

/** Column widths from content length; every column gets a sensible share; the sum is exactly `total`. */
export function columnShares(headers: string[], rows: string[][], total: number): number[] {
  const weights = headers.map((h, c) => {
    const lens = [h.length, ...rows.slice(0, 40).map((r) => (r[c] || '').length)];
    const avg = lens.reduce((a, b) => a + b, 0) / lens.length;
    return Math.min(40, Math.max(8, Math.round(avg)));
  });
  const sum = weights.reduce((a, b) => a + b, 0);
  const widths = weights.map((w) => Math.floor((total * w) / sum));
  widths[widths.length - 1] += total - widths.reduce((a, b) => a + b, 0);
  return widths;
}

const lines = (text: string, bold = false, size?: number): TextRun[] =>
  text.split('\n').map((line, i) => new TextRun({ text: line, bold, size, break: i > 0 ? 1 : undefined }));

export async function buildDocx(spec: DocumentSpec): Promise<Buffer> {
  const numberedRefs: string[] = [];
  const children: (Paragraph | Table)[] = [
    new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun({ text: spec.title })] }),
  ];
  const border = { style: BorderStyle.SINGLE, size: 4, color: 'B0B8C4' };
  const borders = { top: border, bottom: border, left: border, right: border };

  for (const b of spec.blocks) {
    if (b.type === 'heading') {
      children.push(new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun({ text: b.text })] }));
    } else if (b.type === 'paragraph') {
      children.push(new Paragraph({ spacing: { after: 140, line: 300 }, children: lines(b.text) }));
    } else if (b.type === 'bullets') {
      for (const it of b.items) children.push(new Paragraph({ numbering: { reference: 'bullets', level: 0 }, spacing: { after: 60 }, children: lines(it) }));
      children.push(new Paragraph({ spacing: { after: 80 }, children: [] }));
    } else if (b.type === 'numbered') {
      const ref = `num-${numberedRefs.length}`;
      numberedRefs.push(ref);
      for (const it of b.items) children.push(new Paragraph({ numbering: { reference: ref, level: 0 }, spacing: { after: 60 }, children: lines(it) }));
      children.push(new Paragraph({ spacing: { after: 80 }, children: [] }));
    } else if (b.type === 'table') {
      const widths = columnShares(b.headers, b.rows, A4_CONTENT_DXA);
      const cell = (text: string, w: number, header: boolean) => new TableCell({
        width: { size: w, type: WidthType.DXA },
        borders,
        margins: { top: 60, bottom: 60, left: 100, right: 100 },
        shading: header ? { fill: 'E8EEF4', type: ShadingType.CLEAR, color: 'auto' } : undefined,
        children: [new Paragraph({ children: lines(text, header, 20) })],
      });
      children.push(new Table({
        width: { size: A4_CONTENT_DXA, type: WidthType.DXA },
        columnWidths: widths,
        rows: [
          new TableRow({ tableHeader: true, cantSplit: true, children: b.headers.map((h, i) => cell(h, widths[i], true)) }),
          ...b.rows.map((r) => new TableRow({ cantSplit: true, children: r.map((t, i) => cell(t, widths[i], false)) })),
        ],
      }));
      children.push(new Paragraph({ spacing: { after: 160 }, children: [] }));
    }
  }

  const levelFor = (format: (typeof LevelFormat)[keyof typeof LevelFormat], text: string) => ({
    level: 0, format, text, alignment: AlignmentType.LEFT,
    style: { paragraph: { indent: { left: 720, hanging: 360 } } },
  });

  const doc = new Document({
    creator: 'Bifurcation Engine',
    title: spec.title,
    styles: {
      default: { document: { run: { font: FONT, size: 22 } } },
      paragraphStyles: [
        { id: 'Title', name: 'Title', basedOn: 'Normal', next: 'Normal', quickFormat: true,
          run: { font: FONT, size: 38, bold: true, color: '10263D' }, paragraph: { spacing: { after: 240 } } },
        { id: 'Heading1', name: 'heading 1', basedOn: 'Normal', next: 'Normal', quickFormat: true,
          run: { font: FONT, size: 28, bold: true, color: '1F3A5F' }, paragraph: { spacing: { before: 280, after: 120 }, outlineLevel: 0, keepNext: true } },
      ],
    },
    numbering: {
      config: [
        { reference: 'bullets', levels: [levelFor(LevelFormat.BULLET, '•')] },
        ...numberedRefs.map((reference) => ({ reference, levels: [levelFor(LevelFormat.DECIMAL, '%1.')] })),
      ],
    },
    sections: [{
      properties: { page: { size: { width: 11906, height: 16838 }, margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 } } },
      footers: { default: new Footer({ children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ children: [PageNumber.CURRENT], size: 18, color: '7F93AA' })] })] }) },
      children,
    }],
  });
  return Packer.toBuffer(doc);
}

/* ============================== PDF ============================== */

const require_ = createRequire(import.meta.url);
let fontDir: string | null = null;
function fonts() {
  if (!fontDir) fontDir = path.join(path.dirname(require_.resolve('dejavu-fonts-ttf/package.json')), 'ttf');
  return {
    R: path.join(fontDir, 'DejaVuSans.ttf'),
    B: path.join(fontDir, 'DejaVuSans-Bold.ttf'),
    I: path.join(fontDir, 'DejaVuSans-Oblique.ttf'),
  };
}

export function buildPdf(spec: DocumentSpec): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: 'A4', margin: 56, bufferPages: true,
        info: { Title: spec.title, Creator: 'Bifurcation Engine', Producer: 'Bifurcation Engine' },
      });
      const chunks: Buffer[] = [];
      doc.on('data', (c: Buffer) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const f = fonts();
      doc.registerFont('R', f.R); doc.registerFont('B', f.B); doc.registerFont('I', f.I);
      const left = () => doc.page.margins.left;
      const contentWidth = () => doc.page.width - doc.page.margins.left - doc.page.margins.right;
      const bottom = () => doc.page.height - doc.page.margins.bottom;
      const ensure = (h: number) => { if (doc.y + h > bottom()) doc.addPage(); };

      doc.font('B').fontSize(20).fillColor('#10263d').text(spec.title, left(), doc.y, { width: contentWidth() });
      doc.moveDown(0.4);
      doc.moveTo(left(), doc.y).lineTo(left() + contentWidth(), doc.y).lineWidth(0.8).strokeColor('#c5d2e0').stroke();
      doc.moveDown(0.8);

      for (const b of spec.blocks) {
        if (b.type === 'heading') {
          ensure(70);
          doc.moveDown(0.5);
          doc.font('B').fontSize(14).fillColor('#1f3a5f').text(b.text, left(), doc.y, { width: contentWidth() });
          doc.moveDown(0.3);
        } else if (b.type === 'paragraph') {
          doc.font('R').fontSize(11).fillColor('#1b2733').text(b.text, left(), doc.y, { width: contentWidth(), lineGap: 3 });
          doc.moveDown(0.6);
        } else if (b.type === 'bullets' || b.type === 'numbered') {
          doc.font('R').fontSize(11).fillColor('#1b2733');
          doc.list(b.items, left(), doc.y, {
            width: contentWidth(), lineGap: 2, bulletRadius: 2, textIndent: 18, bulletIndent: 4,
            listType: b.type === 'numbered' ? 'numbered' : 'bullet',
          });
          doc.x = left();
          doc.moveDown(0.6);
        } else if (b.type === 'table') {
          const pad = 5;
          const widths = columnShares(b.headers, b.rows, contentWidth());
          const rowHeight = (cells: string[], font: 'R' | 'B') => {
            doc.font(font).fontSize(10);
            return Math.max(...cells.map((t, i) => doc.heightOfString(t || ' ', { width: widths[i] - 2 * pad }))) + 2 * pad;
          };
          const drawRow = (cells: string[], header: boolean) => {
            const font = header ? 'B' : 'R';
            const h = rowHeight(cells, font);
            if (doc.y + h > bottom()) { doc.addPage(); if (!header) drawRow(b.headers, true); }
            const y = doc.y;
            let x = left();
            cells.forEach((t, i) => {
              doc.rect(x, y, widths[i], h).fillAndStroke(header ? '#e8eef4' : '#ffffff', '#b0b8c4');
              doc.fillColor('#1b2733').font(font).fontSize(10).text(t, x + pad, y + pad, { width: widths[i] - 2 * pad });
              x += widths[i];
            });
            doc.x = left();
            doc.y = y + h;
          };
          drawRow(b.headers, true);
          for (const r of b.rows) drawRow(r, false);
          doc.moveDown(0.8);
        }
      }

      // Page numbers. The bottom margin is zeroed while writing so the footer never triggers a new page.
      const range = doc.bufferedPageRange();
      for (let i = range.start; i < range.start + range.count; i++) {
        doc.switchToPage(i);
        const m = doc.page.margins.bottom;
        doc.page.margins.bottom = 0;
        doc.font('R').fontSize(9).fillColor('#7f93aa')
          .text(String(i - range.start + 1), 0, doc.page.height - 36, { width: doc.page.width, align: 'center', lineBreak: false });
        doc.page.margins.bottom = m;
      }
      doc.end();
    } catch (e) { reject(e); }
  });
}
