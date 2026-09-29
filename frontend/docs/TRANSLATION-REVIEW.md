# Language framework and optional review

**English is the only launch language** and the only selector choice in ordinary development and production. Old Tamil/unsupported stored preferences fall back to English without silently overwriting the account's backend preference. A profile save changes profile fields only; an explicit supported language selection may synchronize that preference.

`src/i18n/en.json` is the authoritative interface catalog (827 entries at this pass). `src/i18n/index.ts` retains the registry, dynamic imports, interpolation validation, locale date/number/plural formatting, subscription mechanism and direction metadata. No additional font or optional language is precached.

Existing `ta.draft.json` remains an unapproved machine-authored **optional review overlay** only when `VITE_TRANSLATION_PREVIEW=true` is explicitly set. New auth/IVR entries fall back to English during that review. It is not a complete current approved translation and is not a launch requirement. Normal builds keep that flag false or unset.

To add a reviewed language later: translate every English key with identical interpolation parameters; obtain fluent terminology/security/plural review; register its lazy loader and direction/name in `approvedLoaders`/`interfaceLanguages`; validate catalog tokens; test mounted screens, errors, date/number/plural and any RTL layouts; then offer it as an available choice. Keep API enums, identities, fingerprints and keyboard key values invariant. Review against `catalog-locations.json`; `npm run i18n:check` helps extraction but does not certify language quality or legal approval.
