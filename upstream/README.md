# contour-beta for Mermaid itself (a patch series)

This branch holds the work to add `contour-beta` as a **built-in** diagram type of
[mermaid-js/mermaid](https://github.com/mermaid-js/mermaid), instead of an external plugin: a Langium grammar, a typed
model, the shared drawing core and the six views V1 to V6, with documentation, an example, e2e inputs and a changeset.
It is not a pull request and nothing has been proposed to the Mermaid maintainers.

- Base: `mermaid-js/mermaid` commit `7a027f757cbecf87d93cb7da591506b66f6f134d` (main).
- Content: 9 patches, 45 files, 4 508 added lines (`upstream/patches/`).

## Apply

```bash
git clone https://github.com/mermaid-js/mermaid && cd mermaid
git checkout 7a027f757cbecf87d93cb7da591506b66f6f134d
git checkout -b contour-beta
git am /path/to/upstream/patches/*.patch
pnpm install
(cd packages/parser && pnpm run langium:generate)
pnpm build:mermaid && pnpm build:types
```

The series applies cleanly on that commit; the contour sources of the applied tree equal the working tree it was made from.

## Syntax

The same as the plugin of the main branch, with two differences that Langium's context-free lexer forces: the header is
`contour-beta`, and `subtitle` and `footer` take a quoted string. `scripts/contour_text.py --upstream` of the Landscape
repository writes this syntax from the landscape models. Error messages name the unit (`Contour unit A: level=5 must be
an integer from 0 to 4.`) instead of a line number. The documentation is `packages/mermaid/src/docs/syntax/contour.md`.

## What was verified

- Rendered with the built Mermaid (`mermaid.esm.mjs`, no plugin) in Chromium, all 20 views the landscape models imply:
  mark positions equal those of the Python renderer of the book to 0.0000 inch (V1, V2, V3, V6), image sizes are equal, and 0.02 to
  0.7 per cent of 16 px blocks differ from the book's PNGs, which is text snapped differently by matplotlib and Chromium.
- The TypeScript SVG is byte-identical to the SVG of the JavaScript plugin on those inputs.
- Tests of the contour folders, `diagram-api` (including the beta policy), `packages/parser`, `styles.spec.ts`: pass (849 of 851). The two
  that fail are the `architecture` cases of `mermaidAPI.spec.ts` and `multi-diagram-id-uniqueness.spec.ts`, which need a canvas
  that the sandbox did not have.
- `tsc --noEmit` over `packages/mermaid`: no errors. eslint and prettier: clean on the contour files.

## What is not done

- **Themes.** The colours are the fixed palette of the book. `styles.spec.ts` and the theme files carry per-diagram blocks that
  contour does not have, and none was invented. This is the main design decision before a proposal.
- **Configuration.** No `contour` config block (for example `useMaxWidth`): the renderer sets its size itself.
- **Docs build and screenshots.** `docs:build` was not run, and no Cypress or Applitools snapshots exist for the e2e inputs.
- **GitHub label.** `.github/triage-labels.json` names "Graph: Contour"; the label has to exist upstream.
- **Upstream acceptance.** Contour is a niche notation; the maintainers may not want it in the core, in which case the standalone
  package on the main branch is the supported form.
