// User-made playlists. A playlist is a named, ordered list of track paths
// (relative to the music folder), stored in IndexedDB.

import { db } from './db.js';

function newId() {
  return crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export class Playlists extends EventTarget {
  constructor() {
    super();
    /** @type {Array<{id: string, name: string, tracks: string[], created: number, updated: number}>} */
    this.list = [];
  }

  async init() {
    try {
      this.list = await db.getAll('playlists');
    } catch {
      this.list = [];
    }
    this._sort();
  }

  _sort() {
    this.list.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }));
  }

  get(id) {
    return this.list.find((p) => p.id === id) ?? null;
  }

  async _save(playlist) {
    playlist.updated = Date.now();
    await db.put('playlists', playlist);
    this.dispatchEvent(new CustomEvent('change', { detail: { id: playlist.id } }));
  }

  async create(name, tracks = []) {
    const playlist = { id: newId(), name: name.trim() || 'New playlist', tracks: [...tracks], created: Date.now(), updated: 0 };
    this.list.push(playlist);
    this._sort();
    await this._save(playlist);
    return playlist;
  }

  async rename(id, name) {
    const playlist = this.get(id);
    if (!playlist || !name.trim()) return;
    playlist.name = name.trim();
    this._sort();
    await this._save(playlist);
  }

  async remove(id) {
    const at = this.list.findIndex((p) => p.id === id);
    if (at < 0) return;
    this.list.splice(at, 1);
    await db.delete('playlists', id);
    this.dispatchEvent(new CustomEvent('change', { detail: { id } }));
  }

  /** Appends tracks. Returns how many were added. */
  async addTracks(id, paths) {
    const playlist = this.get(id);
    if (!playlist || !paths.length) return 0;
    playlist.tracks.push(...paths);
    await this._save(playlist);
    return paths.length;
  }

  async removeAt(id, index) {
    const playlist = this.get(id);
    if (!playlist || index < 0 || index >= playlist.tracks.length) return;
    playlist.tracks.splice(index, 1);
    await this._save(playlist);
  }

  async move(id, from, to) {
    const playlist = this.get(id);
    if (!playlist) return;
    const n = playlist.tracks.length;
    if (from === to || from < 0 || from >= n || to < 0 || to >= n) return;
    const [path] = playlist.tracks.splice(from, 1);
    playlist.tracks.splice(to, 0, path);
    await this._save(playlist);
  }
}
