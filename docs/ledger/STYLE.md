# Style

How rows and every other page in `docs/ledger/` are written. The bar is not that a reader *can* understand a row; it is that they spend no effort translating it.

- **Plain words.** No jargon a newcomer would have to look up. If a term has a project-specific meaning, define it in [vocabulary.md](vocabulary.md) and link it in bold the first time a row uses it.
- **One idea per sentence.** A row that needs three sentences gets three sentences, not one with two semicolons.
- **Acronyms expanded once per file.** The first use in a file spells it out; later uses in the same file may abbreviate.
- **Current state only.** Say what is true now. Never "we used to", "previously", or "as of". The history is in git.
- **Say what, not why, in the row.** The Decision cell is the ruling. The reasoning lives in the Source (the pull request, the issue, the note) where a reader can find the argument in full.
- **Name people by role or name, consistently.** A decider is `Andrew` or `the data-science lead` — the same form throughout the ledger.
- **Paths, commands, and identifiers in code spans.** `evals/cases/`, `tools/ledger_check.py`, `AB#582631`.
- **A ruling, not a plan.** "Migrations run in CI" is a row. "We should think about running migrations in CI" is a Not-yet-settled line.
