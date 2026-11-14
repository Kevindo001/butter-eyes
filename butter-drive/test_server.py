"""Tests for butter-drive (mock motors). Run: python3 -m pytest -q test_server.py"""
import asyncio
import json
import time

import pytest
import websockets

import server as S


def test_pin_truth_table_never_shorts_and_matches_notes():
    m = S.Motors(mock=True)
    fwd = m.pins_for("forward")
    # notes: forward = IN2 HIGH, IN1 LOW for every wheel
    for in1, in2 in S.WHEELS.values():
        assert fwd[in1] == 0 and fwd[in2] == 1
    for d in S.PATTERNS:
        lv = m.pins_for(d)
        assert len(lv) == 8
        for in1, in2 in S.WHEELS.values():
            assert not (lv[in1] and lv[in2]), f"{d}: IN1 and IN2 both high"
    assert all(v == 0 for v in m.pins_for("stop").values())


def test_rotations_are_opposite_sides():
    p = S.PATTERNS
    assert p["left"]["LF"] == -1 and p["left"]["RF"] == 1
    assert p["right"] == {k: -v for k, v in p["left"].items()}
    assert p["strafe_right"] == {k: -v for k, v in p["strafe_left"].items()}


async def _start():
    motors = S.Motors(mock=True)
    srv = S.Server(motors)
    wd = asyncio.create_task(srv.watchdog())
    ws_srv = await websockets.serve(srv.handler, "127.0.0.1", 0)
    port = ws_srv.sockets[0].getsockname()[1]
    return motors, srv, wd, ws_srv, f"ws://127.0.0.1:{port}"


async def _recv_type(ws, typ, timeout=2):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        m = json.loads(await asyncio.wait_for(ws.recv(), timeout))
        if m["type"] == typ:
            return m
    raise TimeoutError(typ)


def run(coro):
    return asyncio.run(coro)


def test_drive_ack_and_watchdog_stops_without_heartbeat():
    async def t():
        motors, srv, wd, ws_srv, url = await _start()
        async with websockets.connect(url) as ws:
            await ws.send(json.dumps({"cmd": "hello"}))
            assert (await _recv_type(ws, "hello"))["mock"] is True
            await ws.send(json.dumps({"cmd": "drive", "dir": "forward", "ttl": 300}))
            assert (await _recv_type(ws, "ack"))["dir"] == "forward"
            assert motors.state == "forward"
            t0 = time.monotonic()
            await _recv_type(ws, "watchdog", timeout=2)
            elapsed = time.monotonic() - t0
            assert motors.state == "stop"
            assert 0.25 <= elapsed <= 0.5, elapsed
        wd.cancel(); ws_srv.close()
    run(t())


def test_heartbeat_keeps_moving():
    async def t():
        motors, srv, wd, ws_srv, url = await _start()
        async with websockets.connect(url) as ws:
            for _ in range(10):  # 1.5 s of 150 ms heartbeats
                await ws.send(json.dumps({"cmd": "drive", "dir": "left", "ttl": 450}))
                await asyncio.sleep(0.15)
                assert motors.state == "left"
            assert [d for _, d in motors.history] == ["left"]
        wd.cancel(); ws_srv.close()
    run(t())


def test_ttl_is_capped():
    async def t():
        motors, srv, wd, ws_srv, url = await _start()
        async with websockets.connect(url) as ws:
            await ws.send(json.dumps({"cmd": "drive", "dir": "forward", "ttl": 60000}))
            await asyncio.sleep(1.3)
            assert motors.state == "stop"
        wd.cancel(); ws_srv.close()
    run(t())


def test_disconnect_stops_immediately():
    async def t():
        motors, srv, wd, ws_srv, url = await _start()
        ws = await websockets.connect(url)
        await ws.send(json.dumps({"cmd": "drive", "dir": "backward", "ttl": 1000}))
        await _recv_type(ws, "ack")
        await ws.close()
        await asyncio.sleep(0.1)
        assert motors.state == "stop"
        wd.cancel(); ws_srv.close()
    run(t())


def test_bad_direction_rejected():
    async def t():
        motors, srv, wd, ws_srv, url = await _start()
        async with websockets.connect(url) as ws:
            await ws.send(json.dumps({"cmd": "drive", "dir": "launch"}))
            m = await _recv_type(ws, "error")
            assert "bad dir" in m["error"]
            assert motors.state == "stop"
        wd.cancel(); ws_srv.close()
    run(t())


def test_left_rear_is_reversed_and_enable_pins_are_separate():
    assert S.WHEELS["LR"] == (16, 15)
    direction_pins = {p for pair in S.WHEELS.values() for p in pair}
    assert set(S.ENABLE_PINS) == {12, 35, 7, 32}
    assert not direction_pins & set(S.ENABLE_PINS)


def test_speed_command_clamps():
    async def t():
        motors, srv, wd, ws_srv, url = await _start()
        async with websockets.connect(url) as ws:
            await ws.send(json.dumps({"cmd": "speed", "value": 5}))
            assert (await _recv_type(ws, "speed"))["value"] == 1.0
            await ws.send(json.dumps({"cmd": "speed", "value": 0.01}))
            assert (await _recv_type(ws, "speed"))["value"] == 0.05
            await ws.send(json.dumps({"cmd": "speed", "value": "fast"}))
            assert "bad speed" in (await _recv_type(ws, "error"))["error"]
        wd.cancel(); ws_srv.close()
    run(t())
