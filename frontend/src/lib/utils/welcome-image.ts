/** Decode and resize imports before storing them in synced preferences. */
export async function importWelcomeImage(file: File, kind: 'background' | 'icon'): Promise<string> {
  if (
    !['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/svg+xml'].includes(file.type)
  ) {
    throw new Error('Choose a PNG, JPG, WebP, GIF, or SVG image.');
  }
  if (file.size > 10_000_000) throw new Error('Choose an image smaller than 10 MB.');
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    const limit = kind === 'icon' ? 128 : 1920;
    const scale = Math.min(1, limit / Math.max(image.naturalWidth, image.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Image import is unavailable. Please try again.');
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const source = canvas.toDataURL(kind === 'icon' ? 'image/png' : 'image/webp', 0.85);
    if (source.length > (kind === 'icon' ? 350_000 : 2_000_000)) {
      throw new Error('This image is too detailed to save. Try a smaller image.');
    }
    return source;
  } catch (error) {
    if (error instanceof Error && error.name !== 'EncodingError') throw error;
    throw new Error('This image could not be opened. Try another image.');
  } finally {
    URL.revokeObjectURL(url);
  }
}
