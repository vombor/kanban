// Writes models/vetted.schema.json from the registry's zod schema (src/models/vetted-registry.ts). A test fails when
// the committed file is out of date: run `npx tsx scripts/write-vetted-schema.ts` after changing the schema.
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { buildVettedRegistryJsonSchema } from "../src/models/vetted-registry";

const path = join(dirname(fileURLToPath(import.meta.url)), "..", "models", "vetted.schema.json");
writeFileSync(path, `${JSON.stringify(buildVettedRegistryJsonSchema(), null, "\t")}\n`);
process.stdout.write(`wrote ${path}\n`);
