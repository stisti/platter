// An in-memory stand-in for the app's track store (`trackStore` in app/js/db.js).
// Records are copied in and out, as IndexedDB does, so a test can tell what was
// actually saved from what a live library object looks like.

export function memoryTrackStore(records = []) {
  const tracks = new Map(records.map((r) => [r.path, structuredClone(r)]));
  return {
    /** path -> saved record */
    tracks,
    /** what the last setLastScan() saved, or null */
    lastScan: null,
    async getAll() {
      return [...tracks.values()].map((r) => structuredClone(r));
    },
    async putMany(values) {
      for (const r of values) tracks.set(r.path, structuredClone(r));
    },
    async deleteMany(paths) {
      for (const p of paths) tracks.delete(p);
    },
    async setLastScan(info) {
      this.lastScan = structuredClone(info);
    },
  };
}
