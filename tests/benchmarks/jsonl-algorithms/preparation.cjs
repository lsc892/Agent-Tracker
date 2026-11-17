// 고정 제품 리더·파서를 재사용해 전체 파싱과 검증 후 체크포인트 재개를 비교한다.
'use strict';

const { readFileSync } = require('node:fs');
const { lstat, open } = require('node:fs/promises');
const { join, resolve, dirname } = require('node:path');
const { performance } = require('node:perf_hooks');
const { serialize } = require('node:v8');
const Module = require('node:module');
const { buildBlockIndex, inspectBlocks } = require('./block-validation.cjs');

const variants = [
  'full-xxh128', 'full-blake3', 'sha256-checkpoint', 'xxh128-checkpoint',
  'blake3-checkpoint', 'fingerprint-tail', 'block-fixed', 'block-rolling', 'block-merkle', 'block-rolling-merkle',
];

function loadResumableReader(product) {
  const path = join(product, 'dist/src/summary/jsonl/index.js');
  let source = readFileSync(path, 'utf8');
  for (const marker of ['let read = 0;', 'let lineOffset = 0;']) {
    if (source.split(marker).length !== 2) throw new Error('The frozen reader changed its cursor layout');
  }
  source = source.replace('let read = 0;', 'let read = options.startOffset ?? 0;');
  source = source.replace('let lineOffset = 0;', 'let lineOffset = options.lineOffset ?? options.startOffset ?? 0;');
  const ending = 'return { partialLine: (line?.bytes ?? 0) > 0, bytes: read, rows };';
  if (!source.includes(ending)) throw new Error('The frozen reader changed its completion contract');
  source = source.replace(ending,
    'return { partialLine: (line?.bytes ?? 0) > 0, bytes: read, rows, nextLineOffset: lineOffset };');
  const copy = new Module(path, module);
  copy.filename = path;
  copy.paths = Module._nodeModulePaths(dirname(path));
  copy._compile(source, path);
  return copy.exports.readJsonl;
}

function parserSnapshot(parser) {
  return structuredClone(Object.fromEntries(Object.entries(parser)
    .filter(([name]) => name !== 'context' && name !== 'sink')));
}

function initialMetrics() {
  return { fileReads: 0, bytesRead: 0, parsedRows: 0, fullSources: 0, reusedSources: 0,
    fallbackSources: 0, validationMs: 0, parseMs: 0, cloneMs: 0, indexBuildMs: 0,
    strongHashBytes: 0, rollingOffsets: 0, weakCandidates: 0, matchedBlocks: 0,
    movedBlocks: 0, merkleNodeHashes: 0, totalStrongHashBytes: 0 };
}

async function createEngine({ product, variant, hashers, blockBytes = 65536, observe = () => {} }) {
  if (!variants.includes(variant)) throw new Error('Unknown parsing benchmark variant');
  product = resolve(product);
  const { ClaudeParserAdapter, CodexCurrentParserAdapter } = require(join(product, 'dist/src/summary/parsers'));
  const { SourceWinners } = require(join(product, 'dist/src/summary/aggregation/sourceWinners'));
  const { SummaryError } = require(join(product, 'dist/src/summary/jsonl'));
  const { normalizedIdentity, sqlText } = require(join(product, 'dist/src/summary/scanner/sourceReader'));
  const { sourceIdentity } = require(join(product, 'dist/src/summary/scanner/sourceFingerprint'));
  const readJsonl = loadResumableReader(product);
  const fullOnly = variant.startsWith('full-');
  const blockMode = variant.startsWith('block-') ? variant.slice(6) : undefined;
  const provider = hashers[variant.includes('blake3') ? 'blake3'
    : variant.includes('xxh128') || blockMode ? 'xxh128' : 'sha256'];
  const cache = new Map();
  let priming = false;
  let totals = initialMetrics();

  async function hashFile(file, options, reportBytes, boundary) {
    const handle = await open(file.path, 'r');
    const buffer = Buffer.allocUnsafe(65536);
    const digest = provider.create();
    let position = 0;
    let prefixHash = boundary === 0 ? digest.peek() : undefined;
    try {
      while (position < file.size_bytes) {
        if (options.cancelled()) throw new SummaryError('interrupted', position);
        const limit = boundary !== undefined && position < boundary ? boundary : file.size_bytes;
        const length = Math.min(buffer.length, limit - position);
        const { bytesRead } = await handle.read(buffer, 0, length, position);
        if (!bytesRead) throw new SummaryError('file-truncated-during-read', position);
        digest.update(buffer.subarray(0, bytesRead));
        position += bytesRead;
        reportBytes(bytesRead);
        if (position === boundary) prefixHash = digest.peek();
      }
      return { prefixHash, contentHash: digest.digest() };
    } finally { await handle.close(); }
  }

  async function fingerprint(file, baseline, reportBytes) {
    const length = Math.min(1024, baseline.size);
    const buffer = Buffer.allocUnsafe(length);
    const handle = await open(file.path, 'r');
    try {
      let position = 0;
      while (position < length) {
        const { bytesRead } = await handle.read(buffer, position, length - position, position);
        if (!bytesRead) return false;
        position += bytesRead;
        reportBytes(bytesRead);
      }
      return hashers.sha256.oneShot(buffer) === baseline.fingerprint;
    } finally { await handle.close(); }
  }

  async function prepare(file, options) {
    const started = performance.now();
    let bytes = 0;
    let identity;
    let parser;
    const reportBytes = count => {
      bytes += count;
      totals.bytesRead += count;
      options.onBytes?.(count);
      observe();
    };
    const baseline = cache.get(file.path);
    const compressed = file.path.toLowerCase().endsWith('.zst');
    try {
      const before = await lstat(file.path);
      if (!before.isFile() || String(before.dev) !== file.dev || String(before.ino) !== file.inode
        || before.size < file.size_bytes) throw new SummaryError('file-replaced-during-read');
      let reuse = !priming && !fullOnly && baseline && file.size_bytes >= baseline.size
        && baseline.dev === file.dev && baseline.inode === file.inode
        && (!compressed || !baseline.partialLine);
      let contentHash;
      if (reuse) {
        totals.fileReads++;
        const validationStarted = performance.now();
        if (variant === 'fingerprint-tail') reuse = await fingerprint(file, baseline, reportBytes);
        else if (blockMode) {
          const inspected = await inspectBlocks({ path: file.path, size: file.size_bytes,
            index: baseline.blockIndex, hashProvider: provider, mode: blockMode, onBytes: reportBytes });
          reuse = inspected.prefixMatches;
          contentHash = inspected.contentHash;
          for (const name of Object.keys(totals)) {
            if (typeof inspected.metrics[name] === 'number') totals[name] += inspected.metrics[name];
          }
        } else {
          const inspected = await hashFile(file, options, reportBytes, baseline.size);
          reuse = inspected.prefixHash === baseline.contentHash;
          contentHash = inspected.contentHash;
        }
        totals.validationMs += performance.now() - validationStarted;
      }
      if (baseline && !priming && !fullOnly && !reuse) totals.fallbackSources++;

      let winners;
      let ordinal = 0;
      const cloneStarted = performance.now();
      if (reuse) {
        winners = new SourceWinners(file.provider, structuredClone(baseline.winners));
        ordinal = baseline.ordinal;
        totals.reusedSources++;
      } else {
        winners = new SourceWinners(file.provider);
        totals.fullSources++;
      }
      totals.cloneMs += performance.now() - cloneStarted;
      const sink = { identity() {}, event: value => winners.add(value, ordinal++),
        child: (reference, rootId) => winners.evidence.child(sqlText(reference), sqlText(rootId)) };
      const Parser = file.provider === 'claude' ? ClaudeParserAdapter : CodexCurrentParserAdapter;
      parser = new Parser({ provider: file.provider, path: file.path,
        sourceRoot: file.source_root, fileId: file.id, collectCapabilities: options.collectCapabilities }, sink);
      if (reuse) {
        const cloneParserStarted = performance.now();
        Object.assign(parser, structuredClone(baseline.parser));
        totals.cloneMs += performance.now() - cloneParserStarted;
      }
      const rawStart = reuse ? compressed ? baseline.size : baseline.nextLineOffset : 0;
      const lineStart = reuse ? baseline.nextLineOffset : 0;
      let rawPosition = rawStart;
      const digest = reuse ? variant === 'fingerprint-tail' ? baseline.shaState.copy() : undefined : provider.create();
      const fingerprintChunks = [];
      let fingerprintBytes = 0;
      totals.fileReads++;
      const parseStarted = performance.now();
      const read = rawStart === file.size_bytes && reuse
        ? { partialLine: baseline.partialLine, rows: 0, nextLineOffset: baseline.nextLineOffset }
        : await readJsonl(file.path, file.size_bytes, (row, offset) => parser.row(row, offset), {
          startOffset: rawStart, lineOffset: lineStart, maxLineBytes: options.maxLineBytes,
          signal: options.signal, isCancelled: options.cancelled, onBytes: reportBytes,
          onChunk: chunk => {
            if (!reuse) digest.update(chunk);
            else if (digest) {
              const skip = Math.max(0, baseline.size - rawPosition);
              if (skip < chunk.length) digest.update(chunk.subarray(skip));
            }
            if (priming && variant === 'fingerprint-tail' && fingerprintBytes < 1024) {
              const count = Math.min(1024 - fingerprintBytes, chunk.length);
              fingerprintChunks.push(Buffer.from(chunk.subarray(0, count)));
              fingerprintBytes += count;
            }
            rawPosition += chunk.length;
          },
        });
      totals.parseMs += performance.now() - parseStarted;
      totals.parsedRows += read.rows;
      let savedState;
      let savedSha;
      if (priming && !fullOnly) {
        savedState = parserSnapshot(parser);
        if (variant === 'fingerprint-tail') savedSha = digest.copy();
      }
      if (digest) contentHash = digest.digest();
      const rows = (reuse ? baseline.rows : 0) + read.rows;
      const after = await lstat(file.path);
      if (String(after.dev) !== file.dev || String(after.ino) !== file.inode || after.size < file.size_bytes
        || after.size === file.size_bytes && after.mtimeMs !== file.mtime_ms) throw new SummaryError('file-rewritten-during-read');
      identity = parser.getIdentity();
      if (rows) {
        parser.finish();
        identity = normalizedIdentity(parser.getIdentity());
      }
      const result = { ok: true, bytes, elapsedMs: performance.now() - started,
        read: { rows, partialLine: read.partialLine, contentHash,
          ...(identity ? { identity, sourceIdentity: sourceIdentity(identity) } : {}) }, winners: winners.snapshot() };
      if (priming && !fullOnly) {
        const entry = { size: file.size_bytes, dev: file.dev, inode: file.inode,
          contentHash, partialLine: read.partialLine, rows, ordinal, nextLineOffset: read.nextLineOffset,
          parser: savedState, winners: structuredClone(result.winners), shaState: savedSha,
          fingerprint: variant === 'fingerprint-tail' ? hashers.sha256.oneShot(Buffer.concat(fingerprintChunks)) : undefined };
        if (blockMode) {
          const indexStarted = performance.now();
          entry.blockIndex = await buildBlockIndex({ path: file.path, size: file.size_bytes,
            blockBytes, hashProvider: provider, onBytes: reportBytes });
          totals.indexBuildMs += performance.now() - indexStarted;
        }
        cache.set(file.path, entry);
      }
      observe();
      return result;
    } catch (error) {
      const failure = error instanceof SummaryError ? error : new SummaryError('source-read-error');
      const partialIdentity = parser?.getIdentity();
      if (partialIdentity) identity = normalizedIdentity(partialIdentity);
      return { ok: false, error: { code: failure.code, offset: failure.offset }, identity,
        bytes, elapsedMs: performance.now() - started };
    }
  }

  function cacheStats() {
    let serializedBytes = 0;
    let indexSerializedBytes = 0;
    let packedBlockPayloadBytes = 0;
    let packedMerkleInternalBytes = 0;
    for (const entry of cache.values()) {
      const { shaState: _nativeState, blockIndex, ...serializable } = entry;
      serializedBytes += serialize(serializable).length;
      if (blockIndex) {
        indexSerializedBytes += serialize(blockIndex).length;
        packedBlockPayloadBytes += blockIndex.packedBlockPayloadBytes;
        packedMerkleInternalBytes += blockIndex.packedMerkleInternalBytes;
      }
    }
    return { files: cache.size, serializedBytes, indexSerializedBytes, packedBlockPayloadBytes,
      packedMerkleInternalBytes, excludesNativeHashState: true };
  }

  return { prepare, setPriming(value) { priming = value; }, resetMetrics() { totals = initialMetrics(); },
    metrics: () => ({ ...totals }), cacheStats };
}

module.exports = { createEngine, variants };
