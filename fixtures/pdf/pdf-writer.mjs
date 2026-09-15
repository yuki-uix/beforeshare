/**
 * Minimal PDF construction, in raw syntax.
 *
 * Not a library: a library's output carries that library's habits - object
 * numbering, stream compression, a Producer string it adds unasked - and a
 * fixture exists to isolate one thing. Raw syntax is also reviewable in a diff,
 * which a binary is not, and §16.2 wants the generation method recorded rather
 * than a file whose origin is "some tool".
 *
 * Deterministic on purpose: no timestamps, no random ids, no compression. A
 * fixture whose bytes change between runs cannot have a hash in its provenance.
 */

/** A PDF object, numbered from 1, written in the order given. */
export function buildPdf(objects, { trailerExtra = '' } = {}) {
  return buildPdfWithOffsets(objects, { trailerExtra }).bytes;
}

/**
 * The same, and where the cross-reference table ended up.
 *
 * An incremental update's /Prev must point at the previous table, not at the
 * end of the previous file - a parser following the chain from the newest table
 * otherwise lands on an object, gives up, and never sees the revision the
 * fixture exists to expose. Returned rather than recomputed by the caller,
 * because a caller computing it is a caller getting it wrong.
 */
export function buildPdfWithOffsets(objects, { trailerExtra = '' } = {}) {
  const header = '%PDF-1.7\n%\xE2\xE3\xCF\xD3\n';
  let body = '';
  const offsets = [];
  for (const [index, source] of objects.entries()) {
    offsets.push(header.length + body.length);
    body += `${index + 1} 0 obj\n${source}\nendobj\n`;
  }
  const xrefOffset = header.length + body.length;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    xref += `${String(offset).padStart(10, '0')} 00000 n \n`;
  }
  const trailer = `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R${trailerExtra} >>\n`
    + `startxref\n${xrefOffset}\n%%EOF\n`;
  return { bytes: Buffer.from(header + body + xref + trailer, 'binary'), xrefOffset };
}

/**
 * A stream object whose /Length is counted rather than stated.
 *
 * A declared length that disagrees with the data makes the fixture a test of
 * malformed streams, whichever category it was meant to be about: the parser
 * either truncates the data or treats the remainder as syntax. Found here as 44
 * against 45.
 */
export function streamObject(data, { dictExtra = '' } = {}) {
  return `<< /Length ${Buffer.byteLength(data, 'binary')}${dictExtra} >>\nstream\n${data}\nendstream`;
}

/** A catalogue, pages tree and one page - the least a reader will open. */
export function minimalDocument({ catalogueExtra = '', pageExtra = '', resourcesExtra = '',
  extraObjects = [],
  contents = 'BT /F1 12 Tf 72 720 Td (Nothing to see here.) Tj ET' } = {}) {
  const contentStream = streamObject(contents);
  return [
    `<< /Type /Catalog /Pages 2 0 R${catalogueExtra} >>`,
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792]`
      + ` /Resources << /Font << /F1 5 0 R >>${resourcesExtra} >> /Contents 4 0 R${pageExtra} >>`,
    contentStream,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    ...extraObjects,
  ];
}

/** A PDF string literal with the characters PDF treats specially escaped. */
export function pdfString(value) {
  return `(${value.replace(/[\\()]/g, (c) => `\\${c}`)})`;
}
