/**
 * What this build can honestly measure today.
 *
 * §17.4 wants figures from one documented reference Mac, and this is not it.
 * What these do is bound what is plausible: a limit nobody could reach inside
 * the time allowed is not a limit, and a limit reachable in a millisecond is
 * not one either. The method is committed rather than the numbers, so the
 * figures can be taken again on the machine that counts.
 *
 * No format adapter exists, so nothing here measures parsing. What it measures
 * is what the build actually does to every file: read it whole, and hash it.
 */
import { createHash } from 'node:crypto';
import { hostname, platform, arch, cpus, totalmem } from 'node:os';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { performance } from 'node:perf_hooks';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

/** Median of repeated samples: one run of anything on a laptop is noise. */
function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function measure({ sampleBytes = 32 * 1024 * 1024, samples = 5 } = {}) {
  const bytes = Buffer.alloc(sampleBytes, 0x41);
  const dir = mkdtempSync(`${tmpdir()}/beforeshare-measure-`);
  try {
    const file = `${dir}/sample.bin`;
    writeFileSync(file, bytes);

    const hashRates = [];
    const readRates = [];
    for (let i = 0; i < samples; i += 1) {
      let start = performance.now();
      createHash('sha256').update(bytes).digest('hex');
      hashRates.push(sampleBytes / ((performance.now() - start) / 1000));

      start = performance.now();
      readFileSync(file);
      readRates.push(sampleBytes / ((performance.now() - start) / 1000));
    }

    return {
      machine: `${platform()}/${arch()} ${cpus()[0]?.model ?? 'unknown cpu'}`,
      host: hostname(),
      nodeVersion: process.version,
      totalMemoryBytes: totalmem(),
      sampleBytes,
      samples,
      hashBytesPerSecond: Math.round(median(hashRates)),
      readBytesPerSecond: Math.round(median(readRates)),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * The largest input that can still be read and hashed inside a share of the
 * §17.4 latency target, on the machine this ran on.
 *
 * Reading and hashing are the two passes every file takes before a detector
 * sees anything, so they are the floor under any inspection budget. A quarter
 * of the target leaves the rest for the work that actually finds things.
 */
/**
 * Peak resident memory for what a run holds at once.
 *
 * The build reads the input whole and, since #36, copies it on the way into the
 * record - so the floor is twice the file plus whatever the hash needs. This is
 * the constraint the time measurement turned out not to be.
 */
/**
 * The same measurement, in a process that has done nothing else.
 *
 * arrayBuffers is a process-wide total, so anything the caller allocated before
 * calling is inside the baseline - and a suite that has just expanded a 64 MB
 * decompression bomb reads a different multiplier than the same code run on its
 * own. Taking it in a child is the only way the figure means what it says.
 */
export function measureMemoryInCleanProcess({ sizes = [8, 32, 128] } = {}) {
  const script = `
    import { measureMemory } from ${JSON.stringify(import.meta.url)};
    process.stdout.write(JSON.stringify(measureMemory({ sizes: ${JSON.stringify(sizes)} })));
  `;
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', script],
    { encoding: 'utf8', maxBuffer: 1 << 20 });
  return JSON.parse(out);
}

export function measureMemory({ sizes = [8, 32, 128] } = {}) {
  /** Read at the end, so nothing is collected before it has been observed. */
  const keepAlive = [];
  const samples = sizes.map((mb) => {
    const bytes = mb * 1024 * 1024;
    // One reading per size, deliberately.
    //
    // arrayBuffers is a process-wide total, so repeating this in one process
    // contaminates itself: the previous iteration's buffers are inside the
    // `before` figure and are collected partway through the next one, which
    // makes the delta shrink and then vanish. Traced at 128 MB it read 2.00,
    // then 1.00, then 0.00 - and a median over those reports an instrument
    // fault as a finding. rss was worse still, returning 0.00 outright.
    const before = process.memoryUsage().arrayBuffers;
    const original = Buffer.alloc(bytes, 0x41);
    const copy = Uint8Array.prototype.slice.call(original);   // what intake() does
    const digest = createHash('sha256').update(copy).digest('hex');
    const held = process.memoryUsage().arrayBuffers - before;
    // The buffers themselves are kept, not one byte of each. Keeping a byte
    // lets the collector reclaim the rest partway through the next size, whose
    // `before` already counted them - the delta then shrinks and the run reads
    // 2.00, 1.50, 1.50 for a multiplier that does not depend on size.
    keepAlive.push(original, copy, digest);
    return { fileBytes: bytes, ratio: held / bytes };
  });
  if (keepAlive.length !== sizes.length * 3) throw new Error('a sample was collected early');
  return samples;
}

/**
 * Whether the samples agree well enough to be called a measurement.
 *
 * Reported rather than asserted here, so the suite can decide - but reported,
 * because a spread nobody looks at is the same as one nobody measured.
 */
export function spread(samples) {
  const values = samples.map((s) => s.ratio);
  return { min: Math.min(...values), max: Math.max(...values) };
}

/**
 * The largest input whose in-memory cost stays inside a share of the machine.
 *
 * A quarter of total memory is not a measurement, it is a decision - a desktop
 * app that takes half the machine for one file is a bad neighbour even when it
 * technically fits. What is measured is the multiplier: how many bytes are held
 * per byte of file.
 */
export function inputBytesWithinMemory(samples, { totalMemoryBytes, shareOfMemory = 0.25 } = {}) {
  // The median across sizes, not the largest: the largest is the friendliest
  // sample, and choosing it is choosing the answer.
  const ratio = median(samples.map((s) => s.ratio));
  return Math.floor((totalMemoryBytes * shareOfMemory) / ratio);
}

export function inputBytesWithin({ hashBytesPerSecond, readBytesPerSecond },
  { targetMs = 5000, shareOfTarget = 0.25 } = {}) {
  const bytesPerSecond = 1 / (1 / hashBytesPerSecond + 1 / readBytesPerSecond);
  return Math.floor(bytesPerSecond * (targetMs / 1000) * shareOfTarget);
}

const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  const result = measure();
  const memory = measureMemoryInCleanProcess();
  const memorySpread = spread(memory);
  console.log(JSON.stringify({
    ...result,
    memory,
    memorySpread,
    inputBytesWithinQuarterOfTarget: inputBytesWithin(result),
    inputBytesWithinQuarterOfMemory: inputBytesWithinMemory(memory, result),
  }, null, 2));
}
