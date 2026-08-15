"""Core types of the permission rules: capability, boundary, judgement, execution mode, action.

These are the **pure data types** passed between the permission engine's four layers
(normalise -> rules -> rule layer -> mode layer) and contain no decision logic (that
lives in ``_classify`` / ``_mode_policy`` / ``_engine``). Defining them together here
lets every layer reference the same enums, and means adding or removing a capability /
boundary / mode touches one place only.

``Permission`` is the operative verdict the engine finally writes to
``CallVerdict.verdict``; ``Action`` is the intermediate action the mode layer looks up,
with one extra value ``CLASSIFY`` (hand it to the safety classifier).
"""

from __future__ import annotations

from enum import Enum
from typing import Optional

from pydantic import BaseModel


class Permission(str, Enum):
    """The permission engine's final verdict on one tool call."""

    ALLOW = "allow"
    DENY = "deny"
    ASK = "ask"


class Capability(str, Enum):
    """What a tool call is *doing* — objective, derivable from the tool name plus its
    arguments, and carrying no subjective risk score."""

    READ = "read"          # read / search: read_file, glob, grep, read-only shell
    EDIT = "edit"          # write / modify files: write_file, edit_file, cp/mv/mkdir
    NETWORK = "network"    # network: web_fetch, browser_*, curl
    EXECUTE = "execute"    # run a shell command (beyond plain read/write)
    MCP = "mcp"            # external MCP tools: mcp__*
    MANAGE = "manage"      # read-only management: skill / workspace / schedule queries (always allowed)
    MANAGE_WRITE = "manage_write"  # in-app writes: create/update/delete of schedules, workflows, and skills (confirmed in request mode only; allowed in auto/full)
    CONTROL = "control"    # framework-internal control: switch, request_human_choice (always allowed)


class Boundary(str, Enum):
    """*Where* a call acts. ``NONE`` means there is no notion of a path (pure network /
    control tools).

    ``IN_MOUNT`` / ``IN_APP_HOME`` are both "trusted directories" — the former is
    imported deliberately by the user via "add file/folder", the latter is this app's
    own data directory (``~/.bridgic``). The rules are identical for both (writes
    allowed, deletion depends on whether the target is regenerable), but they are kept
    as separate values so the approval card and the audit log can show the true source.

    ``IN_APP_BUILTIN`` is where the bundled skills live inside **the product's own
    install directory** (``<pkg>/builtin_skills``), and its rules **differ** from the
    two above: reads / execution are allowed (that is our own code, and running it is
    equivalent to trusting the daemon itself), while writes / deletes still fall to the
    mode layer for the classifier to judge under 'self-modification' — i.e. "running a
    bundled skill is not questioned, modifying one still is".
    """

    IN_WORKSPACE = "in_workspace"    # inside the session working directory .work
    IN_TEMP = "in_temp"              # system temp directory (scratch; its contents are inherently disposable)
    IN_MOUNT = "in_mount"            # inside a directory the user mounted
    IN_APP_HOME = "in_app_home"      # this app's data directory ~/.bridgic (skills / sessions / logs, etc.)
    IN_APP_BUILTIN = "in_app_builtin"  # bundled skills inside the install directory <pkg>/builtin_skills (reads/executes trusted; writes/deletes still reviewed)
    OUT_OF_BOUNDS = "out_of_bounds"  # anything outside the above
    NONE = "none"


class Judgement(BaseModel):
    """② The rules layer's output: what kind of call this is. **It carries no final
    action** — whether it is allowed is decided from this by the rule layer (③) and the
    mode layer (④).

    ``hard_deny`` is true when a system-level destruction red line is hit, and the rule
    layer denies outright; ``uncertain_destruction`` is true when a "deletion whose
    target cannot be seen clearly" is hit (a variable / command substitution / unknown
    cwd) and is handled by the ④ ``decide`` cross-cut (request-approval asks a human,
    the rest go to the classifier); ``sensitive`` is true when a sensitive path
    (``.env`` / ``~/.ssh`` …) is hit, so the rule layer does not allow it as an ordinary
    "liberal read / in-workspace edit" but drops it to the mode layer for approval;
    ``cwd`` is the directory a Bash sub-command actually runs in (for path resolution
    and the classifier prompt; ``None`` when unknown); ``label`` is a one-line
    human-readable explanation passed through to "why you are being asked" on the
    approval card.

    ``deletion`` / ``regenerable`` are the deletion rules' output: the first marks "this
    is a deletion", the second means **every delete target is a regenerable artifact**
    (caches / dependencies — rebuildable from a manifest). The rule layer uses them to
    treat "deleting node_modules" differently from "deleting source": the former is
    allowed at any boundary, the latter still goes through approval.

    ``touches_risk_surface`` serves the auto iron rule (everything passes by default
    except obvious / possible risk): it marks **whether this call could affect anything
    outside the workspace** — command-shaped risks (privilege escalation / system
    package managers / global installs / outbound traffic carrying data / executing from
    uncontrolled sources / pushing to remotes and publishing) are set by the rules layer
    from ``_registry.RISK_SURFACE_COMMANDS``, and write-type network / MCP operations are
    set from the tool name. Structural boundary and sensitivity risks do **not** depend
    on this field — ``_mode_policy`` derives them separately from ``sensitive`` /
    ``uncertain_destruction`` / ``EDIT``, forming a double backstop so that a miss in the
    rules layer does not become a fail-open.
    """

    hard_deny: bool = False
    capability: Capability
    boundary: Boundary = Boundary.NONE
    sensitive: bool = False
    uncertain_destruction: bool = False
    deletion: bool = False
    regenerable: bool = False
    touches_risk_surface: bool = False
    cwd: Optional[str] = None
    label: str = ""


class ExecutionMode(str, Enum):
    """Permission mode resolved from the User/Invocation base and any Think override."""

    REQUEST = "request"  # request approval: ask about everything beyond read-only
    AUTO = "auto"        # approve on my behalf (default): everything passes except risk-surface operations, which go to the classifier
    FULL = "full"        # full access: risky operations skip the classifier; system hard-denies still refuse, and credential / uncertain deletions are still held


class Action(str, Enum):
    """④ The action the mode layer looks up. ``CLASSIFY`` means "hand it to the safety
    classifier" and appears only as the default action of auto mode; once the classifier
    has judged, it reduces to ``ALLOW`` / ``ASK``."""

    ALLOW = "allow"
    ASK = "ask"
    DENY = "deny"
    CLASSIFY = "classify"
