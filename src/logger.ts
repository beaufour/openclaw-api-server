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
	const fmt = (message: string, context?: Record<string, unknown>) =>
		`${timestamp()} ${prefix} ${message}${formatContext(context)}`;
	return {
		debug(message, context?) {
			console.log(fmt(message, context));
		},
		info(message, context?) {
			console.log(fmt(message, context));
		},
		// warn/error go to BOTH stdout (the main StandardOutPath log) and stderr
		// (the .err.log). console.warn/error alone only reach stderr, which made
		// operational lines like dropped-mail reasons and credential errors
		// invisible when tailing the main log.
		warn(message, context?) {
			const line = fmt(message, context);
			console.log(line);
			console.error(line);
		},
		error(message, context?) {
			const line = fmt(message, context);
			console.log(line);
			console.error(line);
		},
	};
}
