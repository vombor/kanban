import { z } from "zod";
export const wakeNoticePresentationSchema = z.enum(["full", "compact", "hidden"]);
export const DEFAULT_WAKE_NOTICE_PRESENTATION = "compact" as const;
export type WakeNoticePresentation = z.infer<typeof wakeNoticePresentationSchema>;
