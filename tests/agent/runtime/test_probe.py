from __future__ import annotations

import pytest

from src.amphi_agent.runtime import _probe as probe_module
from src.amphi_agent.runtime._errors import EnvNotReady
from src.amphi_agent.runtime._probe import BaseProbe, ProbeResult, UnreadableBaseGuard, probe_base
from tests._support.sandbox import IsolatedPaths


pytestmark = pytest.mark.windows_runtime


def test_probe_verdicts(test_sandbox: IsolatedPaths, monkeypatch: pytest.MonkeyPatch) -> None:
    """Final probe verdicts:

    {
      "usable": "valid",
      "missing_or_damaged": "invalid",
      "permission_denied_after_three_attempts": "unreadable"
    }

    Checks:
    1. A successful inspector distinguishes usable and unusable bases.
    2. Invalid manifest content is rebuildable and does not enter the retry path.
    3. Repeated operating-system read failures remain unreadable with their last cause.
    """
    damaged_calls = 0
    unreadable_calls = 0
    denied = PermissionError("base access denied")

    def damaged() -> bool:
        nonlocal damaged_calls
        damaged_calls += 1
        raise ValueError("invalid manifest")

    def unreadable() -> bool:
        nonlocal unreadable_calls
        unreadable_calls += 1
        raise denied

    monkeypatch.setattr(probe_module, "PROBE_BACKOFF_SEC", 0)
    base = test_sandbox.root / "base"

    # Check 1: Boolean inspection results map directly to usable versus rebuildable.
    valid = probe_base(base, lambda: True)
    invalid = probe_base(base, lambda: False)
    assert valid.result is ProbeResult.VALID
    assert valid.usable is True
    assert invalid.result is ProbeResult.INVALID
    assert invalid.usable is False

    # Check 2: A damaged readable manifest is invalid immediately, without retries.
    damaged_result = probe_base(base, damaged)
    assert damaged_result.result is ProbeResult.INVALID
    assert damaged_calls == 1

    # Check 3: Three failed reads preserve the unknown verdict and final OS error.
    unreadable_result = probe_base(base, unreadable)
    assert unreadable_result.result is ProbeResult.UNREADABLE
    assert unreadable_result.unreadable is True
    assert unreadable_result.error is denied
    assert unreadable_calls == 3


def test_quarantine_streak(test_sandbox: IsolatedPaths) -> None:
    """Final quarantine state:

    {
      "active_base": "new unreadable base preserved",
      "backup": {"marker.txt": "original packages"},
      "guard_streak": "reset"
    }

    Checks:
    1. A partial unreadable streak never moves or deletes the runtime base.
    2. One readable round resets that streak completely.
    3. Three new unreadable rounds wait; the next attempt moves the base into a backup.
    4. Quarantine resets the guard, so a replacement base receives a fresh grace period.
    """
    base = test_sandbox.root / "base"
    base.mkdir()
    (base / "marker.txt").write_text("original packages", encoding="utf-8")
    error = PermissionError("base access denied")
    unreadable = BaseProbe(ProbeResult.UNREADABLE, base, error)
    valid = BaseProbe(ProbeResult.VALID, base)
    guard = UnreadableBaseGuard()

    def wait_one_round() -> None:
        with pytest.raises(EnvNotReady) as raised:
            guard.settle(unreadable)
        assert raised.value.path == base
        assert raised.value.cause is error
        guard.close_round()

    # Check 1: Transient failures receive a grace period with the original files intact.
    wait_one_round()
    wait_one_round()
    assert (base / "marker.txt").read_text(encoding="utf-8") == "original packages"

    # Check 2: A readable preparation round clears the earlier unreadable streak.
    assert guard.settle(valid) is valid
    guard.close_round()

    # Check 3: Only three newly completed bad rounds allow the next attempt to quarantine.
    wait_one_round()
    wait_one_round()
    wait_one_round()
    assert base.is_dir()
    settled = guard.settle(unreadable)
    backups = list(test_sandbox.root.glob(".base.backup.*"))
    assert settled.result is ProbeResult.INVALID
    assert not base.exists()
    assert len(backups) == 1
    assert (backups[0] / "marker.txt").read_text(encoding="utf-8") == "original packages"

    # Check 4: The moved-aside verdict forgets its streak before a replacement appears.
    base.mkdir()
    (base / "replacement.txt").write_text("new base", encoding="utf-8")
    with pytest.raises(EnvNotReady):
        guard.settle(unreadable)
    assert (base / "replacement.txt").read_text(encoding="utf-8") == "new base"
