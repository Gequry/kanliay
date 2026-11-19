"""
server.py - High-performance, low-latency Python 3.13 asyncio HTTP + RFC 6455 WebSocket server
for 'Kanli Ay' (2D Top-Down Dead by Daylight style Werewolf vs Villagers web game).

Features:
- Zero external dependencies (pure Python 3.13 stdlib)
- TCP_NODELAY enabled on all sockets for ultra-low latency (<2ms local RTT)
- Room-based multiplayer lobby with role preference resolution (1 Werewolf vs 4 Villagers)
- Automatic AI bot slot filling & host migration if the room host disconnects
- Binary-clean RFC 6455 WebSocket framing (handles fragmented frames, masks, pings, closes)
"""

import asyncio
import base64
import hashlib
import json
import mimetypes
import os
import random
import socket
import struct
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, List, Optional
from urllib.parse import unquote

ROOT = Path(__file__).resolve().parent
PUBLIC_DIR = ROOT / "public"
WS_MAGIC = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
ADMIN_PASS = os.environ.get("ADMIN_PASS", "admin123")
CUSTOM_SPRITES: Dict[str, str] = {}

mimetypes.add_type("application/javascript", ".js")
mimetypes.add_type("text/css", ".css")
mimetypes.add_type("image/png", ".png")
mimetypes.add_type("image/svg+xml", ".svg")


@dataclass
class Client:
    id: str
    reader: asyncio.StreamReader
    writer: asyncio.StreamWriter
    room_id: str = ""
    name: str = "Oyuncu"
    pref_role: str = "villager"  # "werewolf" | "villager" | "random"
    is_admin: bool = False
    ping_ms: int = 1
    connected: bool = True
    write_lock: asyncio.Lock = field(default_factory=asyncio.Lock)

    def to_lobby_dict(self) -> dict:
        return {
            "id": self.id,
            "name": self.name,
            "role": self.pref_role,
            "ping": self.ping_ms,
        }


@dataclass
class Room:
    id: str
    clients: Dict[str, Client] = field(default_factory=dict)
    host_id: Optional[str] = None
    in_game: bool = False
    seed: int = 0
    title: str = ""
    fill_bots: bool = True
    difficulty: str = "normal"

    def lobby_payload(self) -> dict:
        return {
            "t": "lobby",
            "room": self.id,
            "title": self.title or f"Oda {self.id}",
            "hostId": self.host_id,
            "inGame": self.in_game,
            "fillBots": self.fill_bots,
            "difficulty": self.difficulty,
            "players": [c.to_lobby_dict() for c in self.clients.values()],
        }

    def summary_dict(self) -> dict:
        host = self.clients.get(self.host_id or "")
        return {
            "id": self.id,
            "title": self.title or f"{host.name if host else 'Avcı'} Odası",
            "count": len(self.clients),
            "max": 5,
            "inGame": self.in_game,
            "fillBots": self.fill_bots,
            "hostName": host.name if host else "Kurucu",
        }


ROOMS: Dict[str, Room] = {}
ALL_CLIENTS: Dict[str, Client] = {}
CLIENT_COUNTER = 0


def next_client_id() -> str:
    global CLIENT_COUNTER
    CLIENT_COUNTER += 1
    return f"p{CLIENT_COUNTER}"


def sanitize_room(code: str) -> str:
    cleaned = "".join(ch for ch in (code or "KANLI-AY").upper() if ch.isalnum() or ch in "-_")
    return cleaned[:16] or "KANLI-AY"


def sanitize_name(name: str) -> str:
    cleaned = " ".join((name or "Avcı").strip().split())
    return cleaned[:18] or "Avcı"


def encode_ws_frame(payload: bytes, opcode: int = 0x1) -> bytes:
    """Encode an unmasked server-to-client RFC 6455 WebSocket frame."""
    header = bytearray()
    header.append(0x80 | (opcode & 0x0F))
    length = len(payload)
    if length < 126:
        header.append(length)
    elif length < 65536:
        header.append(126)
        header.extend(struct.pack("!H", length))
    else:
        header.append(127)
        header.extend(struct.pack("!Q", length))
    return bytes(header) + payload


async def ws_send_bytes(client: Client, payload: bytes, opcode: int = 0x1) -> None:
    if not client.connected:
        return
    frame = encode_ws_frame(payload, opcode)
    try:
        async with client.write_lock:
            if not client.connected:
                return
            client.writer.write(frame)
            await client.writer.drain()
    except Exception:
        client.connected = False


async def ws_send_json(client: Client, obj: dict) -> None:
    raw = json.dumps(obj, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    await ws_send_bytes(client, raw, opcode=0x1)


async def broadcast_room(room: Room, obj: dict, exclude_id: Optional[str] = None) -> None:
    if not room.clients:
        return
    raw = json.dumps(obj, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    tasks = [
        ws_send_bytes(c, raw, opcode=0x1)
        for cid, c in list(room.clients.items())
        if cid != exclude_id and c.connected
    ]
    if tasks:
        await asyncio.gather(*tasks, return_exceptions=True)


async def read_ws_frame(reader: asyncio.StreamReader) -> Optional[tuple]:
    """Read a single RFC 6455 frame. Returns (fin, opcode, payload) or None on EOF."""
    try:
        b1_b2 = await reader.readexactly(2)
    except (asyncio.IncompleteReadError, ConnectionError, OSError):
        return None

    b1, b2 = b1_b2[0], b1_b2[1]
    fin = (b1 & 0x80) != 0
    opcode = b1 & 0x0F
    masked = (b2 & 0x80) != 0
    length = b2 & 0x7F

    if length == 126:
        ext = await reader.readexactly(2)
        length = struct.unpack("!H", ext)[0]
    elif length == 127:
        ext = await reader.readexactly(8)
        length = struct.unpack("!Q", ext)[0]

    if length > 4 * 1024 * 1024:
        # Reject oversized frames (>4MB)
        return None

    mask_key = await reader.readexactly(4) if masked else None
    payload = await reader.readexactly(length) if length > 0 else b""

    if masked and mask_key:
        arr = bytearray(payload)
        for i in range(length):
            arr[i] ^= mask_key[i & 3]
        payload = bytes(arr)

    return fin, opcode, payload


def resolve_match_assignments(room: Room) -> List[dict]:
    """
    Assign final match roles for connected human players (1 Werewolf max, others Villagers).
    If >= 2 human players are in the room and nobody picked Werewolf, pick 1 human Werewolf
    unless fill_bots is True and all explicitly chose Villager? Actually in human-only mode
    (fill_bots=False) or when >=2 humans play, if nobody chose werewolf and fill_bots is False,
    always pick 1 human as Werewolf so the match can start fairly!
    """
    clients = list(room.clients.values())
    wolf_candidates = [c for c in clients if c.pref_role == "werewolf"]
    random_candidates = [c for c in clients if c.pref_role == "random"]

    chosen_wolf_id: Optional[str] = None
    if wolf_candidates:
        chosen_wolf_id = random.choice(wolf_candidates).id
    elif random_candidates and len(clients) >= 2:
        chosen_wolf_id = random.choice(random_candidates).id
    elif random_candidates and len(clients) == 1:
        chosen_wolf_id = random.choice(["werewolf", "villager"])
        if chosen_wolf_id == "werewolf":
            chosen_wolf_id = random_candidates[0].id
        else:
            chosen_wolf_id = None
    elif not room.fill_bots and len(clients) >= 2:
        # In human-only room without bots, 1 player must become the Werewolf
        chosen_wolf_id = random.choice(clients).id

    assignments = []
    for c in clients:
        final_role = "werewolf" if c.id == chosen_wolf_id else "villager"
        assignments.append({
            "id": c.id,
            "name": c.name,
            "role": final_role,
            "isBot": False,
        })
    return assignments


def rooms_list_payload() -> dict:
    return {
        "t": "rooms",
        "list": [r.summary_dict() for r in ROOMS.values() if r.clients],
    }


async def broadcast_rooms_list() -> None:
    if not ALL_CLIENTS:
        return
    raw = json.dumps(rooms_list_payload(), separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    tasks = [ws_send_bytes(c, raw, opcode=0x1) for c in list(ALL_CLIENTS.values()) if c.connected]
    if tasks:
        await asyncio.gather(*tasks, return_exceptions=True)


async def join_room(
    client: Client,
    room_code: str,
    name: str,
    role: str,
    title: Optional[str] = None,
    fill_bots: Optional[bool] = None,
) -> Room:
    await leave_room(client, notify_rooms=False)
    rid = sanitize_room(room_code)
    room = ROOMS.get(rid)
    if room is None:
        clean_name = sanitize_name(name)
        room = Room(
            id=rid,
            title=(title or f"{clean_name} Odası")[:28],
            fill_bots=True if fill_bots is None else bool(fill_bots),
        )
        ROOMS[rid] = room

    client.room_id = rid
    client.name = sanitize_name(name)
    client.pref_role = role if role in ("werewolf", "villager", "random") else "villager"

    room.clients[client.id] = client
    if room.host_id is None or room.host_id not in room.clients:
        room.host_id = client.id

    await ws_send_json(client, {
        "t": "welcome",
        "id": client.id,
        "room": room.id,
        "title": room.title,
        "hostId": room.host_id,
        "inGame": room.in_game,
        "fillBots": room.fill_bots,
        "difficulty": room.difficulty,
        "isAdmin": client.is_admin,
        "customSprites": CUSTOM_SPRITES,
        "players": [c.to_lobby_dict() for c in room.clients.values()],
    })
    await broadcast_room(room, room.lobby_payload(), exclude_id=client.id)
    await broadcast_rooms_list()
    return room


async def leave_room(client: Client, notify_rooms: bool = True) -> None:
    rid = client.room_id
    if not rid or rid not in ROOMS:
        client.room_id = ""
        return
    room = ROOMS[rid]
    room.clients.pop(client.id, None)
    client.room_id = ""

    if not room.clients:
        ROOMS.pop(rid, None)
        if notify_rooms:
            await broadcast_rooms_list()
        return

    if room.host_id == client.id:
        room.host_id = next(iter(room.clients.keys()))
        await broadcast_room(room, {
            "t": "host_changed",
            "hostId": room.host_id,
        })

    await broadcast_room(room, room.lobby_payload())
    if notify_rooms:
        await broadcast_rooms_list()


async def handle_ws_message(client: Client, text: str) -> None:
    try:
        msg = json.loads(text)
    except json.JSONDecodeError:
        return
    if not isinstance(msg, dict):
        return

    t = msg.get("t")

    if t == "p":
        # Low-latency RTT ping
        if isinstance(msg.get("rtt"), (int, float)):
            client.ping_ms = max(1, min(999, int(msg["rtt"])))
        await ws_send_json(client, {"t": "po", "ts": msg.get("ts", 0), "srv": time.time()})
        return

    if t == "list_rooms":
        await ws_send_json(client, rooms_list_payload())
        return

    if t == "admin_auth":
        ok = str(msg.get("pass", "")) == ADMIN_PASS
        if ok:
            client.is_admin = True
        await ws_send_json(client, {"t": "admin_ok", "ok": ok})
        return

    if t == "create_room":
        alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
        gen_code = "".join(random.choice(alphabet) for _ in range(6))
        while gen_code in ROOMS:
            gen_code = "".join(random.choice(alphabet) for _ in range(6))
        custom_code = str(msg.get("room", "")).strip()
        code = sanitize_room(custom_code) if custom_code else gen_code
        if code in ROOMS and ROOMS[code].clients:
            code = gen_code
        await join_room(
            client,
            code,
            str(msg.get("name", "Avcı")),
            str(msg.get("role", "villager")),
            title=str(msg.get("title", "")).strip() or None,
            fill_bots=bool(msg.get("fillBots", True)),
        )
        return

    if t == "join":
        await join_room(
            client,
            str(msg.get("room", "KANLI-AY")),
            str(msg.get("name", "Avcı")),
            str(msg.get("role", "villager")),
        )
        return

    room = ROOMS.get(client.room_id)
    if room is None:
        return

    if t == "role":
        role = msg.get("role", "villager")
        if role in ("werewolf", "villager", "random"):
            client.pref_role = role
            await broadcast_room(room, room.lobby_payload())
        return

    if t == "name":
        client.name = sanitize_name(str(msg.get("name", client.name)))
        await broadcast_room(room, room.lobby_payload())
        return

    if t == "room_settings":
        if client.id != room.host_id:
            return
        if "fillBots" in msg:
            room.fill_bots = bool(msg["fillBots"])
        if msg.get("difficulty") in ("normal", "hard"):
            room.difficulty = msg["difficulty"]
        await broadcast_room(room, room.lobby_payload())
        await broadcast_rooms_list()
        return

    if t == "start":
        if client.id != room.host_id:
            return
        room.in_game = True
        room.seed = random.randint(100000, 99999999)
        if "fillBots" in msg:
            room.fill_bots = bool(msg["fillBots"])
        if msg.get("difficulty") in ("normal", "hard"):
            room.difficulty = msg["difficulty"]
        assignments = resolve_match_assignments(room)
        payload = {
            "t": "started",
            "seed": room.seed,
            "hostId": room.host_id,
            "assignments": assignments,
            "fillBots": room.fill_bots,
            "difficulty": room.difficulty,
        }
        await broadcast_room(room, payload)
        await broadcast_rooms_list()
        return

    if t == "rematch":
        if client.id == room.host_id:
            room.in_game = False
            await broadcast_room(room, room.lobby_payload())
            await broadcast_rooms_list()
        return

    if t == "s":
        # Host broadcasts authoritative world snapshot at 30Hz
        if client.id == room.host_id:
            await broadcast_room(room, msg, exclude_id=client.id)
        return

    if t == "i":
        # Guest sends immediate input to host
        host = room.clients.get(room.host_id or "")
        if host and host.id != client.id:
            msg["from"] = client.id
            await ws_send_json(host, msg)
        return

    if t == "e":
        # Discrete gameplay events relayed across room
        msg["from"] = client.id
        await broadcast_room(room, msg, exclude_id=client.id)
        return

    if t == "admin_sprite":
        if not client.is_admin:
            return
        if msg.get("reset"):
            CUSTOM_SPRITES.clear()
            for r in ROOMS.values():
                await broadcast_room(r, {"t": "sprite_reset"})
            return
        key = msg.get("key")
        data_url = msg.get("dataUrl")
        if (
            key in ("werewolf", "villager", "totem", "cage", "ground")
            and isinstance(data_url, str)
            and data_url.startswith("data:image/")
            and len(data_url) < 2_000_000
        ):
            CUSTOM_SPRITES[key] = data_url
            for r in ROOMS.values():
                await broadcast_room(r, {"t": "sprite_sync", "sprites": {key: data_url}}, exclude_id=client.id)
        return


async def handle_websocket(client: Client) -> None:
    frag_opcode = 0
    frag_chunks: List[bytes] = []

    try:
        ALL_CLIENTS[client.id] = client
        while client.connected:
            frame = await read_ws_frame(client.reader)
            if frame is None:
                break
            fin, opcode, payload = frame

            if opcode == 0x8:  # Close
                await ws_send_bytes(client, b"", opcode=0x8)
                break
            if opcode == 0x9:  # Ping
                await ws_send_bytes(client, payload, opcode=0xA)
                continue
            if opcode == 0xA:  # Pong
                continue

            if opcode in (0x1, 0x2):
                if fin:
                    if opcode == 0x1:
                        await handle_ws_message(client, payload.decode("utf-8", errors="replace"))
                else:
                    frag_opcode = opcode
                    frag_chunks = [payload]
            elif opcode == 0x0:  # Continuation
                frag_chunks.append(payload)
                if fin:
                    full = b"".join(frag_chunks)
                    frag_chunks.clear()
                    if frag_opcode == 0x1:
                        await handle_ws_message(client, full.decode("utf-8", errors="replace"))
    finally:
        client.connected = False
        ALL_CLIENTS.pop(client.id, None)
        await leave_room(client)


async def send_http_response(
    writer: asyncio.StreamWriter,
    status: str,
    content_type: str,
    body: bytes,
    extra_headers: Optional[Dict[str, str]] = None,
) -> None:
    headers = [
        f"HTTP/1.1 {status}",
        f"Content-Type: {content_type}",
        f"Content-Length: {len(body)}",
        "Cache-Control: no-cache, no-store, must-revalidate",
        "Connection: close",
    ]
    if extra_headers:
        for k, v in extra_headers.items():
            headers.append(f"{k}: {v}")
    raw_head = ("\r\n".join(headers) + "\r\n\r\n").encode("ascii")
    writer.write(raw_head + body)
    await writer.drain()


def resolve_static_file(url_path: str) -> Optional[Path]:
    clean_path = unquote(url_path.split("?", 1)[0]).lstrip("/")
    if not clean_path:
        clean_path = "index.html"
    candidate = (PUBLIC_DIR / clean_path).resolve()
    try:
        candidate.relative_to(PUBLIC_DIR.resolve())
    except ValueError:
        return None
    if candidate.is_file():
        return candidate
    return None


async def handle_connection(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
    sock = writer.get_extra_info("socket")
    if sock is not None:
        try:
            sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        except OSError:
            pass

    try:
        head_bytes = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), timeout=10.0)
    except Exception:
        writer.close()
        return

    lines = head_bytes.decode("latin-1", errors="replace").split("\r\n")
    if not lines or " " not in lines[0]:
        writer.close()
        return

    parts = lines[0].split(" ")
    method = parts[0].upper()
    path = parts[1] if len(parts) > 1 else "/"

    headers: Dict[str, str] = {}
    for line in lines[1:]:
        if ":" in line:
            k, v = line.split(":", 1)
            headers[k.strip().lower()] = v.strip()

    # Check WebSocket upgrade on /ws
    if path.split("?", 1)[0] == "/ws" and headers.get("upgrade", "").lower() == "websocket":
        ws_key = headers.get("sec-websocket-key")
        if not ws_key:
            await send_http_response(writer, "400 Bad Request", "text/plain", b"Missing Sec-WebSocket-Key")
            writer.close()
            return

        accept = base64.b64encode(
            hashlib.sha1((ws_key + WS_MAGIC).encode("ascii")).digest()
        ).decode("ascii")

        handshake = (
            "HTTP/1.1 101 Switching Protocols\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            f"Sec-WebSocket-Accept: {accept}\r\n\r\n"
        ).encode("ascii")
        writer.write(handshake)
        await writer.drain()

        client = Client(id=next_client_id(), reader=reader, writer=writer)
        try:
            await handle_websocket(client)
        finally:
            try:
                writer.close()
            except Exception:
                pass
        return

    # Regular HTTP static file serving
    if method not in ("GET", "HEAD"):
        await send_http_response(writer, "405 Method Not Allowed", "text/plain", b"Method Not Allowed")
        writer.close()
        return

    if path == "/health":
        await send_http_response(writer, "200 OK", "application/json", b'{"ok":true}')
        writer.close()
        return

    file_path = resolve_static_file(path)
    if file_path is None:
        await send_http_response(writer, "404 Not Found", "text/plain; charset=utf-8", b"404 - Dosya Bulunamadi")
        writer.close()
        return

    ctype, _ = mimetypes.guess_type(str(file_path))
    if not ctype:
        ctype = "application/octet-stream"
    if ctype.startswith("text/") or ctype in ("application/javascript", "application/json"):
        ctype = f"{ctype}; charset=utf-8"

    data = b"" if method == "HEAD" else file_path.read_bytes()
    await send_http_response(writer, "200 OK", ctype, data)
    writer.close()


async def main() -> None:
    port = int(os.environ.get("PORT", "8080"))
    server = await asyncio.start_server(handle_connection, host="0.0.0.0", port=port, reuse_address=True)
    addrs = ", ".join(str(s.getsockname()) for s in server.sockets)
    print(f"[KANLI AY] Dusuk Gecikmeli WebSocket + HTTP Sunucusu calisiyor: http://localhost:{port} ({addrs})")
    print(f"[KANLI AY] Admin AI Gorsel Sifresi: {ADMIN_PASS}")
    async with server:
        await server.serve_forever()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\n[KANLI AY] Sunucu kapatildi.")
