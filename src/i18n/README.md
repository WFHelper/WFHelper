# Translations

`en.json` is the reference. Missing entries fall back to English, so a partial
catalogue works fine.

Corrections to the Chinese terms are welcome. Use the words the official game
client uses.

## Adding a language

1. Create `<code>.json` with an ISO 639-1 code such as `zh` or `fr`. Copy over
   only the keys from `en.json` that you are ready to translate, and do not
   rename any key.
2. In `src/lib/i18n.ts`, add the code to `LocaleCode`, add an entry to
   `LOCALE_OPTIONS` with the language's own name (`Deutsch`, not `German`), and
   add one line to `LOADERS`.
3. In `ipc/overlayI18n.ts`, add the same file to `DICTIONARIES` so the in-game
   overlays use the language too. They are plain HTML windows with no access to
   the app's store, so the main process looks up their text and sends it to them.

The app loads a language's catalogue only when it is needed. The main process
also bundles every catalogue for the overlay windows, so each new language makes
the installer bigger.

## Rules

- Keep placeholder names. The app fills in `{count}`, `{item}` and the rest.
  You can move them around in the sentence, but do not rename or drop them. A
  test checks this.
- `common.whisperBuy` and `common.whisperSell` stay in English. They are pasted
  into warframe.market trade chat and read by other players.
- Leave a key out instead of copying the English text. Proper nouns and trade
  shorthand (`WTB R0`, relic tiers, riven grade letters) are already exempt.
- Leave capitalisation to CSS. Write labels in normal sentence or title case;
  the UI makes text uppercase where it needs to.
- Write an ellipsis as three plain ASCII dots (`...`), not as the single
  ellipsis character (U+2026).

## Warframe vocabulary

Digital Extremes ships its own translations of game terms. The dependency
`warframe-public-export-plus` has `dict.<lang>.json` for de, en, es, fr, it,
ja, ko, pl, pt, ru, tc, th, tr, uk and zh, keyed by `/Lotus/Language/...` paths.
Match `dict.en.json` with your language's file on the key and you get the word
the game itself uses, which is what players expect to read.

The German catalogue also has a table of game terms in
`tests/main/i18nGameTerms.test.ts`. Its `ownChoice` field records where we
chose a different word than Digital Extremes on purpose, and keeps that choice
consistent.
