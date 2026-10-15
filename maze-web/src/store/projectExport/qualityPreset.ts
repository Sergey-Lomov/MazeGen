import type { MazeState } from "../mazeStore";
import type { CheckDescriptor, StrategyDescriptor } from "../../wasm/types";
import { serializeQuality, downloadJsonFile } from "./serialize";
import {
  QUALITY_PRESET_KIND,
  QUALITY_PRESET_VERSION,
  QUALITY_PRESET_FILE_EXTENSION,
  VISUAL_PRESET_KIND,
  FileKindMismatchError,
  looksLikeProjectFile,
  type ProjectFileNestedStrategy,
  type ProjectFileQuality,
  type QualityPresetFile,
} from "./types";
import { assertObject, assertNumber } from "./validatePrimitives";
import { validateQuality } from "./validateSections";

export function serializeQualityPreset(state: MazeState): QualityPresetFile {
  return { kind: QUALITY_PRESET_KIND, version: QUALITY_PRESET_VERSION, quality: serializeQuality(state) };
}

/** Validates a quality preset file. Keys missing in older presets fall back to defaults through
 *  the same validator as the project file's `quality` section; any shape error throws, so a
 *  malformed file is never partially applied. A project or visual preset file passed by mistake
 *  raises `FileKindMismatchError`. */
export function parseQualityPreset(raw: unknown): QualityPresetFile {
  const obj = assertObject(raw, "root");
  if (obj.kind !== QUALITY_PRESET_KIND) {
    if (obj.kind === VISUAL_PRESET_KIND) throw new FileKindMismatchError("quality_preset", "visual_preset");
    if (looksLikeProjectFile(obj)) throw new FileKindMismatchError("quality_preset", "project");
    throw new Error("Not a quality preset file");
  }
  const version = assertNumber(obj.version, "version");
  if (version > QUALITY_PRESET_VERSION)
    throw new Error(`Quality preset version ${version} is newer than supported (${QUALITY_PRESET_VERSION})`);
  return {
    kind: QUALITY_PRESET_KIND,
    version: QUALITY_PRESET_VERSION,
    quality: validateQuality(obj.quality, "quality"),
  };
}

/** Identifiers a loaded quality preset referenced but this build doesn't know (removed or renamed
 *  checks, strategies, nested-strategy slots or issue kinds, or ones from a newer build). Each id
 *  is listed once; a nested slot is listed as `<parent strategy id>.<slot id>`. */
export interface SkippedQualityIds {
  checks: string[];
  strategies: string[];
  nestedSlots: string[];
  issueKinds: string[];
}

/** Drops every reference the registry doesn't know, collecting the skipped ids for a warning:
 *  - an unknown check is removed from its rule, and a rule left without checks by that removal is
 *    dropped (and scrubbed from its stage) — same as `loadRegistry`'s reload filter; a rule saved
 *    with no checks at all stays;
 *  - a rule whose issue kind no check or strategy handles is dropped;
 *  - an unknown top-level strategy becomes "no fix";
 *  - a nested strategy entry with an unknown strategy, or in a slot its parent strategy doesn't
 *    declare, is removed with its own nested chain;
 *  - params of unknown strategies are dropped from `strategyParams` (not reported). */
export function dropUnknownQualityIds(
  quality: ProjectFileQuality,
  checks: readonly CheckDescriptor[],
  strategies: readonly StrategyDescriptor[],
): { quality: ProjectFileQuality; skipped: SkippedQualityIds } {
  const knownChecks = new Set(checks.map((c) => c.id));
  const strategiesById = new Map(strategies.map((s) => [s.id, s]));
  const knownKinds = new Set([...checks.flatMap((c) => c.issue_kinds), ...strategies.map((s) => s.handles)]);
  const skipped = { checks: new Set<string>(), strategies: new Set<string>(), nestedSlots: new Set<string>(), issueKinds: new Set<string>() };

  const knownStrategy = (id: string) => {
    if (strategiesById.has(id)) return true;
    skipped.strategies.add(id);
    return false;
  };
  const filterNested = (parentId: string, nested: ProjectFileNestedStrategy[]): ProjectFileNestedStrategy[] => {
    const slots = new Set(strategiesById.get(parentId)?.nested_slots.map((d) => d.slot_id) ?? []);
    return nested
      .filter((n) => {
        if (slots.has(n.slotId)) return true;
        skipped.nestedSlots.add(`${parentId}.${n.slotId}`);
        return false;
      })
      .filter((n) => knownStrategy(n.strategyId))
      .map((n) => ({ ...n, nested: filterNested(n.strategyId, n.nested) }));
  };

  const rules = quality.rules.flatMap((rule) => {
    const ruleChecks = rule.checks.filter((c) => {
      if (knownChecks.has(c.typeId)) return true;
      skipped.checks.add(c.typeId);
      return false;
    });
    if (rule.checks.length > 0 && ruleChecks.length === 0) return [];
    if (!knownKinds.has(rule.kind)) {
      skipped.issueKinds.add(rule.kind);
      return [];
    }
    const strategyId = rule.strategyId !== null && knownStrategy(rule.strategyId) ? rule.strategyId : null;
    return [{ ...rule, checks: ruleChecks, strategyId, nestedStrategies: strategyId === null ? [] : filterNested(strategyId, rule.nestedStrategies) }];
  });
  const ruleIds = new Set(rules.map((r) => r.id));
  const strategyParams = Object.fromEntries(
    Object.entries(quality.strategyParams).filter(([id]) => strategiesById.has(id)),
  );

  return {
    quality: {
      ...quality,
      rules,
      stages: quality.stages.map((s) => ({ ...s, ruleIds: s.ruleIds.filter((id) => ruleIds.has(id)) })),
      strategyParams,
    },
    skipped: {
      checks: [...skipped.checks],
      strategies: [...skipped.strategies],
      nestedSlots: [...skipped.nestedSlots],
      issueKinds: [...skipped.issueKinds],
    },
  };
}

/** Every skipped id of `skipped`, flattened in a stable order for the load warning. */
export function skippedQualityIdList(skipped: SkippedQualityIds): string[] {
  return [...skipped.checks, ...skipped.strategies, ...skipped.nestedSlots, ...skipped.issueKinds];
}

/** Registry state `prepareQualityPresetLoad` checks ids against. */
export interface QualityRegistry {
  registryLoaded: boolean;
  availableChecks: readonly CheckDescriptor[];
  availableStrategies: readonly StrategyDescriptor[];
}

/** Parses a picked quality preset and drops ids unknown to `registry`, so the result can be
 *  applied with `loadQualityPreset` in one step. Throws on any parse error (nothing to apply).
 *  Before the registry loads there is nothing to check ids against, so they are kept as is. */
export function prepareQualityPresetLoad(raw: unknown, registry: QualityRegistry): { quality: ProjectFileQuality; skipped: string[] } {
  const { quality } = parseQualityPreset(raw);
  if (!registry.registryLoaded) return { quality, skipped: [] };
  const result = dropUnknownQualityIds(quality, registry.availableChecks, registry.availableStrategies);
  return { quality: result.quality, skipped: skippedQualityIdList(result.skipped) };
}

export function downloadQualityPresetFile(state: MazeState): void {
  downloadJsonFile(serializeQualityPreset(state), `maze-quality-preset${QUALITY_PRESET_FILE_EXTENSION}`);
}
