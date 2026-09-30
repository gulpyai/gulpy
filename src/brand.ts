/** The product name and its one-line promise. Each page reads them from here. */
export const BRAND = {
  name: "Gulpy",
  promise: "One login for all your AI plugins.",
} as const;

/** The official addresses for people who need help. The mail goes to the team through the domain. */
export const CONTACT = {
  support: "support@gulpy.ai",
  security: "security@gulpy.ai",
  privacy: "privacy@gulpy.ai",
  founder: "skyler@gulpy.ai",
} as const;

/** The plans and their prices, on the marketing site. The dashboard links here from Free. */
export const PRICING_URL = "https://gulpy.ai/pricing";

/**
 * The legal facts that the Terms and the Privacy page use. Change `entity` to the
 * registered name when the company exists, and change `rulesVersion` each time
 * the Terms or the Privacy page change: each person accepts the new version at
 * the next sign-in.
 */
export const LEGAL = {
  entity: "Gulpy",
  governingLaw: "the State of New Jersey",
  courts: "the state and federal courts in Mercer County, New Jersey",
  rulesVersion: "2026-09-27",
  rulesDate: "September 27, 2026",
  /** The list of calls is deleted after this number of days. */
  callLogDays: 365,
} as const;
