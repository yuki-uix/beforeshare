/**
 * Reference implementation of the evidence masking rules in
 * docs/contracts/masking.md.
 *
 * This is the contract's executable half. The rules are stated in prose in the
 * document and enforced here; tools/test-masking.mjs runs the table of cases
 * against THIS function, not against a reimplementation of it.
 *
 * Every operation is on code points, never on UTF-16 units or bytes: masking
 * CJK text by byte produces mojibake and can still leak.
 */

export const MAX_DISPLAY_CODE_POINTS = 64;
export const HIDDEN = '***';

/** Minimum code points that must remain hidden, or the policy degrades to fully_masked. */
const MIN_HIDDEN = 2;

const cp = (s) => Array.from(s);

export const POLICIES = [
  'email_local_part',
  'digits_keep_last_4',
  'token_keep_edges',
  'text_keep_edges',
  'coordinate_coarsened',
  'fully_masked',
  'structural_label',
];

function fullyMasked(chars) {
  return '*'.repeat(chars.length);
}

function keepEdges(chars, keep) {
  if (chars.length - 2 * keep < MIN_HIDDEN) return null;
  return chars.slice(0, keep).join('') + HIDDEN + chars.slice(-keep).join('');
}

/**
 * @returns {{displayValue: string, maskPolicy: string, redacted: boolean, truncated: boolean}}
 */
export function mask(value, policy) {
  if (!POLICIES.includes(policy)) throw new Error(`unknown mask policy: ${policy}`);

  // The cap runs FIRST, so neither the tail of a long value nor its exact length
  // leaks. It applies to structural_label too: that policy is unredacted, not
  // unbounded, and an oversized "structural" value is exactly the case where a
  // detector has mislabelled content as structure.
  const all = cp(value);
  const truncated = all.length > MAX_DISPLAY_CODE_POINTS;
  const chars = truncated ? all.slice(0, MAX_DISPLAY_CODE_POINTS) : all;

  if (policy === 'structural_label') {
    return { displayValue: chars.join(''), maskPolicy: policy, redacted: false, truncated };
  }

  const degrade = (p) => ({
    displayValue: fullyMasked(chars),
    maskPolicy: 'fully_masked',
    redacted: true,
    truncated,
    degradedFrom: p,
  });

  let displayValue;
  switch (policy) {
    case 'fully_masked':
      displayValue = fullyMasked(chars);
      break;

    case 'email_local_part': {
      const at = chars.lastIndexOf('@');
      if (at <= 0) return degrade(policy);
      const local = chars.slice(0, at);
      const domain = chars.slice(at).join('');
      if (local.length - 1 < MIN_HIDDEN) return degrade(policy);
      displayValue = local[0] + HIDDEN + domain;
      break;
    }

    case 'digits_keep_last_4': {
      const digitIdx = chars.map((c, i) => (/[0-9]/.test(c) ? i : -1)).filter((i) => i >= 0);
      if (digitIdx.length - 4 < MIN_HIDDEN) return degrade(policy);
      const keep = new Set(digitIdx.slice(-4));
      displayValue = chars.map((c, i) => (/[0-9]/.test(c) && !keep.has(i) ? '*' : c)).join('');
      break;
    }

    case 'token_keep_edges': {
      const out = chars.length >= 8 ? keepEdges(chars, 2) : null;
      if (out === null) return degrade(policy);
      displayValue = out;
      break;
    }

    case 'text_keep_edges': {
      const out = chars.length >= 4 ? keepEdges(chars, 1) : null;
      if (out === null) return degrade(policy);
      displayValue = out;
      break;
    }

    case 'coordinate_coarsened': {
      // The capped value, not the original. Every other branch works on the
      // capped code points; this one went back to the input, so a coordinate
      // written past the sixty-fourth code point was parsed and shown anyway.
      const nums = chars.join('').match(/-?\d+(\.\d+)?/g);
      if (!nums || nums.length < 2) return degrade(policy);
      displayValue = nums.slice(0, 2).map((n) => Number(n).toFixed(1)).join(', ');
      break;
    }

    default:
      throw new Error(`unhandled policy: ${policy}`);
  }

  if (cp(displayValue).length > MAX_DISPLAY_CODE_POINTS) {
    return { displayValue: fullyMasked(chars), maskPolicy: 'fully_masked', redacted: true, truncated };
  }
  return { displayValue, maskPolicy: policy, redacted: true, truncated };
}
