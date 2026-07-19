export const LUXURY_CINEMATIC_CONFIG = {
  splitEase: "0.77,0,0.175,1",
  loaderDuration: 1.05,
  headingDuration: 1.2,
  headingStagger: 0.14,
  mediaDuration: 1.15,
  parallaxPercent: 15,
  mediaStart: "top 86%",
  collapsedClipPath: "polygon(0 100%, 100% 100%, 100% 100%, 0 100%)",
  revealedClipPath: "polygon(0 0%, 100% 0%, 100% 100%, 0 100%)"
} as const;

export const LUXURY_SELECTORS = {
  loader: "[data-luxury-loader]",
  loaderTop: "[data-luxury-loader-top]",
  loaderBottom: "[data-luxury-loader-bottom]",
  loaderMark: "[data-luxury-loader-mark]",
  loaderGrid: "[data-luxury-loader-grid]",
  loaderBeam: "[data-luxury-loader-beam]",
  loaderLetter: "[data-luxury-loader-letter]",
  loaderProgress: "[data-luxury-loader-progress]",
  headingLine: "[data-luxury-line]",
  headingWord: "[data-luxury-word]",
  media: "[data-luxury-media]",
  parallax: "[data-luxury-parallax]"
} as const;

export function shouldDisableLuxuryMotion(disabled: boolean, reducedMotion: boolean) {
  return disabled || reducedMotion;
}
