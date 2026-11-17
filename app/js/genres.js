// Genre families: broad groups that messy genre tags belong to, so a query
// can ask for "rock" and get Classic Rock, Mainstream Rock and Metal & Hard
// Rock too. Used by the SQL tables (sqlrows.js: the genre_family table).
// Pure data code with no browser dependencies.
//
// Keys are genre names in keyOf() form (lower case, single spaces). A genre
// can be in several families. Every genre is also in a family named after
// itself, so `family = 'classic rock'` works as well as `family = 'rock'`,
// and a genre missing from this table still has a family.
//
// The owner adjusts this with SQL of their own run after every rebuild (see
// the Query page), so the table only needs sensible defaults. To see how the
// genres of a real music folder are mapped:
//   node scripts/scan-dir.mjs /path/to/music --genres

import { keyOf } from './library.js';

const ROCK = ['rock'];

export const GENRE_FAMILIES = {
  // Rock and its relatives
  'classic rock': ROCK,
  'mainstream rock': ROCK,
  'hard rock': ['rock', 'metal'],
  'metal & hard rock': ['rock', 'metal'],
  'metal': ['metal', 'rock'],
  'heavy metal': ['rock', 'metal'],
  'symphonic metal': ['rock', 'metal'],
  'power metal': ['rock', 'metal'],
  'progressive rock': ['rock', 'progressive'],
  'prog rock': ['rock', 'progressive'],
  // A bare "Progressive" (iTunes) is not mapped: it covers progressive
  // electronic (Jarre) as well as progressive rock, so it stays in its own family.
  'art rock': ['rock', 'progressive'],
  'psychedelic rock': ROCK,
  'soft rock': ['rock', 'pop'],
  'pop rock': ['rock', 'pop'],
  'pop/rock': ['rock', 'pop'],
  'rock & roll': ROCK,
  "rock 'n' roll": ROCK,
  'rock and roll': ROCK,
  'blues rock': ['rock', 'blues'],
  'folk rock': ['rock', 'folk'],
  'country rock': ['rock', 'country'],
  'roots rock': ROCK,
  'heartland rock': ROCK,
  'arena rock': ROCK,
  'garage rock': ROCK,
  'surf rock': ROCK,
  'glam rock': ROCK,
  'alternative': ['alternative', 'rock'],
  'alternative rock': ['alternative', 'rock'],
  'alternative & punk': ['alternative', 'rock', 'punk'],
  'indie': ['alternative', 'rock'],
  'indie rock': ['alternative', 'rock'],
  'indie / alternative': ['alternative', 'rock'],
  'indie/alternative': ['alternative', 'rock'],
  'indie pop': ['alternative', 'pop'],
  'grunge': ['alternative', 'rock'],
  'britpop': ['alternative', 'rock', 'pop'],
  'post-punk': ['alternative', 'rock', 'punk'],
  'punk': ['punk', 'rock'],
  'punk rock': ['punk', 'rock'],
  'new wave': ['new wave', 'rock', 'pop'],
  'suomirock': ['rock', 'finnish'],

  // Pop
  'contemporary pop': ['pop'],
  'pop': ['pop'],
  'pop latino': ['pop', 'latin'],
  'latin pop': ['pop', 'latin'],
  'espanjankielinen pop': ['pop', 'latin'],
  'world pop': ['pop', 'world'],
  'synthpop': ['pop', 'electronic'],
  'synth-pop': ['pop', 'electronic'],
  'synth pop': ['pop', 'electronic'],
  'electropop': ['pop', 'electronic'],
  'art pop': ['pop'],
  'dance pop': ['pop', 'dance'],
  'europop': ['pop'],
  'iskelmä': ['pop', 'finnish'],
  'suomipop': ['pop', 'finnish'],
  'adult contemporary': ['pop'],
  'easy listening': ['pop'],
  'singer/songwriter': ['singer-songwriter', 'folk'],
  'singer-songwriter': ['singer-songwriter', 'folk'],
  'laulaja-lauluntekijä': ['singer-songwriter', 'folk'],

  // Electronic
  'electronic': ['electronic'],
  'electronica': ['electronic'],
  'electronica/dance': ['electronic', 'dance'],
  'dance': ['electronic', 'dance'],
  'house': ['electronic', 'dance'],
  'techno': ['electronic', 'dance'],
  'trance': ['electronic', 'dance'],
  'ambient': ['electronic', 'ambient'],
  'new age': ['new age', 'ambient'],
  'chillout': ['electronic', 'ambient'],
  'downtempo': ['electronic', 'ambient'],
  'trip-hop': ['electronic'],
  'trip hop': ['electronic'],

  // Classical
  'classical': ['classical'],
  'classical period': ['classical'],
  'contemporary classical': ['classical'],
  'modern classical': ['classical'],
  'baroque': ['classical'],
  'romantic': ['classical'],
  'opera': ['classical', 'vocal'],
  'choral': ['classical', 'vocal'],
  'chant': ['classical', 'vocal'],
  'gregorian chant': ['classical', 'vocal'],
  'early music': ['classical'],
  'medieval': ['classical'],
  'renaissance': ['classical'],
  'orchestral': ['classical'],
  'chamber music': ['classical'],
  'klassinen': ['classical'],

  // Film, stage, games
  'soundtrack': ['soundtrack'],
  'soundtracks': ['soundtrack'],
  'soundtrackit': ['soundtrack'],
  'film': ['soundtrack'],
  'film score': ['soundtrack'],
  'score': ['soundtrack'],
  'original score': ['soundtrack'],
  'broadway / original cast': ['soundtrack', 'vocal'],
  'musical': ['soundtrack', 'vocal'],
  'musicals': ['soundtrack', 'vocal'],
  'show tunes': ['soundtrack', 'vocal'],
  'stage & screen': ['soundtrack'],
  'video game': ['soundtrack'],
  'tv soundtrack': ['soundtrack'],

  // Folk, world, country
  'folk': ['folk'],
  'contemporary folk': ['folk'],
  'traditional folk': ['folk'],
  'celtic': ['folk', 'world'],
  'world': ['world'],
  'world music': ['world'],
  'maailmanmusiikki': ['world'],
  'latin': ['latin', 'world'],
  'reggae': ['reggae', 'world'],
  'country': ['country'],
  'americana': ['country', 'folk'],
  'americana / roots': ['country', 'folk'],
  'traditional american': ['folk'],
  'bluegrass': ['country', 'folk'],

  // Jazz, blues, soul
  'jazz': ['jazz'],
  'vocal jazz': ['jazz', 'vocal'],
  'smooth jazz': ['jazz'],
  'fusion': ['jazz'],
  'jazz fusion': ['jazz'],
  'bebop': ['jazz'],
  'ragtime': ['jazz'],
  'swing': ['jazz'],
  'blues': ['blues'],
  'r&b': ['r&b'],
  'r&b/soul': ['r&b', 'soul'],
  'soul': ['soul', 'r&b'],
  'funk': ['funk', 'r&b'],
  'disco': ['dance', 'pop'],
  'gospel': ['vocal'],

  // Hip-hop
  'hip-hop': ['hip-hop'],
  'hip hop': ['hip-hop'],
  'hip-hop/rap': ['hip-hop'],
  'rap': ['hip-hop'],

  // Experimental
  'avant-garde': ['experimental'],
  'experimental': ['experimental'],
  'avant-garde / experimental': ['experimental'],

  // Vocal
  'vocal': ['vocal'],
  'vocal pop': ['vocal', 'pop'],
  'a cappella': ['vocal'],
};

/** The families a genre belongs to: its own name first, then the broader ones. */
export function familiesOf(genre) {
  const key = keyOf(genre);
  if (!key) return [];
  return [...new Set([key, ...(GENRE_FAMILIES[key] ?? [])])];
}
