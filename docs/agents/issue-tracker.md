# Issue tracker

Use GitHub issues in **glvno/matryoshka** (`gh --repo glvno/matryoshka`). The `origin` remote is this project; `upstream` (WiggisModular/Modular-1, fetch only) is the repo it was hard-forked from on 2026-10-17. Never file issues upstream. Every change reaches `main` by pull request (since 2026-10-23); Claude may merge its own.

## The board

The GitHub project "Matryoshka", https://github.com/users/glvno/projects/6, is where work is managed ([D-069](../ledger/project.md#D-069)). Every open issue is on it.

- **Status** says where the work stands. Inbox means not triaged. Then Next, In progress, Device check (built and emulator-tested, waiting for a real FM-1), Backlog (accepted, not scheduled yet), Someday (spikes and ideas with no plan) and Done. The owner decides what moves out of Inbox.
- **Horizon** (Now, Next, Later) is planning order, not progress. **Initiative** groups issues by goal. **Priority** is High, Medium or Low.
- A **milestone** names the release an issue is planned for. No label carries plan state.

Keep it current:

- A new issue goes on the board in Inbox: `gh project item-add 6 --owner glvno --url <issue url>`, then set Status.
- When work on an issue starts, move it to In progress. When it waits for the owner's device check, move it to Device check.
- Name the issue in the pull request with a closing keyword (`Closes #N`). It closes when the pull request merges, also into a `release-*` branch or `dev-next` ([D-072](../ledger/project.md#D-072)).
- At the start of a work session, read what is In progress and Next:

  ```sh
  gh project item-list 6 --owner glvno --limit 500 --format json \
    | jq -r '.items[] | select(.status == "In progress" or .status == "Next") | "\(.content.number)\t\(.status)\t\(.title)"'
  ```

## Answer from the tracker first

Before researching a question about open work, gaps or status, search the issues and read the one that answers it ([D-070](../ledger/project.md#D-070)). This applies before sending a subagent too.

- Search: `gh issue list --repo glvno/matryoshka --state all --search "<words>" --json number,title,state`.
- A subagent's brief names the issue, and the section of it, that the question is about. Ask the subagent to check and update that issue, not to audit from scratch.
- Write what the research found back to the issue: tick or add a box, or leave a comment. An answer that stays only in a chat is lost.

## Living lists

A [**living list**](../ledger/vocabulary.md#living-list) is a parent issue with one sub-issue per item ([D-071](../ledger/project.md#D-071)). Read the one sub-issue a question is about, not the whole list.

- Issue #375 indexes the FM-1 factory instruments' parity gaps. Each instrument with open gaps has its own sub-issue (#851 to #866). A pull request that closes or finds a gap ticks or adds its box in that sub-issue.
- List the sub-issues: `gh api graphql -f query='{repository(owner:"glvno",name:"matryoshka"){issue(number:375){subIssues(first:100){nodes{number state title}}}}}'`.
