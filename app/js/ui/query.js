// The Query page: SQL against the library (tables in ../sqlrows.js), with the
// result shown as songs to play, albums to open, or a plain table.
//
// Library SQL (app.sql, ../librarysql.js) runs the queries and says what a
// result is a list of; this page only draws. It remembers the SQL being
// written, the unsaved setup SQL and the last query run (in the preferences),
// and runs that query again whenever the page is drawn, so the result follows
// the library through rescans.

import { QueryError } from '../sqldb.js';
import { h, icon, iconButton, plural, formatLength, promptDialog, confirmDialog, toast } from './dom.js';
import { pageHeader, emptyState, albumGrid, trackRow, virtualList } from './views.js';

/** The plain table shows at most this many rows. */
const TABLE_ROWS = 1000;

const EXAMPLES = [
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
    await app.sql.saveQuery(name, editor.value);
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
              await app.sql.deleteQuery(q.name);
              app.rerender({ keepScroll: true });
            }, { size: 14, cls: 'chip-delete' }),
          ),
        ),
      )
    : null;

  // ---- setup SQL, run after every refill of the tables
  // An unsaved change is a draft, kept across redraws and reloads until it is
  // saved or discarded. Text that matches the saved setup SQL is no draft.
  const isDraft = (text) => text != null && text !== app.sql.setup;
  const setDraft = (text) => {
    app.setPref('querySetupDraft', isDraft(text) ? text : null);
    discard.hidden = !isDraft(text);
  };
  const hasDraft = isDraft(prefs.querySetupDraft);
  const setupEditor = h('textarea', {
    class: 'query-sql query-setup-sql',
    spellcheck: false,
    autocomplete: 'off',
    'aria-label': 'Setup SQL',
    placeholder: "-- For example, make Synth Pop count as rock too:\nINSERT INTO genre_family VALUES ('synth pop', 'rock');",
    value: hasDraft ? prefs.querySetupDraft : app.sql.setup,
    onInput: () => setDraft(setupEditor.value),
  });
  const discard = h('button', {
    class: 'btn btn-small',
    type: 'button',
    hidden: !hasDraft,
    onClick: () => {
      setupEditor.value = app.sql.setup;
      setDraft(null);
    },
  }, 'Discard changes');
  const setupStatus = h('div', { class: 'query-setup-status' });
  const setup = h(
    'details',
    { class: 'query-setup', open: Boolean(app.sql.setupError || hasDraft) },
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
          setDraft(null);
          await app.sql.setSetup(setupEditor.value);
          // Redrawing runs the query again, on tables refilled with the new setup.
          app.rerender({ keepScroll: true });
        },
      }, 'Save and apply'),
      discard,
    ),
    setupStatus,
  );
  const refreshSetupStatus = () => {
    const error = app.sql.setupError;
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
    let result;
    let error;
    try {
      result = await app.sql.run(ran);
    } catch (err) {
      error = err;
    } finally {
      clearTimeout(slow);
    }
    if (token !== runCounter || disposed) return;
    fillSchema();
    refreshSetupStatus();
    if (error) {
      const message = error instanceof QueryError ? error.message : `SQLite could not be started: ${error?.message ?? error}`;
      results.replaceChildren(h('pre', { class: 'query-error', role: 'alert' }, message));
      return;
    }
    results.replaceChildren(...resultView(app, result, () => showResults()).filter(Boolean));
  }

  function fillSchema() {
    const objects = app.sql.schema();
    if (!objects.length) return; // SQLite has not started: keep saying so
    schema.replaceChildren(
      ...objects.map((object) =>
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

/** @param {import('../librarysql.js').QueryResult} result */
function resultView(app, result, redraw) {
  const { columns, rows, truncated, ms, kind } = result;
  if (kind === 'none') return [h('p', { class: 'muted query-status' }, `Done in ${ms.toFixed(0)} ms. The last statement returned no rows to show.`)];

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
    const { tracks, missing } = result;
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
    const { albums } = result;
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
