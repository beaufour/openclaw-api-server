from __future__ import annotations

import json
import os
import stat
import sys
import tempfile
import unittest
from pathlib import Path


SKILL_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SKILL_DIR))

from audit_decision import validate_document  # noqa: E402
from inspect_drive_share import extract_drive_file_id, inspect_content  # noqa: E402
from audit_log import append_event, has_decision  # noqa: E402


VALID_DOCUMENT = {
    "category": "school",
    "outcome": "silent",
    "user_attention": False,
    "items": [
        {
            "item": "No school on 2026-09-21",
            "disposition": "skipped_duplicate",
            "reason": "already present in the school tracker",
        }
    ],
    "actions": ["No calendar or notification action taken"],
}


class AuditDecisionTests(unittest.TestCase):
    def test_valid_document(self) -> None:
        self.assertEqual(validate_document(VALID_DOCUMENT), VALID_DOCUMENT)

    def test_google_drive_category(self) -> None:
        document = dict(VALID_DOCUMENT, category="google_drive", outcome="notified")
        self.assertEqual(validate_document(document), document)

    def test_missing_field_is_rejected(self) -> None:
        document = dict(VALID_DOCUMENT)
        del document["items"]
        with self.assertRaisesRegex(ValueError, "missing required fields: items"):
            validate_document(document)

    def test_invalid_disposition_is_rejected(self) -> None:
        document = json.loads(json.dumps(VALID_DOCUMENT))
        document["items"][0]["disposition"] = "ignored"
        with self.assertRaisesRegex(ValueError, r"invalid items\[0\].disposition"):
            validate_document(document)


class AuditLogTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.path = Path(self.tempdir.name) / "audit.jsonl"
        os.environ["HERMES_GMAIL_AUDIT_PATH"] = str(self.path)

    def tearDown(self) -> None:
        os.environ.pop("HERMES_GMAIL_AUDIT_PATH", None)
        self.tempdir.cleanup()

    def test_append_and_decision_lookup(self) -> None:
        append_event(
            {"event": "decision", "message_id": "m1", **VALID_DOCUMENT}
        )
        append_event({"event": "checkpoint_completed", "message_id": "m1"})

        records = [json.loads(line) for line in self.path.read_text().splitlines()]
        self.assertEqual([record["event"] for record in records], [
            "decision",
            "checkpoint_completed",
        ])
        self.assertIn("timestamp", records[0])
        self.assertTrue(has_decision("m1"))
        self.assertFalse(has_decision("m2"))
        self.assertEqual(stat.S_IMODE(self.path.stat().st_mode), 0o600)

    def test_missing_ledger_has_no_decision(self) -> None:
        self.assertFalse(has_decision("m1"))


class DriveShareInspectionTests(unittest.TestCase):
    def test_extracts_canonical_drive_file_url(self) -> None:
        self.assertEqual(
            extract_drive_file_id(
                "Shared file: https://drive.google.com/file/d/abc_DEF-123/view?usp=sharing"
            ),
            "abc_DEF-123",
        )

    def test_extracts_google_docs_url(self) -> None:
        self.assertEqual(
            extract_drive_file_id(
                "https://docs.google.com/spreadsheets/d/sheet_456/edit"
            ),
            "sheet_456",
        )

    def test_rejects_lookalike_host(self) -> None:
        with self.assertRaisesRegex(RuntimeError, "found 0"):
            extract_drive_file_id(
                "https://drive.google.com.attacker.example/file/d/not-safe/view"
            )

    def test_rejects_multiple_file_ids(self) -> None:
        with self.assertRaisesRegex(RuntimeError, "found 2"):
            extract_drive_file_id(
                "https://drive.google.com/file/d/one/view "
                "https://drive.google.com/file/d/two/view"
            )

    def test_binary_file_is_metadata_only(self) -> None:
        result = inspect_content(
            object(),
            {
                "id": "binary-file",
                "mimeType": "application/pdf",
                "size": "1024",
                "capabilities": {"canDownload": True},
            },
        )
        self.assertEqual(result, {
            "status": "metadata_only",
            "reason": "unsupported_mime_type",
        })

    def test_large_text_file_is_metadata_only(self) -> None:
        result = inspect_content(
            object(),
            {
                "id": "large-text-file",
                "mimeType": "text/plain",
                "size": str(2 * 1024 * 1024 + 1),
                "capabilities": {"canDownload": True},
            },
        )
        self.assertEqual(result["status"], "metadata_only")
        self.assertEqual(result["reason"], "file_too_large")


if __name__ == "__main__":
    unittest.main()
