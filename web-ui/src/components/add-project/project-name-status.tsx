import { AlertTriangle, Check, GitBranch } from "lucide-react";
import type { ReactElement } from "react";

import { cn } from "@/components/ui/cn";
import { Spinner } from "@/components/ui/spinner";
import type { ProjectNameCheckStatus } from "@/hooks/use-project-name-check";

/** The typeahead's answer under a project name field. */
export function ProjectNameStatus({
	status,
	path,
}: {
	status: ProjectNameCheckStatus;
	path: string;
}): ReactElement | null {
	if (status.kind === "idle") {
		return null;
	}
	const { tone, icon, text } = describeStatus(status, path);
	return (
		<p
			role="status"
			data-testid="project-name-status"
			data-status={status.kind}
			className={cn(
				"mt-1.5 mb-0 flex items-start gap-1.5 text-[12px] break-all",
				tone === "ok" && "text-status-green",
				tone === "warn" && "text-status-orange",
				tone === "muted" && "text-text-secondary",
			)}
		>
			<span className="mt-0.5 shrink-0">{icon}</span>
			<span>{text}</span>
		</p>
	);
}

function describeStatus(
	status: Exclude<ProjectNameCheckStatus, { kind: "idle" }>,
	path: string,
): { tone: "ok" | "warn" | "muted"; icon: ReactElement; text: string } {
	switch (status.kind) {
		case "checking":
			return { tone: "muted", icon: <Spinner size={12} />, text: `Checking ${path}…` };
		case "available":
			return { tone: "ok", icon: <Check size={12} />, text: `${path} is available.` };
		case "exists-empty":
			return { tone: "ok", icon: <Check size={12} />, text: `${path} exists and is empty; it will be used.` };
		case "exists":
			return status.isGitRepository
				? {
						tone: "warn",
						icon: <GitBranch size={12} />,
						text: `${path} already exists and is a git repository. Use "Open folder" to add it.`,
					}
				: {
						tone: "warn",
						icon: <AlertTriangle size={12} />,
						text: `${path} already exists and is not empty. Pick another name, or use "Open folder" to add it.`,
					};
		case "invalid":
		case "error":
			return { tone: "warn", icon: <AlertTriangle size={12} />, text: status.message };
	}
}
