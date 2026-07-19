/** Experience curve used by the classic level bar. */
export function experienceToNextLevel(level: number): number {
  const safe = Math.max(0, Math.floor(level))
  if (safe >= 30) return 112 + (safe - 30) * 9
  if (safe >= 15) return 37 + (safe - 15) * 5
  return 7 + safe * 2
}

/** Total experience required to begin a level. */
export function experienceForLevel(level: number): number {
  const target = Math.max(0, Math.floor(level))
  let total = 0
  for (let current = 0; current < target; current++) total += experienceToNextLevel(current)
  return total
}

export function levelForExperience(total: number): number {
  let left = Math.max(0, Math.floor(total))
  let level = 0
  while (left >= experienceToNextLevel(level) && level < 10_000) {
    left -= experienceToNextLevel(level)
    level++
  }
  return level
}

export interface ExperienceProgress {
  total: number
  level: number
  intoLevel: number
  nextLevel: number
  fraction: number
}

export function experienceProgress(total: number): ExperienceProgress {
  const safe = Math.max(0, Math.floor(total))
  const level = levelForExperience(safe)
  const intoLevel = safe - experienceForLevel(level)
  const nextLevel = experienceToNextLevel(level)
  return { total: safe, level, intoLevel, nextLevel, fraction: nextLevel > 0 ? intoLevel / nextLevel : 0 }
}

/** Spending an enchantment cost removes whole levels and preserves fractional progress. */
export function spendExperienceLevels(total: number, cost: number): number | null {
  const progress = experienceProgress(total)
  const levels = Math.max(0, Math.floor(cost))
  if (progress.level < levels) return null
  const newLevel = progress.level - levels
  return experienceForLevel(newLevel) + Math.min(progress.intoLevel, experienceToNextLevel(newLevel) - 1)
}

export interface DeathExperience {
  retained: number
  dropped: number
}

/** Death clears retained XP and turns up to 100 points into recoverable orbs. */
export function experienceAfterDeath(total: number): DeathExperience {
  const safe = Math.max(0, Math.floor(total))
  return { retained: 0, dropped: Math.min(100, safe) }
}
