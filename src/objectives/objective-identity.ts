import { createHash } from "node:crypto";
export const objectiveDigest = (value: string): string => createHash("sha256").update(value).digest("hex");
