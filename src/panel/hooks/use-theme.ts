/**
 * Panel-theme choice state: Auto (follow the host admin UI), Light, Dark, or
 * the red-preserving Night mode. The choice persists in localStorage under
 * `cl-theme` and is rendered declaratively by the panel root as a
 * `data-cl-theme` attribute the THEME_STYLE override blocks key off. Because
 * the current Signal K admin has no theme switcher of its own, this choice is
 * how an operator actually gets dark or night mode.
 */

import { useEffect, useState } from 'react'

/** The pinnable theme choices; `auto` follows the host admin UI theme. */
export type ThemeChoice = 'auto' | 'light' | 'dark' | 'night'

const STORAGE_KEY = 'cl-theme'

const VALID_CHOICES_SET: ReadonlySet<string> = new Set<ThemeChoice>(['auto', 'light', 'dark', 'night'])

function readStoredChoice (): ThemeChoice {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (raw !== null && VALID_CHOICES_SET.has(raw)) return raw as ThemeChoice
  } catch {
    // Storage can be unavailable (private mode, blocked third-party
    // storage); fall through to following the host.
  }
  return 'auto'
}

/** The theme choice plus its setter, persisted across panel mounts. */
export function useTheme (): [ThemeChoice, (next: ThemeChoice) => void] {
  const [choice, setChoice] = useState<ThemeChoice>(readStoredChoice)

  useEffect(() => {
    try {
      // Skip the redundant write when storage already holds this choice
      // (every mount would otherwise write back the value it just read).
      if (window.localStorage.getItem(STORAGE_KEY) !== choice) {
        window.localStorage.setItem(STORAGE_KEY, choice)
      }
    } catch {
      // Persistence is best-effort; the in-session choice still applies.
    }
  }, [choice])

  return [choice, setChoice]
}
