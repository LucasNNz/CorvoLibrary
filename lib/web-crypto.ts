/**
 * Normalize Uint8Array values for Node/Web Crypto typings.
 *
 * TypeScript 5.9 models some Uint8Array values as backed by ArrayBufferLike,
 * while SubtleCrypto expects a BufferSource backed by ArrayBuffer. Copying the
 * bytes guarantees an ArrayBuffer-backed view without changing the payload.
 */
export function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

export function utf8ArrayBuffer(value: string): ArrayBuffer {
  return toArrayBuffer(new TextEncoder().encode(value));
}
