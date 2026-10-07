const DIRECTORY_PICKER_UNAVAILABLE_MARKERS = [
	"could not open directory picker",
	'install "zenity" or "kdialog"',
	'install powershell ("powershell" or "pwsh")',
	'command "osascript" is not available',
] as const;

/** True when the native folder picker can't run here (headless Linux, no zenity/kdialog, ...). */
export function isDirectoryPickerUnavailableError(message: string | null | undefined): boolean {
	if (!message) {
		return false;
	}
	const normalized = message.trim().toLowerCase();
	if (!normalized) {
		return false;
	}
	return DIRECTORY_PICKER_UNAVAILABLE_MARKERS.some((marker) => normalized.includes(marker));
}
