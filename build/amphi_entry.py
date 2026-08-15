"""PyInstaller entry script.

We cannot point PyInstaller at `src/__main__.py` directly: that file
contains `from .amphi_cli import dispatch`, which is a relative
import that requires `__package__ == 'src'`. PyInstaller runs the
entry script as a top-level `__main__` with no parent package, so
the relative import fails at runtime:

    ImportError: attempted relative import with no known parent package

This launcher does the same dispatch using an *absolute* import. The
src package itself is still bundled (Analysis pulls it in transitively
via this import), so `from src.amphi_cli import dispatch` resolves
to the same code path as `python -m src` does in dev.
"""

from src.amphi_cli import dispatch


if __name__ == "__main__":
    dispatch()
