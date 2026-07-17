"""Smoke test: HTTP routes, QR embedding, and the WebSocket relay."""
from starlette.testclient import TestClient

import main

client = TestClient(main.app)


def test_index_redirects_and_renders():
    r = client.get("/")  # follows redirect to /?s=<id>
    assert r.status_code == 200, r.status_code
    assert "SESSION_ID" in r.text
    assert "<svg" in r.text                # QR embedded inline
    assert "/controller/" in r.text        # controller URL present
    assert "?s=" in str(r.url)             # session id landed in the query
    print("  index: OK  ->", r.url)


def test_controller_page():
    r = client.get("/controller/abc123")
    assert r.status_code == 200, r.status_code
    assert "flap-btn" in r.text
    assert 'SESSION_ID = "abc123"' in r.text
    print("  controller page: OK")


def test_health():
    r = client.get("/health")
    assert r.status_code == 200 and r.json()["status"] == "ok"
    print("  health: OK ->", r.json())


def test_websocket_relay():
    sid = "testsess"
    with client.websocket_connect(f"/ws/{sid}/host") as host:
        with client.websocket_connect(f"/ws/{sid}/controller") as ctrl:
            # Server notifies host that a controller joined...
            assert host.receive_json() == {"type": "controller_joined"}
            # ...and tells the controller the host is present.
            assert ctrl.receive_json() == {"type": "host_status", "connected": True}

            # Phone -> host: a flap is relayed verbatim.
            ctrl.send_json({"type": "flap"})
            assert host.receive_json() == {"type": "flap"}

            # Host -> phone: game state is relayed to the controller.
            host.send_json({"type": "state", "state": "playing", "score": 3})
            assert ctrl.receive_json() == {
                "type": "state", "state": "playing", "score": 3
            }
        # Controller disconnected -> host is told.
        assert host.receive_json() == {"type": "controller_left"}
    print("  websocket relay: OK")


def test_host_reconnect_sees_existing_controller():
    sid = "resume"
    with client.websocket_connect(f"/ws/{sid}/controller") as ctrl:
        # No host yet.
        assert ctrl.receive_json() == {"type": "host_status", "connected": False}
        with client.websocket_connect(f"/ws/{sid}/host") as host:
            # Controller learns host came online.
            assert ctrl.receive_json() == {"type": "host_status", "connected": True}
            # Host learns a controller is already waiting.
            assert host.receive_json() == {"type": "controller_joined"}
    print("  host-after-controller: OK")


if __name__ == "__main__":
    test_index_redirects_and_renders()
    test_controller_page()
    test_health()
    test_websocket_relay()
    test_host_reconnect_sees_existing_controller()
    # No sessions should leak once everyone disconnects.
    assert main.sessions == {}, f"leaked sessions: {main.sessions}"
    print("\nALL SMOKE TESTS PASSED  (no leaked sessions)")
