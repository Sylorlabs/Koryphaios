export type WelcomeTextColor = '#000000' | '#ffffff';

function parseHexColor(value: string): [number, number, number] | null {
  const hex = value.trim().replace(/^#/, '');
  const normalized = hex.length === 3 ? [...hex].map((channel) => channel + channel).join('') : hex;
  if (!/^[\da-f]{6}$/i.test(normalized)) return null;
  return [
    Number.parseInt(normalized.slice(0, 2), 16),
    Number.parseInt(normalized.slice(2, 4), 16),
    Number.parseInt(normalized.slice(4, 6), 16),
  ];
}

function linearChannel(channel: number): number {
  const normalized = channel / 255;
  return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
}

function luminance(rgb: [number, number, number]): number {
  return (
    0.2126 * linearChannel(rgb[0]) + 0.7152 * linearChannel(rgb[1]) + 0.0722 * linearChannel(rgb[2])
  );
}

/**
 * Selects the foreground with the better average WCAG contrast over a sampled
 * RGBA image. Image alpha and the user's image opacity are composited over the
 * actual surface first, so transparent pixels and brightness changes count.
 */
export function welcomeTextColorForPixels(
  rgba: ArrayLike<number>,
  imageOpacity: number,
  surfaceColor: string,
): WelcomeTextColor {
  const surface = parseHexColor(surfaceColor);
  if (!surface) return '#ffffff';
  if (rgba.length < 4) return luminance(surface) < 0.179 ? '#ffffff' : '#000000';
  const opacity = Math.max(0, Math.min(1, Number.isFinite(imageOpacity) ? imageOpacity : 0));
  let totalLuminance = 0;
  let pixelCount = 0;

  for (let index = 0; index + 3 < rgba.length; index += 4) {
    const alpha = (Math.max(0, Math.min(255, rgba[index + 3])) / 255) * opacity;
    const composite: [number, number, number] = [0, 1, 2].map((channel) =>
      Math.round(
        Math.max(0, Math.min(255, rgba[index + channel])) * alpha + surface[channel] * (1 - alpha),
      ),
    ) as [number, number, number];
    totalLuminance += luminance(composite);
    pixelCount += 1;
  }

  if (!pixelCount) return luminance(surface) < 0.179 ? '#ffffff' : '#000000';
  const average = totalLuminance / pixelCount;
  const blackContrast = (average + 0.05) / 0.05;
  const whiteContrast = 1.05 / (average + 0.05);
  return blackContrast >= whiteContrast ? '#000000' : '#ffffff';
}

/**
 * Transcript chrome (action buttons, timestamps, skill labels) sits directly
 * on the welcome background image, where the theme's muted text can be
 * unreadable. When a background resolved a text color, these keep the chrome
 * in the same black/white family; without a background the theme tokens win.
 */
export function feedChromeColors(textColor: WelcomeTextColor | undefined): {
  fg: string;
  fgHover: string;
  hoverBg: string;
} {
  if (textColor === '#000000') {
    return { fg: 'rgba(0, 0, 0, 0.82)', fgHover: '#000000', hoverBg: 'rgba(255, 255, 255, 0.55)' };
  }
  if (textColor === '#ffffff') {
    return { fg: 'rgba(255, 255, 255, 0.88)', fgHover: '#ffffff', hoverBg: 'rgba(0, 0, 0, 0.45)' };
  }
  return {
    fg: 'var(--color-text-muted)',
    fgHover: 'var(--color-text-primary)',
    hoverBg: 'var(--color-surface-2)',
  };
}
