"""Downloaded models and reference data stay on this machine, out of a library that may sync."""
from __future__ import annotations

from slidestation import store


def test_models_and_data_move_out_of_the_library_once(tmp_path, monkeypatch):
    lib, home = tmp_path / "lib", tmp_path / "home"
    (lib / "models" / "clip").mkdir(parents=True)
    (lib / "models" / "clip" / "model.onnx").write_bytes(b"x")
    (lib / "data" / "geonames").mkdir(parents=True)
    monkeypatch.setattr(store, "library", lambda: lib)
    monkeypatch.setattr(store, "CONFIG_DIR", home)
    monkeypatch.delenv("SLIDESTATION_MODELS", raising=False)

    assert store.models_dir() == home / "models"
    assert (home / "models" / "clip" / "model.onnx").read_bytes() == b"x"
    assert not (lib / "models").exists()
    assert store.data_dir() == home / "data" and (home / "data" / "geonames").is_dir()
    assert not (lib / "data").exists()

    (lib / "models").mkdir()  # both there (a library synced from elsewhere): this machine's wins
    assert store.models_dir() == home / "models" and (lib / "models").is_dir()


def test_accounts_and_shared_models_as_before(tmp_path, monkeypatch):
    monkeypatch.setattr(store, "library", lambda: tmp_path / "lib")
    monkeypatch.setenv("SLIDESTATION_MODELS", str(tmp_path / "shared"))
    assert store.models_dir() == tmp_path / "shared"
    monkeypatch.delenv("SLIDESTATION_MODELS")
    with store.as_home(tmp_path / "user"):
        assert store.models_dir() == tmp_path / "lib" / "models"
