import { registerNotificationCode } from "../notifications/notificationRegistry";
import * as m from "~/paraglide/messages";

/** Source and codes of every error toast raised while loading a project file. Registered here, in
 *  one place, because they come from both the file picker (`FeaturesPanel`) and the store
 *  (`loadProject`). */
export const PROJECT_LOAD_SOURCE = "project_load";

export const PROJECT_LOAD_CODES = {
  invalid: "project.load_error",
  qualityPreset: "project.load_error_quality_preset",
  visualPreset: "project.load_error_visual_preset",
  engineNotLoaded: "project.load_error_engine_not_loaded",
} as const;

for (const code of Object.values(PROJECT_LOAD_CODES)) {
  registerNotificationCode(code, { severity: "error", message: () => m[code]() });
}
