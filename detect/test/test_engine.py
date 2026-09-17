# SPDX-License-Identifier: Apache-2.0
"""Engine-selection tests for the Philotas detection service.

These tests exercise the DETECT_ENGINE dispatch without loading any real model.
Fake engine modules are injected into sys.modules so the AutoGluon and
ultralytics import paths can run in an environment with no model weights.
"""

import importlib
import os
import sys
import types

import pytest

# Make the sibling detect/ package importable regardless of pytest's rootdir.
_DETECT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _DETECT_DIR not in sys.path:
    sys.path.insert(0, _DETECT_DIR)

import service  # noqa: E402


_ENGINE_MODULES = ("ultralytics", "autogluon", "autogluon.multimodal")


@pytest.fixture()
def fresh_service(monkeypatch):
    """Yield a freshly reloaded service with no engine configured.

    Reloading clears the module-level detector state (_detector, _engine, ...)
    so each test starts clean. Engine modules are removed from sys.modules so a
    previous test's fakes cannot leak into this one.
    """
    for key in ("DETECT_ENGINE", "AG_MODEL_DIR", "YOLO_MODEL"):
        monkeypatch.delenv(key, raising=False)
    for mod in _ENGINE_MODULES:
        sys.modules.pop(mod, None)
    importlib.reload(service)
    yield service
    for mod in _ENGINE_MODULES:
        sys.modules.pop(mod, None)


def _install_fake_ultralytics():
    mod = types.ModuleType("ultralytics")

    class FakeYOLO:
        def __init__(self, model_path):
            self.model_path = model_path
            self.names = {0: "person", 1: "bicycle"}

        def predict(self, *args, **kwargs):
            return []

    mod.YOLO = FakeYOLO
    sys.modules["ultralytics"] = mod
    return mod


def _install_fake_autogluon():
    ag = types.ModuleType("autogluon")
    mm = types.ModuleType("autogluon.multimodal")

    class FakeObjectDetector:
        classes = ["car", "person"]

        @classmethod
        def load(cls, model_dir):
            return cls()

    mm.ObjectDetector = FakeObjectDetector
    ag.multimodal = mm
    sys.modules["autogluon"] = ag
    sys.modules["autogluon.multimodal"] = mm
    return ag


def test_auto_without_ag_model_dir_fails_without_importing_ultralytics(fresh_service, monkeypatch):
    monkeypatch.setenv("DETECT_ENGINE", "auto")
    fresh_service._init()

    assert fresh_service._engine == "none"
    assert fresh_service._init_error is not None
    assert "AutoGluon" in fresh_service._init_error
    assert "AG_MODEL_DIR" in fresh_service._init_error
    assert "DETECT_ENGINE=ultralytics" in fresh_service._init_error
    assert "ultralytics" not in sys.modules
    assert "autogluon" not in sys.modules


def test_ultralytics_opt_in_loads_and_logs_agpl_notice(fresh_service, monkeypatch, capsys):
    monkeypatch.setenv("DETECT_ENGINE", "ultralytics")
    _install_fake_ultralytics()
    fresh_service._init()

    captured = capsys.readouterr().out
    assert fresh_service._engine == "ultralytics"
    assert "AGPL-3.0" in captured
    assert "https://www.ultralytics.com/license" in captured


def test_autogluon_engine_selects_autogluon(fresh_service, monkeypatch):
    monkeypatch.setenv("DETECT_ENGINE", "autogluon")
    _install_fake_autogluon()
    fresh_service._init()

    assert fresh_service._engine == "autogluon"
