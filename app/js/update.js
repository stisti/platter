// Notices when a newer Platter has been published while this one is running.
//
// The service worker always loads the latest files when a window opens, so
// only a window that stays open can fall behind. Every so often (and when the
// window comes back into view, or the network comes back) this fetches the
// published js/version.js and compares it with the version that is running.
//
// The request uses cache: 'no-store', which the service worker leaves alone:
// it must not be answered from the saved copy, and must not put a newer
// version.js into the saved copy next to older versions of the other files.

import { VERSION } from './version.js';

const MIN_GAP = 5 * 60 * 1000; // between checks triggered by focus
const PERIOD = 60 * 60 * 1000; // while the window just stays open

/** The version currently published, or null if it can't be read. */
export async function publishedVersion() {
  const response = await fetch(new URL('version.js', import.meta.url), { cache: 'no-store' });
  if (!response.ok) return null;
  return (await response.text()).match(/VERSION = '([^']+)'/)?.[1] ?? null;
}

/**
 * Calls onUpdate(version) once, when the published version differs from the
 * running one. Returns a function that checks right away.
 */
export function watchForUpdates(onUpdate) {
  let lastCheck = Date.now(); // the files were just loaded (fresh, if online)
  let found = false;

  const check = async ({ force = false } = {}) => {
    if (found || !navigator.onLine) return;
    if (!force && Date.now() - lastCheck < MIN_GAP) return;
    lastCheck = Date.now();
    try {
      const version = await publishedVersion();
      if (version && version !== VERSION && !found) {
        found = true;
        onUpdate(version);
      }
    } catch {
      lastCheck = 0; // offline after all: try again at the next chance
    }
  };

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') check();
  });
  window.addEventListener('online', () => check({ force: true }));
  setInterval(() => check({ force: true }), PERIOD);
  return () => check({ force: true });
}
