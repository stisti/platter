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
