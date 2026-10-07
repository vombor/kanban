/// <reference types="vite/client" />

declare const __APP_VERSION__: string;

interface ImportMetaEnv {
	/** Sentry DSN for browser error reports. Unset by default, so nothing is sent. */
	readonly VITE_SENTRY_DSN?: string;
}

interface ImportMeta {
	readonly env: ImportMetaEnv;
}
