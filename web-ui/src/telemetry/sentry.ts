import * as Sentry from "@sentry/react";

// Error reporting is opt-in: builds only send to Sentry when a DSN is supplied at build time.
const sentryDsn = import.meta.env.VITE_SENTRY_DSN?.trim();
const sentryEnvironment = import.meta.env.MODE;

let initialized = false;

export function initializeSentry(): void {
	if (!sentryDsn || initialized) {
		return;
	}

	Sentry.init({
		dsn: sentryDsn,
		environment: sentryEnvironment,
		release: `kanban@${__APP_VERSION__}`,
		sendDefaultPii: false,
		initialScope: {
			tags: {
				app: "kanban",
				runtime_surface: "web",
			},
		},
	});

	initialized = true;
}

export function isSentryEnabled(): boolean {
	return initialized;
}
