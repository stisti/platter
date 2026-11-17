// The Query page: SQL against the library (tables in ../sqlrows.js), with the
// result shown as songs to play, albums to open, or a plain table.
//
// A result with a `path` column is a list of songs; one with `album_key` (and
// no `path`) is a list of albums; anything else is a table. The page remembers
// the SQL being written and the last query run (in the preferences), and runs
// that query again whenever the page is drawn, so the result follows the
// library through rescans.

import { QueryError } from '../sqldb.js';
import { h, icon, iconButton, plural, formatLength, promptDialog, confirmDialog, toast } from './dom.js';
import { pageHeader, emptyState, albumGrid, trackRow, virtualList } from './views.js';

/** The plain table shows at most this many rows. */
export const TABLE_ROWS = 1000;

export const EXAMPLES = [
  {
    name: '80s rock',
    sql: `SELECT s.* FROM songs s JOIN track_families f USING (path)
WHERE f.family = 'rock' AND s.released BETWEEN 1980 AND 1989
ORDER BY s.album_artist COLLATE NOCASE, s.released, s.disc_no, s.track_no;`,
  },
  {
    name: 'First album of each artist',
    sql: `SELECT * FROM albums a
WHERE artist_key <> 'various artists'
  AND year = (SELECT min(year) FROM albums WHERE artist_key = a.artist_key)
ORDER BY artist COLLATE NOCASE;`,
  },
  {
    name: 'Recently added albums',
    sql: `SELECT * FROM albums ORDER BY added DESC LIMIT 24;`,
  },
  {
    name: 'Longest albums without a cover',
    sql: `SELECT title, artist, year, round(duration / 60) AS minutes, album_key
FROM albums WHERE has_cover = 0 ORDER BY duration DESC LIMIT 20;`,
  },
  {
    name: 'Songs per genre family',
    sql: `SELECT family, count(*) AS songs, round(sum(t.duration) / 3600, 1) AS hours
FROM track_families JOIN tracks t USING (path)
GROUP BY family ORDER BY songs DESC;`,
  },
  {
    name: 'Albums per decade',
    sql: `SELECT year / 10 * 10 AS decade, count(*) AS albums
FROM albums WHERE year IS NOT NULL GROUP BY decade ORDER BY decade;`,
  },
];

const DEFAULT_SQL = `-- Ctrl+Enter runs the query. A result with a path column
-- is a list of songs; one with album_key is a list of albums.
${EXAMPLES[0].sql}`;

/** Bumped on every run, so an older run that finishes late does not overwrite a newer one. */
let runCounter = 0;

export function queryView(app) {
  let disposed = false;
  app.onViewDispose(() => {
    disposed = true;
  });
  const prefs = app.prefs;
  const sql = prefs.querySql ?? DEFAULT_SQL;

  // A re-render (a scan finishing, say) must not cost the user their caret.
  const old = document.getElementById('query-sql');
  const caret = old && document.activeElement === old ? [old.selectionStart, old.selectionEnd, old.scrollTop] : null;

  const editor = h('textarea', {
    id: 'query-sql',
    class: 'query-sql',
    spellcheck: false,
    autocomplete: 'off',
    autocapitalize: 'off',
    'aria-label': 'SQL query',
    value: sql,
    onInput: () => app.setPref('querySql', editor.value),
    onKeydown: (event) => {
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        run();
      }
    },
  });
  if (caret) {
    requestAnimationFrame(() => {
      editor.focus();
      editor.setSelectionRange(caret[0], caret[1]);
      editor.scrollTop = caret[2];
    });
  }

  const examples = h(
    'select',
    {
      class: 'select',
      'aria-label': 'Example queries',
      onChange: () => {
        const example = EXAMPLES[Number(examples.value)];
        examples.value = '';
        if (!example) return;
        editor.value = example.sql;
        app.setPref('querySql', editor.value);
        run();
      },
    },
    h('option', { value: '' }, 'Examples…'),
    EXAMPLES.map((example, i) => h('option', { value: String(i) }, example.name)),
  );

  const schema = h('div', { class: 'query-schema-list muted small' }, 'Loading…');
  const results = h('div', { class: 'query-results', 'aria-live': 'polite' });

  const run = () => {
    app.setPref('queryRan', editor.value);
    app.setPref('queryView', null);
    showResults();
  };

  // ---- saved queries
  const savedName = () => app.sql.saved.find((q) => q.sql === editor.value)?.name ?? '';
  const save = async () => {
    const name = await promptDialog({ title: 'Save query', label: 'Name', value: savedName(), okLabel: 'Save' });
    if (!name) return;
    await app.saveQuery(name, editor.value);
    toast(`Saved “${name}”`);
    app.rerender({ keepScroll: true });
  };
  const saved = app.sql.saved.length
    ? h(
        'div',
        { class: 'chips query-saved', 'aria-label': 'Saved queries' },
        app.sql.saved.map((q) =>
          h(
            'span',
            { class: 'chip query-chip' },
            h('button', { class: 'link-btn', type: 'button', title: q.sql, onClick: () => { editor.value = q.sql; app.setPref('querySql', q.sql); run(); } }, q.name),
            iconButton('close', `Delete “${q.name}”`, async () => {
              const ok = await confirmDialog({ title: `Delete “${q.name}”?`, message: 'The saved query is removed.', okLabel: 'Delete', danger: true });
              if (!ok) return;
              await app.deleteQuery(q.name);
              app.rerender({ keepScroll: true });
            }, { size: 14, cls: 'chip-delete' }),
          ),
        ),
      )
    : null;

  // ---- setup SQL, run after every refill of the tables
  const setupEditor = h('textarea', {
    class: 'query-sql query-setup-sql',
    spellcheck: false,
    autocomplete: 'off',
    'aria-label': 'Setup SQL',
    placeholder: "-- For example, make Synth Pop count as rock too:\nINSERT INTO genre_family VALUES ('synth pop', 'rock');",
    value: app.sql.setupDraft ?? app.sql.setup,
    onInput: () => {
      app.sql.setupDraft = setupEditor.value; // kept across redraws until saved
    },
  });
  const setupStatus = h('div', { class: 'query-setup-status' });
  const setup = h(
    'details',
    { class: 'query-setup', open: Boolean(app.sqlSetupError() || app.sql.setupDraft != null) },
    h('summary', null, 'Setup SQL', app.sql.setup.trim() ? h('span', { class: 'muted' }, ' · on') : null),
    h('p', { class: 'muted small' }, 'Runs after the tables are filled, every time the library changes: add genre families of your own, views, anything. Queries then see the result.'),
    setupEditor,
    h(
      'div',
      { class: 'query-actions' },
      h('button', {
        class: 'btn btn-small',
        type: 'button',
        onClick: async () => {
          app.sql.setupDraft = null;
          await app.setSqlSetup(setupEditor.value);
          // Redrawing runs the query again, on tables refilled with the new setup.
          app.rerender({ keepScroll: true });
        },
      }, 'Save and apply'),
    ),
    setupStatus,
  );
  const refreshSetupStatus = () => {
    const error = app.sqlSetupError();
    setupStatus.replaceChildren(error ? h('pre', { class: 'query-error small', role: 'alert' }, `Setup SQL failed: ${error.message}`) : '');
    if (error) setup.open = true;
  };

  async function showResults() {
    const ran = prefs.queryRan ?? '';
    const token = ++runCounter;
    if (!ran.trim()) {
      results.replaceChildren(emptyState('code', 'Ask your library anything', 'Write SQL above and press Ctrl+Enter, or pick one of the examples.'));
      return;
    }
    const slow = setTimeout(() => {
      if (token === runCounter && !disposed) results.replaceChildren(h('p', { class: 'muted query-status' }, 'Starting SQLite…'));
    }, 150);
    const outcome = {};
    try {
      outcome.db = await app.sqlDatabase();
      const started = performance.now();
      outcome.result = outcome.db.run(ran);
      outcome.ms = performance.now() - started;
    } catch (err) {
      outcome.error = err;
    } finally {
      clearTimeout(slow);
    }
    if (token !== runCounter || disposed) return;
    if (outcome.db) {
      fillSchema(outcome.db);
      refreshSetupStatus();
    }
    if (outcome.error) {
      const message = outcome.error instanceof QueryError ? outcome.error.message : `SQLite could not be started: ${outcome.error?.message ?? outcome.error}`;
      results.replaceChildren(h('pre', { class: 'query-error', role: 'alert' }, message));
      return;
    }
    results.replaceChildren(...resultView(app, outcome.result, outcome.ms, () => showResults()).filter(Boolean));
  }

  function fillSchema(db) {
    schema.replaceChildren(
      ...db.schema().map((object) =>
        h(
          'details',
          { class: 'query-object' },
          h('summary', null, h('button', { class: 'link-btn', type: 'button', title: `Insert “${object.name}”`, onClick: () => insert(object.name) }, object.name), object.type === 'view' ? h('span', { class: 'muted' }, ' view') : null),
          h('ul', null, object.columns.map((name) => h('li', null, h('button', { class: 'link-btn', type: 'button', title: `Insert “${name}”`, onClick: () => insert(name) }, name)))),
        ),
      ),
    );
  }

  function insert(text) {
    editor.focus();
    editor.setRangeText(text, editor.selectionStart, editor.selectionEnd, 'end');
    app.setPref('querySql', editor.value);
  }

  showResults();

  return h(
    'div',
    { class: 'page query-page' },
    pageHeader('Query', 'SQL over your library'),
    h(
      'div',
      { class: 'query-layout' },
      h(
        'div',
        { class: 'query-main' },
        editor,
        h(
          'div',
          { class: 'query-actions' },
          h('button', { class: 'btn btn-primary', type: 'button', onClick: run }, icon('play', 18), 'Run'),
          h('span', { class: 'muted small query-hint' }, 'Ctrl+Enter'),
          h('button', { class: 'btn', type: 'button', onClick: save }, icon('add', 18), 'Save…'),
          h('span', { class: 'grow' }),
          examples,
        ),
        saved,
        setup,
      ),
      h('aside', { class: 'query-schema', 'aria-label': 'Tables and columns' }, h('div', { class: 'eyebrow muted' }, 'Tables'), schema),
    ),
    results,
  );
}

/** What kind of list a result is: songs (a path column), albums (album_key), or neither. */
export function resultKind(columns) {
  if (columns.includes('path')) return 'songs';
  if (columns.includes('album_key')) return 'albums';
  return 'table';
}

function resultView(app, result, ms, redraw) {
  const { columns, rows, truncated } = result;
  if (!columns.length) return [h('p', { class: 'muted query-status' }, `Done in ${ms.toFixed(0)} ms. The last statement returned no rows to show.`)];

  const kind = resultKind(columns);
  const view = kind !== 'table' && app.prefs.queryView === 'table' ? 'table' : kind;
  const toggle =
    kind === 'table'
      ? null
      : h(
          'div',
          { class: 'segmented', role: 'group', 'aria-label': 'Show the result as' },
          [kind, 'table'].map((option) =>
            h(
              'button',
              {
                type: 'button',
                class: option === view ? 'on' : '',
                'aria-pressed': String(option === view),
                onClick: () => {
                  app.setPref('queryView', option === 'table' ? 'table' : null);
                  redraw();
                },
              },
              option === 'songs' ? 'Songs' : option === 'albums' ? 'Albums' : 'Table',
            ),
          ),
        );
  const timing = `${ms < 1 ? '<1' : ms.toFixed(0)} ms`;
  const stopped = truncated ? h('p', { class: 'muted small' }, `Stopped after ${rows.length.toLocaleString()} rows.`) : null;

  if (view === 'songs') {
    const at = columns.indexOf('path');
    const seen = new Set();
    const tracks = [];
    let missing = 0;
    for (const row of rows) {
      const path = row[at];
      if (seen.has(path)) continue;
      seen.add(path);
      const track = app.lib.tracks.get(path);
      if (track && !track._dup) tracks.push(track);
      else missing++;
    }
    const duration = tracks.reduce((sum, t) => sum + (t.duration ?? 0), 0);
    const facts = [plural(tracks.length, 'song'), duration ? formatLength(duration) : null, missing ? `${missing.toLocaleString()} not in the library` : null, timing].filter(Boolean).join(' · ');
    const list =
      tracks.length > 200
        ? virtualList(app, { count: tracks.length, rowHeight: 52, renderRow: (i) => trackRow(app, tracks[i], { list: tracks, index: i, showAlbum: true }) })
        : h('div', { class: 'tracks' }, tracks.map((t, i) => trackRow(app, t, { list: tracks, index: i, showAlbum: true })));
    return [
      resultBar(facts, toggle, collectionActions(app, () => tracks, { save: true })),
      stopped,
      tracks.length ? list : h('p', { class: 'muted' }, 'No songs.'),
    ];
  }

  if (view === 'albums') {
    const at = columns.indexOf('album_key');
    const albums = [...new Set(rows.map((row) => row[at]))].map((key) => app.lib.albums.get(key)).filter(Boolean);
    const tracks = () => albums.flatMap((album) => album.tracks);
    const facts = [plural(albums.length, 'album'), timing].join(' · ');
    return [
      resultBar(facts, toggle, collectionActions(app, tracks, { save: false })),
      stopped,
      albums.length ? albumGrid(app, albums) : h('p', { class: 'muted' }, 'No albums.'),
    ];
  }

  const shown = rows.slice(0, TABLE_ROWS);
  const facts = [plural(rows.length, 'row'), timing].join(' · ');
  return [
    resultBar(facts, toggle, null),
    stopped,
    rows.length > TABLE_ROWS ? h('p', { class: 'muted small' }, `Showing the first ${TABLE_ROWS.toLocaleString()} rows.`) : null,
    h(
      'div',
      { class: 'query-table-wrap' },
      h(
        'table',
        { class: 'query-table' },
        h('thead', null, h('tr', null, columns.map((name) => h('th', { scope: 'col' }, name)))),
        h('tbody', null, shown.map((row) => h('tr', null, row.map(cell)))),
      ),
    ),
  ];
}

function cell(value) {
  if (value === null || value === undefined) return h('td', { class: 'null' }, 'NULL');
  if (typeof value === 'number' || typeof value === 'bigint') return h('td', { class: 'num' }, String(value));
  if (value instanceof Uint8Array) return h('td', { class: 'null' }, `(${plural(value.length, 'byte')})`);
  return h('td', null, String(value));
}

function resultBar(facts, toggle, actions) {
  return h('div', { class: 'query-result-bar' }, h('div', { class: 'grow muted', role: 'status' }, facts), toggle, actions);
}

function collectionActions(app, getTracks, { save }) {
  return h(
    'div',
    { class: 'page-actions' },
    h('button', { class: 'btn btn-primary', type: 'button', onClick: () => app.play(getTracks(), null, { shuffle: false }) }, icon('play', 18), 'Play'),
    h('button', { class: 'btn', type: 'button', onClick: () => app.play(getTracks(), null, { shuffle: true }) }, icon('shuffle', 18), 'Shuffle'),
    save ? h('button', { class: 'btn', type: 'button', onClick: () => app.createPlaylist(getTracks()) }, icon('playlistAdd', 18), 'Save as playlist') : null,
    iconButton('more', 'More options', (event) => app.collectionMenu(event.currentTarget, getTracks)),
  );
}
