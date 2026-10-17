import { useEffect, useState } from "react";
import type { RuntimeConfigResponse } from "@/runtime/types";

type Presentation = NonNullable<RuntimeConfigResponse["wakeNoticePresentation"]>;
export function useWakeNoticePresentationDraft(open: boolean, config: RuntimeConfigResponse | null) {
	const initial = config?.wakeNoticePresentation ?? "compact";
	const [presentation, setPresentation] = useState<Presentation>(initial);
	useEffect(() => {
		setPresentation(open ? initial : "compact");
	}, [open, initial]);
	return { presentation, setPresentation, dirty: presentation !== initial };
}
