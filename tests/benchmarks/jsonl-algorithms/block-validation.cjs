// Streams block fingerprints and exercises fixed, rolling, and Merkle prefix validation.
'use strict';

const { open } = require('node:fs/promises');

const READ_BYTES = 64 * 1024;
const MASK16 = 0xffff;

function checkArguments(size, blockBytes) {
  if (!Number.isSafeInteger(size) || size < 0) throw new RangeError('Invalid source size');
  if (!Number.isSafeInteger(blockBytes) || blockBytes < 1) throw new RangeError('Invalid block size');
}

function digestParts(provider, parts) {
  const digest = provider.create();
  for (const part of parts) digest.update(part);
  return digest.digest();
}

function weakParts(buffer, head, length) {
  let sum = 0;
  let weighted = 0;
  for (let index = 0; index < length; index++) {
    const value = buffer[(head + index) % buffer.length];
    sum = (sum + value) & MASK16;
    weighted = (weighted + (length - index) * value) & MASK16;
  }
  return { length, sum, weighted };
}

function weakValue(state) {
  return (state.sum + state.weighted * 0x10000) >>> 0;
}

function hashWindow(provider, buffer, head, length) {
  const digest = provider.create();
  const first = Math.min(length, buffer.length - head);
  digest.update(buffer.subarray(head, head + first));
  if (first < length) digest.update(buffer.subarray(0, length - first));
  return digest.digest();
}

function merkleTree(blocks, provider) {
  let hashedBytes = 0;
  let nodeHashes = 0;
  const leaves = blocks.map(block => {
    const prefix = Buffer.allocUnsafe(9);
    prefix[0] = 0;
    prefix.writeBigUInt64LE(BigInt(block.length), 1);
    const value = Buffer.from(block.hash, 'hex');
    hashedBytes += prefix.length + value.length;
    nodeHashes++;
    return digestParts(provider, [prefix, value]);
  });
  if (!leaves.length) {
    return { root: digestParts(provider, [Buffer.from([2])]), levels: [[]], hashedBytes: 1, nodeHashes: 1 };
  }
  const levels = [leaves];
  while (levels.at(-1).length > 1) {
    const before = levels.at(-1);
    const next = [];
    for (let index = 0; index < before.length; index += 2) {
      if (index + 1 === before.length) {
        next.push(before[index]);
        continue;
      }
      const left = Buffer.from(before[index], 'hex');
      const right = Buffer.from(before[index + 1], 'hex');
      hashedBytes += 1 + left.length + right.length;
      nodeHashes++;
      next.push(digestParts(provider, [Buffer.from([1]), left, right]));
    }
    levels.push(next);
  }
  return { root: levels.at(-1)[0], levels, hashedBytes, nodeHashes };
}

function addLookup(lookup, block) {
  let checksums = lookup.get(block.length);
  if (!checksums) lookup.set(block.length, checksums = new Map());
  let hashes = checksums.get(block.weak);
  if (!hashes) checksums.set(block.weak, hashes = new Map());
  let offsets = hashes.get(block.hash);
  if (!offsets) hashes.set(block.hash, offsets = new Set());
  offsets.add(block.offset);
}

/** A sequential reader hashes each observed raw chunk once and preserves the old-size boundary. */
class SourceBytes {
  constructor(file, size, provider, onBytes, prefixSize) {
    this.file = file;
    this.size = size;
    this.provider = provider;
    this.onBytes = onBytes;
    this.prefixSize = prefixSize;
    this.buffer = Buffer.allocUnsafe(Math.min(READ_BYTES, Math.max(1, size)));
    this.cursor = 0;
    this.available = 0;
    this.loaded = 0;
    this.consumed = 0;
    this.digest = provider.create();
    this.prefixHasher = prefixSize !== undefined && typeof this.digest.peek !== 'function' ? provider.create() : undefined;
    this.prefixHash = prefixSize === 0 ? this.finishPrefix() : undefined;
    this.extraPrefixHashBytes = 0;
  }

  finishPrefix() {
    return this.prefixHasher ? this.prefixHasher.digest() : this.digest.peek();
  }

  hashChunk(chunk) {
    const prefixRemaining = this.prefixSize === undefined ? 0 : this.prefixSize - this.loaded;
    if (prefixRemaining <= 0) {
      this.digest.update(chunk);
      return;
    }
    const leading = Math.min(prefixRemaining, chunk.length);
    const prefix = chunk.subarray(0, leading);
    this.digest.update(prefix);
    if (this.prefixHasher) {
      this.prefixHasher.update(prefix);
      this.extraPrefixHashBytes += prefix.length;
    }
    if (leading === prefixRemaining) this.prefixHash = this.finishPrefix();
    if (leading < chunk.length) this.digest.update(chunk.subarray(leading));
  }

  async refill() {
    if (this.cursor < this.available) return true;
    if (this.loaded === this.size) return false;
    const count = Math.min(this.buffer.length, this.size - this.loaded);
    const { bytesRead } = await this.file.read(this.buffer, 0, count, this.loaded);
    if (!bytesRead) throw new Error('Source truncated while inspecting blocks');
    this.onRawChunk?.(this.buffer.subarray(0, bytesRead));
    this.hashChunk(this.buffer.subarray(0, bytesRead));
    this.loaded += bytesRead;
    this.cursor = 0;
    this.available = bytesRead;
    this.onBytes?.(bytesRead);
    return true;
  }

  async readInto(target, offset, length) {
    let copied = 0;
    while (copied < length && await this.refill()) {
      const count = Math.min(length - copied, this.available - this.cursor);
      this.buffer.copy(target, offset + copied, this.cursor, this.cursor + count);
      copied += count;
      this.cursor += count;
      this.consumed += count;
    }
    return copied;
  }

  async drain() {
    while (await this.refill()) {
      this.consumed += this.available - this.cursor;
      this.cursor = this.available;
    }
  }
}

function metricsFor(mode) {
  return {
    mode,
    blockComparisons: 0,
    strongHashBytes: 0,
    rollingOffsets: 0,
    weakCandidates: 0,
    matchedBlocks: 0,
    movedBlocks: 0,
    matchedBytes: 0,
    merkleNodeHashes: 0,
    merkleHashBytes: 0,
  };
}

/** Builds a reusable O(block-count) index. Payload accounting excludes JS object/Map overhead. */
async function buildBlockIndex({ path, size, blockBytes = READ_BYTES, hashProvider, onBytes }) {
  checkArguments(size, blockBytes);
  const file = await open(path, 'r');
  try {
    const source = new SourceBytes(file, size, hashProvider, onBytes);
    const buffer = Buffer.allocUnsafe(Math.min(blockBytes, Math.max(1, size)));
    const blocks = [];
    const lookup = new Map();
    let offset = 0;
    while (offset < size) {
      const length = await source.readInto(buffer, 0, Math.min(blockBytes, size - offset));
      const bytes = buffer.subarray(0, length);
      const block = { offset, length, weak: weakValue(weakParts(buffer, 0, length)), hash: digestParts(hashProvider, [bytes]) };
      blocks.push(block);
      addLookup(lookup, block);
      offset += length;
    }
    const merkle = merkleTree(blocks, hashProvider);
    return {
      size,
      blockBytes,
      algorithm: hashProvider.name ?? 'xxh3-128',
      format: 'length-and-block-digest-merkle-v1',
      contentHash: source.digest.digest(),
      blocks,
      lookup,
      merkle,
      packedBlockPayloadBytes: blocks.length * 32,
      packedMerkleInternalBytes: Math.max(0, blocks.length - 1) * 16,
      buildMetrics: { bytesRead: source.loaded, strongHashBytes: size, merkleHashBytes: merkle.hashedBytes },
    };
  } finally {
    await file.close();
  }
}

async function inspectFixed(source, index, provider, mode, metrics) {
  const buffer = Buffer.allocUnsafe(Math.min(index.blockBytes, Math.max(1, source.size)));
  const current = [];
  let equal = source.size >= index.size;
  for (const previous of index.blocks) {
    const length = await source.readInto(buffer, 0, previous.length);
    if (!length) {
      equal = false;
      break;
    }
    const hash = digestParts(provider, [buffer.subarray(0, length)]);
    metrics.strongHashBytes += length;
    metrics.blockComparisons++;
    const same = length === previous.length && hash === previous.hash;
    if (same) {
      metrics.matchedBlocks++;
      metrics.matchedBytes += length;
    } else equal = false;
    if (mode === 'merkle') current.push({ length, hash });
  }
  if (mode === 'merkle') {
    const merkle = merkleTree(current, provider);
    metrics.merkleHashBytes = merkle.hashedBytes;
    metrics.merkleNodeHashes = merkle.nodeHashes;
    equal = source.size >= index.size && merkle.root === index.merkle.root;
  }
  await source.drain();
  return equal;
}

async function inspectRolling(source, index, provider, metrics) {
  const capacity = index.blockBytes;
  const ring = Buffer.allocUnsafe(capacity);
  const lengths = [...index.lookup.keys()].sort((left, right) => right - left);
  let count = await source.readInto(ring, 0, Math.min(capacity, source.size));
  let head = 0;
  let position = 0;
  let states = lengths.filter(length => length <= count).map(length => weakParts(ring, head, length));
  while (count) {
    metrics.rollingOffsets++;
    let matchedLength = 0;
    for (const state of states) {
      if (state.length > count) continue;
      const candidates = index.lookup.get(state.length).get(weakValue(state));
      if (!candidates) continue;
      metrics.weakCandidates++;
      const hash = hashWindow(provider, ring, head, state.length);
      metrics.strongHashBytes += state.length;
      const offsets = candidates.get(hash);
      if (!offsets) continue;
      metrics.matchedBlocks++;
      metrics.matchedBytes += state.length;
      if (!offsets.has(position)) metrics.movedBlocks++;
      matchedLength = state.length;
      break;
    }
    if (matchedLength === capacity) {
      position += capacity;
      head = 0;
      count = await source.readInto(ring, 0, Math.min(capacity, source.size - position));
      states = lengths.filter(length => length <= count).map(length => weakParts(ring, head, length));
      continue;
    }
    // A failed candidate slides one byte. A short final-block match slides its length.
    // The recurrence keeps these shifts linear without recalculating a whole window.
    const advance = matchedLength || 1;
    for (let step = 0; step < advance && count; step++) {
      let hasNext = source.cursor < source.available;
      if (!hasNext && source.loaded < source.size) hasNext = await source.refill();
      const incoming = hasNext ? source.buffer[source.cursor] : undefined;
      const leaving = ring[head];
      const nextCount = incoming === undefined ? count - 1 : count;
      for (const state of states) {
        if (state.length > nextCount) continue;
        const entering = state.length < count ? ring[(head + state.length) % capacity] : incoming;
        state.sum = (state.sum - leaving + entering) & MASK16;
        state.weighted = (state.weighted - state.length * leaving + state.sum) & MASK16;
      }
      if (incoming !== undefined) {
        ring[(head + count) % capacity] = incoming;
        source.cursor++;
        source.consumed++;
      }
      head = (head + 1) % capacity;
      count = nextCount;
      position++;
    }
  }
  await source.drain();
  return source.size >= index.size && source.prefixHash === index.contentHash;
}

/**
 * The returned full-file fingerprint shares the physical read with each validator.
 * Rolling additionally hashes match candidates. Prefix equality uses the old-size
 * digest boundary so shifted matches can never be accepted as an unchanged prefix.
 */
async function inspectBlocks({ path, size, index, hashProvider, mode = 'fixed', onBytes }) {
  checkArguments(size, index.blockBytes);
  if (!['fixed', 'rolling', 'merkle', 'rolling-merkle'].includes(mode)) throw new RangeError('Unknown block inspection mode');
  const file = await open(path, 'r');
  try {
    const source = new SourceBytes(file, size, hashProvider, onBytes, index.size);
    const metrics = metricsFor(mode);
    const current = [];
    let blockOrdinal = 0;
    let blockLength = 0;
    let blockDigest = hashProvider.create();
    if (mode === 'rolling-merkle') source.onRawChunk = chunk => {
      let position = 0;
      while (position < chunk.length && blockOrdinal < index.blocks.length) {
        const previous = index.blocks[blockOrdinal];
        const count = Math.min(chunk.length - position, previous.length - blockLength);
        blockDigest.update(chunk.subarray(position, position + count));
        metrics.strongHashBytes += count;
        blockLength += count;
        position += count;
        if (blockLength === previous.length) {
          current.push({ length: blockLength, hash: blockDigest.digest() });
          blockOrdinal++;
          blockLength = 0;
          blockDigest = hashProvider.create();
        }
      }
    };
    let prefixMatches = mode === 'rolling' || mode === 'rolling-merkle'
      ? await inspectRolling(source, index, hashProvider, metrics)
      : await inspectFixed(source, index, hashProvider, mode, metrics);
    if (mode === 'rolling-merkle') {
      const tree = merkleTree(current, hashProvider);
      metrics.merkleHashBytes = tree.hashedBytes;
      metrics.merkleNodeHashes = tree.nodeHashes;
      prefixMatches = size >= index.size && tree.root === index.merkle.root;
    }
    metrics.fullContentHashBytes = source.loaded;
    metrics.prefixVerificationExtraHashBytes = source.extraPrefixHashBytes;
    metrics.totalStrongHashBytes = metrics.fullContentHashBytes + metrics.strongHashBytes
      + metrics.merkleHashBytes + metrics.prefixVerificationExtraHashBytes;
    return { prefixMatches, contentHash: source.digest.digest(), bytesRead: source.loaded, metrics };
  } finally {
    await file.close();
  }
}

module.exports = { buildBlockIndex, inspectBlocks };
