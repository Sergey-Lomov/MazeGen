export function readImageFile(file: File): Promise<{ dataUrl: string; width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("Failed to read image"));
    reader.onload = () => {
      const dataUrl = typeof reader.result === "string" ? reader.result : null;
      if (!dataUrl) {
        reject(new Error("Image file did not produce a data URL"));
        return;
      }
      const image = new Image();
      image.onload = () => {
        if (image.naturalWidth <= 0 || image.naturalHeight <= 0) {
          reject(new Error("Image has invalid dimensions"));
          return;
        }
        resolve({ dataUrl, width: image.naturalWidth, height: image.naturalHeight });
      };
      image.onerror = () => reject(new Error("Failed to decode image"));
      image.src = dataUrl;
    };
    reader.readAsDataURL(file);
  });
}
