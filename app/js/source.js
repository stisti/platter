// The connection to the music folder on the (removable) drive.
//
// Chrome hands out a directory handle for the folder the user picks; the
// handle is saved in IndexedDB so the folder only has to be picked once. On a
// later visit three things can be true, and the app has to cope with each:
//   - Chrome wants the user to re-confirm access  -> 'needs-permission'
//   - access is fine but the drive is unplugged   -> 'disconnected'
//   - everything works                            -> 'connected'

import { db } from './db.js';

const HANDLE_KEY = 'rootHandle';

export class SourceError extends Error {
  /** @param {'none'|'needs-permission'|'disconnected'|'missing-file'|'unsupported'} code */
  constructor(code, cause) {
    super(`Music source: ${code}`, { cause });
    this.name = 'SourceError';
    this.code = code;
  }
}

export class MusicSource extends EventTarget {
  constructor() {
    super();
    /** @type {'none'|'needs-permission'|'connected'|'disconnected'} */
    this.state = 'none';
    /** @type {FileSystemDirectoryHandle|null} */
    this.root = null;
    this._checking = null;
    this._timer = null;
  }

  static get supported() {
    return typeof window !== 'undefined' && 'showDirectoryPicker' in window;
  }

  get folderName() {
    return this.root?.name ?? '';
  }

  /** Loads the remembered folder (if any) and works out the current state. */
  async init() {
    try {
      this.root = (await db.get('kv', HANDLE_KEY)) ?? null;
    } catch {
      this.root = null;
    }
    return this.check();
  }

  /** Opens Chrome's folder picker. Must be called from a click. */
  async pick() {
    if (!MusicSource.supported) throw new SourceError('unsupported');
    const handle = await window.showDirectoryPicker({ id: 'platter-music', mode: 'read' });
    this.root = handle;
    await db.put('kv', handle, HANDLE_KEY);
    return this.check();
  }

  /** Asks Chrome to re-grant access to the remembered folder. Must be called from a click. */
  async requestAccess() {
    if (!this.root) return this.state;
    try {
      await this.root.requestPermission({ mode: 'read' });
    } catch {
      // Dismissed, or no user gesture: check() below reports where we stand.
    }
    return this.check();
  }

  /** Re-evaluates the state. Concurrent calls share one check. */
  check() {
    this._checking ??= this._evaluate().finally(() => (this._checking = null));
    return this._checking;
  }

  async _evaluate() {
    let state = 'none';
    if (this.root) {
      let permission = 'prompt';
      try {
        permission = await this.root.queryPermission({ mode: 'read' });
      } catch {
        // treat as not granted
      }
      state = permission === 'granted' ? await this._probe() : 'needs-permission';
    }
    if (state !== this.state) {
      const previous = this.state;
      this.state = state;
      this.dispatchEvent(new CustomEvent('change', { detail: { state, previous } }));
    }
    return state;
  }

  /** Cheapest possible "is the folder really there?" test: list its first entry. */
  async _probe() {
    try {
      // eslint-disable-next-line no-unused-vars
      for await (const _ of this.root.keys()) break;
      return 'connected';
    } catch (err) {
      return err?.name === 'NotAllowedError' || err?.name === 'SecurityError' ? 'needs-permission' : 'disconnected';
    }
  }

  /**
   * Polls so the app notices the drive being unplugged or plugged back in
   * without the user having to do anything. Only while the window is visible:
   * a hidden app has nobody to tell, and should leave an idle disk alone.
   * (Playback finds out on its own the moment it next needs a file.)
   */
  watch({ connectedMs = 12000, disconnectedMs = 3000 } = {}) {
    const tick = async () => {
      if (this.root && document.visibilityState === 'visible') await this.check();
      this._timer = setTimeout(tick, this.state === 'connected' ? connectedMs : disconnectedMs);
    };
    clearTimeout(this._timer);
    this._timer = setTimeout(tick, disconnectedMs);
    const recheck = () => {
      if (this.root && document.visibilityState === 'visible') this.check();
    };
    document.addEventListener('visibilitychange', recheck);
    window.addEventListener('focus', recheck);
  }

  /**
   * Opens a file by its path relative to the music folder.
   * @throws {SourceError} with a code saying why the file cannot be had.
   */
  async getFile(path) {
    if (!this.root) throw new SourceError('none');
    try {
      const parts = path.split('/');
      let dir = this.root;
      for (let i = 0; i < parts.length - 1; i++) dir = await dir.getDirectoryHandle(parts[i]);
      const handle = await dir.getFileHandle(parts[parts.length - 1]);
      return await handle.getFile();
    } catch (err) {
      const state = await this.check();
      throw new SourceError(state === 'connected' ? 'missing-file' : state, err);
    }
  }
}
