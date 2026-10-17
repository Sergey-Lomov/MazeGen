import { useNotificationStore } from "../notifications/notificationStore";

/** `source/code` of every error card, oldest first. */
export function errorCards(): string[] {
  return useNotificationStore.getState().errors.map((c) => `${c.source}/${c.code}`);
}

/** `details` of the latest occurrence of the error card with `code`. */
export function errorDetails(code: string): string | undefined {
  const card = useNotificationStore.getState().errors.find((c) => c.code === code);
  return card?.occurrences[card.occurrences.length - 1].details;
}

/** `source/code` of every visible and queued notice. */
export function noticeCodes(): string[] {
  const { notices, queue } = useNotificationStore.getState();
  return [...notices, ...queue].map((n) => `${n.source}/${n.code}`);
}

/** Params of the visible or queued notice with `code`. */
export function noticeParams(code: string): Readonly<Record<string, string | number | boolean | null>> | undefined {
  const { notices, queue } = useNotificationStore.getState();
  return [...notices, ...queue].find((n) => n.code === code)?.params;
}
