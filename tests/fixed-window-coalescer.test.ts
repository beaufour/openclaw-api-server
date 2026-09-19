import { afterEach, describe, expect, it, vi } from "vitest";

import { createFixedWindowCoalescer } from "../src/fixed-window-coalescer.js";

describe("createFixedWindowCoalescer", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("turns a burst into one trailing dispatch with the newest value", async () => {
		vi.useFakeTimers();
		const dispatch = vi.fn();
		const schedule = createFixedWindowCoalescer({
			delayMs: 15_000,
			dispatch,
		});

		schedule({ historyId: "first" });
		schedule({ historyId: "second" });
		expect(dispatch).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(14_999);
		expect(dispatch).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(1);
		expect(dispatch).toHaveBeenCalledOnce();
		expect(dispatch).toHaveBeenCalledWith({ historyId: "second" });
	});

	it("opens a new window after the prior dispatch", async () => {
		vi.useFakeTimers();
		const dispatch = vi.fn();
		const schedule = createFixedWindowCoalescer({
			delayMs: 100,
			dispatch,
		});

		schedule(1);
		await vi.advanceTimersByTimeAsync(100);
		schedule(2);
		await vi.advanceTimersByTimeAsync(100);

		expect(dispatch.mock.calls).toEqual([[1], [2]]);
	});
});
