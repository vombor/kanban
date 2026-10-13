// The tags of ghcr.io/vombor/kanban a pod can follow (`update.imageChannel` in config.json). Zod only: the config
// schema imports it, and that schema is in the web-ui's typecheck of the app router's import graph, which must not reach
// src/update/container-image.ts (test/runtime/trpc/app-router-web-ui-graph.test.ts).
import { z } from "zod";

/** `latest` (every fork/stack push and the daily rebuild) and `stable` (the last release). */
export const KANBAN_IMAGE_CHANNELS = ["latest", "stable"] as const;
export const imageChannelSchema = z.enum(KANBAN_IMAGE_CHANNELS);
export type KanbanImageChannel = z.infer<typeof imageChannelSchema>;
export const DEFAULT_KANBAN_IMAGE_CHANNEL: KanbanImageChannel = "latest";
