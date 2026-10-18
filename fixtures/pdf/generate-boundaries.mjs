// Synthetic boundary fixtures. No private data, timestamps, or random IDs.
// Kept separate from the original one-positive/one-control taxonomy fixtures.
import { buildPdf, minimalDocument, streamObject } from './pdf-writer.mjs';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

export function boundaryFixtures() {
  const visible = 'BT /F1 12 Tf 72 720 Td (Synthetic visible text) Tj ET';
  const hidden = 'BT /F1 12 Tf 3 Tr 72 720 Td (SYNTHETIC-HIDDEN-42) Tj ET';
  const packet = '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:dc="http://purl.org/dc/elements/1.1/" dc:creator="SYNTHETIC-XMP-42"/></rdf:RDF></x:xmpmeta>';
  const xmp = streamObject(packet, { dictExtra: ' /Type /Metadata /Subtype /XML' });
  const form = streamObject(hidden, { dictExtra: ' /Type /XObject /Subtype /Form /BBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >>' });
  const cases = [];
  const add = (name, options, expectedStatus, failed = [], categories = []) => cases.push({
    name: `${name}.pdf`, bytes: buildPdf(minimalDocument({ contents: visible, ...options })),
    expectedStatus, expectedFailed: failed, expectedCategories: categories,
  });
  const gap = (detector, errorCode = 'unsupported_feature') => [{ detector, errorCode }];
  add('visible-control', {}, 'no_findings');
  add('xmp-catalog', { catalogueExtra: ' /Metadata 6 0 R', extraObjects: [xmp] }, 'partial', gap('pdf.metadata'));
  add('xmp-page', { pageExtra: ' /Metadata 6 0 R', extraObjects: [xmp] }, 'partial', gap('pdf.metadata'));
  add('null-metadata-control', { catalogueExtra: ' /Metadata null' }, 'no_findings');
  add('form-text-direct', { contents: '/Fm1 Do', resourcesExtra: ' /XObject << /Fm1 6 0 R >>', extraObjects: [form] }, 'partial', gap('pdf.text_layer'));
  const indirect = minimalDocument({ contents: '/Fm1 Do', extraObjects: [form, '<< /XObject << /Fm1 6 0 R >> >>'] });
  indirect[2] = '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources 7 0 R /Contents 4 0 R >>';
  cases.push({ name: 'form-text-indirect-resources.pdf', bytes: buildPdf(indirect), expectedStatus: 'partial', expectedFailed: gap('pdf.text_layer'), expectedCategories: [] });
  const inherited = [...indirect];
  inherited[1] = '<< /Type /Pages /Kids [3 0 R] /Count 1 /Resources 7 0 R >>';
  inherited[2] = '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>';
  cases.push({ name: 'form-text-inherited-resources.pdf', bytes: buildPdf(inherited), expectedStatus: 'partial', expectedFailed: gap('pdf.text_layer'), expectedCategories: [] });
  add('missing-xobject', { contents: '/Missing Do' }, 'partial', gap('pdf.text_layer', 'parser_error'));
  const image = streamObject('\x00', { dictExtra: ' /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8' });
  const imageWithMetadata = streamObject('\x00', { dictExtra: ' /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8 /Metadata 7 0 R' });
  add('xmp-image-xobject', { contents: '/Im1 Do', resourcesExtra: ' /XObject << /Im1 6 0 R >>', extraObjects: [imageWithMetadata, xmp] }, 'partial', gap('pdf.metadata'));
  add('image-xobject-control', { contents: '/Im1 Do', resourcesExtra: ' /XObject << /Im1 6 0 R >>', extraObjects: [image] }, 'partial');
  add('rotated-content', { contents: `0 1 -1 0 0 0 cm ${hidden}` }, 'partial', gap('pdf.text_layer'));
  add('skewed-text', { contents: 'BT /F1 12 Tf 1 0.2 0 1 72 720 Tm (SYNTHETIC-SKEW-42) Tj ET' }, 'partial', gap('pdf.text_layer'));
  add('translated-control', { contents: `q 2 0 0 2 10 20 cm ${visible} Q` }, 'no_findings');
  add('background-control', { contents: `0 0 0 rg 60 700 300 40 re f ${visible}` }, 'no_findings');
  add('cover-after-text', { contents: `${visible} 0 0 0 rg 60 700 300 40 re f` }, 'blocking_findings', [], ['text_under_redaction']);
  add('hidden-text-control', { contents: hidden }, 'review_required', [], ['hidden_text']);
  return cases;
}

export function boundaryManifest() {
  return { evalVersion: 'pdf-boundaries-v1', generatedBy: 'fixtures/pdf/generate-boundaries.mjs',
    provenance: 'Deterministic synthetic PDF syntax; all values are invented.',
    annotationInstructions: 'unsupported_feature means a valid structure was not inspected; it must never be completed. Controls distinguish images, supported transforms, and drawing order.',
    fixtures: Object.fromEntries(boundaryFixtures().map(({ name, bytes, ...expected }) => [name, {
      ...expected, sha256: createHash('sha256').update(bytes).digest('hex'),
    }])) };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const dir = new URL('./boundaries/', import.meta.url);
  mkdirSync(dir, { recursive: true });
  for (const { name, bytes } of boundaryFixtures()) writeFileSync(new URL(name, dir), bytes);
  writeFileSync(new URL('manifest.json', dir), JSON.stringify(boundaryManifest(), null, 2) + '\n');
  console.log(`Generated ${boundaryFixtures().length} boundary PDFs in ${fileURLToPath(dir)}`);
}
