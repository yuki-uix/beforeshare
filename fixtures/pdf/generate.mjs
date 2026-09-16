/**
 * The §7.1 fixtures, generated rather than committed as opaque bytes.
 *
 * Each category gets a must_detect and a clean_control, and the pair is built
 * to differ in as little as possible: a detector that fires on both has found
 * the document, not the disclosure. §17.1 puts clean controls wrongly given a
 * blocking deterministic finding at zero, and a control that looks nothing like
 * its positive cannot test that.
 *
 * Every value is invented. §16.1 forbids committing real personal information,
 * and the names here are obviously not anybody's.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import {
  buildPdf, buildPdfWithOffsets, minimalDocument, pdfString, streamObject,
} from './pdf-writer.mjs';

const EVAL_VERSION = 'eval-v1';

/**
 * Keyed by the §7.1 category text, exactly as the case study writes it, so the
 * coverage check compares against the requirement rather than against a name
 * someone chose here.
 */
export const FIXTURES = {
  'standard document metadata, including author, creator, producer, title, subject, keywords, and timestamps': {
    short: 'document-metadata',
    must_detect: () => buildPdf([
      ...minimalDocument(),
      `<< /Author ${pdfString('Wendy Okonkwo')} /Creator ${pdfString('Internal Drafting Tool 3.2')}`
      + ` /Producer ${pdfString('Acme Export Pipeline')} /Title ${pdfString('Q3 layoff shortlist')}`
      + ` /Subject ${pdfString('restructuring')} /Keywords ${pdfString('confidential, headcount')}`
      + ` /CreationDate (D:20240612093000+01'00') >>`,
    ], { trailerExtra: ' /Info 6 0 R' }),
    clean_control: () => buildPdf([...minimalDocument()]),
    annotationInstructions: 'The positive carries an /Info dictionary with seven populated fields. The control has no /Info at all. Label the positive for every field present, not once for the dictionary.',
    expectedCoverage: 'completed',
    expectedRemediation: 'remove_pdf_metadata_field',
    expectedStatus: 'review_required',
  },

  'annotations and comments': {
    short: 'annotations',
    must_detect: () => buildPdf(minimalDocument({
      pageExtra: ' /Annots [6 0 R]',
      extraObjects: [
        `<< /Type /Annot /Subtype /Text /Rect [100 700 120 720] /T ${pdfString('R. Alvarez')}`
        + ` /Contents ${pdfString('Do not send this to the client yet')} >>`,
      ],
    })),
    clean_control: () => buildPdf(minimalDocument({ pageExtra: ' /Annots []' })),
    annotationInstructions: 'The positive has one text annotation carrying an author and a comment. The control declares an empty /Annots array - present but empty, which is the case a detector keying on the key rather than its contents gets wrong.',
    expectedCoverage: 'completed',
    expectedRemediation: 'remove_annotations',
    expectedStatus: 'review_required',
  },

  'form field names and values': {
    short: 'form-fields',
    must_detect: () => buildPdf(minimalDocument({
      catalogueExtra: ' /AcroForm << /Fields [6 0 R] >>',
      extraObjects: [
        `<< /FT /Tx /T ${pdfString('applicant_national_id')} /V ${pdfString('QQ-123456-C')} >>`,
      ],
    })),
    clean_control: () => buildPdf(minimalDocument({
      catalogueExtra: ' /AcroForm << /Fields [6 0 R] >>',
      extraObjects: [`<< /FT /Tx /T ${pdfString('applicant_national_id')} >>`],
    })),
    annotationInstructions: 'Both have a form field with the same name; only the positive has a value. The field name alone may be disclosive - label it - but the blocking case is the value.',
    expectedCoverage: 'completed',
    expectedRemediation: 'clear_form_values',
    expectedStatus: 'review_required',
    // This control is not silent, and saying it is would be a false
    // expectation rather than a strict one. §7.1 separates the field name from
    // its value precisely because `applicant_national_id` discloses what the
    // form collects while empty, and both documents carry that name - it is
    // what makes them a pair. Only the value is blocking.
    controlExpectedStatus: 'review_required',
    controlIsNotSilentBecause:
      'the field name discloses what the form collects, and both documents carry it; only the value is blocking',
  },

  'embedded files': {
    short: 'embedded-file',
    must_detect: () => buildPdf(minimalDocument({
      catalogueExtra: ' /Names << /EmbeddedFiles << /Names [(payroll.csv) 6 0 R] >> >>',
      extraObjects: [
        '<< /Type /Filespec /F (payroll.csv) /EF << /F 7 0 R >> >>',
        streamObject('name,salary\nW. Okonkwo,91000\nR. Alvarez,88000'),
      ],
    })),
    clean_control: () => buildPdf(minimalDocument({
      catalogueExtra: ' /Names << /EmbeddedFiles << /Names [] >> >>',
    })),
    annotationInstructions: 'The positive embeds a CSV whose contents are themselves disclosive. The control declares the name tree with no entries.',
    expectedCoverage: 'completed',
    expectedRemediation: 'remove_embedded_files',
    expectedStatus: 'blocking_findings',
  },

  'document-level JavaScript and launch actions': {
    short: 'javascript-and-launch',
    must_detect: () => buildPdf(minimalDocument({
      catalogueExtra: ' /Names << /JavaScript << /Names [(boot) 6 0 R] >> >> /OpenAction 7 0 R',
      extraObjects: [
        `<< /S /JavaScript /JS ${pdfString('app.alert("phoning home");')} >>`,
        '<< /S /Launch /F (/System/Applications/Calculator.app) >>',
      ],
    })),
    clean_control: () => buildPdf(minimalDocument({
      catalogueExtra: ' /OpenAction 6 0 R',
      extraObjects: ['<< /S /GoTo /D [3 0 R /Fit] >>'],
    })),
    annotationInstructions: 'The positive has both document-level JavaScript and a launch action. The control has an /OpenAction too - a benign GoTo - so a detector keying on /OpenAction rather than on its /S fails here. Expect review_required, not blocking: E1 set both categories to high, and §7.2\'s concern is that a user cannot judge a script, not that every script is disclosure.',
    expectedCoverage: 'completed',
    expectedRemediation: 'disable_javascript_and_launch_actions',
    expectedStatus: 'review_required',
  },

  'external and local-file references': {
    short: 'external-references',
    // Both halves of the item, because it names two categories. The positive
    // carried only the outward link, so `local_file_reference` had no sample at
    // all and its detection rate was a claim about nothing.
    must_detect: () => buildPdf(minimalDocument({
      pageExtra: ' /Annots [6 0 R 7 0 R]',
      extraObjects: [
        '<< /Type /Annot /Subtype /Link /Rect [72 700 300 720] /A'
        + ' << /S /URI /URI (https://intranet.example.invalid/hr/q3-shortlist) >> >>',
        '<< /Type /Annot /Subtype /Link /Rect [72 660 300 680] /A'
        + ' << /S /GoToR /F (/Users/wendy/Documents/severance-model.xlsx) /D [0 /Fit] >> >>',
      ],
    })),
    clean_control: () => buildPdf(minimalDocument({
      pageExtra: ' /Annots [6 0 R]',
      extraObjects: [
        '<< /Type /Annot /Subtype /Link /Rect [72 700 300 720] /A << /S /GoTo /D [3 0 R /Fit] >> >>',
      ],
    })),
    controlExpectedStatus: 'review_required',
    controlIsNotSilentBecause:
      'both documents carry a link annotation - that is what makes them a pair - and §7.1 counts an annotation whether or not it points outward',
    annotationInstructions: 'The positive carries two links: one outward to an internal host, one a /GoToR naming a path on the author\'s own disk. The control points at its own page. An internal host name is disclosive even when unreachable, and so is a local path.',
    expectedCoverage: 'completed',
    expectedRemediation: null,
    expectedStatus: 'review_required',
  },

  'text content not visually obvious in the rendered page': {
    short: 'invisible-text',
    must_detect: () => buildPdf(minimalDocument({
      contents: 'BT /F1 12 Tf 72 720 Td (Approved for release.) Tj ET\n'
        + 'BT /F1 12 Tf 3 Tr 72 700 Td (Internal note: the figure below is disputed.) Tj ET',
    })),
    clean_control: () => buildPdf(minimalDocument({
      contents: 'BT /F1 12 Tf 72 720 Td (Approved for release.) Tj ET\n'
        + 'BT /F1 12 Tf 0 Tr 72 700 Td (Internal note: the figure below is disputed.) Tj ET',
    })),
    annotationInstructions: 'Text rendering mode 3 is invisible; mode 0 is the same sentence, visible. The control is deliberately the same words - a detector that flags the sentence rather than its rendering mode fails here.',
    expectedCoverage: 'completed',
    expectedRemediation: null,
    expectedStatus: 'review_required',
  },

  'text that remains extractable beneath an apparent visual cover or redaction': {
    short: 'text-under-cover',
    must_detect: () => buildPdf(minimalDocument({
      contents: 'BT /F1 12 Tf 72 720 Td (Claimant: Wendy Okonkwo) Tj ET\n'
        + '0 0 0 rg 70 715 200 18 re f',
    })),
    clean_control: () => buildPdf(minimalDocument({
      contents: '0 0 0 rg 70 715 200 18 re f',
    })),
    annotationInstructions: 'The positive draws a filled black rectangle over text that is still in the content stream. The control has the rectangle and no text under it. This is the case where a viewer shows nothing and extraction shows everything.',
    expectedCoverage: 'completed',
    expectedRemediation: 'apply_visual_redaction',
    expectedStatus: 'blocking_findings',
  },

  'image-only pages through local OCR': {
    short: 'image-only-page',
    must_detect: () => buildPdf(minimalDocument({
      contents: 'q 612 0 0 792 0 0 cm /Im1 Do Q',
      // Merged into the /Resources the page already has. A second /Resources
      // key is undefined behaviour, and the fixture would be testing that.
      resourcesExtra: ' /XObject << /Im1 6 0 R >>',
      extraObjects: [
        streamObject('\x00\xFF\xFF\x00', {
          dictExtra: ' /Type /XObject /Subtype /Image /Width 2 /Height 2'
            + ' /ColorSpace /DeviceGray /BitsPerComponent 8',
        }),
      ],
    })),
    clean_control: () => buildPdf(minimalDocument({
      contents: 'BT /F1 12 Tf 72 720 Td (This page has extractable text.) Tj ET',
    })),
    annotationInstructions: 'The positive is a page whose only content is an image, so nothing is extractable without OCR. Expect a skip with a reason, not a finding: OCR belongs to E5, and what E3 owes here is an honest "not checked".',
    expectedCoverage: 'skipped',
    expectedRemediation: null,
    expectedStatus: 'partial',
  },

  'encryption and permission state': {
    short: 'encryption-state',
    must_detect: () => buildPdf(minimalDocument({
      extraObjects: [
        '<< /Filter /Standard /V 2 /R 3 /Length 128 /P -44'
        + ' /O <0102030405060708090A0B0C0D0E0F101112131415161718191A1B1C1D1E1F20>'
        + ' /U <202122232425262728292A2B2C2D2E2F303132333435363738393A3B3C3D3E3F> >>',
      ],
    }), { trailerExtra: ' /Encrypt 6 0 R /ID [<41> <41>]' }),
    clean_control: () => buildPdf(minimalDocument(), { trailerExtra: ' /ID [<41> <41>]' }),
    annotationInstructions: 'The positive declares an encryption dictionary with restrictive permissions (/P -44). It is not a finding about content - it is a statement about what can and cannot be checked, and §7.1 asks for the state to be reported.',
    expectedCoverage: 'skipped',
    expectedRemediation: null,
    expectedStatus: 'partial',
  },

  'digital signature presence and the likelihood that modification will invalidate it': {
    short: 'digital-signature',
    must_detect: () => buildPdf(minimalDocument({
      catalogueExtra: ' /AcroForm << /Fields [6 0 R] /SigFlags 3 >>',
      extraObjects: [
        '<< /FT /Sig /T (Signature1) /V 7 0 R >>',
        '<< /Type /Sig /Filter /Adobe.PPKLite /SubFilter /adbe.pkcs7.detached'
        + ' /ByteRange [0 100 200 300] /Contents <00> >>',
      ],
    })),
    clean_control: () => buildPdf(minimalDocument({
      catalogueExtra: ' /AcroForm << /Fields [6 0 R] /SigFlags 0 >>',
      extraObjects: [`<< /FT /Tx /T ${pdfString('unsigned_note')} >>`],
    })),
    controlExpectedStatus: 'review_required',
    controlIsNotSilentBecause:
      'the control carries an unsigned form field, and a field name is a disclosure of its own under §7.1 - it is clean of a signature, not of everything',
    annotationInstructions: 'The positive carries a signature field with a value. The finding is not the signature - it is that remediation would invalidate it, which §9.2 lists as a side effect the user must be shown before approving.',
    expectedCoverage: 'completed',
    expectedRemediation: null,
    expectedStatus: 'review_required',
  },

  'parser warnings, malformed objects, incremental updates, and unsupported features': {
    short: 'incremental-update',
    must_detect: () => {
      // A second revision appended after %%EOF: the original /Info is still in
      // the file, and a reader that trusts the newest xref never sees it.
      const base = buildPdfWithOffsets([
        ...minimalDocument(),
        `<< /Author ${pdfString('Wendy Okonkwo')} /Title ${pdfString('Superseded draft')} >>`,
      ], { trailerExtra: ' /Info 6 0 R' });
      const update = `6 0 obj\n<< /Title ${pdfString('Public version')} >>\nendobj\n`;
      const updateOffset = base.bytes.length;
      const xref = `xref\n0 1\n0000000000 65535 f \n6 1\n${String(updateOffset).padStart(10, '0')} 00000 n \n`;
      const trailer = `trailer\n<< /Size 7 /Root 1 0 R /Info 6 0 R /Prev ${base.xrefOffset} >>\n`
        + `startxref\n${updateOffset + update.length}\n%%EOF\n`;
      // /Prev points at the previous cross-reference TABLE, not at the end of
      // the previous file: a parser following the chain otherwise lands on an
      // object and never reaches the revision this fixture exists to expose.
      return Buffer.concat([base.bytes, Buffer.from(update + xref + trailer, 'binary')]);
    },
    clean_control: () => buildPdf([
      ...minimalDocument(),
      `<< /Title ${pdfString('Public version')} >>`,
    ], { trailerExtra: ' /Info 6 0 R' }),
    controlExpectedStatus: 'review_required',
    controlIsNotSilentBecause:
      'the control carries the public /Info title, which is document metadata and a finding under §7.1; it is clean of a hidden revision, not of metadata',
    annotationInstructions: 'The positive is a two-revision file whose first revision still contains an author the second removed. The control is a single revision with only the public title. A detector that reads the current xref and stops will report the control\'s contents for both.',
    expectedCoverage: 'completed',
    expectedRemediation: 'flatten_to_high_assurance_copy',
    expectedStatus: 'blocking_findings',
  },
};

export function generateAll(directory) {
  mkdirSync(directory, { recursive: true });
  const written = [];
  for (const [category, spec] of Object.entries(FIXTURES)) {
    for (const kind of ['must_detect', 'clean_control']) {
      const bytes = spec[kind]();
      const name = `${spec.short}.${kind === 'must_detect' ? 'positive' : 'control'}.pdf`;
      writeFileSync(`${directory}/${name}`, bytes);
      written.push({
        category,
        kind,
        file: name,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        bytes: bytes.length,
      });
    }
  }
  return written;
}

export { EVAL_VERSION };

const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  const dir = new URL('./files/', import.meta.url).pathname;
  const written = generateAll(dir);
  console.log(`${written.length} files in ${dir}`);
  for (const w of written) console.log(`  ${w.file}  ${w.bytes} bytes  ${w.sha256.slice(0, 12)}`);
}
