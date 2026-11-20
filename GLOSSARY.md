# Glossary

Domain terms used in Platter's code, docs and reviews. One meaning per word.

**Library sync**: bringing the stored library in line with the drive, without
ever losing tracks to a vanished or wrong drive. One scan of the music folder
plus the rules around it: records are saved as they are read, removals happen
only after a complete scan (and an automatic scan that finds most of the
library missing removes nothing), covers of vanished albums are pruned only
after a complete scan, and a failure leaves the library as saved. Lives in
`app/js/sync.js` (`syncLibrary`); `app/js/scanner.js` is the folder walk it
runs. _Avoid_: rescan (that is the user's action that starts one), refresh.

**Library state**: the library the app is showing now, and the only way to
change it. It loads the saved library, runs Library sync, and applies changes
to single tracks (such as a song length learned by playing it). Each change
is saved through the track store, the in-memory index is rebuilt, and a
`change` event says why. Nothing else replaces the library or edits a track in
place. Lives in `app/js/librarystate.js` (`LibraryState`). _Avoid_: library
store (that is IndexedDB `tracks`), app.lib (a read of it).

**Rebuild the in-memory index**: run `buildLibrary` over the track records the
app already holds, to regroup albums, artists and genres and recount their
totals. Reads no music files and nothing back from IndexedDB; only Library
sync reads the drive. _Avoid_: rebuild the library, rescan.
