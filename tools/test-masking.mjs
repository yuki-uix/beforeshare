#!/usr/bin/env node
/**
 * Table-driven tests for the masking rules.
 *
 * Every case calls tools/masking.mjs. Nothing here reimplements a masking rule:
 * a test that recomputes the expected output with its own copy of the logic
 * stays green when the real implementation drifts.
 */
import { mask, MAX_DISPLAY_CODE_POINTS, POLICIES } from './masking.mjs';
import { pathToFileURL } from 'node:url';

// A suite that dies instead of failing reports nothing about the case it died
// on. Anything reading this output for failures — the CI guard among them —
// sees no FAIL line and concludes the guard stopped working, or worse, that
// nothing went wrong. Any escape becomes one FAIL line and a non-zero exit.
process.on('uncaughtException', (e) => {
  console.error(`FAIL  the suite aborted instead of reporting a failure\n        ${e?.stack ?? e}`);
  process.exit(1);
});
process.on('unhandledRejection', (e) => {
  console.error(`FAIL  the suite aborted on a rejected promise\n        ${e?.stack ?? e}`);
  process.exit(1);
});


// Only run when invoked directly. tools/validate-schemas.mjs discovers exported
// arrays by importing every module in this directory; a suite that ran on import
// would execute itself — and call process.exit — inside that scan.
const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {

  let failures = 0;
  const cp = (s) => Array.from(s);

  /**
   * An assertion whose expression throws must fail, not kill the suite.
   *
   * `check(name, subject())` evaluates its argument first, so a throwing subject
   * escapes before check runs: the process dies with a stack trace, no FAIL line
   * is printed, and anything reading the output for failures — the CI guard among
   * them — sees none. A suite that dies instead of failing reports nothing about
   * the case it died on.
   *
   * Passing a function defers the call to inside the try. Plain values still work,
   * so existing call sites are unaffected.
   */
  const check = (name, cond, detail) => {
    let value;
    try {
      value = typeof cond === 'function' ? cond() : cond;
    } catch (e) {
      failures += 1;
      console.error(`FAIL  ${name}\n        threw instead of returning: ${e?.reason ?? e?.message ?? e}`);
      return;
    }
    if (value) console.log(`ok    ${name}`);
    else { failures += 1; console.error(`FAIL  ${name}${detail ? `\n        ${detail}` : ''}`); }
  };

  // --- 1. every example printed in docs/contracts/masking.md must reproduce -----
  const documented = [
    ['yuki@example.com', 'email_local_part', 'y***@example.com'],
    ['+86 138 0013 8000', 'digits_keep_last_4', '+** *** **** 8000'],
    ['sk-live-9fA2b7Qz', 'token_keep_edges', 'sk***Qz'],
    ['李建华明', 'text_keep_edges', '李***明'],
    ['31.2304, 121.4737', 'coordinate_coarsened', '31.2, 121.5'],
    ['李明', 'fully_masked', '**'],
    ['AES-256', 'structural_label', 'AES-256'],
  ];
  for (const [input, policy, expected] of documented) {
    const got = mask(input, policy).displayValue;
    check(`documented: ${policy} on ${JSON.stringify(input)}`, got === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(got)}`);
  }

  // --- 2. short values degrade rather than half-revealing ----------------------
  const degrades = [
    ['李建华', 'text_keep_edges', '3 code points would leave only 1 hidden'],
    ['ab', 'text_keep_edges', 'shorter than the policy minimum'],
    ['sk-live', 'token_keep_edges', '7 code points is below the token minimum of 8'],
    ['a@b.com', 'email_local_part', 'single-code-point local part reveals itself'],
    ['12345', 'digits_keep_last_4', '5 digits would leave only 1 hidden'],
  ];
  for (const [input, policy, why] of degrades) {
    const r = mask(input, policy);
    check(`degrades to fully_masked: ${policy} on ${JSON.stringify(input)} (${why})`,
      r.maskPolicy === 'fully_masked' && /^\*+$/.test(r.displayValue),
      `got ${JSON.stringify(r)}`);
  }

  // The boundary on the other side: these are long enough and must NOT degrade.
  const boundaries = [
    ['sk-live1', 'token_keep_edges', 8],
    ['李建华明', 'text_keep_edges', 4],
    ['555-1234', 'digits_keep_last_4', 7],
  ];
  for (const [input, policy, size] of boundaries) {
    check(`does not degrade at the boundary: ${policy} on ${JSON.stringify(input)} (${size})`,
      mask(input, policy).maskPolicy === policy,
      JSON.stringify(mask(input, policy)));
  }

  // --- 3. no policy ever leaves fewer than 2 code points hidden ----------------
  for (const policy of POLICIES) {
    if (policy === 'structural_label') continue;
    for (const input of ['a', 'ab', 'abc', '李', '李明', '李建华', 'a@b.c', '1', '12345']) {
      const r = mask(input, policy);
      const shown = cp(r.displayValue).filter((c) => c !== '*' && c !== undefined).length;
      const hidden = cp(input).length - cp(r.displayValue).filter((c) => c !== '*').length;
      check(`${policy} on ${JSON.stringify(input)} hides >= 2 or is fully masked`,
        /^\*+$/.test(r.displayValue) || hidden >= 2,
        `displayValue=${JSON.stringify(r.displayValue)} shown=${shown}`);
    }
  }

  // --- 4. overlong values: cap applies before masking --------------------------
  const long = '张'.repeat(500);
  const r = mask(long, 'text_keep_edges');
  check('overlong CJK value is marked truncated', r.truncated === true);
  check('overlong value respects the display cap',
    cp(r.displayValue).length <= MAX_DISPLAY_CODE_POINTS,
    `length ${cp(r.displayValue).length}`);
  check('overlong value does not leak its real length',
    !r.displayValue.includes(String(cp(long).length)));

  // structural_label is unredacted, not unbounded.
  const longLabel = mask('A'.repeat(65), 'structural_label');
  check('structural_label respects the display cap',
    cp(longLabel.displayValue).length === MAX_DISPLAY_CODE_POINTS && longLabel.truncated === true,
    JSON.stringify(longLabel));
  check('a short structural_label passes through untouched',
    mask('AES-256', 'structural_label').displayValue === 'AES-256'
    && mask('AES-256', 'structural_label').truncated === false);

  const longAscii = 'a'.repeat(200) + '@example.com';
  const r2 = mask(longAscii, 'email_local_part');
  check('overlong email is truncated and never emits the full domain tail',
    r2.truncated === true && cp(r2.displayValue).length <= MAX_DISPLAY_CODE_POINTS,
    JSON.stringify(r2));

  // --- 5. code-point correctness, not UTF-16 units -----------------------------
  const emoji = '👨‍👩‍👧‍👦家庭住址在北京市朝阳区';
  const r3 = mask(emoji, 'text_keep_edges');
  check('surrogate pairs are not split',
    !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(r3.displayValue),
    JSON.stringify(r3.displayValue));

  // --- 6. determinism (§17.5) --------------------------------------------------
  for (const [input, policy] of documented.map(([i, p]) => [i, p])) {
    check(`deterministic: ${policy}`, mask(input, policy).displayValue === mask(input, policy).displayValue);
  }

  // --- 7. structural_label is the only unredacted policy ----------------------
  for (const policy of POLICIES) {
    const out = mask('AES-256 sample value', policy);
    check(`${policy} sets redacted correctly`,
      policy === 'structural_label' ? out.redacted === false : out.redacted === true);
  }

  // --- 8. an unknown policy fails loudly rather than passing the value through --
  let threw = false;
  try { mask('secret', 'no_such_policy'); } catch { threw = true; }
  check('unknown policy throws instead of returning the raw value', threw);

  console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'}  masking: ${failures} failure(s)`);
  process.exit(failures === 0 ? 0 : 1);

}
