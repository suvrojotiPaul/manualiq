# ManualIQ

**Ask your manuals and your databases. Get the answer, the page it came from, and the SQL behind it.**

Runs on your own machine. Your files stay in `data/` on your computer; only the few passages needed for a question
are sent to the model.

![ManualIQ walkthrough: a manual question answered with page citations and page previews, a citation opened in
the page viewer, a database question answered with rows and the SQL, then "More detail"](docs/demo.webp)

<sub>One-minute walkthrough with a Samsung Galaxy S24 manual, a Rotem controller manual and the Northwind sample
database (waits for the model sped up). [Full-quality MP4](docs/demo.mp4)</sub>

- **Manuals:** ask "how do I…" or "what does error E24 mean" and get the answer from **your PDFs**, with page
  citations you can click and a picture of each cited page under the answer.
- **Databases:** ask "which 5 customers spent the most last year?" and the app writes **SQL**, checks it is
  read-only, runs it on a sandbox copy of your database and shows the answer, the rows and the SQL.
- **Both at once:** "what does the probe alarm mean, and which customers reported it this month?" A router decides
  whether a question needs the manuals, a database or both, and you get one combined answer.
- **Not quite right?** *More detail*, *Shorter* and *Not what I meant* redo an answer without retyping.

Works for any documents: product manuals, internal guides, specifications, your own PDFs.

## Quick start

Requirements: **Node 22.13+**, **Python 3.11+**, and the **[Claude Code](https://claude.com/claude-code)** CLI.
The app talks to Claude through that CLI, with either your Claude login or an API key
([next section](#connecting-to-claude-login-or-api-key)).

```bash
git clone https://github.com/suvrojotiPaul/manualiq.git
cd manualiq
npm run setup        # checks tools, creates .env and a Python venv, builds an empty index
npm start            # open http://127.0.0.1:5623
```

Then add your sources and ask away.

## Connecting to Claude: login or API key

| | How | Pays with | Good for |
|---|---|---|---|
| **Claude login** | run `claude` once and log in | your Claude plan's usage | trying it, using it yourself |
| **API key** | put `ANTHROPIC_API_KEY=sk-ant-...` in `.env` (from [console.anthropic.com](https://console.anthropic.com)) | per answer, about $0.08 with Sonnet | a team or anyone else using your instance |
| **Amazon Bedrock, Google Vertex AI, Microsoft Foundry** | set the provider variables from the [Claude Code docs](https://code.claude.com/docs/en/authentication) in `.env` | your cloud account | companies that already buy Claude through a cloud |

With a key in `.env` the key is used, even if you are also logged in, and no login is needed. Restart the app
after changing `.env`. If people other than you will use the app, use a key or a cloud provider rather than your
personal login.

`CLAUDE_MODEL=haiku` makes answers cheaper and faster, `opus` handles the hardest questions. `server/claude.js` is the
only file that calls the model.

## Adding your documents and databases

Two ways, same result:

| | Manuals (`.pdf`) | Databases (`.sqlite`, `.db`, `.sql` dump) |
|---|---|---|
| **Upload in the app** | *Sources* → drop files or click to choose (or drop anywhere on the page) | same |
| **Copy into a folder** | `data/inbox/manuals/` | `data/inbox/databases/` |

Files in the inbox are picked up when the server starts or with `npm run ingest-inbox`. Unchanged files are skipped;
a changed file replaces its old version. Removing a source in the app unloads it (and moves an inbox file to
`data/inbox/removed/`).

- **PDFs** are parsed into sections, added to the keyword index and embedded on your CPU (a 100-page manual takes
  about a minute). Scanned PDFs without a text layer need OCR first.
- **SQL dumps** from SQLite, PostgreSQL (`pg_dump`, plain format), MySQL (`mysqldump`) and SQL Server (scripts with
  `GO` batches, e.g. *Generate Scripts* in SSMS or the classic Northwind script) are converted into a local SQLite
  sandbox. Anything that can't be converted (triggers, procedures, …) is listed, the rest loads.
- **Hundreds of PDFs?** Put them in `data/pdfs/` (or set `PDF_DIR`) and run `npm run ingest-bulk`, which parses in
  parallel. Optional metadata per file (title, document number, models) goes in `data/documents.json`.
- **Moving to another machine:** copy the `data/` folder. Nothing needs to be parsed or embedded again.

## Why hybrid search, and why it should answer better

A common recipe for "chat with your documents" is to cut every file into fixed-size pieces (about a paragraph), turn
each piece into a vector, and send the model the handful of pieces whose vectors are closest to the question. That
works well for prose. On manuals it often goes wrong in predictable ways:

| Where vector-only, fixed-size pieces struggle | What ManualIQ does instead |
|---|---|
| Vectors are fuzzy on codes. `E24`, `AB-2566` and `SW100` look alike to an embedding model, so the passage for the *right* part number may not make the cut. | **Keyword search (SQLite FTS5, BM25) and vector search are blended.** Exact codes are matched exactly; questions in other words ("vibrates a lot" vs "excessive vibration") are still found by meaning. |
| Pieces are picked from the whole library, so an answer can mix two similar products. | **Manuals are ranked first, then sections inside the best manuals.** Older revisions of the same document are dropped. If several models fit, the model asks which one you mean. |
| A procedure cut into pieces loses steps, warnings or the table it refers to. | **Whole sections are sent**, up to a token budget. A small manual, or a broad question, gets the whole manual; a wiring question gets the wiring document whole. |
| Pieces often carry no page numbers, so answers are hard to check. | **Every claim cites a page.** Click it to see the page; thumbnails of cited pages sit under the answer. |
| Databases are usually out of scope, or a separate tool. | **A router sends each question to the manuals, a database or both**, and SQL runs through a guard on a read-only copy. |

**Benchmarks are coming.** Early tests on a large library of real product manuals are encouraging; published
benchmarks on public document sets will follow. Meanwhile you can measure it on your own documents with
[eval/](eval/README.md): a blind test where each answer is graded against the source text.

## How it works

```
 question ──► router ──┬──► manuals:  keyword + vector search ─► best whole sections ─┐
                       │                                                               ├─► Claude ─► answer
                       └──► database: question ─► SQL ─► guard ─► read-only run ──────┘     + page previews
                                                                                            + rows and SQL
```

- **Manual search** blends keyword and vector scores twice: to rank manuals (manual card 0.35, best passages 0.35,
  vectors 0.30) and to pick sections inside them (50/50). Embeddings come from a small local model (`bge-small`,
  runs on your CPU).
- **SQL is guarded four ways:** one `SELECT` only (writes, `PRAGMA`, `ATTACH` and the like are refused, also when
  hidden in comments or CTEs), a forced row limit, a read-only connection on a **copy** of your database with an
  authorizer that only allows reads, and a separate process that is stopped after 5 seconds. Set `SQL_EXECUTE=false`
  to only see the SQL.
- More detail for code readers: [docs/how-it-works.md](docs/how-it-works.md).

### What is sent to the model

For each question: the system prompt ([prompts/system.md](prompts/system.md)), the few document sections picked for
that question (about 6,000 tokens on average), and the chat history. For database questions: the table structure
(names, columns, a few sample values) and the rows of the query result. Your whole library and your full databases
are never sent. Everything else (parsing, the index, embeddings, running SQL) happens locally.

The model is told to answer only from that material, cite pages, repeat safety warnings, give every step of a
procedure, ask one clarifying question when several models or variants match, and never invent values.

## Configuration

Everything lives in `.env` (created by `npm run setup` from [.env.example](.env.example), which documents each
value). The ones you'll most likely change:

| Variable | Default | |
|---|---|---|
| `ANTHROPIC_API_KEY` | empty | use an API key instead of your Claude login |
| `APP_NAME` / `APP_CONTEXT` | `ManualIQ` / empty | page title; one line telling the model what the documents are about |
| `SAMPLE_QUESTIONS` | empty | example questions on the start screen, separated by `\|` |
| `CLAUDE_MODEL` | `sonnet` | answer model (`haiku`, `sonnet`, `opus` or a full model id) |
| `HOST` / `PORT` | `127.0.0.1` / `5623` | `HOST=0.0.0.0` opens it to your network |
| `SQL_EXECUTE` | `true` | `false` = show SQL, never run it |
| `PDF_DIR` | `data/pdfs` | folder for `npm run ingest-bulk` |

## Good to know

- **No sign-in.** Anyone who can reach the address can ask questions and add or remove sources. Keep it on
  `127.0.0.1` or a network you trust, or put it behind a proxy that asks for a login.
- **Diagrams** are shown as page images, but the model reads text only.
- **One database per question;** no joins across two uploaded databases.
- **Tests:** `npm test` (no model calls). Test databases are generated by `test/make_fixtures.mjs`, never committed.

## License

[PolyForm Noncommercial 1.0.0](LICENSE): free to use, change and share for personal study, research, hobby
projects, and by charities, schools, public research and government institutions. **Commercial use is not allowed** (selling it, offering it as a paid service,
or using it in a business) without a separate license. For commercial use, open an issue or contact the author.
