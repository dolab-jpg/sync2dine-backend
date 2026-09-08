/**
 * CV text extraction + field parsing for recruitment uploads.
 * Deliberately dependency-free: PDF (FlateDecode streams), DOCX (zip + inflateRaw), plain text.
 */
import { inflateRawSync, inflateSync } from 'zlib';

export type ParsedCv = {
  text: string;
  name?: string;
  phone?: string;
  email?: string;
  location?: string;
  summary: string;
};

const MAX_TEXT = 20000;

function collapse(text: string): string {
  return text.replace(/[ \t\u00a0]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

/** Decode PDF text-showing operators from a decompressed content stream. */
function textFromPdfContent(content: string): string {
  let out = '';
  // (literal) Tj  and  [(a) -2 (b)] TJ
  const re = /\((?:\\.|[^\\()])*\)|\bT[jJ]\b|\bTd\b|\bTD\b|\bT\*\b|\bET\b/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(content))) {
    const token = match[0];
    if (token.startsWith('(')) {
      const literal = token
        .slice(1, -1)
        .replace(/\\([()\\])/g, '$1')
        .replace(/\\n/g, '\n')
        .replace(/\\r/g, '')
        .replace(/\\t/g, ' ')
        .replace(/\\([0-7]{1,3})/g, (_m, oct) => String.fromCharCode(parseInt(oct, 8)));
      out += literal;
    } else if (token === 'Td' || token === 'TD' || token === 'T*' || token === 'ET') {
      out += '\n';
    }
  }
  return out;
}

/** Adobe ASCII85 (ReportLab writes /Filter [ /ASCII85Decode /FlateDecode ]). */
function ascii85Decode(input: Buffer): Buffer | null {
  let text = input.toString('latin1').replace(/\s+/g, '');
  if (text.startsWith('<~')) text = text.slice(2);
  const end = text.indexOf('~>');
  if (end >= 0) text = text.slice(0, end);
  const out: number[] = [];
  let tuple: number[] = [];
  for (const ch of text) {
    if (ch === 'z' && tuple.length === 0) {
      out.push(0, 0, 0, 0);
      continue;
    }
    const code = ch.charCodeAt(0) - 33;
    if (code < 0 || code > 84) return null;
    tuple.push(code);
    if (tuple.length === 5) {
      let value = 0;
      for (const digit of tuple) value = value * 85 + digit;
      out.push((value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff);
      tuple = [];
    }
  }
  if (tuple.length > 1) {
    const missing = 5 - tuple.length;
    for (let i = 0; i < missing; i += 1) tuple.push(84);
    let value = 0;
    for (const digit of tuple) value = value * 85 + digit;
    const bytes = [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
    out.push(...bytes.slice(0, 4 - missing));
  }
  return Buffer.from(out);
}

/** Undo whichever of ASCII85 / Flate the writer used, in either order. */
function decodePdfStream(raw: Buffer): Buffer | null {
  const tryInflate = (buf: Buffer): Buffer | null => {
    try {
      return inflateSync(buf);
    } catch {
      try {
        return inflateRawSync(buf);
      } catch {
        return null;
      }
    }
  };
  const inflated = tryInflate(raw);
  if (inflated) return inflated;
  const unascii = ascii85Decode(raw);
  if (unascii) {
    const then = tryInflate(unascii);
    if (then) return then;
    if (/T[jJ]\b/.test(unascii.toString('latin1'))) return unascii;
  }
  return null;
}

function extractPdfText(buffer: Buffer): string {
  const latin = buffer.toString('latin1');
  let out = '';
  // Leading non-letter keeps this off the "stream" inside "endstream".
  const streamRe = /[^a-zA-Z]stream\r?\n?/g;
  let match: RegExpExecArray | null;
  while ((match = streamRe.exec(latin))) {
    const start = match.index + match[0].length;
    const end = latin.indexOf('endstream', start);
    if (end < 0) break;
    const raw = buffer.subarray(start, end);
    const decoded = decodePdfStream(raw);
    const content = decoded ? decoded.toString('latin1') : raw.toString('latin1');
    if (/T[jJ]\b/.test(content)) out += `${textFromPdfContent(content)}\n`;
    streamRe.lastIndex = end + 'endstream'.length;
    if (out.length > MAX_TEXT * 2) break;
  }
  return collapse(out);
}

/** Minimal zip reader — pulls one entry out of a DOCX by name. */
function zipEntry(buffer: Buffer, wanted: string): Buffer | null {
  const SIG = 0x04034b50;
  for (let i = 0; i + 30 < buffer.length; i += 1) {
    if (buffer.readUInt32LE(i) !== SIG) continue;
    const method = buffer.readUInt16LE(i + 8);
    const compressedSize = buffer.readUInt32LE(i + 18);
    const nameLen = buffer.readUInt16LE(i + 26);
    const extraLen = buffer.readUInt16LE(i + 28);
    const nameStart = i + 30;
    const name = buffer.subarray(nameStart, nameStart + nameLen).toString('latin1');
    const dataStart = nameStart + nameLen + extraLen;
    if (name !== wanted) {
      if (compressedSize > 0) i = dataStart + compressedSize - 1;
      continue;
    }
    if (!compressedSize) return null; // streamed entry — sizes live in the central directory
    const data = buffer.subarray(dataStart, dataStart + compressedSize);
    if (method === 0) return data;
    try {
      return inflateRawSync(data);
    } catch {
      return null;
    }
  }
  return null;
}

function extractDocxText(buffer: Buffer): string {
  const xml = zipEntry(buffer, 'word/document.xml');
  if (!xml) return '';
  return collapse(
    xml
      .toString('utf8')
      .replace(/<w:p\b[^>]*>/g, '\n')
      .replace(/<w:tab\b[^>]*\/>/g, ' ')
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'"),
  );
}

export function extractCvText(buffer: Buffer, filename: string): string {
  const lower = filename.toLowerCase();
  const isPdf = lower.endsWith('.pdf') || buffer.subarray(0, 5).toString('latin1') === '%PDF-';
  const isZip = buffer.readUInt32LE(0) === 0x04034b50;
  let text = '';
  if (isPdf) text = extractPdfText(buffer);
  else if (lower.endsWith('.docx') || isZip) text = extractDocxText(buffer);
  else text = collapse(buffer.toString('utf8'));
  return text.slice(0, MAX_TEXT);
}

const UK_PHONE_RE = /(?:(?:\+|00)44\s?7\d{3}|\(?07\d{3}\)?)[\s.-]?\d{3}[\s.-]?\d{3}\b/;
const UK_LANDLINE_RE = /(?:(?:\+|00)44\s?|0)(?:1\d{2,3}|2\d)[\s.-]?\d{3,4}[\s.-]?\d{3,4}\b/;
const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;
const POSTCODE_RE = /\b[A-Z]{1,2}\d[A-Z\d]?\s?\d?[A-Z]{0,2}\b/;

/** UK mobile in E.164, or '' when the CV has no dialable mobile. */
export function normaliseUkMobile(raw: string): string {
  const digits = String(raw || '').replace(/[^\d+]/g, '').replace(/^00/, '+');
  const bare = digits.replace(/\D/g, '');
  if (/^447\d{9}$/.test(bare)) return `+${bare}`;
  if (/^07\d{9}$/.test(bare)) return `+44${bare.slice(1)}`;
  if (/^7\d{9}$/.test(bare)) return `+44${bare}`;
  return '';
}

const NAME_STOPWORDS = /(curriculum|vitae|resume|cv|profile|personal|statement|contact|details|address|phone|mobile|email|linkedin|references?|experience|education|skills|objective|summary)/i;

function looksLikeName(line: string): boolean {
  const trimmed = line.trim().replace(/[|,]+$/, '');
  if (trimmed.length < 4 || trimmed.length > 45) return false;
  if (NAME_STOPWORDS.test(trimmed)) return false;
  if (/\d|@|https?:/i.test(trimmed)) return false;
  const words = trimmed.split(/\s+/);
  if (words.length < 2 || words.length > 4) return false;
  return words.every((w) => /^[A-Z][a-zA-Z'’.-]*$/.test(w) || /^[A-Z.'’-]+$/.test(w));
}

function nameFromFilename(filename: string): string {
  const base = filename.replace(/\.[a-z0-9]+$/i, '');
  const cleaned = base
    .replace(/[_\-.]+/g, ' ')
    // CVDarshanPanchal → CV Darshan Panchal, so the CV/resume words can be dropped next
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\b(CV)([A-Z])/g, '$1 $2')
    .replace(/\b(cv|resume|curriculum|vitae|final|updated|copy|\d{4})\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const words = cleaned.split(' ').filter((w) => w.length > 1 && /^[A-Za-z'’-]+$/.test(w));
  if (!words.length) return '';
  return words
    .slice(0, 3)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

const UK_PLACE_RE = /\b([A-Z][a-z]+(?:[ -][A-Z][a-z]+)?)\s*,?\s*(?:UK|United Kingdom|England)\b/;

/** Town / postcode from the contact block at the top of a CV. */
function findLocation(lines: string[], text: string): string | undefined {
  const head = lines.slice(0, 15);
  for (const line of head) {
    for (const segment of line.split(/[|•·]/).map((s) => s.trim())) {
      if (!segment || segment.length > 60) continue;
      if (/@|https?:|linkedin/i.test(segment)) continue;
      const place = segment.match(UK_PLACE_RE);
      if (place) return place[0].replace(/\s+/g, ' ').trim();
      if (POSTCODE_RE.test(segment) && !/\d{6,}/.test(segment)) return segment;
    }
  }
  const place = text.match(UK_PLACE_RE);
  if (place) return place[0].replace(/\s+/g, ' ').trim();
  return text.match(POSTCODE_RE)?.[0];
}

export function parseCv(buffer: Buffer, filename: string): ParsedCv {
  const text = extractCvText(buffer, filename);
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);

  const email = text.match(EMAIL_RE)?.[0]?.toLowerCase();
  const mobileMatch = text.match(UK_PHONE_RE)?.[0] || '';
  const phone = normaliseUkMobile(mobileMatch)
    || normaliseUkMobile(text.match(UK_LANDLINE_RE)?.[0] || '');

  let name = lines.slice(0, 12).find(looksLikeName) || '';
  if (!name && email) {
    const local = email.split('@')[0].replace(/\d+/g, '');
    const parts = local.split(/[._-]+/).filter((p) => p.length > 1);
    if (parts.length >= 2) {
      name = parts.slice(0, 2).map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join(' ');
    }
  }
  if (!name) name = nameFromFilename(filename);

  const location = findLocation(lines, text);

  return {
    text,
    name: name || undefined,
    phone: phone || undefined,
    email,
    location: location || undefined,
    summary: text.slice(0, 1500),
  };
}
