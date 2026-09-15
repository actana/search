# Spreadsheets parse without SheetJS

**Supersedes [ADR 0007](0007-the-sheetjs-exception.md).**

ADR 0007 kept SheetJS (`xlsx@0.18.5`) with two high advisories acknowledged in
`pnpm-workspace.yaml` — prototype pollution (GHSA-4r6h-8v6p-xvw6) and a ReDoS
(GHSA-5pgg-2g8v-p4x9) — because the fixed releases exist only as a CDN tarball
`SECURITY.md` forbids, and because replacing the parser would move what a
spreadsheet parses into, which [ADR 0005](0005-behaviour-is-identical-nothing-is-retired.md)
held still during the lift. It named its own end: "spreadsheet parsing moves
off it behind a fixture re-record that shows what changed … a deliberate
behaviour change with its own ADR". This is that ADR.

**Why now.** The second reason no longer holds. Backward compatibility and
existing knowledge-base data are explicitly out of scope for this project, so a
spreadsheet chunking slightly differently after the change costs nothing. What
is left is a known prototype-pollution bug reachable by any `write`-scoped
client with a crafted workbook, in a long-lived worker, kept to protect a
guarantee nobody needs. That is not a trade worth keeping.

## Considered Options

- **`officeparser` for `.xlsx` (rejected).** It is already a dependency and does
  read `.xlsx`, but its output is one cell per line — no sheet names, no rows,
  no columns. A three-column sheet `Name/Age/Note` comes back as
  `Name\nAge\nNote\nAlice\n30\n…`. `StructuredDataChunker` steers on
  tab-separated rows under a header line; a flat cell stream would stop being
  detected as structured data and would chunk as prose, splitting records
  mid-row. ADR 0007 already rejected it for this reason, and dropping backcompat
  does not make the output any better.
- **A different npm spreadsheet library (rejected).** `SECURITY.md` asks for
  vanilla code over a new dependency, and the maintained alternatives are large
  (ExcelJS pulls in a zip stack, a stream stack and more) for the read-only,
  text-only subset this engine uses.
- **A small in-repo `.xlsx` reader on `node:zlib` (chosen).** An `.xlsx` is a
  zip of XML parts. Node already ships the one hard piece — raw DEFLATE — and
  reading a zip's central directory is a few dozen lines. The XML the engine
  needs (`workbook.xml`, its relationships, `sharedStrings.xml`, each
  worksheet's `<sheetData>`) is a fixed, shallow vocabulary that a linear tag
  scanner handles without a general XML parser.

## Decisions

1. **`xlsx` is removed from `@actana/search-shared`**, with the eight packages
   only it pulled in (`adler-32`, `cfb`, `codepage`, `crc-32`, `frac`, `ssf`,
   `wmf`, `word`). No dependency was added. Both GHSAs, and the
   `auditConfig.ignoreGhsas` block that held only them, are gone:
   `pnpm audit --prod --audit-level high` passes with no ignores.
2. **`.xlsx` is parsed by `packages/shared/src/file-parsers/xlsx-parser.ts`** on
   `packages/shared/src/file-parsers/zip-reader.ts`.
   - The zip reader reads stored and deflated entries from a single-volume,
     unencrypted, non-ZIP64 archive through its central directory, and refuses
     everything else by name.
   - **Decompression-bomb limits are its own**, not inherited from a library: at
     most 10,000 central-directory entries, and at most 256 MiB inflated across
     every entry one parse reads. Inflation runs with `maxOutputLength` set to
     the remaining budget, so a header that under-declares its size cannot buy a
     larger allocation, and an inflated size that disagrees with its header is a
     malformed archive. A workbook declaring more than 1,000 sheets is refused.
   - `withParseTimeout` still wraps every parse, unchanged.
   - The XML scanner never processes a DTD. An internal subset is skipped, and an
     entity reference other than the five predefined ones and numeric
     references stays literal text; nothing is fetched. The XXE regression
     suite covers it as it covered SheetJS.
3. **The text shape is kept where it mattered.** Output is still a
   `=== Sheet: name ===` header per sheet, a tab-separated header row and rule,
   tab-separated rows padded to the sheet's width, `[Empty sheet]` for an empty
   one, the 1,000-row preview with its truncation notice, and the same metadata
   keys. Run side by side with the SheetJS parser over 19 distinct real-world
   Excel workbooks, 17 produced byte-identical content and the other 2 differed
   only by the tab-only rows described below; SheetJS-written workbooks
   (multiple sheets, empty sheets, offsets, dates, booleans, Unicode) were
   identical too.
4. **What changed in the text:**
   - A row whose every cell is an empty string — typically formulas evaluating
     to `""` — is no longer emitted as a line of bare tabs, and is no longer
     counted in `totalRows`.
   - The column span is the sheet's `<dimension>` *widened to every valued
     cell*. SheetJS used the dimension alone and silently dropped any cell
     outside it; a wrong dimension now loses nothing.
   - `metadata.sampledData` holds strings (`"30"`, `"true"`), not SheetJS's typed
     values. Nothing in the engine reads it.
   - Values are what the file stores and what SheetJS emitted by default:
     numbers in shortest decimal form, dates as Excel serial numbers, booleans
     as `true`/`false`, formulas as their cached result, error cells as empty.
     Number formats are not applied — neither did SheetJS here.
5. **Legacy binary `.xls` is no longer supported.** It is an OLE2 compound file,
   not a zip, and SheetJS was its only reader. `xls` is gone from the parser
   registry, from `SupportedFileType`, and from `SUPPORTED_DOCUMENT_EXTENSIONS`.
   It is listed in `RETIRED_DOCUMENT_EXTENSIONS`, and `resolveParserExtension`
   refuses it by name — from the filename or from the
   `application/vnd.ms-excel` mime type, before the plain-text fallback could
   read its bytes as text — with
   `Unsupported file type: xls (legacy binary Excel (.xls) is not supported; save the workbook as .xlsx)`.

## Consequences

- The fixture suites hold no spreadsheet, so nothing needed re-recording.
- `.xlsm`, `.xltx` and Strict OOXML workbooks were never in the accepted list and
  still are not; the reader would likely handle the first two if they were added.
- The zip reader is a parser of untrusted input maintained in this repository.
  It is small, its limits are tested (entry count, cumulative budget, a lying
  header, corrupt deflate data, truncation, encryption), and it is used for
  nothing but spreadsheets. If another format ever needs it, that is a reason to
  review it again, not to widen it quietly.
- Studio's own upload surface still lists `.xls` as accepted; that is a Studio
  change, tracked outside this repository.
