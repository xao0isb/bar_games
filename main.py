"""Flappy Beer played on a big screen, controlled from a phone via a QR code.

Flow
----
1. The main screen opens ``/`` and shows a QR code.
2. A player scans it and lands on ``/controller/<session_id>`` — a single big button.
3. Tapping the button sends a "flap" event over a WebSocket. The server relays it
   to the main screen, where the Flappy Beer game (running in the browser) makes the
   player's avatar jump. The player sets a name and photo on their phone first; the
   photo becomes the flying character. Obstacles are drinks — beer, soju and shots.

The game physics/rendering live in the browser (``static/host.js``); the server is a
thin real-time relay between the controller(s) and the host screen of a session.
"""

from __future__ import annotations

import json
import os
import uuid
from dataclasses import dataclass, field
from io import BytesIO

import qrcode
import qrcode.image.svg
from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import HTMLResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from pydantic import BaseModel

app = FastAPI(title="Flappy Beer — QR Controller")

# --------------------------------------------------------------------------- #
# Deployment settings (environment-driven)
# --------------------------------------------------------------------------- #
# If set, the QR code / controller link use this exact public base URL, e.g.
# "https://game.example.com". Otherwise the URL is derived from the incoming
# request — correct behind a reverse proxy as long as it forwards the Host
# header and X-Forwarded-Proto (run uvicorn with --proxy-headers).
PUBLIC_BASE_URL = os.environ.get("PUBLIC_BASE_URL", "").rstrip("/")

# Optional comma-separated Host allow-list, e.g. "game.example.com,www.example.com".
_ALLOWED_HOSTS = [h.strip() for h in os.environ.get("ALLOWED_HOSTS", "").split(",") if h.strip()]
if _ALLOWED_HOSTS:
    from starlette.middleware.trustedhost import TrustedHostMiddleware

    app.add_middleware(TrustedHostMiddleware, allowed_hosts=_ALLOWED_HOSTS)

# Templates/static are resolved relative to this file so the app runs from any CWD.
_BASE_DIR = os.path.dirname(os.path.abspath(__file__))
templates = Jinja2Templates(directory=os.path.join(_BASE_DIR, "templates"))
app.mount("/static", StaticFiles(directory=os.path.join(_BASE_DIR, "static")), name="static")


# --------------------------------------------------------------------------- #
# Session state (in-memory; fine for a single-process demo / bar screen)
# --------------------------------------------------------------------------- #
@dataclass
class GameSession:
    """One screen (host) plus the phone(s) controlling it."""

    host: WebSocket | None = None
    controllers: set[WebSocket] = field(default_factory=set)


# NOTE: sessions live in this process's memory. A host screen and its
# controllers must be served by the SAME process, so run a SINGLE worker
# (see README). To scale horizontally you'd relay events through Redis/pub-sub.
sessions: dict[str, GameSession] = {}


# Operator-controlled game mode, flipped from the /admin page. Global on purpose:
# this is a single-screen demo, so one switch drives whatever screen(s) connect.
#   single_play == False -> 3-play demo that ends on a (flattering) leaderboard
#   single_play == True  -> one play that ends on "you lost", no leaderboard
GAME_SETTINGS = {"single_play": False}


class ModeIn(BaseModel):
    single: bool


def get_or_create(session_id: str) -> GameSession:
    session = sessions.get(session_id)
    if session is None:
        session = GameSession()
        sessions[session_id] = session
    return session


def make_qr_svg(data: str) -> str:
    """Return an inline SVG string for ``data`` (no external image dependency)."""
    qr = qrcode.QRCode(
        border=2,
        box_size=10,
        error_correction=qrcode.constants.ERROR_CORRECT_M,
    )
    qr.add_data(data)
    qr.make(fit=True)
    img = qr.make_image(image_factory=qrcode.image.svg.SvgPathImage)
    buf = BytesIO()
    img.save(buf)
    svg = buf.getvalue().decode("utf-8")
    # Drop the XML prolog so the SVG embeds cleanly inside HTML.
    if svg.startswith("<?xml"):
        svg = svg.split("?>", 1)[1].lstrip()
    return svg


def controller_url_for(request: Request, session_id: str) -> str:
    """Absolute URL of the controller page.

    Prefers ``PUBLIC_BASE_URL`` when configured; otherwise derives it from the
    request (scheme comes from X-Forwarded-Proto when uvicorn runs with
    ``--proxy-headers``, host from the forwarded Host header).
    """
    if PUBLIC_BASE_URL:
        return f"{PUBLIC_BASE_URL}/controller/{session_id}"
    return str(request.url_for("controller_page", session_id=session_id))


# --------------------------------------------------------------------------- #
# HTTP routes
# --------------------------------------------------------------------------- #
@app.get("/", response_class=HTMLResponse)
async def index(request: Request, s: str | None = None):
    """Main screen: shows the QR code and runs the game.

    A session id is kept in the ``?s=`` query param so refreshing the screen keeps
    the *same* QR code (and thus the same game) instead of orphaning the player.
    """
    session_id = "".join(c for c in (s or "") if c.isalnum())[:16]
    if not session_id:
        new_id = uuid.uuid4().hex[:8]
        return RedirectResponse(
            url=str(request.url.include_query_params(s=new_id))
        )

    controller_url = controller_url_for(request, session_id)
    return templates.TemplateResponse(
        request,
        "index.html",
        {
            "session_id": session_id,
            "controller_url": controller_url,
            "qr_svg": make_qr_svg(controller_url),
        },
    )


@app.get(
    "/controller/{session_id}",
    response_class=HTMLResponse,
    name="controller_page",
)
async def controller_page(request: Request, session_id: str):
    """The page that opens on the player's phone: one big button."""
    return templates.TemplateResponse(
        request,
        "controller.html",
        {"session_id": session_id},
    )


# --------------------------------------------------------------------------- #
# Operator control panel (open /admin on your phone)
# --------------------------------------------------------------------------- #
@app.get("/admin", response_class=HTMLResponse)
async def admin_page(request: Request):
    """Operator panel: a single switch to flip demo/normal mode."""
    return templates.TemplateResponse(request, "admin.html", {})


@app.get("/api/mode")
async def get_mode():
    return {"single": GAME_SETTINGS["single_play"]}


@app.post("/api/mode")
async def set_mode(body: ModeIn):
    """Flip the mode, then tell every screen to switch and restart the game."""
    GAME_SETTINGS["single_play"] = bool(body.single)
    await broadcast_to_hosts({"type": "mode", "single": GAME_SETTINGS["single_play"]})
    await broadcast_to_hosts({"type": "reset"})
    return {"single": GAME_SETTINGS["single_play"]}


# --------------------------------------------------------------------------- #
# WebSocket relay
# --------------------------------------------------------------------------- #
async def send_safe(ws: WebSocket | None, msg: dict) -> None:
    if ws is None:
        return
    try:
        await ws.send_text(json.dumps(msg))
    except Exception:
        pass


async def broadcast_to_hosts(msg: dict) -> None:
    """Push a message to every connected host screen (used by /api/mode)."""
    for session in list(sessions.values()):
        await send_safe(session.host, msg)


async def broadcast_to_controllers(session: GameSession, msg: dict) -> None:
    payload = json.dumps(msg)
    for ws in list(session.controllers):
        try:
            await ws.send_text(payload)
        except Exception:
            session.controllers.discard(ws)


@app.websocket("/ws/{session_id}/{role}")
async def ws_endpoint(websocket: WebSocket, session_id: str, role: str):
    """Relay events for one session.

    * ``role == "host"``  — the big screen. Its messages (game state) go to controllers.
    * ``role == "controller"`` — a phone. Its messages (flap) go to the host.
    """
    await websocket.accept()
    session = get_or_create(session_id)

    if role == "host":
        session.host = websocket
        # Tell the freshly-connected screen the current operator mode.
        await send_safe(websocket, {"type": "mode", "single": GAME_SETTINGS["single_play"]})
        await broadcast_to_controllers(session, {"type": "host_status", "connected": True})
        # If a phone is already waiting, let the freshly-(re)connected screen know.
        if session.controllers:
            await send_safe(websocket, {"type": "controller_joined"})
    else:
        session.controllers.add(websocket)
        await send_safe(session.host, {"type": "controller_joined"})
        await send_safe(
            websocket, {"type": "host_status", "connected": session.host is not None}
        )

    try:
        while True:
            raw = await websocket.receive_text()
            try:
                msg = json.loads(raw)
            except (json.JSONDecodeError, TypeError):
                continue
            if role == "host":
                await broadcast_to_controllers(session, msg)
            else:
                await send_safe(session.host, msg)
    except WebSocketDisconnect:
        pass
    finally:
        if role == "host":
            if session.host is websocket:
                session.host = None
            await broadcast_to_controllers(
                session, {"type": "host_status", "connected": False}
            )
        else:
            session.controllers.discard(websocket)
            await send_safe(session.host, {"type": "controller_left"})

        if session.host is None and not session.controllers:
            sessions.pop(session_id, None)


@app.get("/health")
async def health():
    return {"status": "ok", "active_sessions": len(sessions)}
