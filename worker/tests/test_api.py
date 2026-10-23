from fastapi.testclient import TestClient

from devin_vlsi_worker.api import app

client = TestClient(app)


def test_health_is_public():
    assert client.get("/health").json()["status"] == "ok"


def test_jobs_refused_without_configured_token(monkeypatch):
    monkeypatch.delenv("WORKER_TOKEN", raising=False)
    assert client.post("/v1/jobs", json={}).status_code == 503


def test_jobs_require_valid_token(monkeypatch):
    monkeypatch.setenv("WORKER_TOKEN", "t0ken")
    assert client.get("/v1/capabilities", headers={"Authorization": "Bearer wrong"}).status_code == 401
    assert client.get("/v1/capabilities", headers={"Authorization": "Bearer t0ken"}).status_code == 200


def test_invalid_job_rejected(monkeypatch):
    monkeypatch.setenv("WORKER_TOKEN", "t0ken")
    bad = {"job_id": "x", "stage": "shell", "top": "t", "files": {}, "filelist": []}
    assert client.post("/v1/jobs", json=bad, headers={"Authorization": "Bearer t0ken"}).status_code == 422
