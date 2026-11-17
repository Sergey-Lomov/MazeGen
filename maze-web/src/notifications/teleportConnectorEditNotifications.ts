import { registerNotificationCode } from "./notificationRegistry";
import { notify } from "./notificationStore";
import * as m from "~/paraglide/messages";

export const TELEPORT_CONNECTOR_ENDPOINT_CANNOT_BE_REMOVED = "image_export.teleport_connector.endpoint_cannot_be_removed";

registerNotificationCode(TELEPORT_CONNECTOR_ENDPOINT_CANNOT_BE_REMOVED, {
  severity: "warning",
  message: () => m[TELEPORT_CONNECTOR_ENDPOINT_CANNOT_BE_REMOVED](),
});

export function notifyTeleportConnectorEndpointCannotBeRemoved(): void {
  notify({ source: "image_export", code: TELEPORT_CONNECTOR_ENDPOINT_CANNOT_BE_REMOVED });
}
