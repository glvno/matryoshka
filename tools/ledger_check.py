#!/usr/bin/env python3
"""ledger_check.py - checker and fixer for the decision ledger in docs/ledger/.

Usage:
  python3 tools/ledger_check.py                 check; exit 1 on any finding
  python3 tools/ledger_check.py --fix           anchor new rows, link bare D-### mentions,
                                                link vocabulary terms, regenerate
                                                docs/ledger/backlinks.md, then check
  python3 tools/ledger_check.py --changed BASE  list rows and doc lines that cite files
                                                changed since BASE (input to the branch audit)
Options:
  --root DIR    repository root (default: walk up from the current directory until a
                directory containing docs/ledger/ or .git/ is found)

Findings print as  path:line: message  and are relative to the repository root.
Exit codes: 0 clean, 1 findings, 2 usage or no ledger.

What it enforces (the rules in docs/ledger/README.md):
  1. every subject file has, in order: a title, an `IDs: D-###-D-###` block line (more blocks after commas), a
     current-state paragraph, one table with the exact 5-column header, and a
     `## Not yet settled` heading
  2. every row's ID is inside its file's block
  3. IDs are unique; the ID cell is exactly `<a id="D-###"></a>D-###`; D-TBD never merges
  4. Status is one of: Decided | Decided, amended | Proposed (decider: NAME) |
     Superseded by [D-###](file.md#D-###)
  5. an inline `**Amended DATE (WHO):**` marker, the `Decided, amended` status and a
     `->`-style Date all appear together or not at all
  6. Date is YYYY-MM or YYYY-MM-DD, optionally `→` a second date
  7. Source is non-empty
  8. every D-### mention in any markdown file is a link whose target row exists
     (code spans and fenced blocks are exempt)
  9. every Not-yet-settled item names a ticket or link
 10. vocabulary.md terms are `### Term` headings; a bold term in a Decision cell that
     matches one is a link to it
 11. backlinks.md matches what --fix would generate

Ignore patterns: one glob per line in docs/ledger/.checkignore (relative to the root).
Standard library only.
"""

from __future__ import annotations

import argparse
import fnmatch
import os
import re
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path

LEDGER_DIR = Path("docs") / "ledger"
NON_SUBJECT = {"readme.md", "style.md", "vocabulary.md", "backlinks.md"}
HEADER = ["ID", "Decision", "Status", "Date", "Source"]
SKIP_DIRS = {".git", "node_modules", ".venv", "venv", "dist", "build", "__pycache__", ".tox"}
MAX_SCAN_BYTES = 2_000_000

ID_RE = re.compile(r"\bD-(\d{3,})\b")
TBD_RE = re.compile(r"\bD-TBD\b")
ANCHOR_RE = re.compile(r'<a id="(D-\d{3,})"></a>\1')
ANCHOR_ANY_RE = re.compile(r'<a id="(D-\d{3,})"></a>(D-\d{3,})')
RANGE = r"D-(\d{3,})\s*(?:–|—|-|\.\.)\s*D-(\d{3,})"
IDS_LINE_RE = re.compile(r"^IDs?:\s*" + RANGE + r"(?:\s*,\s*" + RANGE + r")*\s*$")
RANGE_RE = re.compile(RANGE)
LINK_RE = re.compile(r"\[([^\]]*)\]\(([^)\s]*)\)")
CODE_SPAN_RE = re.compile(r"`[^`]*`")
BOLD_RE = re.compile(r"\*\*([^*]+)\*\*")
DATE_ONE = r"\d{4}-\d{2}(?:-\d{2})?"
DATE_RE = re.compile(rf"^{DATE_ONE}(?:\s*(?:→|->)\s*{DATE_ONE})?$")
AMENDED_RE = re.compile(rf"\*\*Amended {DATE_ONE} \([^()]+\):\*\*")
STATUS_RE = re.compile(
    r"^(?:Decided|Decided, amended|Proposed \(decider: [^()]+\)|"
    r"Superseded by (?:D-\d{3,}|\[D-\d{3,}\]\([^)\s]+\)))$"
)
SEP_CELL_RE = re.compile(r"^:?-{3,}:?$")
NYS_HEADING_RE = re.compile(r"^##\s+Not yet settled\s*$", re.IGNORECASE)
LIST_ITEM_RE = re.compile(r"^\s*(?:[-*+]|\d+\.)\s+(.*)$")
NONE_ITEM_RE = re.compile(r"^\(?(?:none|nothing|—|-)\)?\.?$", re.IGNORECASE)
TICKET_RE = re.compile(r"(?:https?://|\[[^\]]*\]\([^)]+\)|\b[A-Z][A-Z0-9]+[-#]\d+\b|(?<![\w`])#\d+\b)")


@dataclass
class Finding:
    path: Path
    line: int
    message: str


@dataclass
class Row:
    file: Path
    line: int
    cells: list[str]
    rid: str | None = None  # canonical D-### if parseable

    @property
    def decision(self) -> str:
        return self.cells[1]

    @property
    def status(self) -> str:
        return self.cells[2]

    @property
    def date(self) -> str:
        return self.cells[3]

    @property
    def source(self) -> str:
        return self.cells[4]


@dataclass
class SubjectFile:
    path: Path
    lines: list[str]
    blocks: list[tuple[int, int]] | None = None  # (a file that fills its first block gets a second, D-003)
    ids_line: int | None = None
    table_start: int | None = None
    rows: list[Row] = field(default_factory=list)
    nys_line: int | None = None


@dataclass
class Ledger:
    root: Path
    dir: Path
    subjects: dict[Path, SubjectFile]
    rows_by_id: dict[str, Row]
    vocab_slugs: dict[str, str]  # slug -> term
    vocab_terms: dict[str, str]  # lower term -> slug
    ignore: list[str]


# ---------------------------------------------------------------- helpers


def rel(root: Path, p: Path) -> str:
    try:
        return p.relative_to(root).as_posix()
    except ValueError:
        return p.as_posix()


def find_root(start: Path) -> Path | None:
    cur = start.resolve()
    for candidate in [cur, *cur.parents]:
        if (candidate / LEDGER_DIR).is_dir() or (candidate / ".git").exists():
            return candidate
    return None


def read_lines(p: Path) -> list[str]:
    return p.read_text(encoding="utf-8").splitlines()


def write_lines(p: Path, lines: list[str]) -> None:
    p.write_text("\n".join(lines) + "\n", encoding="utf-8")


def slugify(term: str) -> str:
    s = re.sub(r"[^\w\- ]", "", term.strip().lower())
    return re.sub(r"\s+", "-", s)


def split_cells(line: str) -> list[str] | None:
    s = line.strip()
    if not (s.startswith("|") and s.endswith("|")):
        return None
    parts = re.split(r"(?<!\\)\|", s)
    return [c.strip() for c in parts[1:-1]]


def join_cells(cells: list[str]) -> str:
    return "| " + " | ".join(cells) + " |"


def mask(text: str, spans: list[tuple[int, int]]) -> str:
    out = list(text)
    for a, b in spans:
        for i in range(a, b):
            out[i] = " "
    return "".join(out)


def mask_code_and_anchors(text: str) -> str:
    spans = [m.span() for m in CODE_SPAN_RE.finditer(text)]
    spans += [m.span() for m in ANCHOR_ANY_RE.finditer(text)]
    return mask(text, spans)


def link_spans(text: str) -> list[tuple[int, int]]:
    return [m.span() for m in LINK_RE.finditer(text)]


def inside(pos: int, spans: list[tuple[int, int]]) -> bool:
    return any(a <= pos < b for a, b in spans)


def repo_files(root: Path, ignore: list[str]) -> list[Path]:
    files: list[Path] = []
    if (root / ".git").exists():
        try:
            out = subprocess.run(
                ["git", "-C", str(root), "ls-files", "-co", "--exclude-standard", "-z"],
                check=True, capture_output=True,
            ).stdout.decode("utf-8", "replace")
            files = [root / f for f in out.split("\0") if f]
        except (subprocess.CalledProcessError, FileNotFoundError):
            files = []
    if not files:
        for dirpath, dirnames, filenames in os.walk(root):
            dirnames[:] = sorted(d for d in dirnames if d not in SKIP_DIRS)
            for f in sorted(filenames):
                files.append(Path(dirpath) / f)
    result = []
    for f in files:
        if not f.is_file():
            continue
        r = rel(root, f)
        if any(part in SKIP_DIRS for part in Path(r).parts):
            continue
        if any(fnmatch.fnmatch(r, pat) or fnmatch.fnmatch(r, pat.rstrip("/") + "/*") for pat in ignore):
            continue
        result.append(f)
    return sorted(set(result), key=lambda p: rel(root, p))


def read_text_file(p: Path) -> list[str] | None:
    try:
        if p.stat().st_size > MAX_SCAN_BYTES:
            return None
        return p.read_text(encoding="utf-8").splitlines()
    except (UnicodeDecodeError, OSError):
        return None


# ---------------------------------------------------------------- loading


def load_ledger(root: Path) -> tuple[Ledger | None, list[Finding]]:
    ldir = root / LEDGER_DIR
    findings: list[Finding] = []
    if not ldir.is_dir():
        return None, [Finding(ldir, 0, "no ledger: docs/ledger/ does not exist")]
    ignore: list[str] = []
    ign = ldir / ".checkignore"
    if ign.exists():
        ignore = [l.strip() for l in read_lines(ign) if l.strip() and not l.startswith("#")]

    subjects: dict[Path, SubjectFile] = {}
    rows_by_id: dict[str, Row] = {}
    for p in sorted(ldir.glob("*.md")):
        if p.name.lower() in NON_SUBJECT:
            continue
        sf, f = parse_subject(p)
        findings += f
        subjects[p] = sf
        for r in sf.rows:
            if r.rid is None:
                continue
            if r.rid in rows_by_id:
                other = rows_by_id[r.rid]
                findings.append(Finding(p, r.line, f"duplicate ID {r.rid} (also at {rel(root, other.file)}:{other.line})"))
            else:
                rows_by_id[r.rid] = r

    vocab_slugs: dict[str, str] = {}
    vocab_terms: dict[str, str] = {}
    vpath = ldir / "vocabulary.md"
    if vpath.exists():
        for i, line in enumerate(read_lines(vpath), 1):
            m = re.match(r"^(#+)\s+(.*?)\s*$", line)
            if not m:
                continue
            level, text = len(m.group(1)), m.group(2)
            if level == 1:
                continue
            if level != 3:
                findings.append(Finding(vpath, i, "vocabulary terms are `### Term` headings; no other heading levels"))
                continue
            slug = slugify(text)
            if text.lower() in vocab_terms:
                findings.append(Finding(vpath, i, f"duplicate vocabulary term '{text}'"))
            vocab_slugs[slug] = text
            vocab_terms[text.lower()] = slug
    else:
        findings.append(Finding(vpath, 0, "vocabulary.md is missing"))
    for name in ("README.md", "STYLE.md"):
        if not (ldir / name).exists():
            findings.append(Finding(ldir / name, 0, f"{name} is missing"))

    return Ledger(root, ldir, subjects, rows_by_id, vocab_slugs, vocab_terms, ignore), findings


def parse_subject(p: Path) -> tuple[SubjectFile, list[Finding]]:
    lines = read_lines(p)
    sf = SubjectFile(p, lines)
    f: list[Finding] = []

    first = next((i for i, l in enumerate(lines) if l.strip()), None)
    if first is None or not lines[first].startswith("# "):
        f.append(Finding(p, (first or 0) + 1, "subject file must start with a `# Title` heading"))

    in_table = False
    saw_paragraph = False
    header_ok = False
    table_count = 0
    in_fence = False
    for i, line in enumerate(lines):
        n = i + 1
        if line.strip().startswith("```"):
            in_fence = not in_fence
            continue
        if in_fence:
            continue
        m = IDS_LINE_RE.match(line.strip())
        if m and sf.ids_line is None and sf.table_start is None:
            sf.ids_line = n
            sf.blocks = [(int(a), int(b)) for a, b in RANGE_RE.findall(line)]
            if any(a > b for a, b in sf.blocks):
                f.append(Finding(p, n, "ID block start is after its end"))
            continue
        cells = split_cells(line)
        if cells is not None:
            if not in_table:
                in_table = True
                table_count += 1
                if table_count > 1:
                    f.append(Finding(p, n, "one table per subject file"))
                    continue
                sf.table_start = n
                if sf.ids_line is None:
                    f.append(Finding(p, n, "missing `IDs: D-###–D-###` block line before the table"))
                if not saw_paragraph:
                    f.append(Finding(p, n, "missing current-state paragraph between the IDs line and the table"))
                if cells != HEADER:
                    f.append(Finding(p, n, f"table header must be exactly {join_cells(HEADER)}"))
                else:
                    header_ok = True
                continue
            if table_count > 1:
                continue
            if all(SEP_CELL_RE.match(c) for c in cells) and cells:
                continue
            if not header_ok:
                continue
            if len(cells) != 5:
                f.append(Finding(p, n, f"row has {len(cells)} cells, expected 5"))
                continue
            row = Row(p, n, cells)
            f += parse_row_id(row, sf)
            sf.rows.append(row)
            continue
        in_table = False
        if NYS_HEADING_RE.match(line):
            if sf.nys_line is None:
                sf.nys_line = n
                if sf.table_start is None:
                    f.append(Finding(p, n, "`## Not yet settled` must come after the table"))
            continue
        if line.strip() and not line.startswith("#") and sf.ids_line is not None and sf.table_start is None:
            saw_paragraph = True

    if sf.table_start is None:
        f.append(Finding(p, len(lines) or 1, "subject file has no decision table"))
    if sf.nys_line is None:
        f.append(Finding(p, len(lines) or 1, "missing `## Not yet settled` heading after the table"))
    return sf, f


def parse_row_id(row: Row, sf: SubjectFile) -> list[Finding]:
    f: list[Finding] = []
    cell = row.cells[0]
    m = ANCHOR_RE.fullmatch(cell)
    if m:
        row.rid = m.group(1)
    elif TBD_RE.fullmatch(cell):
        f.append(Finding(row.file, row.line, "D-TBD row never merges: assign the next free ID in this file's block"))
        return f
    elif ID_RE.fullmatch(cell):
        row.rid = cell
        f.append(Finding(row.file, row.line, f"row {cell} is missing its anchor (fixable)"))
    else:
        mm = ANCHOR_ANY_RE.fullmatch(cell)
        if mm:
            f.append(Finding(row.file, row.line, f"anchor {mm.group(1)} does not match ID {mm.group(2)}"))
        else:
            f.append(Finding(row.file, row.line, 'ID cell must be `<a id="D-###"></a>D-###`'))
        return f
    if sf.blocks is not None and row.rid:
        num = int(row.rid[2:])
        if not any(a <= num <= b for a, b in sf.blocks):
            ranges = ", ".join(f"D-{a:03d}–D-{b:03d}" for a, b in sf.blocks)
            f.append(Finding(row.file, row.line, f"{row.rid} is outside this file's blocks {ranges}"))
    return f


# ---------------------------------------------------------------- row checks


def check_rows(ledger: Ledger) -> list[Finding]:
    f: list[Finding] = []
    for sf in ledger.subjects.values():
        for r in sf.rows:
            if not STATUS_RE.match(r.status):
                f.append(Finding(r.file, r.line, f"Status '{r.status}' is not one of: Decided | Decided, amended | Proposed (decider: NAME) | Superseded by [D-###](file.md#D-###)"))
            decision_prose = mask_code_and_anchors(r.decision)
            has_marker = "**Amended" in decision_prose
            if has_marker and not AMENDED_RE.search(decision_prose):
                f.append(Finding(r.file, r.line, "amendment marker must read `**Amended YYYY-MM-DD (who):**`"))
            amended_status = r.status == "Decided, amended"
            has_arrow = "→" in r.date or "->" in r.date
            if has_marker and not amended_status:
                f.append(Finding(r.file, r.line, "Decision has an Amended marker but Status is not `Decided, amended`"))
            if amended_status and not has_marker:
                f.append(Finding(r.file, r.line, "Status is `Decided, amended` but Decision has no `**Amended ...:**` marker"))
            if amended_status and not has_arrow:
                f.append(Finding(r.file, r.line, "an amended row's Date must read `original → amendment`"))
            if has_arrow and not amended_status:
                f.append(Finding(r.file, r.line, "Date has an arrow but Status is not `Decided, amended`"))
            if not DATE_RE.match(r.date):
                f.append(Finding(r.file, r.line, f"Date '{r.date}' must be YYYY-MM or YYYY-MM-DD, optionally `→` a second date"))
            if not r.source:
                f.append(Finding(r.file, r.line, "Source is empty: say where a teammate can find the ruling"))
            if not r.decision.strip() and not r.status.startswith("Superseded"):
                f.append(Finding(r.file, r.line, "Decision is empty"))
        f += check_not_yet_settled(sf)
    return f


def check_not_yet_settled(sf: SubjectFile) -> list[Finding]:
    f: list[Finding] = []
    if sf.nys_line is None:
        return f
    for i in range(sf.nys_line, len(sf.lines)):
        line = sf.lines[i]
        if line.startswith("#"):
            break
        m = LIST_ITEM_RE.match(line)
        if not m:
            continue
        if NONE_ITEM_RE.match(m.group(1)):
            continue
        if not TICKET_RE.search(m.group(1)):
            f.append(Finding(sf.path, i + 1, "Not-yet-settled item must name the ticket or link where it is being worked"))
    return f


# ---------------------------------------------------------------- mentions & links


def resolve_link(ledger: Ledger, src: Path, url: str) -> tuple[Path | None, str]:
    """Return (target file, fragment) for a markdown link url."""
    path, _, frag = url.partition("#")
    if not path:
        return src, frag
    cand = (src.parent / path).resolve()
    if not cand.exists():
        alt = (ledger.root / path).resolve()
        if alt.exists():
            cand = alt
    return cand, frag


def scan_mentions(ledger: Ledger, path: Path, lines: list[str], collect: dict[str, list[tuple[Path, int]]] | None,
                  fix: bool) -> tuple[list[Finding], list[str], int]:
    """Check (and optionally fix) D-### mentions in one markdown file.

    Returns (findings, new_lines, number_of_fixes)."""
    f: list[Finding] = []
    out = list(lines)
    fixes = 0
    in_fence = False
    sf = ledger.subjects.get(path)
    row_lines = {r.line for r in sf.rows} if sf else set()
    for i, line in enumerate(lines):
        n = i + 1
        if line.strip().startswith("```"):
            in_fence = not in_fence
            continue
        if in_fence or IDS_LINE_RE.match(line.strip()):
            continue
        work = mask_code_and_anchors(line)
        protect: list[tuple[int, int]] = []
        if n in row_lines:
            # the ID cell is checked by the row rules, not as a mention
            first = work.find("|")
            second = work.find("|", first + 1)
            if second > 0:
                protect.append((0, second))
        links = link_spans(work)
        # link target validation
        for m in LINK_RE.finditer(work):
            text, url = m.group(1), m.group(2)
            ids_in_text = ID_RE.findall(text)
            frag_id = re.search(r"#(D-\d{3,})$", url)
            if not ids_in_text and not frag_id:
                if url.split("#")[0].endswith("vocabulary.md") and "#" in url:
                    target, frag = resolve_link(ledger, path, url)
                    if target and target.resolve() == (ledger.dir / "vocabulary.md").resolve() and frag not in ledger.vocab_slugs:
                        f.append(Finding(path, n, f"vocabulary link '#{frag}' has no matching term"))
                continue
            target, frag = resolve_link(ledger, path, url)
            if not re.fullmatch(r"D-\d{3,}", frag):
                f.append(Finding(path, n, f"link '{url}' must point at a row: `file.md#D-###`"))
                continue
            row = ledger.rows_by_id.get(frag)
            if row is None:
                f.append(Finding(path, n, f"link target {frag} is not a row in the ledger"))
                continue
            if target is None or target.resolve() != row.file.resolve():
                f.append(Finding(path, n, f"link '{url}' points at the wrong file for {frag} (it lives in {rel(ledger.root, row.file)})"))
            for t in ids_in_text:
                if f"D-{t}" != frag:
                    f.append(Finding(path, n, f"link text D-{t} but target {frag}"))
        # bare mentions
        replacements: list[tuple[int, int, str]] = []
        for m in ID_RE.finditer(work):
            if inside(m.start(), protect):
                continue
            rid = m.group(0)
            if collect is not None:
                collect.setdefault(rid, []).append((path, n))
            if inside(m.start(), links):
                continue
            row = ledger.rows_by_id.get(rid)
            if row is None:
                f.append(Finding(path, n, f"{rid} is mentioned but is not a row in the ledger"))
                continue
            if fix:
                target = os.path.relpath(row.file, path.parent).replace(os.sep, "/")
                replacements.append((m.start(), m.end(), f"[{rid}]({target}#{rid})"))
            else:
                f.append(Finding(path, n, f"bare mention of {rid}: every mention is a link (fixable)"))
        if replacements:
            new = out[i]
            for a, b, text in sorted(replacements, reverse=True):
                new = new[:a] + text + new[b:]
            out[i] = new
            fixes += len(replacements)
    return f, out, fixes


def check_vocab_terms(ledger: Ledger, sf: SubjectFile, fix: bool) -> tuple[list[Finding], int]:
    """Rule 10, second half: bold terms in Decision cells link to vocabulary.md."""
    f: list[Finding] = []
    fixes = 0
    if not ledger.vocab_terms:
        return f, 0
    vocab_rel = os.path.relpath(ledger.dir / "vocabulary.md", sf.path.parent).replace(os.sep, "/")
    for r in sf.rows:
        cell = r.cells[1]
        work = mask(mask_code_and_anchors(cell), link_spans(cell))
        replacements: list[tuple[int, int, str]] = []
        for m in BOLD_RE.finditer(work):
            inner = m.group(1).strip()
            if inner.startswith("Amended"):
                continue
            slug = ledger.vocab_terms.get(inner.lower())
            if slug is None:
                continue
            if fix:
                replacements.append((m.start(), m.end(), f"[**{inner}**]({vocab_rel}#{slug})"))
            else:
                f.append(Finding(r.file, r.line, f"vocabulary term '{inner}' must link to vocabulary.md#{slug} (fixable)"))
        if replacements:
            new = cell
            for a, b, text in sorted(replacements, reverse=True):
                new = new[:a] + text + new[b:]
            r.cells[1] = new
            fixes += len(replacements)
    return f, fixes


# ---------------------------------------------------------------- backlinks


def backlinks_text(ledger: Ledger, refs: dict[str, list[tuple[Path, int]]]) -> list[str]:
    def group(p: Path) -> int:
        r = rel(ledger.root, p)
        if r.startswith(LEDGER_DIR.as_posix() + "/"):
            return 0
        return 1 if r.lower().endswith(".md") else 2

    out = [
        "# Backlinks",
        "",
        "Generated by `python3 tools/ledger_check.py --fix`; do not edit by hand. One section per row, "
        "listing every place in the repository that refers to it.",
        "",
    ]
    for rid in sorted(ledger.rows_by_id, key=lambda s: int(s[2:])):
        row = ledger.rows_by_id[rid]
        target = os.path.relpath(row.file, ledger.dir).replace(os.sep, "/")
        out.append(f"## [{rid}]({target}#{rid})")
        out.append("")
        places = sorted(set(refs.get(rid, [])), key=lambda t: (group(t[0]), rel(ledger.root, t[0]), t[1]))
        if not places:
            out.append("- (no references)")
        for p, n in places:
            out.append(f"- `{rel(ledger.root, p)}:{n}`")
        out.append("")
    return out[:-1] if out[-1] == "" else out


# ---------------------------------------------------------------- driver


def run(root: Path, fix: bool) -> tuple[list[Finding], list[str]]:
    """Check the ledger; with fix=True, apply fixes first. Returns (findings, change notes)."""
    ledger, findings = load_ledger(root)
    changes: list[str] = []
    if ledger is None:
        return findings, changes

    # row-level fixes: anchors, vocabulary links
    if fix:
        for sf in ledger.subjects.values():
            touched = 0
            for r in sf.rows:
                if r.rid and not ANCHOR_RE.fullmatch(r.cells[0]):
                    r.cells[0] = f'<a id="{r.rid}"></a>{r.rid}'
                    touched += 1
                if "->" in r.cells[3]:
                    r.cells[3] = re.sub(r"\s*->\s*", " → ", r.cells[3])
                    touched += 1
            _, vfix = check_vocab_terms(ledger, sf, fix=True)
            touched += vfix
            if touched:
                for r in sf.rows:
                    sf.lines[r.line - 1] = join_cells(r.cells)
                write_lines(sf.path, sf.lines)
                changes.append(f"{rel(root, sf.path)}: {touched} row fix(es)")
        # anchors may have been reported as findings before fixing; reload cleanly
        ledger, findings = load_ledger(root)
        assert ledger is not None

    findings += check_rows(ledger)
    for sf in ledger.subjects.values():
        vf, _ = check_vocab_terms(ledger, sf, fix=False)
        findings += vf

    refs: dict[str, list[tuple[Path, int]]] = {}
    backlinks_path = ledger.dir / "backlinks.md"
    for p in repo_files(root, ledger.ignore):
        if p.resolve() == backlinks_path.resolve():
            continue
        lines = read_text_file(p)
        if lines is None:
            continue
        if p.suffix.lower() == ".md":
            f, new_lines, n = scan_mentions(ledger, p, lines, refs, fix)
            findings += f
            if n:
                write_lines(p, new_lines)
                changes.append(f"{rel(root, p)}: linked {n} bare mention(s)")
        else:
            for i, line in enumerate(lines, 1):
                for m in ID_RE.finditer(line):
                    if m.group(0) in ledger.rows_by_id:
                        refs.setdefault(m.group(0), []).append((p, i))

    expected = backlinks_text(ledger, refs)
    if fix:
        if not backlinks_path.exists() or read_lines(backlinks_path) != expected:
            write_lines(backlinks_path, expected)
            changes.append(f"{rel(root, backlinks_path)}: regenerated")
    else:
        if not backlinks_path.exists():
            findings.append(Finding(backlinks_path, 0, "backlinks.md is missing; run `python3 tools/ledger_check.py --fix`"))
        elif read_lines(backlinks_path) != expected:
            findings.append(Finding(backlinks_path, 1, "backlinks.md is stale; run `python3 tools/ledger_check.py --fix`"))

    findings.sort(key=lambda x: (rel(root, x.path), x.line, x.message))
    return findings, changes


def changed_files(root: Path, base: str) -> list[str]:
    def git(*args: str) -> str:
        return subprocess.run(["git", "-C", str(root), *args], check=True, capture_output=True).stdout.decode()

    try:
        merge_base = git("merge-base", base, "HEAD").strip()
    except subprocess.CalledProcessError:
        merge_base = base
    out = git("diff", "--name-only", merge_base)
    untracked = git("ls-files", "--others", "--exclude-standard")
    return sorted({l.strip() for l in (out + untracked).splitlines() if l.strip()})


def run_changed(root: Path, base: str) -> list[str]:
    ledger, _ = load_ledger(root)
    if ledger is None:
        return []
    changed = changed_files(root, base)
    lines_out: list[str] = []
    for sf in ledger.subjects.values():
        for r in sf.rows:
            if not r.rid:
                continue
            # the first token of each code span, if it looks like a path (`tools/x.py --fix` cites tools/x.py)
            cited = {m.group(0)[1:-1].split()[0] for m in CODE_SPAN_RE.finditer(r.decision + " " + r.source) if m.group(0)[1:-1].strip()}
            cited = {c for c in cited if ("/" in c or "." in c) and not c.startswith(("<", "*", "-"))}
            for c in sorted(cited):
                cc = c.rstrip("/")
                for ch in changed:
                    if ch == cc or ch.startswith(cc + "/"):
                        lines_out.append(f"ROW  {r.rid}  {rel(root, r.file)}:{r.line}  cites `{c}` (changed: {ch})")
                        break
    ledger_prefix = LEDGER_DIR.as_posix() + "/"
    for ch in changed:
        if ch.startswith(ledger_prefix) or not ch.lower().endswith(".md"):
            continue
        p = root / ch
        lines = read_text_file(p) if p.exists() else None
        if not lines:
            continue
        for i, line in enumerate(lines, 1):
            seen: set[str] = set()
            for m in ID_RE.finditer(mask_code_and_anchors(line)):
                rid = m.group(0)
                if rid in ledger.rows_by_id and rid not in seen:
                    seen.add(rid)
                    lines_out.append(f"DOC  {rid}  {ch}:{i}")
    return lines_out


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0], add_help=True)
    ap.add_argument("--fix", action="store_true", help="apply fixes, then check")
    ap.add_argument("--changed", metavar="BASE", help="list rows and doc lines citing files changed since BASE")
    ap.add_argument("--root", metavar="DIR", help="repository root")
    args = ap.parse_args(argv)

    root = Path(args.root).resolve() if args.root else find_root(Path.cwd())
    if root is None or not (root / LEDGER_DIR).is_dir():
        print("no ledger found: expected docs/ledger/ under the repository root", file=sys.stderr)
        return 2

    if args.changed:
        for line in run_changed(root, args.changed):
            print(line)
        return 0

    findings, changes = run(root, args.fix)
    for c in changes:
        print(f"fixed: {c}")
    for f in findings:
        print(f"{rel(root, f.path)}:{f.line}: {f.message}")
    if findings:
        print(f"{len(findings)} finding(s)", file=sys.stderr)
        return 1
    print("ledger check: clean")
    return 0


if __name__ == "__main__":
    sys.exit(main())
