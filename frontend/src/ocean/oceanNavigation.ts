export type OceanNavigationDecision = "animate" | "dissolve" | "ignore" | "block";

export type OceanNavigationInput = {
  currentPath: string;
  destinationPath: string;
  sameOrigin: boolean;
  button: number;
  modified: boolean;
  opensNewContext: boolean;
  download: boolean;
  defaultPrevented: boolean;
  reducedMotion: boolean;
  navigationPending: boolean;
};

const AUTH_DESTINATIONS = new Set(["/login", "/register"]);
const DIVE_SOURCE_PATHS = new Set(["/", "/login", "/register"]);

export function decideOceanNavigation(input: OceanNavigationInput): OceanNavigationDecision {
  if (
    !DIVE_SOURCE_PATHS.has(input.currentPath)
    || !AUTH_DESTINATIONS.has(input.destinationPath)
    || input.currentPath === input.destinationPath
    || !input.sameOrigin
  ) {
    return "ignore";
  }

  if (
    input.defaultPrevented
    || input.button !== 0
    || input.modified
    || input.opensNewContext
    || input.download
  ) {
    return "ignore";
  }

  if (input.navigationPending) return "block";
  return input.reducedMotion ? "dissolve" : "animate";
}
