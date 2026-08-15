"""PyInstaller runtime hook — point ssl/httpx at a STABLE certifi CA path.

PyInstaller 6.x ships no certifi hook, so ``certifi.where()`` resolves to a
path that doesn't exist in the frozen binary → every HTTPS call raises
``FileNotFoundError`` in ``ssl.create_default_context`` (codex probe / token
exchange, and the agent's LLM calls).

The cacert.pem IS bundled at ``_MEIPASS/certifi/cacert.pem`` because certifi is
part of the pyproject-derived runtime dependency closure collected by
``build/amphi.spec``.

Under the old onefile build ``_MEIPASS`` was a per-process temp dir wiped on
exit, so a detached daemon spawned by ``amphi server start`` would inherit a
path that died with its launcher. The build is onedir now and ``_MEIPASS``
points at the permanent ``_internal/`` directory beside the executable, so that
particular hazard is gone.

The copy is kept anyway, deliberately: exporting a path under ~/.bridgic keeps
SSL_CERT_FILE valid for processes that outlive or relocate relative to the app
bundle, and it costs one stat per launch. httpx checks SSL_CERT_FILE before
certifi.where() (see httpx/_config.py), and Python's ssl honors it too, so this
covers all outbound TLS regardless of how the process was spawned.
"""
import os
import shutil
import sys

if hasattr(sys, "_MEIPASS"):
    _src = os.path.join(sys._MEIPASS, "certifi", "cacert.pem")
    if os.path.exists(_src):
        _stable = os.path.join(
            os.path.expanduser("~"), ".bridgic", "AmphiAgent", "cacert.pem"
        )
        try:
            os.makedirs(os.path.dirname(_stable), exist_ok=True)
            # Idempotent copy (same bytes every run); refresh if size differs.
            if not os.path.exists(_stable) or os.path.getsize(_stable) != os.path.getsize(_src):
                shutil.copyfile(_src, _stable)
            os.environ["SSL_CERT_FILE"] = _stable
        except Exception:
            # Last resort: the temp path at least works within this process.
            os.environ.setdefault("SSL_CERT_FILE", _src)
