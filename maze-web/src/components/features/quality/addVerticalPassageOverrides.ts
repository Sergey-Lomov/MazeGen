const PARAM_ONE_WAY_BALANCE = "one_way_balance";
const PARAM_DIRECTION_BALANCE = "direction_balance";

/** Forced value + disabled state for `add_vertical_passage`'s `one_way_balance`/
 * `direction_balance` sliders, driven by the rule-level `passage_type` param (see GitHub issue
 * #253's rule-level-param mechanism, and the follow-up promoting `passage_type` to rule level for
 * the vertical-passage-add rule). The rule-level `passage_type` already tells the strategy exactly
 * which kind of passage to add, so once it picks anything but "Any" the sliders stop being a real
 * choice — they're locked to the value the strategy will actually use, not left at a stale
 * user-set number that no longer reflects what gets added. */
export interface AddVerticalPassageOverrides {
  /** Overrides to merge on top of the raw slider values before rendering — empty when `passage_type`
   * is "Any" (both sliders stay fully user-controlled). */
  values: Record<string, string>;
  disabledIds: Set<string>;
}

export function addVerticalPassageOverrides(passageType: string | undefined): AddVerticalPassageOverrides {
  switch (passageType) {
    case "two_way":
      return {
        values: { [PARAM_ONE_WAY_BALANCE]: "0", [PARAM_DIRECTION_BALANCE]: "0.5" },
        disabledIds: new Set([PARAM_ONE_WAY_BALANCE, PARAM_DIRECTION_BALANCE]),
      };
    case "one_way":
      return {
        values: { [PARAM_ONE_WAY_BALANCE]: "1" },
        disabledIds: new Set([PARAM_ONE_WAY_BALANCE]),
      };
    case "one_way_down":
      return {
        values: { [PARAM_ONE_WAY_BALANCE]: "1", [PARAM_DIRECTION_BALANCE]: "0" },
        disabledIds: new Set([PARAM_ONE_WAY_BALANCE, PARAM_DIRECTION_BALANCE]),
      };
    case "one_way_up":
      return {
        values: { [PARAM_ONE_WAY_BALANCE]: "1", [PARAM_DIRECTION_BALANCE]: "1" },
        disabledIds: new Set([PARAM_ONE_WAY_BALANCE, PARAM_DIRECTION_BALANCE]),
      };
    default:
      return { values: {}, disabledIds: new Set() };
  }
}

