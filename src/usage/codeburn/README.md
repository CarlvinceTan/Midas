# Vendored codeburn

Parsing and pricing code vendored from [codeburn](https://github.com/getagentseal/codeburn)
(MIT — see `LICENSE`), commit `b0e53cfc`.

Midas uses it internally to compute `/stats` (per-agent cost, sessions, calls,
tokens) without depending on the `codeburn` binary. Files are copied verbatim
(import specifiers rewritten `.js` -> `.ts`, `@ts-nocheck` added) and are not
intended to be edited here.
