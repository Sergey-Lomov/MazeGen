import { OtherContextToggle, WithOtherContextOverrides } from "./OtherContextOverrides";
import { SelectRow } from "../SelectRow";
import type { LinkPath } from "../../store/parameterLinkSchema";
import { SliderRow } from "../SliderRow";
import { ColorRow, UnregisteredColorRow } from "../ColorRow";
import { FontRow } from "../FontRow";
import { ToggleRow } from "../ToggleRow";
import { TextFieldRow } from "../TextFieldRow";
import { LinkStatusIcon } from "../LinkStatusIcon";
import { useLinkContext } from "./LinkContext";
import { useRef } from "react";
import { Trash2 } from "lucide-react";
import { FlatIconButton } from "../FlatIconButton";
import { Tooltip } from "../Tooltip";
import * as m from "~/paraglide/messages";
import type React from "react";

/** `SelectRow`/`SliderRow`/`ColorRow`/`ToggleRow`/`TextFieldRow` wrappers (GitHub issue #652
 *  follow-up) that always render a `LinkStatusIcon` as the row's trailing `resetButton`, reading
 *  `links`/`registry`/`onSetLinkEnabled`/`onAddLink` from the nearest `LinkContextProvider`
 *  (`LinkContext.tsx`) instead of taking them as props — every call site only ever adds one new
 *  prop, `linkTarget`. `linkTarget: P` for a field that's in the mode's `ParamDescriptor` registry
 *  (the icon then reflects and edits that field's actual link state); `linkTarget: null` for a
 *  field that isn't (dropdown fields with no enum type modeled yet, plain toggles, etc. — the icon
 *  then always renders in its "unsupported" state, see `LinkStatusIcon`'s own doc comment). These
 *  are the only call sites `VectorByWallsSettingsPanel`/`VectorByCorridorsSettingsPanel` and their
 *  subsections should use for a field row that needs a link-status icon at all — which, per that
 *  issue, is every field row in those two panels. Every other prop passes straight through to the
 *  underlying row unchanged. */

/** A linked row exists only while the schema reports its field as active (`activePaths`, built by
 *  `useExportPanelModel` from `LINK_SCHEMA`'s rules, GitHub issue #927) — the panels carry no copy of a
 *  linked field's visibility condition. A row with `linkTarget: null` has no schema entry and always shows. */
function useIsLinkedRowShown(linkTarget: string | null): boolean {
  const { activePaths } = useLinkContext<string>();
  return linkTarget === null || activePaths.has(linkTarget);
}

interface ZoneRow {
  disabled: boolean;
  reset: React.ReactNode;
  /** Turns the link driving the row's parameter on or off for the zone; absent while the zone cannot set the parameter. */
  toggleLink?: (enabled: boolean) => void;
}

/** How a row behaves in the zone context (GitHub issue #1040): the link icon turns read-only and a "back to the global value"
 *  button joins it while the zone sets the parameter itself, and a parameter the zone cannot set is disabled. `editable: false`
 *  marks a control that has no zone editor at all. `null` outside the zone context. */
function useZoneRow(linkTarget: string | null, editable = true, zonePath?: string): ZoneRow | null {
  const { zone } = useLinkContext<string>();
  if (!zone) return null;
  // A row with no link of its own (`zonePath`) is still settable by the zone, only without a link to turn on or off.
  const path = linkTarget ?? zonePath ?? null;
  const canEdit = editable && path !== null && zone.canOverride(path);
  const reset = canEdit && zone.overridden.has(path)
    ? <FlatIconButton title={m["image_export.zone_context.delete_param"]()} onClick={() => zone.reset(path)}><Trash2 size={16} /></FlatIconButton>
    : null;
  const toggleLink = canEdit && linkTarget !== null ? (enabled: boolean) => zone.toggleLink(linkTarget, enabled) : undefined;
  return { disabled: !canEdit, reset, toggleLink };
}

/** The trailing controls of a linked row: the link icon, which inside a zone context only switches its link on or off for the
 *  zone (the link system itself cannot be reconfigured there), followed by the "delete the zone's value" button while the zone
 *  sets the parameter itself. */
function RowTrailing<P extends string>({ linkTarget, unsupportedHint, zoneRow, zonePath }: { linkTarget: P | null; unsupportedHint?: string; zoneRow: ZoneRow | null; zonePath?: string }) {
  return <><LinkIcon linkTarget={linkTarget} unsupportedHint={unsupportedHint} readOnly={zoneRow !== null} zoneToggle={zoneRow?.toggleLink} />{zoneRow?.reset}<OtherContextToggle linkTarget={linkTarget ?? zonePath ?? null} /></>;
}

/** Explains over a row disabled by the zone context why it is. */
function ZoneRowHint({ zoneRow, linkTarget, children }: { zoneRow: { disabled: boolean } | null; linkTarget: string | null; children: React.ReactNode }) {
  const row = zoneRow?.disabled ? <Tooltip content={m["image_export.zone_context.global_only"]()} block>{children}</Tooltip> : <>{children}</>;
  return <WithOtherContextOverrides linkTarget={linkTarget}>{row}</WithOtherContextOverrides>;
}

/** The trailing link-status icon of a linked row, wired to the nearest `LinkContextProvider`. */
function LinkIcon<P extends string>({ linkTarget, unsupportedHint, readOnly, zoneToggle }: { linkTarget: P | null; unsupportedHint?: string; readOnly?: boolean; zoneToggle?: (enabled: boolean) => void }) {
  const { links, registry, onSetLinkEnabled, onAddLink, activePaths } = useLinkContext<P>();
  return <LinkStatusIcon target={linkTarget} links={links} registry={registry} onSetLinkEnabled={onSetLinkEnabled} onAddLink={onAddLink} unsupportedHint={unsupportedHint} activePaths={activePaths} readOnly={readOnly} zoneToggle={zoneToggle} />;
}

type SelectRowProps<T extends string> = Parameters<typeof SelectRow<T>>[0];
export function LinkedSelectRow<T extends string, P extends LinkPath>({ linkTarget, unsupportedHint, zonePath, ...rest }: SelectRowProps<T> & { linkTarget: P | null; unsupportedHint?: string; zonePath?: string }) {
  const shown = useIsLinkedRowShown(linkTarget);
  const zoneRow = useZoneRow(linkTarget, true, zonePath);
  if (!shown) return null;
  return (
    <ZoneRowHint zoneRow={zoneRow} linkTarget={linkTarget ?? zonePath ?? null}>
      <SelectRow
        {...rest}
        disabled={rest.disabled || zoneRow?.disabled}
        resetButton={<RowTrailing linkTarget={linkTarget} unsupportedHint={unsupportedHint} zoneRow={zoneRow} zonePath={zonePath} />}
      />
    </ZoneRowHint>
  );
}

type SliderRowProps = React.ComponentProps<typeof SliderRow>;
export function LinkedSliderRow<P extends LinkPath>({ linkTarget, unsupportedHint, ...rest }: SliderRowProps & { linkTarget: P | null; unsupportedHint?: string }) {
  const shown = useIsLinkedRowShown(linkTarget);
  const zoneRow = useZoneRow(linkTarget);
  if (!shown) return null;
  return (
    <ZoneRowHint zoneRow={zoneRow} linkTarget={linkTarget}>
      <SliderRow
        {...rest}
        disabled={rest.disabled || zoneRow?.disabled}
        resetButton={<RowTrailing linkTarget={linkTarget} unsupportedHint={unsupportedHint} zoneRow={zoneRow} />}
      />
    </ZoneRowHint>
  );
}

/** Cancel of a color picker in a zone context (GitHub issue #1097): preview ticks write the zone's own value, so a
 *  parameter the zone did not set before the picker opened must lose it again, not keep the original color as an override. */
function useZoneOverrideRestore(linkTarget: string | null): { onOpen: () => void; onCancel: () => void } {
  const { zone } = useLinkContext<string>();
  const wasOverridden = useRef(false);
  return {
    onOpen: () => {
      wasOverridden.current = linkTarget !== null && (zone?.overridden.has(linkTarget) ?? false);
    },
    onCancel: () => {
      if (zone && linkTarget !== null && !wasOverridden.current) zone.reset(linkTarget);
    },
  };
}

type ColorRowProps = React.ComponentProps<typeof ColorRow>;
export function LinkedColorRow<P extends LinkPath>({ linkTarget, unsupportedHint, ...rest }: ColorRowProps & { linkTarget: P | null; unsupportedHint?: string }) {
  const { links, onSetLinkEnabled } = useLinkContext<P>();
  const shown = useIsLinkedRowShown(linkTarget);
  const zoneRow = useZoneRow(linkTarget);
  // GitHub issue #666: a preview/commit tick while the picker is open disables the field's
  // incoming link as an override (correct for a real edit), but Cancel must leave the link's
  // enabled state exactly as it was when the picker opened � snapshotted here since the link may
  // already have been disabled by the time Cancel fires. A zone context never touches the links.
  const wasLinkEnabledRef = useRef(false);
  const zoneRestore = useZoneOverrideRestore(linkTarget);
  if (!shown) return null;
  return (
    <ZoneRowHint zoneRow={zoneRow} linkTarget={linkTarget}>
      <ColorRow
        {...rest}
        disabled={rest.disabled || zoneRow?.disabled}
        onOpen={() => {
          wasLinkEnabledRef.current = linkTarget !== null && (links.find((l) => l.target === linkTarget)?.enabled ?? false);
          zoneRestore.onOpen();
        }}
        onCancel={() => {
          if (!zoneRow && linkTarget !== null && wasLinkEnabledRef.current) onSetLinkEnabled(linkTarget, true);
          zoneRestore.onCancel();
        }}
        resetButton={<RowTrailing linkTarget={linkTarget} unsupportedHint={unsupportedHint} zoneRow={zoneRow} />}
      />
    </ZoneRowHint>
  );
}

type FontRowProps = React.ComponentProps<typeof FontRow>;
/** Font-picker row with a link-status icon. Like `LinkedColorRow` (GitHub issue #666): a preview tick
 *  disables the field's incoming link as an override, so Cancel re-enables it when it was enabled on open. A font has
 *  no zone editor yet, so the zone context disables it. */
export function LinkedFontRow<P extends LinkPath>({ linkTarget, unsupportedHint, ...rest }: FontRowProps & { linkTarget: P | null; unsupportedHint?: string }) {
  const { links, onSetLinkEnabled } = useLinkContext<P>();
  const shown = useIsLinkedRowShown(linkTarget);
  const zoneRow = useZoneRow(linkTarget, false);
  const wasLinkEnabledRef = useRef(false);
  if (!shown) return null;
  return (
    <ZoneRowHint zoneRow={zoneRow} linkTarget={linkTarget}>
      <FontRow
        {...rest}
        disabled={rest.disabled || zoneRow?.disabled}
        onOpen={() => {
          wasLinkEnabledRef.current = linkTarget !== null && (links.find((l) => l.target === linkTarget)?.enabled ?? false);
          rest.onOpen?.();
        }}
        onCancel={() => {
          if (linkTarget !== null && wasLinkEnabledRef.current) onSetLinkEnabled(linkTarget, true);
          rest.onCancel?.();
        }}
        resetButton={<RowTrailing linkTarget={linkTarget} unsupportedHint={unsupportedHint} zoneRow={zoneRow} />}
      />
    </ZoneRowHint>
  );
}

/** Link-status variant for a colour that is intentionally not a project-colour field. */
type UnregisteredColorRowProps = React.ComponentProps<typeof UnregisteredColorRow>;
export function LinkedUnregisteredColorRow<P extends string>({ linkTarget, unsupportedHint, ...rest }: UnregisteredColorRowProps & { linkTarget: P | null; unsupportedHint?: string }) {
  const { links, onSetLinkEnabled } = useLinkContext<P>();
  const zoneRow = useZoneRow(linkTarget);
  const wasLinkEnabledRef = useRef(false);
  const zoneRestore = useZoneOverrideRestore(linkTarget);
  return (
    <ZoneRowHint zoneRow={zoneRow} linkTarget={linkTarget}>
      <UnregisteredColorRow
        {...rest}
        disabled={rest.disabled || zoneRow?.disabled}
        onOpen={() => {
          wasLinkEnabledRef.current = linkTarget !== null && (links.find((l) => l.target === linkTarget)?.enabled ?? false);
          zoneRestore.onOpen();
        }}
        onCancel={() => {
          if (!zoneRow && linkTarget !== null && wasLinkEnabledRef.current) onSetLinkEnabled(linkTarget, true);
          zoneRestore.onCancel();
        }}
        resetButton={<RowTrailing linkTarget={linkTarget} unsupportedHint={unsupportedHint} zoneRow={zoneRow} />}
      />
    </ZoneRowHint>
  );
}

type ToggleRowProps = React.ComponentProps<typeof ToggleRow>;
export function LinkedToggleRow<P extends LinkPath>({ linkTarget, unsupportedHint, zonePath, ...rest }: ToggleRowProps & { linkTarget: P | null; unsupportedHint?: string; zonePath?: string }) {
  const shown = useIsLinkedRowShown(linkTarget);
  const zoneRow = useZoneRow(linkTarget, true, zonePath);
  if (!shown) return null;
  return (
    <ZoneRowHint zoneRow={zoneRow} linkTarget={linkTarget ?? zonePath ?? null}>
      <ToggleRow
        {...rest}
        disabled={rest.disabled || zoneRow?.disabled}
        resetButton={<RowTrailing linkTarget={linkTarget} unsupportedHint={unsupportedHint} zoneRow={zoneRow} zonePath={zonePath} />}
      />
    </ZoneRowHint>
  );
}

type TextFieldRowProps = React.ComponentProps<typeof TextFieldRow>;
export function LinkedTextFieldRow<P extends LinkPath>({ linkTarget, unsupportedHint, ...rest }: TextFieldRowProps & { linkTarget: P | null; unsupportedHint?: string }) {
  const shown = useIsLinkedRowShown(linkTarget);
  const zoneRow = useZoneRow(linkTarget);
  if (!shown) return null;
  return (
    <ZoneRowHint zoneRow={zoneRow} linkTarget={linkTarget}>
      <TextFieldRow
        {...rest}
        disabled={rest.disabled || zoneRow?.disabled}
        resetButton={<RowTrailing linkTarget={linkTarget} unsupportedHint={unsupportedHint} zoneRow={zoneRow} />}
      />
    </ZoneRowHint>
  );
}
