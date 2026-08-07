/** Triggers a browser download of a PNG blob — same Blob→ObjectURL→`<a download>`→revoke pattern
 * as `downloadProjectFile` (`store/projectExport/serialize.ts`). */
export function downloadPngExport(blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "maze-export.png";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
