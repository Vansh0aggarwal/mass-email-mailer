import fs from 'node:fs';
import zlib from 'node:zlib';

/**
 * Reader for the shared-string table of an XLSX workbook (`xl/sharedStrings.xml`).
 *
 * ExcelJS' streaming workbook reader resolves `t="s"` cells through a shared-string
 * table that it only builds when it reaches `xl/sharedStrings.xml` in the archive.
 * When the worksheet is reached first, ExcelJS defers it to a temporary file and the
 * ZIP scan can terminate before the shared strings are delivered, which leaves every
 * cell as an unresolved `{ sharedString: index }` reference. Reading the table
 * directly from the archive keeps worksheet parsing deterministic and memory bounded
 * (only the string table is materialised, exactly like ExcelJS' `cache` mode).
 */

const EOCD_SIGNATURE = 0x06054b50;
const CEN_SIGNATURE = 0x02014b50;
const LOCAL_HEADER_SIGNATURE = 0x04034b50;
const EOCD_MIN_SIZE = 22;
const MAX_ZIP_COMMENT = 0xffff;
const CENTRAL_HEADER_SIZE = 46;
const LOCAL_HEADER_SIZE = 30;

export interface XlsxSharedStringsResult {
  /** True when the table was read and validated against the workbook metadata. */
  ok: boolean;
  /** Shared strings in archive order (index == `t="s"` cell reference). */
  strings: string[];
  /** Populated when `ok` is false. */
  reason?: string;
}

function readExactly(fd: number, length: number, position: number): Buffer {
  const buffer = Buffer.alloc(length);
  let read = 0;
  while (read < length) {
    const bytes = fs.readSync(fd, buffer, read, length - read, position + read);
    if (bytes <= 0) break;
    read += bytes;
  }
  return read === length ? buffer : buffer.subarray(0, read);
}

/**
 * Decodes the XML entities that may appear inside a shared string.
 */
function decodeXmlEntities(value: string): string {
  if (!value.includes('&')) return value;
  return value.replace(/&(#x?[0-9a-fA-F]+|amp|lt|gt|quot|apos);/g, (match, entity: string) => {
    switch (entity) {
      case 'amp':
        return '&';
      case 'lt':
        return '<';
      case 'gt':
        return '>';
      case 'quot':
        return '"';
      case 'apos':
        return "'";
      default: {
        const isHex = entity[1] === 'x' || entity[1] === 'X';
        const code = isHex ? Number.parseInt(entity.slice(2), 16) : Number.parseInt(entity.slice(1), 10);
        if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return match;
        try {
          return String.fromCodePoint(code);
        } catch {
          return match;
        }
      }
    }
  });
}

/**
 * Concatenates every `<t>` run of a single `<si>` element.
 */
function extractSharedStringText(inner: string): string {
  let text = '';
  const pattern = /<t\b[^>]*\/>|<t\b[^>]*>([\s\S]*?)<\/t>/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(inner)) !== null) {
    text += decodeXmlEntities(match[1] ?? '');
  }
  return text;
}

/**
 * Parses `xl/sharedStrings.xml` into the ordered list of shared strings and the
 * `uniqueCount` declared by the workbook, when present.
 */
export function parseSharedStringsXml(xml: string): { strings: string[]; uniqueCount: number | null } {
  const uniqueCountMatch = /<sst\b[^>]*\buniqueCount="(\d+)"/.exec(xml);
  const uniqueCount = uniqueCountMatch ? Number.parseInt(uniqueCountMatch[1], 10) : null;

  const strings: string[] = [];
  const pattern = /<si\b[^>]*\/>|<si\b[^>]*>([\s\S]*?)<\/si>/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(xml)) !== null) {
    strings.push(extractSharedStringText(match[1] ?? ''));
  }

  return { strings, uniqueCount: Number.isFinite(uniqueCount as number) ? uniqueCount : null };
}

/**
 * Reads and validates the shared-string table of an XLSX workbook.
 *
 * The workbook is never loaded as a whole: only the end-of-central-directory record,
 * the central directory and the shared-string entry are read from disk.
 */
export function readXlsxSharedStrings(filePath: string): XlsxSharedStringsResult {
  let fd: number;
  try {
    fd = fs.openSync(filePath, 'r');
  } catch (err: any) {
    return { ok: false, strings: [], reason: `unable to open workbook: ${err?.message ?? String(err)}` };
  }

  try {
    const fileSize = fs.fstatSync(fd).size;
    if (fileSize < EOCD_MIN_SIZE) {
      return { ok: false, strings: [], reason: 'workbook is too small to be a valid XLSX archive' };
    }

    const tailSize = Math.min(fileSize, EOCD_MIN_SIZE + MAX_ZIP_COMMENT);
    const tail = readExactly(fd, tailSize, fileSize - tailSize);

    let eocdOffset = -1;
    for (let i = tail.length - EOCD_MIN_SIZE; i >= 0; i--) {
      if (tail.readUInt32LE(i) === EOCD_SIGNATURE) {
        eocdOffset = i;
        break;
      }
    }
    if (eocdOffset < 0) {
      return { ok: false, strings: [], reason: 'end of central directory record not found' };
    }

    const entryCount = tail.readUInt16LE(eocdOffset + 10);
    const centralDirSize = tail.readUInt32LE(eocdOffset + 12);
    const centralDirOffset = tail.readUInt32LE(eocdOffset + 16);
    if (centralDirOffset + centralDirSize > fileSize) {
      return { ok: false, strings: [], reason: 'central directory is out of bounds' };
    }

    const centralDir = readExactly(fd, centralDirSize, centralDirOffset);
    let position = 0;

    for (let i = 0; i < entryCount; i++) {
      if (position + CENTRAL_HEADER_SIZE > centralDir.length) break;
      if (centralDir.readUInt32LE(position) !== CEN_SIGNATURE) break;

      const compressionMethod = centralDir.readUInt16LE(position + 10);
      const compressedSize = centralDir.readUInt32LE(position + 20);
      const nameLength = centralDir.readUInt16LE(position + 28);
      const extraLength = centralDir.readUInt16LE(position + 30);
      const commentLength = centralDir.readUInt16LE(position + 32);
      const localHeaderOffset = centralDir.readUInt32LE(position + 42);
      const name = centralDir.toString('utf8', position + 46, position + 46 + nameLength);

      position += CENTRAL_HEADER_SIZE + nameLength + extraLength + commentLength;

      if (name !== 'xl/sharedStrings.xml') continue;
      if (compressedSize === 0) return { ok: true, strings: [] };

      const localHeader = readExactly(fd, LOCAL_HEADER_SIZE, localHeaderOffset);
      if (localHeader.length < LOCAL_HEADER_SIZE || localHeader.readUInt32LE(0) !== LOCAL_HEADER_SIGNATURE) {
        return { ok: false, strings: [], reason: 'shared strings local header is invalid' };
      }

      const localNameLength = localHeader.readUInt16LE(26);
      const localExtraLength = localHeader.readUInt16LE(28);
      const dataOffset = localHeaderOffset + LOCAL_HEADER_SIZE + localNameLength + localExtraLength;
      const compressed = readExactly(fd, compressedSize, dataOffset);
      if (compressed.length !== compressedSize) {
        return { ok: false, strings: [], reason: 'shared strings payload is truncated' };
      }

      let xml: string;
      if (compressionMethod === 0) {
        xml = compressed.toString('utf8');
      } else if (compressionMethod === 8) {
        try {
          xml = zlib.inflateRawSync(compressed).toString('utf8');
        } catch (err: any) {
          return { ok: false, strings: [], reason: `shared strings could not be inflated: ${err?.message ?? err}` };
        }
      } else {
        return { ok: false, strings: [], reason: `unsupported compression method ${compressionMethod}` };
      }

      const { strings, uniqueCount } = parseSharedStringsXml(xml);
      if (uniqueCount !== null && uniqueCount !== strings.length) {
        return {
          ok: false,
          strings: [],
          reason: `shared string count mismatch (expected ${uniqueCount}, parsed ${strings.length})`,
        };
      }

      return { ok: true, strings };
    }

    return { ok: true, strings: [] };
  } catch (err: any) {
    return { ok: false, strings: [], reason: err?.message ?? String(err) };
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      /* ignore close failures */
    }
  }
}
