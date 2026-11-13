// Small byte-level helpers shared by the tag parsers.

/**
 * Reads byte ranges out of a Blob/File with a single sliding window, so that
 * parsing sequential metadata costs one or two disk reads per file instead of
 * one per field. That matters a lot on a USB hard drive.
 */
export class BlobReader {
  constructor(blob, { firstChunk = 65536, minChunk = 4096 } = {}) {
    this.blob = blob;
    this.size = blob.size;
    this.reads = 0;
    this._buf = null;
    this._start = 0;
    this._firstChunk = firstChunk;
    this._minChunk = minChunk;
  }

  /**
   * Returns up to `length` bytes at `offset`. The result is shorter than
   * requested only when the range runs past the end of the file. The returned
   * view is only valid until the next call to read().
   */
  async read(offset, length) {
    if (!(offset >= 0) || !(length >= 0)) throw new RangeError('Invalid read range');
    const end = Math.min(offset + length, this.size);
    if (end <= offset) return new Uint8Array(0);
    if (this._buf && offset >= this._start && end <= this._start + this._buf.length) {
      return this._buf.subarray(offset - this._start, end - this._start);
    }
    const want = Math.max(end - offset, this._buf === null ? this._firstChunk : this._minChunk);
    const chunkEnd = Math.min(offset + want, this.size);
    const data = await this.blob.slice(offset, chunkEnd).arrayBuffer();
    this.reads++;
    this._buf = new Uint8Array(data);
    this._start = offset;
    return this._buf.subarray(0, end - offset);
  }
}

export const be24 = (b, o) => (b[o] << 16) | (b[o + 1] << 8) | b[o + 2];
export const be32 = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
export const le32 = (b, o) => ((b[o + 3] << 24) | (b[o + 2] << 16) | (b[o + 1] << 8) | b[o]) >>> 0;

/** ID3 "syncsafe" integer: four bytes, seven significant bits each. */
export const syncsafe = (b, o) =>
  ((b[o] & 0x7f) << 21) | ((b[o + 1] & 0x7f) << 14) | ((b[o + 2] & 0x7f) << 7) | (b[o + 3] & 0x7f);

export function latin1(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return s;
}
