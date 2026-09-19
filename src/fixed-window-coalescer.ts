export interface FixedWindowCoalescerOptions<T> {
	delayMs: number;
	dispatch: (value: T) => void | Promise<void>;
	onError?: (error: unknown) => void;
}

/**
 * Collapse every value received during a fixed window into one trailing
 * dispatch. The newest value wins. This avoids concurrent work for a burst of
 * notifications while ensuring a continuous stream is handled once per window.
 */
export function createFixedWindowCoalescer<T>({
	delayMs,
	dispatch,
	onError = () => undefined,
}: FixedWindowCoalescerOptions<T>): (value: T) => void {
	let timer: ReturnType<typeof setTimeout> | null = null;
	let pending: T | undefined;

	return (value: T) => {
		pending = value;
		if (timer) return;

		timer = setTimeout(() => {
			timer = null;
			const next = pending;
			pending = undefined;
			if (next === undefined) return;
			Promise.resolve(dispatch(next)).catch(onError);
		}, delayMs);
	};
}
