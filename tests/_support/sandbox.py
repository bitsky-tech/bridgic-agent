from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True, slots=True)
class IsolatedPaths:
    """Filesystem boundaries reserved for one test case."""

    root: Path
    home: Path
    app_home: Path
    state_db: Path
    sessions: Path
    attachments: Path
    workflows: Path
    runs: Path
    skills: Path
    policy_file: Path

    @classmethod
    def from_root(cls, root: Path) -> IsolatedPaths:
        resolved_root = root.resolve()
        home = resolved_root / "home"
        app_home = home / ".bridgic" / "AmphiAgent"
        return cls(
            root=resolved_root,
            home=home,
            app_home=app_home,
            state_db=resolved_root / "state.db",
            sessions=resolved_root / "sessions",
            attachments=resolved_root / "attachments",
            workflows=resolved_root / "workflows",
            runs=resolved_root / "runs",
            skills=resolved_root / "skills",
            policy_file=app_home / "policy.json",
        )

    def application_environment(self) -> dict[str, str]:
        """Return path overrides safe to apply inside the pytest process."""
        return {
            "BRIDGIC_AGENT_STATE_DB": str(self.state_db),
            "BRIDGIC_AGENT_SESSIONS_ROOT": str(self.sessions),
            "BRIDGIC_AGENT_ATTACHMENTS_ROOT": str(self.attachments),
            "BRIDGIC_AGENT_WORKFLOWS_ROOT": str(self.workflows),
            "BRIDGIC_AGENT_RUNS_ROOT": str(self.runs),
            "BRIDGIC_AGENT_SKILLS_ROOT": str(self.skills),
            "AMPHI_POLICY_FILE": str(self.policy_file),
        }

    def process_environment(self) -> dict[str, str]:
        """Return overrides for a child process imported inside the sandbox."""
        return {
            **self.application_environment(),
            "HOME": str(self.home),
        }


__all__ = ["IsolatedPaths"]
