// 벤치마크 전용 네이티브 스트리밍 해시 공급자를 같은 인터페이스로 연결한다.
'use strict';

const { createHash } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { join, resolve } = require('node:path');

const dependencyRoot = resolve(__dirname, '../../.cache/jsonl-algorithms-deps/node_modules');
let providers;

function shaState(hash = createHash('sha256')) {
  return {
    update(chunk) { hash.update(chunk); return this; },
    digest() { return hash.digest('hex'); },
    peek() { return hash.copy().digest('hex'); },
    copy() { return shaState(hash.copy()); },
  };
}

function nativeState(hash, digest) {
  return {
    update(chunk) { hash.update(chunk); return this; },
    digest() { return digest(hash); },
    peek() { return digest(hash); },
  };
}

async function loadHashers() {
  if (providers) return providers;
  const xxhash = require(join(dependencyRoot, 'xxhash-addon'));
  const blake = require(join(dependencyRoot, '@napi-rs/blake-hash'));
  const xxhashPackage = JSON.parse(readFileSync(join(dependencyRoot, 'xxhash-addon/package.json'), 'utf8'));
  const blakePackage = JSON.parse(readFileSync(join(dependencyRoot, '@napi-rs/blake-hash/package.json'), 'utf8'));
  providers = {
    sha256: {
      name: 'SHA-256',
      implementation: `Node ${process.version} crypto, OpenSSL ${process.versions.openssl}, native streaming`,
      package: null,
      create: () => shaState(),
      oneShot: input => createHash('sha256').update(input).digest('hex'),
      reference: 'https://nodejs.org/api/crypto.html#class-hash',
    },
    xxh128: {
      name: 'XXH3-128',
      implementation: `xxhash-addon ${xxhashPackage.version}, xxHash 0.8.3, native N-API streaming`,
      package: { name: xxhashPackage.name, version: xxhashPackage.version },
      create: () => nativeState(new xxhash.XXHash128(Buffer.alloc(8)), hash => hash.digest().toString('hex')),
      oneShot: input => xxhash.XXHash128.hash(input).toString('hex'),
      reference: 'https://github.com/ktrongnhan/xxhash-addon',
    },
    blake3: {
      name: 'BLAKE3',
      implementation: `@napi-rs/blake-hash ${blakePackage.version}, native Rust N-API streaming`,
      package: { name: blakePackage.name, version: blakePackage.version },
      create: () => nativeState(new blake.Blake3Hasher(), hash => hash.digest('hex')),
      oneShot: input => blake.blake3(input).toString('hex'),
      reference: 'https://github.com/Brooooooklyn/blake-hash',
    },
  };
  return providers;
}

async function validateHashers() {
  const hashers = await loadHashers();
  const known = {
    sha256: { input: '', digest: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' },
    xxh128: { input: '', digest: '99aa06d3014798d86001c324468d497f' },
    blake3: { input: 'hello', digest: 'ea8f163db38682925e4491c5e58d4bb3506ef8c14eb78a86e908c5624a67200f' },
  };
  const input = Buffer.alloc(131089);
  for (let index = 0; index < input.length; index++) input[index] = (index * 31 + 17) & 255;
  const verification = {};
  for (const [id, provider] of Object.entries(hashers)) {
    const vector = known[id];
    const expected = provider.oneShot(input);
    const stream = provider.create();
    stream.update(input.subarray(0, 65536));
    const prefixDigest = stream.peek();
    stream.update(input.subarray(65536, 131072));
    stream.update(input.subarray(131072));
    const observed = stream.digest();
    if (provider.oneShot(Buffer.from(vector.input)) !== vector.digest) throw new Error(`${id} known vector mismatch`);
    if (prefixDigest !== provider.oneShot(input.subarray(0, 65536))) throw new Error(`${id} non-consuming prefix digest mismatch`);
    if (observed !== expected) throw new Error(`${id} streaming digest mismatch`);
    verification[id] = { knownVectorMatched: true, streamingMatchedOneShot: true, prefixPeekPreservedState: true };
  }
  return verification;
}

module.exports = { loadHashers, validateHashers, dependencyRoot };
