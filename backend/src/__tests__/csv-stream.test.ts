import { describe, it, expect } from 'vitest';
import { Readable } from 'node:stream';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCsvRowStream, inspectCsvStream } from '../services/csv-parser.service.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REAL_CSV = path.resolve(HERE, '../../../swaniki_verified_outbound_campaign(2).csv');

function streamOf(text: string, chunkSize?: number): Readable {
  if (!chunkSize) return Readable.from([text]);
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += chunkSize) chunks.push(text.slice(i, i + chunkSize));
  return Readable.from(chunks);
}

async function collect(source: Readable, highWaterMark?: number) {
  const stream = createCsvRowStream(source, highWaterMark ? { highWaterMark } : {});
  const rows: Record<string, string>[] = [];
  for await (const { rowNumber, raw } of stream.rows) {
    rows.push({ __row: String(rowNumber), ...raw });
  }
  return { rows, headers: stream.headers(), parseErrors: stream.parseErrors(), delimiter: stream.delimiter() };
}

describe('csv-parser streaming (bounded memory)', () => {
  it('parses BOM, quoted commas, escaped quotes, multiline fields and empty fields', async () => {
    const csv =
      '\uFEFFCompany Name,Work Email,Notes\r\n' +
      'Acme Ltd,hi@acme.com,"Line one, with comma\r\nand a second line"\r\n' +
      '"Quote ""Co"", Ltd",,plain\r\n';
    const { rows, headers, parseErrors } = await collect(streamOf(csv));

    expect(headers).toContain('Company Name');
    expect(parseErrors).toEqual([]);
    expect(rows).toHaveLength(2);
    expect(rows[0]['Company Name']).toBe('Acme Ltd');
    expect(rows[0]['Notes']).toBe('Line one, with comma\r\nand a second line');
    expect(rows[1]['Company Name']).toBe('Quote "Co", Ltd');
    expect(rows[1]['Notes']).toBe('plain');
  });

  it('preserves order and completeness with aggressive backpressure (highWaterMark=1)', async () => {
    const header = 'Company Name,Step 1 Body\n';
    let body = '';
    for (let i = 0; i < 1000; i++) body += `Company ${i},"Body ${i}, with comma and ""quotes"", padded ${'x'.repeat(200)}"\n`;
    const { rows } = await collect(streamOf(header + body, 97), 1);

    expect(rows).toHaveLength(1000);
    expect(rows[0]['Company Name']).toBe('Company 0');
    expect(rows[999]['Company Name']).toBe('Company 999');
    expect(rows[999]['Step 1 Body']).toContain('Body 999, with comma and "quotes"');
  });

  it('handles rows split across arbitrary chunk boundaries (partial lines)', async () => {
    const csv =
      'A,B,C\n' +
      '"multi\nline\nvalue",second,third\n' +
      'x,"comma,here",z\n';
    const { rows } = await collect(streamOf(csv, 3));
    expect(rows).toHaveLength(2);
    expect(rows[0].A).toBe('multi\nline\nvalue');
    expect(rows[0].B).toBe('second');
    expect(rows[1].B).toBe('comma,here');
  });

  it('inspectCsvStream bounds sample rows while counting every row', async () => {
    const header = 'Company Name,Work Email\n';
    let body = '';
    for (let i = 0; i < 5000; i++) body += `Company ${i},user${i}@example.com\n`;
    const source = streamOf(header + body, 512);

    const info = await inspectCsvStream(source, { maxPreviewRows: 5 });
    expect(info.totalRows).toBe(5000);
    expect(info.sampleRows).toHaveLength(5);
    expect(info.sampleRows[0]['Company Name']).toBe('Company 0');
    expect(info.headers).toContain('Work Email');
  });

  it('streams the real 6.2MB Swaniki campaign file and counts all rows', async () => {
    const source = createReadStream(REAL_CSV);
    const info = await inspectCsvStream(source, { maxPreviewRows: 3 });

    expect(info.totalRows).toBe(2908);
    expect(info.headers).toHaveLength(22);
    expect(info.headers).toContain('Step 3 Body');
    expect(info.sampleRows).toHaveLength(3);
    expect(info.parseErrors).toEqual([]);
  });
});
