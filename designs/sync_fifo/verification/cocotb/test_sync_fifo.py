"""cocotb regression for the sync_fifo golden-path design.

The design configuration is passed in the FIFO_CONFIG environment variable as
JSON (WIDTH, DEPTH, RESET, ALLOW_WRITE_WHEN_FULL_WITH_READ). Every test names
the requirement IDs it covers in its docstring as ``Covers: REQ-...`` so the
traceability matrix can be built from this file.

Timing convention: inputs are driven and outputs sampled on the falling edge,
so the design is observed between rising edges, after all registers settle.
"""

from __future__ import annotations

import json
import os
import random
from collections import deque

import cocotb
from cocotb.clock import Clock
from cocotb.triggers import FallingEdge, RisingEdge

CONFIG = json.loads(os.environ.get("FIFO_CONFIG", "{}"))
WIDTH = int(CONFIG.get("WIDTH", 8))
DEPTH = int(CONFIG.get("DEPTH", 16))
RESET = CONFIG.get("RESET", "sync_active_low")
ALLOW_RW_FULL = bool(CONFIG.get("ALLOW_WRITE_WHEN_FULL_WITH_READ", True))
SEED = int(os.environ.get("FIFO_SEED", "20261023"))
MASK = (1 << WIDTH) - 1


class Model:
    """Reference model written from the interface contract."""

    def __init__(self) -> None:
        self.items: deque[int] = deque()

    @property
    def full(self) -> bool:
        return len(self.items) == DEPTH

    @property
    def empty(self) -> bool:
        return not self.items

    def step(self, wr: bool, data: int, rd: bool) -> tuple[bool, bool]:
        rd_acc = rd and not self.empty
        wr_acc = wr and (not self.full or (ALLOW_RW_FULL and rd_acc))
        if rd_acc:
            self.items.popleft()
        if wr_acc:
            self.items.append(data)
        return wr_acc, rd_acc


def reset_handle(dut):
    return dut.rst_n if RESET.endswith("active_low") else dut.rst


async def start(dut) -> Model:
    cocotb.start_soon(Clock(dut.clk, 10, unit="ns").start())
    rst = reset_handle(dut)
    active = 0 if RESET.endswith("active_low") else 1
    dut.wr_en.value = 0
    dut.rd_en.value = 0
    dut.wr_data.value = 0
    rst.value = active
    for _ in range(3):
        await RisingEdge(dut.clk)
    await FallingEdge(dut.clk)
    rst.value = 1 - active
    return Model()


def check_outputs(dut, model: Model) -> None:
    assert int(dut.empty.value) == int(model.empty), (
        f"empty={int(dut.empty.value)} but model holds {len(model.items)} items"
    )
    assert int(dut.full.value) == int(model.full), (
        f"full={int(dut.full.value)} but model holds {len(model.items)} of {DEPTH} items"
    )
    assert int(dut.count.value) == len(model.items), (
        f"count={int(dut.count.value)} but model holds {len(model.items)} items"
    )
    if not model.empty:
        assert int(dut.rd_data.value) == model.items[0], (
            f"rd_data=0x{int(dut.rd_data.value):x}, expected oldest item 0x{model.items[0]:x}"
        )


async def cycle(dut, model: Model, wr: bool = False, data: int = 0, rd: bool = False) -> tuple[bool, bool]:
    check_outputs(dut, model)
    dut.wr_en.value = int(wr)
    dut.wr_data.value = data & MASK
    dut.rd_en.value = int(rd)
    await RisingEdge(dut.clk)
    accepted = model.step(wr, data & MASK, rd)
    await FallingEdge(dut.clk)
    dut.wr_en.value = 0
    dut.rd_en.value = 0
    check_outputs(dut, model)
    return accepted


@cocotb.test()
async def test_reset_state(dut):
    """After reset the FIFO is empty, not full, and reports zero items.

    Covers: REQ-RST-001, REQ-FUNC-002
    """
    model = await start(dut)
    check_outputs(dut, model)


@cocotb.test()
async def test_single_write_read(dut):
    """One item written is the item read back.

    Covers: REQ-FUNC-001
    """
    model = await start(dut)
    await cycle(dut, model, wr=True, data=0xA5)
    await cycle(dut, model, rd=True)
    assert model.empty


@cocotb.test()
async def test_order_fill_drain(dut):
    """Filling to capacity and draining preserves order and flags.

    Covers: REQ-FUNC-001, REQ-FUNC-002, REQ-FUNC-003, REQ-FUNC-004
    """
    model = await start(dut)
    for i in range(DEPTH):
        await cycle(dut, model, wr=True, data=(i * 37 + 11))
    assert model.full
    for _ in range(DEPTH):
        await cycle(dut, model, rd=True)
    assert model.empty


@cocotb.test()
async def test_overflow_ignored(dut):
    """A write while full (without a read) is ignored and stored data is kept.

    Covers: REQ-FUNC-003
    """
    model = await start(dut)
    for i in range(DEPTH):
        await cycle(dut, model, wr=True, data=i)
    wr_acc, _ = await cycle(dut, model, wr=True, data=0x5A)
    assert not wr_acc
    for _ in range(DEPTH):
        await cycle(dut, model, rd=True)


@cocotb.test()
async def test_underflow_ignored(dut):
    """A read while empty is ignored and does not corrupt later traffic.

    Covers: REQ-FUNC-004
    """
    model = await start(dut)
    _, rd_acc = await cycle(dut, model, rd=True)
    assert not rd_acc
    await cycle(dut, model, wr=True, data=0x3C)
    await cycle(dut, model, rd=True)


@cocotb.test()
async def test_simultaneous_read_write(dut):
    """Same-cycle read and write follow the documented rules when empty, partly full and full.

    Covers: REQ-FUNC-005
    """
    model = await start(dut)
    await cycle(dut, model, wr=True, data=1, rd=True)  # empty: only the write is accepted
    await cycle(dut, model, wr=True, data=2, rd=True)  # partial: both accepted
    while not model.full:
        await cycle(dut, model, wr=True, data=len(model.items) + 3)
    await cycle(dut, model, wr=True, data=0x77, rd=True)  # full: depends on ALLOW_RW_FULL
    while not model.empty:
        await cycle(dut, model, rd=True)


@cocotb.test()
async def test_random_scoreboard(dut):
    """Seeded random traffic checked cycle by cycle against the reference model.

    Covers: REQ-FUNC-001, REQ-FUNC-002, REQ-FUNC-003, REQ-FUNC-004, REQ-FUNC-005
    """
    rng = random.Random(SEED)
    dut._log.info("random seed %d", SEED)
    model = await start(dut)
    for _ in range(2000):
        await cycle(dut, model, wr=rng.random() < 0.55, data=rng.getrandbits(WIDTH), rd=rng.random() < 0.45)
