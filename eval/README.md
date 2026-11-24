# Measuring answer quality

A small, repeatable test: your own questions, each with the manual page that holds the answer and the facts a good
answer must contain. The app answers them, then Claude grades every answer blind against the manual text.

Your questions and the answers stay on your machine: `eval/questions.json`, `eval/answers/`, `eval/results/` and
`eval/report.md` are git-ignored.

## 1. Write the questions

Copy `questions.example.json` to `questions.json` and add 15-30 real questions. For each one:

| Field | What |
|---|---|
| `id` | `q01`, `q02`, … |
| `topic` | free text, e.g. wiring, troubleshooting, specs, settings, maintenance, procedure |
| `question` | asked exactly as a user would |
| `source` | the manual and page(s) the answer comes from (for people reading the report) |
| `sections` | the section id(s) in the index that hold the answer, e.g. `<manual id>#s9` (the grader reads their text) |
| `facts` | the key facts a correct answer must state |
| `traps` | common wrong answers, e.g. the value for a different model |

Find section ids with: `sqlite3 data/index.sqlite "SELECT id, path, page_start FROM sections WHERE manual_id = '<id>'"`.

## 2. Run the app and grade

```bash
node --disable-warning=ExperimentalWarning eval/run_app.mjs                    # answers -> eval/answers/app/
node --disable-warning=ExperimentalWarning eval/run_app.mjs --tool app-opus    # a second run under another name
node --disable-warning=ExperimentalWarning eval/grade.mjs                      # grades new/changed answers -> eval/report.md
```

- `run_app.mjs` uses the same retrieval, prompt and model as the chat (`CLAUDE_MODEL`), one fresh session per question.
- `grade.mjs` uses Opus by default (`--model sonnet` is cheaper). Re-running only grades new or changed answers;
  `--force` re-grades everything.

## 3. Compare with other tools (optional)

`node eval/make_sheets.mjs` writes empty answer sheets for other tools (`eval/answers/<tool>/qNN.md`) and a list of
the questions (`eval/ASK_THESE.md`). Ask each question in the other tool, paste the full answer into its sheet, and
add a `NOTE:` line for anything the grader can't see (e.g. `NOTE: showed a wiring diagram`). Then run `grade.mjs`.

## How grading works

For each answer the grader gets the question, the manual section text, the key facts, the traps and your notes. It
doesn't know which tool wrote the answer, and answers are graded in random order. It records each key fact
(covered / partial / missing / contradicted), errors that contradict the manual, wrong product, whether the answer
cites a page, and a 0-10 score.

**Limits:** the grader is a model; spot-check a few results in `eval/results/<tool>/qNN.json`. With 20 questions,
differences of a few tenths are within noise.
