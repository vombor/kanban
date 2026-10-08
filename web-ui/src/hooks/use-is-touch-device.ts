import { useMedia } from "@/utils/react-use";

// The primary pointer is a finger (phones, tablets). Touchscreen laptops keep
// their mouse as the primary pointer, so desktop-only UI stays as it is there.
const COARSE_POINTER_QUERY = "(pointer: coarse)";

export function useIsTouchDevice(): boolean {
	return useMedia(COARSE_POINTER_QUERY, false);
}
