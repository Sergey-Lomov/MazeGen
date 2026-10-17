import { screen } from "@testing-library/react";

/** Finds the accessible tooltip anchor by the text exposed through `aria-describedby`. */
export function getTooltipAnchor(content: string | RegExp): HTMLElement {
  const anchor = getTooltipAnchors(content)[0];
  if (!anchor) throw new Error(`Tooltip anchor not found: ${content}`);
  return anchor;
}

/** Returns every accessible tooltip anchor whose description contains `content`. */
export function getTooltipAnchors(content: string | RegExp): HTMLElement[] {
  return screen.getAllByTestId("tooltip-anchor").filter((candidate) => {
    const description = document.getElementById(candidate.getAttribute("aria-describedby") ?? "");
    return typeof content === "string" ? description?.textContent?.includes(content) : content.test(description?.textContent ?? "");
  });
}

/** Returns the interactive element wrapped by a tooltip. */
export function getTooltipControl(content: string | RegExp): HTMLElement {
  return getTooltipControlWithin(document.body, content);
}

/** Returns every interactive control with the same tooltip content. */
export function getTooltipControls(content: string | RegExp): HTMLElement[] {
  return screen.getAllByTestId("tooltip-anchor")
    .filter((candidate) => {
      const description = document.getElementById(candidate.getAttribute("aria-describedby") ?? "");
      return typeof content === "string" ? description?.textContent?.includes(content) : content.test(description?.textContent ?? "");
    })
    .map((anchor) => anchor.querySelector<HTMLElement>("button, [role='button']"))
    .filter((control): control is HTMLElement => control !== null);
}

/** Returns an interactive tooltip child within a specific row or panel. */
export function getTooltipControlWithin(container: HTMLElement, content: string | RegExp): HTMLElement {
  const anchor = Array.from(container.querySelectorAll<HTMLElement>("[data-testid='tooltip-anchor']")).find((candidate) => {
    const description = document.getElementById(candidate.getAttribute("aria-describedby") ?? "");
    return typeof content === "string" ? description?.textContent?.includes(content) : content.test(description?.textContent ?? "");
  });
  const control = anchor?.querySelector<HTMLElement>("button, [role='button']");
  if (!control) throw new Error(`Tooltip control not found: ${content}`);
  return control;
}
