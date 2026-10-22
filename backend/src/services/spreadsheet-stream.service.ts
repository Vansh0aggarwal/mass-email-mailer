import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import ExcelJS from 'exceljs';
import Papa from 'papaparse';
import { env } from '../config/env.js';
import { AppError } from '../middleware/errorHandler.js';
import { readXlsxSharedStrings } from './xlsx-shared-strings.service.js';

export interface StreamedSpreadsheetRow {
  rowNumber: number;
  raw: Record<string, string>;
}

export interface SpreadsheetStreamInspection {
  headers: string[];
  totalRows: number;
  totalRowsIsExact: boolean;
  sampleRows: Record<string, string>[];
  fileType: 'csv' | 'xlsx';
  delimiter: string;
  parseErrors: string[];
}

export interface SpreadsheetRowStream {
  headers: () => string[];
  delimiter: () => string;
  parseErrors: () => string[];
  rows: AsyncGenerator<StreamedSpreadsheetRow, void, void>;
}

/**
 * Normalizes header string, stripping BOM and extraneous whitespace/quotes.
 */
export function normalizeHeader(raw: any): string {
  if (raw === null || raw === undefined) return '';
  let str = String(raw).replace(/^\uFEFF/, '').trim();
  if (str.startsWith('"') && str.endsWith('"') && str.length >= 2) {
    str = str.slice(1, -1).trim();
  }
  return str;
}

/**
 * Safely converts an Excel cell value into a clean string, handling formulas,
 * dates, rich text, hyperlinks, and primitives without throwing.
 */
export function extractExcelCellValue(val: any): string {
  if (val === null || val === undefined) return '';
  if (typeof val === 'string') return val.trim();
  if (typeof val === 'number' || typeof val === 'boolean') return String(val);
  if (val instanceof Date) return val.toISOString();
  if (typeof val === 'object') {
    // Hyperlink or direct text property
    if (typeof val.text === 'string') return val.text.trim();
    if (typeof val.value === 'string' || typeof val.value === 'number') return String(val.value).trim();
    // Formula result
    if (val.result !== undefined && val.result !== null) return String(val.result).trim();
    // Rich text array
    if (Array.isArray(val.richText)) {
      return val.richText.map((item: any) => item?.text || '').join('').trim();
    }
    // Prevent returning [object Object] for cell models or internal objects
    return '';
  }
  return String(val).trim();
}

/**
 * Detects whether a file is a CSV or Excel file by extension and MIME type.
 */
export function detectSpreadsheetType(fileName: string, mimeType?: string): 'csv' | 'xlsx' {
  const ext = path.extname(fileName || '').toLowerCase();
  if (ext === '.xlsx' || ext === '.xls') return 'xlsx';
  if (ext === '.csv') return 'csv';

  if (mimeType) {
    if (
      mimeType.includes('spreadsheetml') ||
      mimeType.includes('vnd.ms-excel') ||
      mimeType.includes('application/octet-stream')
    ) {
      if (fileName.toLowerCase().endsWith('.xlsx')) return 'xlsx';
    }
  }
  return 'csv';
}

/**
 * Creates an async row generator for an XLSX file using ExcelJS streaming WorkbookReader.
 * Memory consumption remains flat ($O(1)$) regardless of the workbook size because
 * rows are emitted through the streaming ZIP extractor and discarded immediately after yield.
 */
export function createXlsxRowStream(
  filePath: string,
  options: { highWaterMark?: number } = {}
): SpreadsheetRowStream {
  let headers: string[] = [];
  const parseErrors: string[] = [];

  async function* iterate(): AsyncGenerator<StreamedSpreadsheetRow, void, void> {
    // ExcelJS resolves `t="s"` cells through a shared-string table it only builds
    // once it reaches `xl/sharedStrings.xml` in the archive. When the worksheet is
    // emitted first, ExcelJS defers it to a temporary file and the ZIP scan can end
    // before the shared strings are delivered, leaving every cell as an unresolved
    // `{ sharedString: index }` reference. Reading the table up front keeps the
    // worksheet on the direct streaming path and makes every read deterministic.
    const preloaded = readXlsxSharedStrings(filePath);
    if (!preloaded.ok) {
      parseErrors.push(`Excel shared strings unavailable (${preloaded.reason ?? 'unknown error'})`);
    }

    const workbookReader = new (ExcelJS.stream.xlsx as any).WorkbookReader(filePath, {
      entries: 'emit',
      sharedStrings: preloaded.ok ? 'ignore' : 'cache',
      worksheets: 'emit',
    });
    workbookReader.model = { sheets: [] };
    if (preloaded.ok) {
      workbookReader.sharedStrings = preloaded.strings;
    }

    // Column index of every header, so sparse header rows stay aligned with data.
    let headerColumns: number[] = [];

    const readCell = (row: any, column: number, fallback: any): string => {
      const cell = typeof row?.getCell === 'function' ? row.getCell(column) : null;
      const value = cell && cell.value !== undefined && cell.value !== null ? cell.value : fallback;
      // An unresolved shared-string reference means ExcelJS never saw the table;
      // resolve it from the preloaded copy instead of leaking "[object Object]".
      if (value && typeof value === 'object' && typeof value.sharedString === 'number') {
        const resolved = preloaded.strings[value.sharedString];
        return typeof resolved === 'string' ? resolved.trim() : '';
      }
      return extractExcelCellValue(value);
    };

    let rowCounter = 0;
    try {
      for await (const worksheetReader of workbookReader) {
        for await (const row of worksheetReader) {
          const rawValues: any[] = Array.isArray(row.values) ? row.values : [];
          if (rawValues.length <= 1 && (!row.cellCount || row.cellCount === 0)) continue; // Empty row

          // First non-empty row is treated as header
          if (headers.length === 0) {
            headers = [];
            headerColumns = [];
            const colLimit = Math.max(rawValues.length - 1, row.cellCount || 0);
            for (let i = 1; i <= colLimit; i++) {
              const h = normalizeHeader(readCell(row, i, rawValues[i]));
              if (h) {
                headers.push(h);
                headerColumns.push(i);
              }
            }
            continue;
          }

          // Data row: map each column to the corresponding header
          const raw: Record<string, string> = {};
          let hasData = false;
          for (let i = 0; i < headers.length; i++) {
            const h = headers[i];
            const column = headerColumns[i] ?? i + 1;
            const cellVal = readCell(row, column, rawValues[column]);
            raw[h] = cellVal;
            if (cellVal.length > 0) hasData = true;
          }

          if (hasData) {
            rowCounter++;
            yield { rowNumber: rowCounter, raw };
          }
        }
        break; // Only ingest the first worksheet
      }
    } catch (err: any) {
      parseErrors.push(`Excel parse error: ${err.message || String(err)}`);
      throw err;
    }
  }

  return {
    headers: () => headers,
    delimiter: () => ',',
    parseErrors: () => parseErrors,
    rows: iterate(),
  };
}

/**
 * Creates an async row generator for a CSV file using PapaParse with pause/resume backpressure.
 */
export function createCsvFileStream(
  filePath: string,
  options: { highWaterMark?: number } = {}
): SpreadsheetRowStream {
  const highWaterMark = Math.max(1, options.highWaterMark ?? 500);
  const lowWaterMark = Math.max(1, Math.floor(highWaterMark / 2));

  const queue: StreamedSpreadsheetRow[] = [];
  const parseErrors: string[] = [];
  let headers: string[] = [];
  let delimiter = ',';
  let rowCounter = 0;
  let done = false;
  let failure: Error | null = null;
  let paused = false;
  let handle: { pause?: () => void; resume?: () => void } | null = null;
  let notify: (() => void) | null = null;

  const wake = () => {
    if (notify) {
      const n = notify;
      notify = null;
      n();
    }
  };

  const readStream = fs.createReadStream(filePath);

  Papa.parse(readStream as any, {
    header: true,
    skipEmptyLines: 'greedy',
    dynamicTyping: false,
    transformHeader: (h: string) => normalizeHeader(h),
    step: (results: any, stepHandle: any) => {
      handle = stepHandle;
      if (results.meta?.fields && headers.length === 0) {
        headers = (results.meta.fields || []).map(normalizeHeader).filter((h: string) => h !== '');
      }
      if (results.meta?.delimiter) delimiter = results.meta.delimiter;
      for (const e of results.errors || []) {
        if (e?.type === 'Quotes' || e?.type === 'Delimiter') {
          parseErrors.push(`${e.message}${e.row !== undefined ? ` (row ${e.row + 1})` : ''}`);
        }
      }
      const raw = results.data as Record<string, string> | undefined;
      if (raw && Object.keys(raw).length > 0) {
        const cleanRaw: Record<string, string> = {};
        for (const [k, v] of Object.entries(raw)) {
          cleanRaw[normalizeHeader(k)] = v !== undefined && v !== null ? String(v) : '';
        }
        queue.push({ rowNumber: ++rowCounter, raw: cleanRaw });
      }
      if (queue.length >= highWaterMark && handle?.pause) {
        try {
          handle.pause();
          paused = true;
        } catch {}
      }
      wake();
    },
    complete: () => {
      done = true;
      wake();
    },
    error: (err: any) => {
      failure = err instanceof Error ? err : new Error(String(err?.message ?? err));
      done = true;
      wake();
    },
  });

  async function* iterate(): AsyncGenerator<StreamedSpreadsheetRow, void, void> {
    try {
      while (true) {
        if (queue.length > 0) {
          const item = queue.shift()!;
          if (paused && queue.length <= lowWaterMark) {
            paused = false;
            try {
              handle?.resume?.();
            } catch {}
          }
          yield item;
          continue;
        }
        if (failure) throw failure;
        if (done) return;
        await new Promise<void>((resolve) => {
          notify = resolve;
        });
      }
    } finally {
      if (!done) {
        try {
          readStream.destroy();
        } catch {}
      }
    }
  }

  return {
    headers: () => headers,
    delimiter: () => delimiter,
    parseErrors: () => parseErrors,
    rows: iterate(),
  };
}

/**
 * Unified row stream creator for CSV and XLSX files.
 */
export function createSpreadsheetRowStream(
  filePath: string,
  fileType: 'csv' | 'xlsx',
  options: { highWaterMark?: number } = {}
): SpreadsheetRowStream {
  if (fileType === 'xlsx') {
    return createXlsxRowStream(filePath, options);
  }
  return createCsvFileStream(filePath, options);
}

/**
 * Streams a spreadsheet file from disk and inspects its headers, samples the first
 * few rows (e.g. 5-10 rows), and determines total row count without accumulating
 * all rows in memory. For multi-GB files, samples rows and estimates total count rapidly
 * so initial UI mapping does not block.
 */
export async function inspectSpreadsheetFile(
  filePath: string,
  originalName: string,
  options: { maxPreviewRows?: number; forceExactCount?: boolean } = {}
): Promise<SpreadsheetStreamInspection> {
  const fileType = detectSpreadsheetType(originalName);
  const maxPreviewRows = Math.max(1, options.maxPreviewRows ?? 5);

  const stats = await fs.promises.stat(filePath).catch(() => null);
  const fileSize = stats?.size ?? 0;
  const isLarge = fileSize > env.IMPORT_ESTIMATION_THRESHOLD_BYTES;

  // For multi-GB CSV files, estimate total rows rapidly from sampled byte size
  // so users don't wait minutes just for column mapping:
  if (isLarge && fileType === 'csv' && !options.forceExactCount) {
    const stream = createCsvFileStream(filePath, { highWaterMark: 100 });
    const sampleRows: Record<string, string>[] = [];
    let sampledBytes = 0;
    let sampledRows = 0;

    for await (const { raw } of stream.rows) {
      sampledRows++;
      if (sampleRows.length < maxPreviewRows) {
        sampleRows.push(raw);
      }
      sampledBytes += JSON.stringify(raw).length + 2;
      if (sampledRows >= 50) break;
    }

    const headers = stream.headers();
    if (headers.length === 0) {
      throw new AppError('No columns detected in the uploaded file. Ensure the file contains a header row.', 400, 'EMPTY_FILE');
    }

    const avgRowBytes = sampledRows > 0 ? sampledBytes / sampledRows : 80;
    const estimatedTotalRows = Math.max(sampledRows, Math.round(fileSize / Math.max(20, avgRowBytes)));

    return {
      headers,
      totalRows: estimatedTotalRows,
      totalRowsIsExact: false,
      sampleRows,
      fileType,
      delimiter: stream.delimiter(),
      parseErrors: stream.parseErrors(),
    };
  }

  // Exact streaming row count
  const stream = createSpreadsheetRowStream(filePath, fileType, { highWaterMark: 256 });
  const sampleRows: Record<string, string>[] = [];
  let totalRows = 0;

  for await (const { raw } of stream.rows) {
    totalRows++;
    if (sampleRows.length < maxPreviewRows) {
      sampleRows.push(raw);
    }
  }

  const headers = stream.headers();
  if (headers.length === 0) {
    throw new AppError('No columns detected in the uploaded file. Ensure the file contains a header row.', 400, 'EMPTY_FILE');
  }

  return {
    headers,
    totalRows,
    totalRowsIsExact: true,
    sampleRows,
    fileType,
    delimiter: stream.delimiter(),
    parseErrors: stream.parseErrors(),
  };
}

/**
 * Safely removes a temporary file from disk.
 */
export async function safeUnlinkFile(filePath?: string | null): Promise<void> {
  if (!filePath) return;
  try {
    if (fs.existsSync(filePath)) {
      await fs.promises.unlink(filePath);
    }
  } catch {
    /* ignore deletion errors */
  }
}

/**
 * Ensures the temporary upload directory exists on disk and returns its path.
 */
export function ensureUploadDir(): string {
  fs.mkdirSync(env.IMPORT_UPLOAD_DIR, { recursive: true });
  return env.IMPORT_UPLOAD_DIR;
}

/**
 * Resolves an uploaded file on disk by its upload ID. Ignores chunk part files,
 * directories, and error reports.
 */
export function resolveUploadedFilePath(uploadId: string): { filePath: string; fileType: 'csv' | 'xlsx' } | null {
  const dir = ensureUploadDir();
  try {
    const files = fs.readdirSync(dir);
    const match = files.find(
      (f) => f.startsWith(uploadId) && !f.endsWith('.part') && !f.includes('_errors')
    );
    if (!match) return null;
    const fullPath = path.join(dir, match);
    const stat = fs.statSync(fullPath);
    if (!stat.isFile()) return null;
    const fileType = detectSpreadsheetType(match);
    return { filePath: fullPath, fileType };
  } catch {
    return null;
  }
}

/**
 * Writes an in-memory CSV string to a temporary file on disk so it can be streamed
 * through the unified streaming pipeline with zero heap pressure.
 */
export async function writeCsvStringToTempFile(
  csvContent: string,
  prefix: string = 'upl_raw_'
): Promise<{ filePath: string; uploadId: string; fileType: 'csv' }> {
  const dir = ensureUploadDir();
  const uploadId = `${prefix}${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const filePath = path.join(dir, `${uploadId}.csv`);
  await fs.promises.writeFile(filePath, csvContent, 'utf8');
  return { filePath, uploadId, fileType: 'csv' };
}

/**
 * Metadata tracked for resumable chunked upload sessions.
 */
export interface ChunkedUploadMeta {
  uploadId: string;
  fileName: string;
  fileSize: number;
  chunkSize: number;
  totalChunks: number;
  receivedChunks: number[];
  createdAt: string;
  fileType: 'csv' | 'xlsx';
}

/**
 * Initializes a new resumable chunked upload session.
 */
export async function initChunkedUploadSession(
  fileName: string,
  fileSize: number,
  chunkSize: number = env.IMPORT_CHUNK_SIZE_BYTES
): Promise<ChunkedUploadMeta> {
  if (fileSize > env.IMPORT_MAX_FILE_BYTES) {
    throw new AppError(
      `File size (${(fileSize / (1024 * 1024 * 1024)).toFixed(2)} GB) exceeds maximum allowed limit of ${(
        env.IMPORT_MAX_FILE_BYTES / (1024 * 1024 * 1024)
      ).toFixed(0)} GB`,
      413,
      'FILE_TOO_LARGE'
    );
  }

  const dir = ensureUploadDir();
  const fileType = detectSpreadsheetType(fileName);
  const uploadId = `upl_chnk_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;
  const totalChunks = Math.max(1, Math.ceil(fileSize / chunkSize));

  const sessionDir = path.join(dir, uploadId);
  await fs.promises.mkdir(sessionDir, { recursive: true });

  const meta: ChunkedUploadMeta = {
    uploadId,
    fileName,
    fileSize,
    chunkSize,
    totalChunks,
    receivedChunks: [],
    createdAt: new Date().toISOString(),
    fileType,
  };

  await fs.promises.writeFile(path.join(sessionDir, 'meta.json'), JSON.stringify(meta, null, 2), 'utf8');
  return meta;
}

/**
 * Writes an uploaded chunk slice to disk and updates session metadata.
 */
export async function writeUploadChunk(
  uploadId: string,
  chunkIndex: number,
  chunkBuffer: Buffer
): Promise<{
  uploadId: string;
  chunkIndex: number;
  received: boolean;
  totalReceived: number;
  totalChunks: number;
  isComplete: boolean;
}> {
  const dir = ensureUploadDir();
  const sessionDir = path.join(dir, uploadId);
  const metaPath = path.join(sessionDir, 'meta.json');

  if (!fs.existsSync(metaPath)) {
    throw new AppError('Upload session not found or expired. Please restart the upload.', 404, 'SESSION_NOT_FOUND');
  }

  const meta: ChunkedUploadMeta = JSON.parse(await fs.promises.readFile(metaPath, 'utf8'));

  if (chunkIndex < 0 || chunkIndex >= meta.totalChunks) {
    throw new AppError(
      `Invalid chunk index ${chunkIndex}. Expected 0 to ${meta.totalChunks - 1}`,
      400,
      'INVALID_CHUNK_INDEX'
    );
  }

  const chunkPath = path.join(sessionDir, `chunk_${chunkIndex}.part`);
  await fs.promises.writeFile(chunkPath, chunkBuffer);

  const receivedSet = new Set(meta.receivedChunks);
  receivedSet.add(chunkIndex);
  meta.receivedChunks = Array.from(receivedSet).sort((a, b) => a - b);

  await fs.promises.writeFile(metaPath, JSON.stringify(meta, null, 2), 'utf8');

  return {
    uploadId,
    chunkIndex,
    received: true,
    totalReceived: meta.receivedChunks.length,
    totalChunks: meta.totalChunks,
    isComplete: meta.receivedChunks.length === meta.totalChunks,
  };
}

/**
 * Retrieves the status and received chunk indices of an in-flight chunked upload session.
 */
export async function getUploadSessionStatus(uploadId: string): Promise<ChunkedUploadMeta & { isComplete: boolean }> {
  const dir = ensureUploadDir();
  const sessionDir = path.join(dir, uploadId);
  const metaPath = path.join(sessionDir, 'meta.json');

  if (!fs.existsSync(metaPath)) {
    throw new AppError('Upload session not found or expired', 404, 'SESSION_NOT_FOUND');
  }

  const meta: ChunkedUploadMeta = JSON.parse(await fs.promises.readFile(metaPath, 'utf8'));
  const isComplete = meta.receivedChunks.length === meta.totalChunks;
  return { ...meta, isComplete };
}

/**
 * Assembles all chunk slices into the finalized spreadsheet file on disk, validates
 * its contents, runs stream inspection, and cleans up chunk parts.
 */
export async function finalizeUploadSession(uploadId: string): Promise<{
  uploadId: string;
  storedFilePath: string;
  fileName: string;
  fileSize: number;
  fileType: 'csv' | 'xlsx';
  headers: string[];
  sampleRows: Record<string, string>[];
  totalRows: number;
  totalRowsIsExact: boolean;
  delimiter: string;
}> {
  const dir = ensureUploadDir();
  const sessionDir = path.join(dir, uploadId);
  const metaPath = path.join(sessionDir, 'meta.json');

  if (!fs.existsSync(metaPath)) {
    throw new AppError('Upload session not found or expired', 404, 'SESSION_NOT_FOUND');
  }

  const meta: ChunkedUploadMeta = JSON.parse(await fs.promises.readFile(metaPath, 'utf8'));

  // Verify all chunks exist
  const missingChunks: number[] = [];
  for (let i = 0; i < meta.totalChunks; i++) {
    const chunkPath = path.join(sessionDir, `chunk_${i}.part`);
    if (!fs.existsSync(chunkPath)) {
      missingChunks.push(i);
    }
  }

  if (missingChunks.length > 0) {
    throw new AppError(
      `Upload cannot be finalized: ${missingChunks.length} chunk(s) are missing (${missingChunks.slice(0, 10).join(', ')}${
        missingChunks.length > 10 ? '...' : ''
      }).`,
      400,
      'INCOMPLETE_UPLOAD'
    );
  }

  // Concatenate parts sequentially with bounded O(1) memory
  const ext = meta.fileType === 'xlsx' ? '.xlsx' : '.csv';
  const targetFilePath = path.join(dir, `${uploadId}${ext}`);
  const writeStream = fs.createWriteStream(targetFilePath, { flags: 'w' });

  for (let i = 0; i < meta.totalChunks; i++) {
    const chunkPath = path.join(sessionDir, `chunk_${i}.part`);
    await new Promise<void>((resolve, reject) => {
      const readStream = fs.createReadStream(chunkPath);
      readStream.on('error', reject);
      readStream.on('end', () => resolve());
      readStream.pipe(writeStream, { end: false });
    });
  }

  await new Promise<void>((resolve, reject) => {
    writeStream.end((err: any) => (err ? reject(err) : resolve()));
  });

  const assembledStats = await fs.promises.stat(targetFilePath);

  // Clean up chunk part directory
  try {
    for (let i = 0; i < meta.totalChunks; i++) {
      const chunkPath = path.join(sessionDir, `chunk_${i}.part`);
      await fs.promises.unlink(chunkPath).catch(() => {});
    }
    await fs.promises.unlink(metaPath).catch(() => {});
    await fs.promises.rmdir(sessionDir).catch(() => {});
  } catch {
    /* ignore session cleanup errors */
  }

  // Stream-inspect the finalized file
  const inspection = await inspectSpreadsheetFile(targetFilePath, meta.fileName, {
    maxPreviewRows: env.IMPORT_MAX_PREVIEW_ROWS,
  });

  return {
    uploadId,
    storedFilePath: targetFilePath,
    fileName: meta.fileName,
    fileSize: assembledStats.size,
    fileType: meta.fileType,
    headers: inspection.headers,
    sampleRows: inspection.sampleRows,
    totalRows: inspection.totalRows,
    totalRowsIsExact: inspection.totalRowsIsExact,
    delimiter: inspection.delimiter,
  };
}

/**
 * Aborts an active chunked upload session, freeing disk space and removing all
 * chunk files, meta.json, and partially assembled files.
 */
export async function abortUploadSession(uploadId: string): Promise<boolean> {
  if (!uploadId || typeof uploadId !== 'string') return false;
  const dir = ensureUploadDir();
  const sessionDir = path.join(dir, uploadId);
  try {
    if (fs.existsSync(sessionDir)) {
      const files = await fs.promises.readdir(sessionDir).catch(() => []);
      for (const f of files) {
        await fs.promises.unlink(path.join(sessionDir, f)).catch(() => {});
      }
      await fs.promises.rmdir(sessionDir).catch(() => {});
    }
    for (const ext of ['.csv', '.xlsx', '.xls', '.txt']) {
      const targetFilePath = path.join(dir, `${uploadId}${ext}`);
      if (fs.existsSync(targetFilePath)) {
        await fs.promises.unlink(targetFilePath).catch(() => {});
      }
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Streams row errors directly to a dedicated CSV error report file on disk so
 * millions of row-level errors never inflate process memory or MongoDB BSON documents.
 */
export async function appendRowErrorToDisk(
  jobId: string,
  error: { row: number; field: string; reason: string }
): Promise<void> {
  const dir = ensureUploadDir();
  const errorPath = path.join(dir, `${jobId}_errors.csv`);
  const exists = fs.existsSync(errorPath);
  const rowNum = error.row;
  const field = String(error.field || '').replace(/"/g, '""');
  const reason = String(error.reason || '').replace(/"/g, '""');
  const line = `"${rowNum}","${field}","${reason}","${new Date().toISOString()}"\r\n`;

  if (!exists) {
    await fs.promises.writeFile(errorPath, `Row,Field,Reason,Timestamp\r\n${line}`, 'utf8');
  } else {
    await fs.promises.appendFile(errorPath, line, 'utf8');
  }
}

/**
 * Returns the path to the disk-persisted error report for an import job if it exists.
 */
export function getJobErrorReportPath(jobId: string): string | null {
  const dir = ensureUploadDir();
  const errorPath = path.join(dir, `${jobId}_errors.csv`);
  return fs.existsSync(errorPath) ? errorPath : null;
}

/**
 * Purges old temporary upload files and reports older than the configured TTL.
 */
export async function cleanupStaleUploads(ttlHours: number = env.IMPORT_TEMP_TTL_HOURS): Promise<number> {
  const dir = ensureUploadDir();
  let purged = 0;
  try {
    const files = await fs.promises.readdir(dir);
    const now = Date.now();
    const maxAgeMs = ttlHours * 60 * 60 * 1000;
    for (const file of files) {
      const fullPath = path.join(dir, file);
      try {
        const stats = await fs.promises.stat(fullPath);
        if (now - stats.mtimeMs > maxAgeMs) {
          if (stats.isDirectory()) {
            await fs.promises.rm(fullPath, { recursive: true, force: true });
          } else {
            await fs.promises.unlink(fullPath);
          }
          purged++;
        }
      } catch {
        /* ignore individual file error */
      }
    }
  } catch {
    /* ignore dir read error */
  }
  return purged;
}

