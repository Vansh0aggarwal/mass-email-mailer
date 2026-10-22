import { describe, it, expect, afterAll } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import ExcelJS from 'exceljs';
import { createXlsxRowStream, inspectSpreadsheetFile } from '../services/spreadsheet-stream.service.js';
import { readXlsxSharedStrings, parseSharedStringsXml } from '../services/xlsx-shared-strings.service.js';

const tempFiles: string[] = [];

afterAll(() => {
  for (const file of tempFiles) {
    try {
      fs.unlinkSync(file);
    } catch {
      /* ignore */
    }
  }
});

async function writeWorkbook(filePath: string, rows: Record<string, any>[]): Promise<void> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Recipients');
  sheet.columns = [
    { header: 'Company Name', key: 'company' },
    { header: 'Work Email', key: 'email' },
    { header: 'Notes', key: 'notes' },
  ];
  for (const row of rows) sheet.addRow(row);
  await workbook.xlsx.writeFile(filePath);
}

describe('XLSX shared string resolution', () => {
  it('reads the shared string table straight from the archive', async () => {
    const file = path.join(os.tmpdir(), `xlsx_shared_${Date.now()}.xlsx`);
    tempFiles.push(file);
    await writeWorkbook(file, [
      { company: 'Acme Ltd', email: 'hi@acme.com', notes: 'first note' },
      { company: 'Beta & Co', email: 'yo@beta.com', notes: 'second note' },
    ]);

    const result = readXlsxSharedStrings(file);
    expect(result.ok).toBe(true);
    expect(result.strings).toContain('Acme Ltd');
    expect(result.strings).toContain('hi@acme.com');
    expect(result.strings).toContain('Beta & Co');
    // Index alignment matters: the table is consumed by index, not by content.
    expect(result.strings.length).toBeGreaterThan(3);
  });

  it('reports a readable failure for a non-zip file instead of throwing', () => {
    const file = path.join(os.tmpdir(), `xlsx_notzip_${Date.now()}.xlsx`);
    tempFiles.push(file);
    fs.writeFileSync(file, 'definitely not a zip archive');

    const result = readXlsxSharedStrings(file);
    expect(result.ok).toBe(false);
    expect(result.reason).toBeTruthy();
  });

  it('parses entities, empty strings and multi-run shared strings', () => {
    const xml =
      '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="5" uniqueCount="4">' +
      '<si><t>Acme &amp; Co</t></si>' +
      '<si><t>plain</t></si>' +
      '<si><t>multi</t><t xml:space="preserve"> run</t></si>' +
      '<si/>' +
      '</sst>';

    const { strings, uniqueCount } = parseSharedStringsXml(xml);
    expect(uniqueCount).toBe(4);
    expect(strings).toEqual(['Acme & Co', 'plain', 'multi run', '']);
  });
});

describe('XLSX row streaming', () => {
  it('resolves shared strings on every read (regression: unresolved { sharedString } cells)', async () => {
    const file = path.join(os.tmpdir(), `xlsx_stream_${Date.now()}.xlsx`);
    tempFiles.push(file);
    await writeWorkbook(file, [
      { company: 'Acme Ltd', email: 'hi@acme.com', notes: 'first note' },
      { company: 'Beta & Co', email: 'yo@beta.com', notes: 'second note' },
    ]);

    // The historic bug was a race inside ExcelJS' ZIP scan: reads intermittently
    // returned unresolved shared-string references, so repeat the read many times.
    for (let attempt = 0; attempt < 10; attempt++) {
      const stream = createXlsxRowStream(file);
      const rows: Record<string, string>[] = [];
      for await (const { raw } of stream.rows) rows.push(raw);

      expect(stream.parseErrors()).toEqual([]);
      expect(stream.headers()).toEqual(['Company Name', 'Work Email', 'Notes']);
      expect(rows).toHaveLength(2);
      expect(rows[0]['Company Name']).toBe('Acme Ltd');
      expect(rows[0]['Work Email']).toBe('hi@acme.com');
      expect(rows[0].Notes).toBe('first note');
      expect(rows[1]['Company Name']).toBe('Beta & Co');
      expect(rows[1].Notes).toBe('second note');
      expect(JSON.stringify(rows)).not.toContain('sharedString');
      expect(JSON.stringify(rows)).not.toContain('[object Object]');
    }
  });

  it('keeps header and data columns aligned when a header cell is empty', async () => {
    const file = path.join(os.tmpdir(), `xlsx_sparse_${Date.now()}.xlsx`);
    tempFiles.push(file);
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Recipients');
    sheet.addRow(['Company Name', '', 'Work Email']);
    sheet.addRow(['Acme Ltd', 'ignored', 'hi@acme.com']);
    await workbook.xlsx.writeFile(file);

    const stream = createXlsxRowStream(file);
    const rows: Record<string, string>[] = [];
    for await (const { raw } of stream.rows) rows.push(raw);

    expect(stream.headers()).toEqual(['Company Name', 'Work Email']);
    expect(rows).toHaveLength(1);
    expect(rows[0]['Company Name']).toBe('Acme Ltd');
    expect(rows[0]['Work Email']).toBe('hi@acme.com');
  });

  it('inspects headers and row counts from an XLSX file', async () => {
    const file = path.join(os.tmpdir(), `xlsx_inspect_${Date.now()}.xlsx`);
    tempFiles.push(file);
    await writeWorkbook(file, [
      { company: 'Acme Ltd', email: 'hi@acme.com', notes: 'first note' },
      { company: 'Beta & Co', email: 'yo@beta.com', notes: 'second note' },
    ]);

    const inspection = await inspectSpreadsheetFile(file, 'recipients.xlsx');
    expect(inspection.fileType).toBe('xlsx');
    expect(inspection.headers).toEqual(['Company Name', 'Work Email', 'Notes']);
    expect(inspection.totalRows).toBe(2);
    expect(inspection.sampleRows[0]['Company Name']).toBe('Acme Ltd');
    expect(inspection.parseErrors).toEqual([]);
  });
});
