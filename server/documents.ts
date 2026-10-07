import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Document, Packer, Paragraph, HeadingLevel, Table, TableCell, TableRow, WidthType } from 'docx';
import * as pdfkitModule from 'pdfkit';
import { z } from 'zod';

export const documentSchema = z.object({
  title: z.string().trim().min(1).max(200),
  paragraphs: z.array(z.string().max(10000)).max(100).default([]),
  bullets: z.array(z.string().max(5000)).max(100).default([]),
  sections: z.array(z.object({
    title: z.string().max(200),
    paragraphs: z.array(z.string().max(10000)).max(50).default([]),
    bullets: z.array(z.string().max(5000)).max(50).default([]),
  })).max(50).default([]),
  tables: z.array(z.object({
    headers: z.array(z.string().max(200)).max(20).default([]),
    rows: z.array(z.array(z.string().max(5000)).max(20)).max(200),
  })).max(20).default([]),
});

export type DocumentPayload = z.infer<typeof documentSchema>;

export function validateDocument(value: unknown): DocumentPayload {
  return documentSchema.parse(value);
}

function paragraphsFor(d: DocumentPayload): Paragraph[] {
  const out: Paragraph[] = [];
  for (const p of d.paragraphs) out.push(new Paragraph({ text: p, spacing: { after: 180 } }));
  for (const b of d.bullets) out.push(new Paragraph({ text: b, bullet: { level: 0 }, spacing: { after: 100 } }));
  for (const section of d.sections) {
    out.push(new Paragraph({ text: section.title, heading: HeadingLevel.HEADING_2, spacing: { before: 240, after: 120 } }));
    for (const p of section.paragraphs) out.push(new Paragraph({ text: p, spacing: { after: 180 } }));
    for (const b of section.bullets) out.push(new Paragraph({ text: b, bullet: { level: 0 }, spacing: { after: 100 } }));
  }
  return out;
}

export async function buildDocx(payload: DocumentPayload): Promise<Buffer> {
  const children: Array<Paragraph | Table> = [
    new Paragraph({ text: payload.title, heading: HeadingLevel.TITLE }),
    ...paragraphsFor(payload),
  ];
  for (const t of payload.tables) {
    if (!t.headers.length && !t.rows.length) continue;
    const rows = [
      ...(t.headers.length ? [new TableRow({ children: t.headers.map((h) => new TableCell({ children: [new Paragraph(h)] })) })] : []),
      ...t.rows.map((row) => new TableRow({
        children: row.map((cell) => new TableCell({ children: [new Paragraph(cell)] })),
      })),
    ];
    children.push(new Table({
      rows,
      width: { size: 100, type: WidthType.PERCENTAGE },
    }));
    children.push(new Paragraph({ text: '' }));
  }
  const doc = new Document({
    sections: [{ properties: {}, children }],
  });
  return Packer.toBuffer(doc);
}

function pdfText(value: string): string {
  return value.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

const PDFDocument: any = (pdfkitModule as any).default || (pdfkitModule as any);

export async function buildPdf(payload: DocumentPayload): Promise<Buffer> {
  // pdfkit's bundled standard fonts do not contain Cyrillic. The application
  // supplies a Unicode-capable font via PDF_FONT_PATH in deployment.
  const fontPath = process.env.PDF_FONT_PATH || path.join(path.dirname(fileURLToPath(import.meta.url)), 'fonts', 'NotoSans-Regular.ttf');
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50, size: 'A4' });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.font(fontPath).fontSize(20).text(pdfText(payload.title), { paragraphGap: 10 });
    doc.moveDown(0.5);
    doc.fontSize(11);
    const writeParagraph = (text: string) => {
      doc.text(pdfText(text), { paragraphGap: 7, lineGap: 2 });
    };
    for (const p of payload.paragraphs) writeParagraph(p);
    for (const b of payload.bullets) doc.text(`• ${pdfText(b)}`, { paragraphGap: 5, lineGap: 2 });
    for (const section of payload.sections) {
      doc.moveDown(0.4).fontSize(14).text(pdfText(section.title)).moveDown(0.2).fontSize(11);
      for (const p of section.paragraphs) writeParagraph(p);
      for (const b of section.bullets) doc.text(`• ${pdfText(b)}`, { paragraphGap: 5, lineGap: 2 });
    }
    for (const table of payload.tables) {
      doc.moveDown(0.5).fontSize(10);
      if (table.headers.length) doc.text(table.headers.join(' | '), { continued: false });
      for (const row of table.rows) doc.text(row.join(' | '));
      doc.moveDown(0.5);
    }
    doc.end();
  });
}
