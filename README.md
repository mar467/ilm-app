# Ilm app

A personal spaced-repetition app built around the Experts Incubator method: recall, then understand, then apply.

This repository holds only the app. It contains no notes, cards or review history; those live in a separate private repository and on the learner's own devices.

## Layout

- `docs/` is the app exactly as GitHub Pages serves it. There is no build step: the files in `docs/` are the source.
  - `js/parser.js` reads card files in the flashcard SOP block format and runs the SOP's checks.
  - `js/engine.js` works out scheduling by replaying the history of events (FSRS via `ts-fsrs`).
  - `js/store.js` keeps cards, history and settings in the browser (IndexedDB).
  - `js/render.js` turns card text into HTML (bold key terms, gaps, Arabic).
  - `js/main.js` is the interface (Preact + htm, no compile step).
  - `vendor/` and `fonts/` are third-party files copied in so the app makes no outside requests.
- `test/` holds the tests. Run them with `npm test` (Node 20 or later, no install needed).

## Card format

```
[LON01.cohsch.M1] M-DEF | active
C: Epistemology › Schools › Coherentism
Q: **coherentism** pictures beliefs as what?
A: a web
```

`C:` is the context line, shown above the question on every card. `X:` is an optional extra shown under the answer and `S:` an optional source.

## Third-party files

- `docs/vendor/ts-fsrs.js`: ts-fsrs (MIT)
- `docs/vendor/preact-htm.js`: Preact and htm (MIT, Apache-2.0)
- `docs/fonts/`: Noto Naskh Arabic (SIL Open Font License)
