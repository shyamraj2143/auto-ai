export const KINETIC_REVEAL_VARIANTS = [
  "sky-drop",
  "left-flight",
  "right-flight",
  "diagonal-prism-left",
  "diagonal-prism-right",
  "depth-landing",
  "bottom-lift",
  "split-assembly",
  "container-drop"
] as const;

export type KineticRevealVariant = (typeof KINETIC_REVEAL_VARIANTS)[number];

export type KineticMotionPreset = {
  x: number;
  y: number;
  rotateX: number;
  rotateY: number;
  rotateZ: number;
  scale: number;
  duration: number;
};

export const KINETIC_MOTION_PRESETS: Record<KineticRevealVariant, KineticMotionPreset> = {
  "sky-drop": { x: 0, y: -112, rotateX: -10, rotateY: 0, rotateZ: 0, scale: 0.94, duration: 900 },
  "left-flight": { x: -132, y: 0, rotateX: 0, rotateY: 9, rotateZ: -1, scale: 0.96, duration: 820 },
  "right-flight": { x: 132, y: 0, rotateX: 0, rotateY: -9, rotateZ: 1, scale: 0.96, duration: 820 },
  "diagonal-prism-left": { x: -108, y: -72, rotateX: 0, rotateY: 6, rotateZ: -4, scale: 0.93, duration: 880 },
  "diagonal-prism-right": { x: 108, y: -72, rotateX: 0, rotateY: -6, rotateZ: 4, scale: 0.93, duration: 880 },
  "depth-landing": { x: 0, y: 20, rotateX: 4, rotateY: 0, rotateZ: 0, scale: 0.9, duration: 820 },
  "bottom-lift": { x: 0, y: 54, rotateX: 0, rotateY: 0, rotateZ: 0, scale: 0.98, duration: 700 },
  "split-assembly": { x: 46, y: 20, rotateX: 0, rotateY: 0, rotateZ: 0, scale: 0.98, duration: 650 },
  "container-drop": { x: 0, y: -96, rotateX: -7, rotateY: 0, rotateZ: 0, scale: 0.94, duration: 920 }
};

export const LANDING_KINETIC_MAP = {
  heroHeading: "depth-landing",
  heroParagraph: "bottom-lift",
  sectionOneHeading: "sky-drop",
  sectionOneBoxLeft: "left-flight",
  sectionOneBoxRight: "right-flight",
  sectionTwoHeading: "split-assembly",
  sectionTwoCardLeft: "diagonal-prism-left",
  sectionTwoCardRight: "diagonal-prism-right",
  sectionThreeHeading: "depth-landing",
  sectionThreeContent: "container-drop",
  supportingText: "bottom-lift",
  testimonialLeft: "left-flight",
  testimonialRight: "right-flight",
  pricingHeading: "split-assembly",
  importantCta: "depth-landing",
  faqHeading: "sky-drop",
  faqRowLeft: "left-flight",
  faqRowRight: "right-flight",
  footerText: "bottom-lift",
  label: "bottom-lift"
} as const satisfies Record<string, KineticRevealVariant>;

export const KINETIC_REVEAL_COMPLETE_MS = 1800;
export const KINETIC_SPLIT_WORD_LIMIT = 8;
export const KINETIC_INNER_SEQUENCE = {
  headingDelay: 400,
  bodyDelay: 480,
  metaDelay: 550,
  childDuration: 270,
  total: 820
} as const;

const CMS_KINETIC_VARIANTS: Partial<Record<string, KineticRevealVariant>> = {
  heading: "sky-drop",
  paragraph: "bottom-lift",
  rich_text: "bottom-lift",
  page_section: "container-drop",
  container: "container-drop",
  quote: "depth-landing",
  testimonial: "depth-landing",
  badge: "bottom-lift",
  feature_card: "left-flight",
  feature_grid: "container-drop",
  testimonials: "container-drop",
  statistics: "container-drop",
  team_section: "container-drop",
  list: "bottom-lift",
  faq: "left-flight",
  accordion: "right-flight",
  one_column: "bottom-lift",
  stack: "bottom-lift"
};

export function cmsKineticRevealVariant(blockType: string) {
  return CMS_KINETIC_VARIANTS[blockType];
}

export function isCmsKineticRevealEnabled(editMode = false, previewMode = false) {
  return !editMode || previewMode;
}

export function splitKineticWords(text: string, limit = KINETIC_SPLIT_WORD_LIMIT) {
  const words = text.trim().split(/\s+/).filter(Boolean);
  return words.length > 0 && words.length <= limit ? words : null;
}

export function alternatingFlight(index: number): KineticRevealVariant {
  return index % 2 === 0 ? "left-flight" : "right-flight";
}

export function alternatingDiagonal(index: number): KineticRevealVariant {
  return index % 2 === 0 ? "diagonal-prism-left" : "diagonal-prism-right";
}

export function isSimpleKineticDevice(profile: {
  width: number;
  memoryGb?: number;
  cores?: number;
  saveData?: boolean;
}) {
  return profile.width <= 640 || Boolean(profile.saveData) || (profile.memoryGb ?? 4) <= 2;
}
