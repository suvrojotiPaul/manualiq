# How ManualIQ works

The README covers using the app. This page is for people reading the code.

## Manual search (hybrid)

- **Ingest:** `ingest/parse_manuals.py` (bulk) or `ingest/add_manual.py` (one file) turns a PDF into sections
  (headings from the PDF outline and font sizes, tables as Markdown, repeated headers/footers removed, drawing-heavy
  pages flagged). `ingest/build_index.py` writes them to `data/index.sqlite`: `manuals`, `sections` (what the model
  reads) and `chunks` (~1,100-character search units with a title/section header), plus two FTS5 tables.
- **Vectors:** `ingest/embed_index.py` embeds every chunk locally with fastembed (`BAAI/bge-small-en-v1.5`, CPU) into
  table `chunk_vec`. Batches are sorted by length so little time goes to padding. Questions are embedded by a
  long-running helper (`ingest/embed_server.py`) the server starts once (`server/embed.js`); the nearest chunks are
  found by brute-force cosine similarity over all vectors in memory (fast enough for tens of thousands of chunks).
- **Retrieval** (`server/retrieval.js`): 1) rank manuals from three signals (manual-card keyword match, keyword
  chunk hits, vector chunk hits); 2) inside the chosen 1-3 manuals, score sections by a 50/50 blend of keyword and
  vector hits; 3) send **whole sections** (or a whole small manual) up to a token budget, so procedures are not cut
  off. Several revisions of one document are collapsed to the newest.
- **Answer:** `server/prompts.js` + `prompts/system.md`, through `server/claude.js` (`claude -p`, one Claude session
  per chat). `server/cite.js` turns citations like `(AB-2566 p.3)` into links and page previews; page images are
  rendered on demand by `ingest/render_page.py` and cached in `data/pages/`.

## Adding sources, the SQL agent and the router

1. **Adding sources (two ways, same pipeline)**
   - **Upload in the UI.** Use the *Sources* drawer (drop zone or file picker), the 📎 button, or drop files anywhere
     on the page. The browser streams each file to `POST /upload` (raw body, upload % shown). It then fires an event
     that makes Datastar `POST /ingest`, which streams progress back over SSE.
   - **Drop folder.** Copy files into `data/inbox/manuals/` (PDF) or `data/inbox/databases/` (`.sqlite`, `.db`, `.sql`).
     They are ingested when the server starts (in the background) or with `npm run ingest-inbox`. A file whose
     SHA-256 hasn't changed since the last ingest is skipped. A changed file replaces the source it made before.
     Removing an inbox source in the UI moves its file to `data/inbox/removed/`. Deleting a file from the inbox by hand
     does **not** unload it; remove it in the UI instead.
   - **Manuals (PDF)** are copied to `data/uploads/pdfs/` and then added to the index **incrementally**:
     parse → insert this manual's rows (manual, sections, chunks, both FTS tables) in one transaction → embed only
     its chunks, with the same model as the existing vectors. Progress shown: parsing → indexing (pages,
     sections) → embedding (n/m chunks) → ready. Removing a manual deletes its rows, FTS rows, vectors, PDF and
     cached page images.
   - **Databases** each become a sandbox SQLite file `data/uploads/db/<name>.sqlite`. The original upload is never
     queried.
     - `.sqlite`/`.db`: the header is checked, the file is copied, switched to `journal_mode=DELETE` (so it opens
       read-only) and passes `quick_check`.
     - `.sql`: SQLite, PostgreSQL (`pg_dump` plain format incl. `COPY ... FROM stdin`), MySQL (`mysqldump`) and
       SQL Server scripts (`GO` batches, statements without `;`, `N'..'`, `[names]`, `IDENTITY`, `0x..` images;
       dates are stored as `YYYY-MM-DD` following `SET DATEFORMAT`; `CONVERT(type, x)` and string `+` in views
       become `CAST`/`||`) are detected and translated best-effort. The report lists tables, rows per table and every skipped statement
       with its reason (shown in the drawer under "n statement(s) skipped").
   - The drawer lists the manual count (built-in plus uploaded), each uploaded/inbox manual (pages, the number to
     cite it by), each database with its tables and row counts, errors, and a ✕ to remove each one.
   - The same SHA-256 already loaded counts as a duplicate and is not loaded twice.

2. **SQL agent** (`server/sql/`)
   - `schema.js` builds a compact catalog for each sandbox DB: tables and views, columns, types, PKs, FKs, row
     counts, 3 sample rows, and the distinct values of short text columns with 12 values or fewer (e.g.
     `status: 'closed','in_progress','open'`). The distinct values are what lets the model write the right
     `WHERE` literal.
   - `agent.js`: NL → SQL with **sonnet** (stateless call, JSON reply `{database, sql, explanation}` or
     `{cannot}`), then the guard, then execution. There is **one self-correction retry** if the guard rejects the
     SQL or SQLite raises an error; the error and the previous SQL go back to the model.
   - `guard.js` rules:
     - exactly one statement (a trailing `;` is allowed); must start with `SELECT`/`WITH`.
     - Blocklist checked **outside** string literals and quoted names: writes, DDL, `PRAGMA` (incl. `pragma_*`
       functions), `ATTACH`/`DETACH`, transactions, `INTO`, `REPLACE` (but `replace()` is allowed),
       `load_extension`, `readfile`/`writefile`/`edit`, `fts3_tokenizer`, `sqlite_dbpage`, etc.
     - No bind parameters. Comments are stripped first; unterminated quotes or comments are refused.
     - The outer `LIMIT` is added (default 100, `SQL_MAX_ROWS`) when missing or larger than the cap.
   - `exec.js` + `exec_child.js`: every query runs in a **forked child process**. It opens the sandbox copy with
     `readOnly: true`, extension loading off and defensive mode on. An **authorizer** allows only
     `SELECT`/`READ`/`FUNCTION`/`RECURSIVE` and denies `load_extension` and friends. A **time limit** kills the
     child (default 5 s, `SQL_TIMEOUT_MS`).
   - `SQL_EXECUTE=false`: the SQL is generated and guarded but not run. A database-only question then shows the
     SQL without results and makes no answer call.
   - The answer always shows: a short plain-language answer from the model (sonnet, same chat session as manual
     answers, grounded in the rows), a result table (first 20 rows, `SQL_SHOW_ROWS`) and the SQL in a collapsible
     block (open when not executed), plus a "self-corrected after: …" note when the retry was used.

3. **Router** (`server/router.js`)
   - If only manuals or only databases are loaded, it picks that side with no model call.
   - Otherwise it scores cheap signals:
     - Database side: "how many / total / average / list all / which customers / this month / by technician…"
       phrases (+2 each); mentioned table names (+3, or +2 for the last word of `service_tickets`); column names
       (+1.5, generic ones like `name`/`status` ignored); known column values (+0.5 each, capped at +1, because
       model and alarm names also appear in the manuals).
     - Manual side: "how do I / install / wire / adjust / steps / troubleshoot / what does X mean (+3) / manual /
       diagram…".
     - Decision: both sides ≥ 3 → `both`; one side ≥ 3 and the other < 1.5 → that side; one side ≥ 2 and the other
       0 → that side; anything else → a short **haiku** call with the source catalog (manual titles plus tables
       and columns), returning `{route, database, clarify, reason}`.
     - If the haiku call fails, the router falls back to the previous turn's route, else manuals.
   - `clarify`: the haiku question is shown as the answer. The user's next typed message is appended to the
     original question (`"probe problems (the service records)"`) and routed again.
   - `both`: manual retrieval and the SQL agent run **in parallel**, then one answer call receives both
     `<manual_context>` and `<database_result>`.
   - The label on each answer reads "Manuals", "Database: support.sqlite", "Both: manuals + support.sqlite" or
     "Clarify". Its tooltip shows how it was decided (heuristic / llm / only-source / previous) and why.
   - Follow-ups:
     - *Shorter*: rewrite in the session, no new data.
     - *More detail*: manuals as before; for databases it **re-runs the same SQL with a 500-row cap** (no SQL
       call) and asks for a fuller breakdown.
     - *Not what I meant*: manuals as before; for databases it **regenerates the SQL** with the previous SQL and
       the user's typed feedback.
     - Refinements keep the route of the answer they refine.

## File map

| File | What |
|---|---|
| `server/sources.js` | registry `data/uploads/sources.json`, ingestion queue (one writer), manual/database ingest, removal, inbox scan |
| `server/uploads.js` | HTTP: `/upload` (raw body), `/ingest` (SSE progress), `/sources` (panel), `/sources/remove`, inbox scan on start |
| `server/catalog.js` | cached introspection of ready DBs + router vocabulary + manual titles; invalidated (and vectors reloaded) on any source change |
| `server/router.js` | heuristics, decision thresholds, haiku fallback, JSON reply parsing |
| `server/sql/dump.js` | dump scanner + SQLite/PostgreSQL/MySQL/SQL Server → SQLite translator and loader |
| `server/sql/guard.js` | SQL guard |
| `server/sql/exec.js`, `exec_child.js` | sandboxed, read-only, time-limited execution in a child process |
| `server/sql/schema.js` | introspection, catalog text, vocabulary |
| `server/sql/agent.js` | NL → SQL (sonnet), self-correction, rows → Markdown table |
| `server/prompts.js` | + `databaseBlock`, `buildDataPrompt`, `columnSums` |
| `prompts/system.md` | + one paragraph on answering from `<database_result>` |
| `server/index.js` | routing in `/chat`, route label, SQL/result block, DB follow-ups, new routes |
| `server/config.js` | models per job, SQL/upload/inbox settings, `pdfPath()` (uploads vs. base PDFs) |
| `server/db.js` | creates an empty index if there is none (so a fresh install can start from uploads/inbox) |
| `server/embed.js` | `reloadVectors()` after adds/removes |
| `ingest/build_index.py` | refactored: `SCHEMA` + `insert_manual()` reused by the incremental path (full rebuild unchanged) |
| `ingest/add_manual.py` | `init` / `parse <pdf>` / `index <json>` / `remove <id>`, one JSON result line each |
| `ingest/embed_index.py` | `--manual <id>`: embed only that manual's chunks without vectors (keeps the stored model) |
| `web/index.html`, `web/app.css` | Sources drawer, drop zone, drag overlay, 📎, upload progress, route tags, SQL/result styling |
| `scripts/ingest_inbox.mjs` | `npm run ingest-inbox` |
| `test/make_fixtures.mjs` | generates the synthetic support DB as SQLite + pg_dump + mysqldump into `data/test-fixtures/` |
| `test/*.test.mjs` | dump, guard + executor, router + catalog, agent (fake model); no Claude calls |
| `test/e2e_chat.mjs` | drives `/chat` on a running server (uses Claude) |

## Design decisions and trade-offs

- **The sandbox is a copy; the original never runs a query.** Even a `.sqlite` upload is copied, so a bad query
  can't touch the user's file. There are four layers: the guard (cheap, early, readable error for the
  self-correction), then a read-only connection, the authorizer, and a child process with a kill timer.
  `node:sqlite` has no interrupt or progress handler, so killing a process is the only reliable time limit.
- **Keywords are matched outside literals.** The earlier project's guard matched keywords anywhere, so
  `WHERE resolution = 'Firmware update'` would be refused. Here strings and quoted identifiers are masked first.
  This is safe because a literal can't execute, and the lexer follows SQLite's quoting (no backslash escapes).
- **One database per query.** The model picks the database from the catalog, and the router's table/column votes
  hint which one. Cross-database joins (ATTACH) are deliberately not supported.
- **Dumps are planned in phases** (tables, then data, then indexes/views). This lets PostgreSQL's trailing
  `ALTER TABLE ONLY ... ADD CONSTRAINT ... PRIMARY KEY/FOREIGN KEY` be folded into `CREATE TABLE`, since SQLite
  can't add constraints later. Foreign keys are off while loading. Anything that fails is listed, not fatal.
- **The SQL call is stateless; the answer call uses the chat's Claude session.** SQL generation sees only the
  catalog, question and feedback, which keeps it cheap and focused. The answer joins the conversation so that
  *Shorter* and typed follow-ups work across manual and database answers.
- **Models per job:** answers use **sonnet** (`CLAUDE_MODEL`), SQL generation uses sonnet (`SQL_MODEL`), routing
  uses haiku (`ROUTER_MODEL`).
- **Column sums.** In the first end-to-end run the model wrote "11 devices in total" over rows that add up to
  10. The data block now carries app-computed sums of count-like numeric columns (ids, averages, rates, dates
  excluded), with an instruction to use them only when stating a total. The re-run said 10.
- **Router thresholds are hand-tuned** on the test questions. Values that also appear in the manuals (model
  names, alarm names) only nudge, because they are ambiguous by nature.
- **Ingestion is serialized** (one queue): the index has a single writer (Python), and the Node server keeps a
  read-only connection that sees each commit.
- **Parsed JSON of uploads goes to `data/parsed/`**, so a full `build_index.py` rebuild keeps uploaded manuals. Their
  PDFs live in `data/uploads/pdfs/`, and `pdfPath()` looks there first.
- **Upload metadata is guessed from the filename** (a number like `123-00582`, title from the rest), because there
  is no `data/documents.json` entry. The number is what citations use, e.g. `(123-00582 p.85)`. If no number is
  found it becomes `DOC-<hash>`.

## Known limitations

- The dump translator is best-effort:
  - Not handled: stored procedures and triggers (skipped); SQL Server `IF`/`EXEC` blocks (skipped; statements
    inside `IF … BEGIN … END` run unconditionally); PG `CREATE TABLE … PARTITION OF` / `AS SELECT`;
    `COPY … WITH (FORMAT csv)` or binary; PG arrays and enums (stored as text); MySQL `ON UPDATE`;
    generated-column expressions (kept as plain columns); CHECK constraints (dropped and noted);
    `INSERT … ON DUPLICATE KEY UPDATE` (the update part is dropped).
  - Dumps load in the server process. A very large dump (hundreds of MB) blocks the event loop while it loads.
- Functions are not translated (apart from SQL Server `CONVERT`): a view using MySQL-, PG- or SQL Server-only
  functions (`YEAR()`, `TOP n`, …) is checked after loading, dropped and listed as skipped.
- One database per question; no joins across uploaded databases.
- Router thresholds were tuned on a small set. Expect some questions to take the haiku path or to land on the
  wrong side; *Not what I meant* doesn't change the route (it refines within it). Typing "use the database" is
  routed afresh.
- Uploaded manuals get filename-derived titles and numbers; there's no metadata form.
- The inbox scan on server start runs concurrently with requests. `npm run ingest-inbox` while the server is
  also ingesting could race on `sources.json`, so run it with the server stopped (or just restart the server).
- Datastar retries a failed SSE request automatically. For `/ingest` a retry finds no pending upload and reports
  "upload not found".
- Untested: very large PDFs (more than 100 pages) for upload time; scanned PDFs (no text layer, so nothing
  searchable); `.sqlite` uploads in WAL mode with a separate `-wal` file (code handles it; not tested); an empty
  base index plus uploads only (the code path exists, `db.js` creates the schema; tried only via `add_manual.py init`
  on an existing index).
