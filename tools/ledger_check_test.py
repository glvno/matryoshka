#!/usr/bin/env python3
"""Regression tests for the ledger's branch impact report; uses disposable Git repos."""
import subprocess
import tempfile
import unittest
from pathlib import Path

import ledger_check


FIRST, SECOND, THIRD = (f"D-{number:03}" for number in (1, 2, 3))


def row(rid, decision, status="Decided", source="owner", date="2026-11-09"):
    return f'| <a id="{rid}"></a>{rid} | {decision} | {status} | {date} | {source} |'


def subject(*rows):
    return "\n".join([
        "# Rules", "", f"IDs: {FIRST}–D-049", "", "Current rules.", "",
        "| ID | Decision | Status | Date | Source |", "|---|---|---|---|---|",
        *rows, "", "## Not yet settled", "", "- (none)", "",
    ])


class ImpactReportTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.git("init", "-q")
        self.git("config", "user.email", "ledger-test@example.invalid")
        self.git("config", "user.name", "Ledger Test")
        for name in ("README.md", "STYLE.md", "vocabulary.md"):
            self.write(f"docs/ledger/{name}", "# Reference\n")
        self.rules(row(FIRST, "Run the full checks."), row(SECOND, "Keep the hardware gate."))
        self.write("README.md", f"# Guide\n\nUse the full checks\nbefore integrating ([{FIRST}](docs/ledger/rules.md#{FIRST})).\n\nHardware: [{SECOND}](docs/ledger/rules.md#{SECOND}).\n")
        self.commit()
        self.base = self.git("rev-parse", "HEAD").strip()

    def git(self, *args):
        return subprocess.check_output(["git", "-C", str(self.root), *args], text=True, stderr=subprocess.PIPE)

    def write(self, name, content):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content)

    def rules(self, *rows):
        self.write("docs/ledger/rules.md", subject(*rows))

    def commit(self):
        self.git("add", ".")
        self.git("-c", "commit.gpgsign=false", "commit", "-qm", "fixture")

    def references(self, base=None):
        return [line for line in ledger_check.run_changed(self.root, base or self.base) if line.startswith("REF  ")]

    def test_changed_ruling_reports_unchanged_wrapped_guidance_and_code(self):
        self.write("README.md", f"# Guide\n\n- Run checks for this stage\n  using [{FIRST}](docs/ledger/rules.md#{FIRST}) and [{FIRST}](docs/ledger/rules.md#{FIRST}).\n- Unrelated next item.\n")
        self.write("tools/example.py", f"# Follow {FIRST} when selecting checks.\n")
        self.commit()
        baseline = self.git("rev-parse", "HEAD").strip()
        self.rules(row(FIRST, "Run focused checks for candidates."), row(SECOND, "Keep the hardware gate."))
        refs = self.references(baseline)
        readme = [line for line in refs if "README.md:" in line]
        self.assertEqual(len(readme), 1)
        self.assertIn("README.md:3-4", readme[0])
        self.assertIn("Run checks for this stage", readme[0])
        self.assertNotIn("Unrelated next item", readme[0])
        self.assertTrue(any("tools/example.py:1" in line for line in refs))
        self.assertFalse(any(SECOND in line for line in refs))

    def test_status_changes_require_review_but_source_and_date_edits_do_not(self):
        self.rules(row(FIRST, "Run the full checks.", source="corrected attribution", date="2026-11-10"), row(SECOND, "Keep the hardware gate."))
        self.assertEqual(self.references(), [])
        self.rules(row(FIRST, "Run the full checks.", status="Proposed (decider: owner)"), row(SECOND, "Keep the hardware gate."))
        self.assertTrue(any("README.md:3-4" in line for line in self.references()))

    def test_removed_and_new_ids_find_live_references(self):
        self.write("docs/new guide.md", f"New rule: [{THIRD}](ledger/rules.md#{THIRD}).\n")
        self.rules(row(THIRD, "A replacement rule."), row(SECOND, "Keep the hardware gate."))
        refs = self.references()
        self.assertTrue(any(FIRST in line and "README.md:" in line for line in refs))
        self.assertTrue(any(THIRD in line and "docs/new guide.md:1" in line for line in refs))
        self.assertFalse(any(SECOND in line for line in refs))

    def test_row_moves_and_generated_backlinks_do_not_report_all_rules(self):
        (self.root / "docs/ledger/rules.md").rename(self.root / "docs/ledger/moved.md")
        self.write("docs/ledger/backlinks.md", f"# Backlinks\n\n## [{FIRST}](moved.md#{FIRST})\n- `README.md:3`\n")
        self.assertEqual(self.references(), [])

    def test_backlink_scanner_ignores_examples_and_excluded_files(self):
        self.write("docs/examples.md", f"`{FIRST}`\n\n```text\n{FIRST}\n```\n")
        self.write("docs/ledger/.checkignore", "docs/old/**\n")
        self.write("docs/old/notes.md", f"Follow {FIRST}.\n")
        self.write("docs/ledger/backlinks.md", f"## [{FIRST}](rules.md#{FIRST})\n")
        self.rules(row(FIRST, "Changed ruling."), row(SECOND, "Keep the hardware gate."))
        refs = self.references()
        self.assertEqual(len(refs), 1)
        self.assertIn("README.md:3-4", refs[0])

    def test_report_uses_branch_merge_base_not_unrelated_upstream_changes(self):
        self.git("branch", "upstream")
        self.git("checkout", "-qb", "feature")
        self.write("feature.txt", "Independent feature.\n")
        self.commit()
        self.git("checkout", "-q", "upstream")
        self.rules(row(FIRST, "Upstream changed this rule."), row(SECOND, "Keep the hardware gate."))
        self.commit()
        self.git("checkout", "-q", "feature")
        self.assertEqual(self.references("upstream"), [])

    def test_existing_file_dependency_report_handles_spaces(self):
        self.rules(row(FIRST, "See `tools/check notes.py`."), row(SECOND, "Keep the hardware gate."))
        self.write("tools/check notes.py", "# original\n")
        self.commit()
        baseline = self.git("rev-parse", "HEAD").strip()
        self.write("tools/check notes.py", "# changed\n")
        report = ledger_check.run_changed(self.root, baseline)
        self.assertTrue(any(line.startswith("ROW  ") and "tools/check notes.py" in line for line in report))
        self.assertFalse(any(line.startswith("REF  ") for line in report))


if __name__ == "__main__":
    unittest.main()
