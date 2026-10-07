"""The deadline of a request to an address somebody typed holds for the head of the answer too: a server that sends a
header line every second (or every half second) is cut off at the deadline, not after the last line. Against a real
socket on this machine, not a stand-in transport: the deadline lives in the socket."""

from __future__ import annotations

import socket
import threading
import time
from collections.abc import Iterator

import pytest

from app.services import outbound


@pytest.fixture
def trickler() -> Iterator[tuple[int, list[float]]]:
    """A server that answers with a status line and then a header line every ``pause`` seconds, for 30 seconds."""
    server = socket.socket()
    server.bind(("127.0.0.1", 0))
    server.listen(4)
    pause: list[float] = [1.0]
    stop = threading.Event()

    def serve() -> None:
        server.settimeout(0.2)
        while not stop.is_set():
            try:
                connection, _ = server.accept()
            except OSError:
                continue
            with connection:
                try:
                    connection.recv(4096)
                    connection.sendall(b"HTTP/1.1 200 OK\r\n")
                    end = time.monotonic() + 30
                    number = 0
                    while time.monotonic() < end and not stop.is_set():
                        time.sleep(pause[0])
                        number += 1
                        connection.sendall(f"X-Line-{number}: drip\r\n".encode())
                except OSError:
                    pass

    thread = threading.Thread(target=serve, daemon=True)
    thread.start()
    yield server.getsockname()[1], pause
    stop.set()
    server.close()
    thread.join(5)


@pytest.mark.parametrize("pause", [1.8, 1.0, 0.4])
def test_a_head_that_trickles_ends_at_the_deadline(trickler: tuple[int, list[float]], pause: float) -> None:
    port, pauses = trickler
    pauses[0] = pause
    place = outbound.Target(urls=(f"http://127.0.0.1:{port}/api/server/ping",), host="127.0.0.1",
                            named=f"127.0.0.1:{port}", scheme="http", port=port, addresses=("127.0.0.1",))
    started = time.monotonic()
    with outbound.client(None) as session, pytest.raises(outbound.Late):
        outbound.send(session, "GET", place, {}, deadline=started + 2.5, ticks=time.monotonic, limit=1024,
                      connect_seconds=2)
    took = time.monotonic() - started
    # At the deadline itself, not one waiting read later (a line every 1.8 s would end at 3.6 s then).
    assert took < 3.1, f"the request ran {took:.1f} s against a deadline of 2.5 s"


def test_without_a_request_running_the_sockets_wait_as_asked() -> None:
    """Outside ``send`` nothing is cut short: the deadline belongs to the request of this thread only."""
    assert outbound._bounded(5.0) == 5.0
    assert outbound._bounded(None) is None
