export interface Logger {
	debug(message: string, context?: Record<string, unknown>): void;
	info(message: string, context?: Record<string, unknown>): void;
	warn(message: string, context?: Record<string, unknown>): void;
	error(message: string, context?: Record<string, unknown>): void;
}

function formatContext(context?: Record<string, unknown>): string {
	if (!context || Object.keys(context).length === 0) return "";
	const parts = Object.entries(context).map(
		([k, v]) => `${k}=${JSON.stringify(v)}`,
	);
	return ` ${parts.join(" ")}`;
}

function timestamp(): string {
	return new Date().toISOString().replace("T", " ").replace("Z", "");
}

export function createLogger(name: string): Logger {
	const prefix = `[${name}]`;
	return {
		debug(message, context?) {
			console.debug(
				`${timestamp()} ${prefix} ${message}${formatContext(context)}`,
			);
		},
		info(message, context?) {
			console.info(
				`${timestamp()} ${prefix} ${message}${formatContext(context)}`,
			);
		},
		warn(message, context?) {
			console.warn(
				`${timestamp()} ${prefix} ${message}${formatContext(context)}`,
			);
		},
		error(message, context?) {
			console.error(
				`${timestamp()} ${prefix} ${message}${formatContext(context)}`,
			);
		},
	};
}
