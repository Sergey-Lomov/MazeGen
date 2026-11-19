import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const sourceRoot = fileURLToPath(new URL("../src/", import.meta.url));
const sharedComponent = "components/SearchInput.tsx";
const migratedConsumers = [
  "components/DebugEventTree.tsx",
  "components/FontPickerPanel.tsx",
  "components/features/ParameterLinksPicker.tsx",
  "components/features/PostEditChangesPanel.tsx",
];

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.isFile() && path.endsWith(".tsx") ? [path] : [];
  }));
  return nested.flat();
}

const files = await sourceFiles(sourceRoot);
const violations = [];

for (const file of files) {
  const name = relative(sourceRoot, file).replaceAll("\\", "/");
  if (name.startsWith("test/")) continue;
  const source = await readFile(file, "utf8");
  if (name === sharedComponent) continue;

  if (/type\s*=\s*["']search["']/i.test(source)) {
    violations.push(`${name}: native type=\"search\" is forbidden; use SearchInput.`);
  }

  const rawSearchInput = /<input\b[^>]*(?:search|query|filter)[^>]*>/i;
  if (rawSearchInput.test(source)) {
    violations.push(`${name}: search/filter input must use SearchInput instead of a raw <input>.`);
  }

  if (/<SearchInput\b[^>]*(?:inputStyle|clearLabel|debounceMs)\s*=/i.test(source)) {
    violations.push(`${name}: SearchInput owns its visual treatment, clear label, and debounce policy.`);
  }
}

for (const consumer of migratedConsumers) {
  const source = await readFile(join(sourceRoot, consumer), "utf8");
  if (!source.includes('SearchInput') || !source.includes("<SearchInput")) {
    violations.push(`${consumer}: expected to use the shared SearchInput.`);
  }
}

if (violations.length > 0) {
  console.error("Search-input architecture check failed:\n" + violations.map((message) => `- ${message}`).join("\n"));
  process.exit(1);
}
