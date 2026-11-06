/**
 * Operational health checks with deduplicated, persistent alerting.
 *
 * Components report each attempt with ok()/fail(). A check becomes "failing"
 * after `failureThreshold` consecutive failures (or immediately for a
 * permanent failure such as a deleted OAuth client), which queues one alert.
 * While it stays failing, a reminder is queued every `reminderMs`; the first
 * success afterwards queues one recovery notice. A check with `maxSilenceMs`
 * also fails when no success has been seen for that long, which catches a
 * renewal loop that silently stopped running.
 *
 * Alerts that cannot be delivered (e.g. Hermes is down) stay queued in the
 * persisted state and are retried on every report and on the periodic tick.
 *
 * Alert text is built only from trusted constants and sanitized error codes;
 * never pass message content, tokens, or provider error bodies as `detail`.
 */

import { readFileSync, renameSync, writeFileSync } from "node:fs";
import type { Logger } from "./logger.js";

export interface HealthCheckDefinition {
	/** Human-readable name used in alert text. */
	title: string;
	/** What stops working while the check fails (one sentence). */
	impact: string;
	/** How to fix it (one sentence). */
	remedy: string;
	/** Fail the check when no success has been recorded for this long. */
	maxSilenceMs?: number;
	/** State wording in alerts (default "failing"), e.g. "due for renewal". */
	failingLabel?: string;
	/** Wording when the check clears (default "recovered"), e.g. "renewed". */
	recoveredLabel?: string;
}

export interface HealthAlert {
	check: string;
	kind: "failing" | "reminder" | "recovered";
	text: string;
}

export type AlertSender = (alert: HealthAlert) => Promise<boolean>;

interface CheckState {
	status: "ok" | "failing";
	consecutiveFailures: number;
	failingSince?: number;
	lastOkAt?: number;
	lastDetail?: string;
	lastAlertAt?: number;
	/** Whether a "failing" alert was actually delivered for this incident. */
	alerted?: boolean;
	pending?: HealthAlert["kind"];
}

export interface HealthMonitorOptions {
	statePath: string;
	checks: Record<string, HealthCheckDefinition>;
	send: AlertSender;
	logger: Logger;
	source: string;
	failureThreshold?: number;
	reminderMs?: number;
	now?: () => number;
}

export interface HealthMonitor {
	ok(check: string): void;
	fail(check: string, detail: string, options?: { permanent?: boolean }): void;
	/** Evaluate silence limits and retry queued alerts. */
	tick(): Promise<void>;
	/** Deliver queued alerts; resolves when the attempt finishes. */
	flush(): Promise<void>;
	state(check: string): Readonly<CheckState> | undefined;
}

const DETAIL_RE = /[^A-Za-z0-9 _.:()/=-]/g;

export function sanitizeDetail(detail: string): string {
	return detail.replace(DETAIL_RE, "").slice(0, 160);
}

function iso(ms: number | undefined): string {
	return ms === undefined
		? "unknown"
		: `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

export function createHealthMonitor(
	options: HealthMonitorOptions,
): HealthMonitor {
	const {
		statePath,
		checks,
		send,
		logger,
		source,
		failureThreshold = 2,
		reminderMs = 86_400_000,
		now = () => Date.now(),
	} = options;

	let states: Record<string, CheckState> = {};
	try {
		states = JSON.parse(readFileSync(statePath, "utf-8")) as Record<
			string,
			CheckState
		>;
	} catch {
		states = {};
	}

	function get(check: string): CheckState {
		if (!checks[check]) throw new Error(`Unknown health check: ${check}`);
		states[check] ??= { status: "ok", consecutiveFailures: 0 };
		return states[check];
	}

	function save(): void {
		try {
			const tmp = `${statePath}.tmp`;
			writeFileSync(tmp, JSON.stringify(states), { mode: 0o600 });
			renameSync(tmp, statePath);
		} catch (error) {
			logger.warn("Could not persist health alert state", {
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	function render(check: string, state: CheckState): HealthAlert {
		const def = checks[check];
		const kind = state.pending ?? "failing";
		const label = def.failingLabel ?? "failing";
		if (kind === "recovered") {
			return {
				check,
				kind,
				text: `✅ ${source}: ${def.title} ${def.recoveredLabel ?? "recovered"} (was ${label} since ${iso(state.failingSince)}).`,
			};
		}
		const lead = kind === "reminder" ? "🚨 Still:" : "🚨";
		return {
			check,
			kind,
			text:
				`${lead} ${source}: ${def.title} ${label} since ${iso(state.failingSince)}` +
				` (${state.lastDetail ?? "unknown error"}). ${def.impact} Fix: ${def.remedy}`,
		};
	}

	let flushing: Promise<void> | undefined;
	async function deliver(): Promise<void> {
		for (const [check, state] of Object.entries(states)) {
			if (!state.pending || !checks[check]) continue;
			const alert = render(check, state);
			let delivered = false;
			try {
				delivered = await send(alert);
			} catch {
				delivered = false;
			}
			if (!delivered) {
				logger.warn("Health alert not delivered; will retry", {
					check,
					kind: alert.kind,
				});
				continue;
			}
			logger.info("Health alert delivered", { check, kind: alert.kind });
			// A newer transition may have replaced the pending alert while we
			// were sending; only clear the one we delivered.
			if (state.pending === alert.kind) state.pending = undefined;
			state.lastAlertAt = now();
			state.alerted = alert.kind !== "recovered";
			save();
		}
	}

	function flush(): Promise<void> {
		flushing ??= deliver().finally(() => {
			flushing = undefined;
		});
		return flushing;
	}

	function fail(
		check: string,
		detail: string,
		opts: { permanent?: boolean } = {},
	): void {
		const state = get(check);
		state.consecutiveFailures++;
		state.lastDetail = sanitizeDetail(detail) || "unknown error";
		if (
			state.status === "ok" &&
			(opts.permanent || state.consecutiveFailures >= failureThreshold)
		) {
			state.status = "failing";
			state.failingSince = now();
			state.alerted = false;
			state.pending = "failing";
			logger.error("Health check failing", {
				check,
				detail: state.lastDetail,
			});
		} else if (
			state.status === "failing" &&
			!state.pending &&
			state.alerted &&
			now() - (state.lastAlertAt ?? 0) >= reminderMs
		) {
			state.pending = "reminder";
		}
		save();
		void flush();
	}

	function ok(check: string): void {
		const state = get(check);
		const wasFailing = state.status === "failing";
		state.status = "ok";
		state.consecutiveFailures = 0;
		state.lastOkAt = now();
		if (wasFailing) {
			logger.info("Health check recovered", { check });
			// Only announce recovery for an incident that was announced.
			state.pending = state.alerted ? "recovered" : undefined;
			state.alerted = false;
		}
		save();
		if (state.pending) void flush();
	}

	async function tick(): Promise<void> {
		for (const [check, def] of Object.entries(checks)) {
			if (!def.maxSilenceMs) continue;
			const state = get(check);
			// Start the silence clock at first observation so a fresh install
			// doesn't alert before the first scheduled attempt.
			state.lastOkAt ??= now();
			if (now() - state.lastOkAt >= def.maxSilenceMs) {
				const hours = Math.round(def.maxSilenceMs / 3_600_000);
				fail(check, `no success in ${hours}h`, { permanent: true });
			}
		}
		save();
		await flush();
	}

	return {
		ok,
		fail,
		tick,
		flush,
		state: (check) => states[check],
	};
}

/** Extract a safe OAuth error code (e.g. "deleted_client") from a response body. */
export async function oauthErrorCode(res: Response): Promise<string> {
	try {
		const body = (await res.json()) as { error?: unknown };
		if (typeof body.error === "string" && /^[a-z_]{1,40}$/.test(body.error)) {
			return body.error;
		}
	} catch {
		// fall through
	}
	return `HTTP ${res.status}`;
}

/** Token-endpoint errors that will not fix themselves on retry. */
export function isPermanentOAuthError(code: string): boolean {
	return [
		"deleted_client",
		"invalid_client",
		"invalid_grant",
		"unauthorized_client",
		"disabled_client",
	].includes(code);
}
