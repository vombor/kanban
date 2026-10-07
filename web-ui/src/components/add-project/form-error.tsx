import { AlertTriangle } from "lucide-react";
import type { ReactElement } from "react";

/** A server or validation error shown inside the add-project dialog. */
export function FormError({ message }: { message: string | null }): ReactElement | null {
	if (!message) {
		return null;
	}
	return (
		<div
			role="alert"
			className="flex items-start gap-2 rounded-md border border-status-red/30 bg-status-red/5 px-3 py-2 text-[13px] text-text-primary break-words"
		>
			<AlertTriangle size={14} className="mt-0.5 shrink-0 text-status-red" />
			<span>{message}</span>
		</div>
	);
}
