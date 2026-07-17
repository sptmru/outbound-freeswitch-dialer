import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { format, resolveConfig } from "prettier";
import { createGenerator } from "ts-json-schema-generator";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputPath = resolve(repoRoot, "apps/api/src/generated/shared-openapi-schemas.json");
const checkOnly = process.argv.includes("--check");

const generated = createGenerator({
  path: resolve(repoRoot, "packages/shared/src/index.ts"),
  tsconfig: resolve(repoRoot, "packages/shared/tsconfig.json"),
  type: "*",
  expose: "export"
}).createSchema("*");

const definitions = generated.definitions ?? {};
const names = new Map();
let generatedIndex = 0;
for (const name of Object.keys(definitions).sort()) {
  names.set(name, /^[A-Za-z][A-Za-z0-9]*$/.test(name) ? name : `GeneratedSchema${++generatedIndex}`);
}

function normalize(value) {
  if (Array.isArray(value)) return value.map(normalize);
  if (!value || typeof value !== "object") return value;

  const normalized = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === "$schema") continue;
    if (key === "$ref" && typeof child === "string" && child.startsWith("#/definitions/")) {
      const originalName = decodeURIComponent(child.slice("#/definitions/".length));
      normalized[key] = `${names.get(originalName) ?? originalName}#`;
      continue;
    }
    if (key === "$ref" && typeof child === "string" && child.endsWith("#")) {
      const originalName = decodeURIComponent(child.slice(0, -1));
      normalized[key] = `${names.get(originalName) ?? originalName}#`;
      continue;
    }
    normalized[key] = normalize(child);
  }
  return normalized;
}

const schemas = Object.fromEntries(
  Object.entries(definitions).map(([name, schema]) => {
    const normalizedName = names.get(name);
    return [normalizedName, { $id: normalizedName, ...normalize(schema) }];
  })
);
const prettierConfig = (await resolveConfig(outputPath)) ?? {};
const output = await format(JSON.stringify(schemas), { ...prettierConfig, parser: "json" });

if (checkOnly) {
  let current = "";
  try {
    current = readFileSync(outputPath, "utf8");
  } catch {
    // Report the same actionable error for a missing or stale generated file.
  }
  if (current !== output) {
    console.error(
      "Generated OpenAPI schemas are stale. Run: npm --workspace @outbound-dialer/api run openapi:generate"
    );
    process.exitCode = 1;
  }
} else {
  writeFileSync(outputPath, output);
  console.log(`Generated ${Object.keys(schemas).length} OpenAPI component schemas.`);
}
