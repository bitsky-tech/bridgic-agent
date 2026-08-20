import io
import logging
from pathlib import Path
from typing import Iterator

import pytest

from src.amphi_service.server._logging import APP_LOGGER_NAMES, configure_daemon_logging


@pytest.fixture(autouse=True)
def restore_logging_state() -> Iterator[None]:
    """Isolate the process-wide logger configuration owned by this module."""
    root = logging.getLogger()
    handlers = list(root.handlers)
    root_level = root.level
    disabled = logging.root.manager.disable
    app_levels = {name: logging.getLogger(name).level for name in APP_LOGGER_NAMES}
    logging.disable(logging.NOTSET)
    yield
    for handler in list(root.handlers):
        if handler not in handlers:
            root.removeHandler(handler)
            handler.close()
    root.setLevel(root_level)
    for name, level in app_levels.items():
        logging.getLogger(name).setLevel(level)
    logging.disable(disabled)


def test_daemon_logging_records_application_context(tmp_path: Path) -> None:
    """The successful daemon path writes useful records without enabling dependency debug logs."""
    log_path = tmp_path / "server.log"
    handler = configure_daemon_logging(log_path, log_level="debug", stderr=io.StringIO())
    assert handler is not None

    logging.getLogger("src.amphi_agent.test").debug("application detail")
    logging.getLogger("httpx").debug("dependency request detail")
    handler.flush()

    content = log_path.read_text(encoding="utf-8")
    assert "[daemon-logging] started" in content
    assert "DEBUG src.amphi_agent.test application detail" in content
    assert "dependency request detail" not in content
    assert logging.getLogger().level == logging.INFO
    assert logging.getLogger("src.amphi_agent.test").getEffectiveLevel() == logging.DEBUG
    assert logging.getLogger("httpx").getEffectiveLevel() == logging.INFO


def test_daemon_logging_rotates_instead_of_growing_without_bound(tmp_path: Path) -> None:
    log_path = tmp_path / "server.log"
    handler = configure_daemon_logging(
        log_path,
        stderr=io.StringIO(),
        max_bytes=512,
        backup_count=2,
    )
    assert handler is not None

    logger = logging.getLogger("rotation.probe")
    for index in range(64):
        logger.info("rotation filler %04d %s", index, "x" * 64)
    handler.flush()

    assert log_path.is_file()
    assert (tmp_path / "server.log.1").is_file()
    assert log_path.stat().st_size <= 1024
