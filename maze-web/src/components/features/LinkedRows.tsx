import { SelectRow } from "../SelectRow";
import { SliderRow } from "../SliderRow";
import { ColorRow } from "../ColorRow";
import { ToggleRow } from "../ToggleRow";
import { TextFieldRow } from "../TextFieldRow";
import { LinkStatusIcon } from "../LinkStatusIcon";
import { useLinkContext } from "./LinkContext";
import { useRef } from "react";
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

type SelectRowProps<T extends string> = Parameters<typeof SelectRow<T>>[0];
export function LinkedSelectRow<T extends string, P extends string>({ linkTarget, unsupportedHint, ...rest }: SelectRowProps<T> & { linkTarget: P | null; unsupportedHint?: string }) {
  const { links, registry, onSetLinkEnabled, onAddLink } = useLinkContext<P>();
  return (
    <SelectRow
      {...rest}
      resetButton={<LinkStatusIcon target={linkTarget} links={links} registry={registry} onSetLinkEnabled={onSetLinkEnabled} onAddLink={onAddLink} unsupportedHint={unsupportedHint} />}
    />
  );
}

type SliderRowProps = React.ComponentProps<typeof SliderRow>;
export function LinkedSliderRow<P extends string>({ linkTarget, unsupportedHint, ...rest }: SliderRowProps & { linkTarget: P | null; unsupportedHint?: string }) {
  const { links, registry, onSetLinkEnabled, onAddLink } = useLinkContext<P>();
  return (
    <SliderRow
      {...rest}
      resetButton={<LinkStatusIcon target={linkTarget} links={links} registry={registry} onSetLinkEnabled={onSetLinkEnabled} onAddLink={onAddLink} unsupportedHint={unsupportedHint} />}
    />
  );
}

type ColorRowProps = React.ComponentProps<typeof ColorRow>;
export function LinkedColorRow<P extends string>({ linkTarget, unsupportedHint, ...rest }: ColorRowProps & { linkTarget: P | null; unsupportedHint?: string }) {
  const { links, registry, onSetLinkEnabled, onAddLink } = useLinkContext<P>();
  // GitHub issue #666: a preview/commit tick while the picker is open disables the field's
  // incoming link as an override (correct for a real edit), but Cancel must leave the link's
  // enabled state exactly as it was when the picker opened — snapshotted here since the link may
  // already have been disabled by the time Cancel fires.
  const wasLinkEnabledRef = useRef(false);
  return (
    <ColorRow
      {...rest}
      onOpen={() => {
        wasLinkEnabledRef.current = linkTarget !== null && (links.find((l) => l.target === linkTarget)?.enabled ?? false);
      }}
      onCancel={() => {
        if (linkTarget !== null && wasLinkEnabledRef.current) onSetLinkEnabled(linkTarget, true);
      }}
      resetButton={<LinkStatusIcon target={linkTarget} links={links} registry={registry} onSetLinkEnabled={onSetLinkEnabled} onAddLink={onAddLink} unsupportedHint={unsupportedHint} />}
    />
  );
}

type ToggleRowProps = React.ComponentProps<typeof ToggleRow>;
export function LinkedToggleRow<P extends string>({ linkTarget, unsupportedHint, ...rest }: ToggleRowProps & { linkTarget: P | null; unsupportedHint?: string }) {
  const { links, registry, onSetLinkEnabled, onAddLink } = useLinkContext<P>();
  return (
    <ToggleRow
      {...rest}
      resetButton={<LinkStatusIcon target={linkTarget} links={links} registry={registry} onSetLinkEnabled={onSetLinkEnabled} onAddLink={onAddLink} unsupportedHint={unsupportedHint} />}
    />
  );
}

type TextFieldRowProps = React.ComponentProps<typeof TextFieldRow>;
export function LinkedTextFieldRow<P extends string>({ linkTarget, unsupportedHint, ...rest }: TextFieldRowProps & { linkTarget: P | null; unsupportedHint?: string }) {
  const { links, registry, onSetLinkEnabled, onAddLink } = useLinkContext<P>();
  return (
    <TextFieldRow
      {...rest}
      resetButton={<LinkStatusIcon target={linkTarget} links={links} registry={registry} onSetLinkEnabled={onSetLinkEnabled} onAddLink={onAddLink} unsupportedHint={unsupportedHint} />}
    />
  );
}
