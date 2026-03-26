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

export function createLogger(name: string): Logger {
	const prefix = `[${name}]`;
	return {
		debug(message, context?) {
			console.debug(`${prefix} ${message}${formatContext(context)}`);
		},
		info(message, context?) {
			console.info(`${prefix} ${message}${formatContext(context)}`);
		},
		warn(message, context?) {
			console.warn(`${prefix} ${message}${formatContext(context)}`);
		},
		error(message, context?) {
			console.error(`${prefix} ${message}${formatContext(context)}`);
		},
	};
}
