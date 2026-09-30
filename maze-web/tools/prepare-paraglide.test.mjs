import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getInputFingerprint, needsPreparation } from "./prepare-paraglide.mjs";

const temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function createProject() {
  const root = mkdtempSync(join(tmpdir(), "mazegen-paraglide-"));
  temporaryDirectories.push(root);
  mkdirSync(join(root, "messages"), { recursive: true });
  mkdirSync(join(root, "project.inlang"), { recursive: true });
  mkdirSync(join(root, "node_modules", "@inlang", "paraglide-js"), { recursive: true });
  writeFileSync(join(root, "messages", "en.json"), '{"hello":"Hello"}');
  writeFileSync(join(root, "project.inlang", "settings.json"), '{"baseLocale":"en"}');
  writeFileSync(join(root, "package.json"), '{"dependencies":{"@inlang/paraglide-js":"2.19.0"}}');
  writeFileSync(join(root, "package-lock.json"), '{"lockfileVersion":3}');
  writeFileSync(join(root, "node_modules", "@inlang", "paraglide-js", "package.json"), '{"version":"2.19.0"}');
  return root;
}

describe("Paraglide preparation inputs", () => {
  it("keeps a stable fingerprint when inputs are unchanged", () => {
    const root = createProject();
    expect(getInputFingerprint(root)).toBe(getInputFingerprint(root));
  });

  it("changes the fingerprint when translations, settings, or the package changes", () => {
    const root = createProject();
    const initial = getInputFingerprint(root);

    writeFileSync(join(root, "messages", "en.json"), '{"hello":"Hi"}');
    expect(getInputFingerprint(root)).not.toBe(initial);

    const afterTranslation = getInputFingerprint(root);
    writeFileSync(join(root, "project.inlang", "settings.json"), '{"baseLocale":"ru"}');
    expect(getInputFingerprint(root)).not.toBe(afterTranslation);

    const afterSettings = getInputFingerprint(root);
    writeFileSync(join(root, "node_modules", "@inlang", "paraglide-js", "package.json"), '{"version":"2.20.0"}');
    expect(getInputFingerprint(root)).not.toBe(afterSettings);
  });
});

describe("needsPreparation", () => {
  it("prepares when the fingerprint is stale or generated output is missing", () => {
    expect(needsPreparation({ cachedFingerprint: "old", fingerprint: "new", generatedOutputExists: true })).toBe(true);
    expect(needsPreparation({ cachedFingerprint: "same", fingerprint: "same", generatedOutputExists: false })).toBe(true);
  });

  it("skips preparation when the fingerprint and generated output are current", () => {
    expect(needsPreparation({ cachedFingerprint: "same", fingerprint: "same", generatedOutputExists: true })).toBe(false);
  });
});
