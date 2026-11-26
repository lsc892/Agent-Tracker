// Stores legacy Codex comparison signatures as transferable UTF-8 bytes.
export interface LegacySignatures {
  rowIds: Uint32Array<ArrayBuffer>;
  offsets: Float64Array<ArrayBuffer>;
  bytes: Uint8Array<ArrayBuffer>;
}

export function packLegacySignatures(signatures: readonly string[]): LegacySignatures {
  const rowIds = new Uint32Array(new ArrayBuffer(signatures.length * Uint32Array.BYTES_PER_ELEMENT));
  const offsets = new Float64Array(new ArrayBuffer((signatures.length + 1) * Float64Array.BYTES_PER_ELEMENT));
  const ids = new Map<string, number>();
  let byteLength = 0;
  for (let row = 0; row < signatures.length; row++) {
    const signature = signatures[row];
    let id = ids.get(signature);
    if (id === undefined) {
      id = ids.size;
      ids.set(signature, id);
      byteLength += Buffer.byteLength(signature);
      offsets[id + 1] = byteLength;
    }
    rowIds[row] = id;
  }

  const bytes = new Uint8Array(new ArrayBuffer(byteLength));
  const target = Buffer.from(bytes.buffer);
  // JSON.stringify escapes lone surrogates, so UTF-8 preserves exact signature equality.
  for (const [signature, id] of ids) target.write(signature, offsets[id], offsets[id + 1] - offsets[id]);
  return { rowIds, offsets: offsets.subarray(0, ids.size + 1), bytes };
}

/** Compare the ordered prefix exactly, even when files assign different IDs to the same signature. */
export function copiedLegacyPrefix(legacy: LegacySignatures, parent: LegacySignatures): number {
  const limit = Math.min(legacy.rowIds.length, parent.rowIds.length);
  const childBytes = legacy.bytes, parentBytes = parent.bytes;
  for (let copied = 0; copied < limit; copied++) {
    const childId = legacy.rowIds[copied], parentId = parent.rowIds[copied];
    const childStart = legacy.offsets[childId], parentStart = parent.offsets[parentId];
    const length = legacy.offsets[childId + 1] - childStart;
    if (length !== parent.offsets[parentId + 1] - parentStart) return copied;
    for (let offset = 0; offset < length; offset++) {
      if (childBytes[childStart + offset] !== parentBytes[parentStart + offset]) return copied;
    }
  }
  return limit;
}
