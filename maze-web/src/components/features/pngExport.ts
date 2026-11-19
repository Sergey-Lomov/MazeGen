/** Triggers a browser download of a PNG blob — same Blob→ObjectURL→`<a download>`→revoke pattern
 * as `downloadProjectFile` (`store/projectExport/serialize.ts`). */
export function downloadPngExport(blob: Blob, fileName = "maze-export.png"): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
