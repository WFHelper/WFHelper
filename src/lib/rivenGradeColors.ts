/**
 * Shared riven grade color utilities.
 * Grade colors are defined as CSS custom properties in tokens.css and
 * can be customized via the theme system.
 */

/** Return the CSS variable reference for a riven overall grade (S, A, B, C, D, F). */
export function gradeColor(grade: string): string {
  const base = grade.charAt(0);
  switch (base) {
    case "S":
      return "var(--grade-s)";
    case "A":
      return "var(--grade-a)";
    case "B":
      return "var(--grade-b)";
    case "C":
      return "var(--grade-c)";
    case "D":
      return "var(--grade-d)";
    case "F":
      return "var(--grade-f)";
    default:
      return "var(--grade-default)";
  }
}

/** Return the CSS variable reference for an individual attribute grade. */
export function attrGradeColor(grade: string): string {
  switch (grade) {
    case "Great":
      return "var(--grade-s)";
    case "Good":
      return "var(--grade-a)";
    case "OK":
      return "var(--grade-b)";
    case "Bad":
      return "var(--grade-f)";
    default:
      return "var(--grade-default)";
  }
}

/** Return a disposition star string for a given disposition value. */
export function dispoStars(dispo: number): string {
  if (dispo >= 1.3) return "●●●●●";
  if (dispo >= 1.1) return "●●●●○";
  if (dispo >= 0.9) return "●●●○○";
  if (dispo >= 0.7) return "●●○○○";
  return "●○○○○";
}
