export const coachLanguages = ["en", "de"] as const;
export type CoachLanguage = typeof coachLanguages[number];

export function isCoachLanguage(value: unknown): value is CoachLanguage {
  return typeof value === "string" && coachLanguages.some(language => language === value);
}
