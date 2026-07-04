/**
 * Inline-style design tokens for the federated configuration panel.
 *
 * The panel renders inside the Signal K admin UI. Inline styles cannot
 * read the host's theme, so every color here references a `--cl-*` CSS
 * custom property rather than a hex literal. THEME_STYLE (below) defines
 * those properties once on `.cl-config-panel` with explicit light values,
 * then overrides them per theme. Components stay theme-agnostic: they
 * read tokens, the theme layer redefines them. A new hex literal in a
 * component is a defect.
 *
 * Theme pinning: a `data-cl-theme` attribute on the `.cl-config-panel`
 * root (set by ThemeToggle, persisted under localStorage key `cl-theme`)
 * pins light, dark, or the red-preserving night theme. The pinned blocks
 * share specificity with the host-driven dark block and are emitted later
 * in the stylesheet, so a pinned choice wins. The host-driven block keyed
 * on `[data-bs-theme="dark"]` / `.dark-mode` is dormant today (the current
 * Signal K admin sets neither; verified against the server-admin-ui source),
 * so the ThemeToggle is the way a user actually gets dark or night mode.
 *
 * The token values are identical to the sibling plugin panels (Crow's Nest,
 * Emitter Cannon), only the namespace differs, so the three panels read as
 * one family. Surfaces are deliberately NOT derived from the host's
 * `--bs-body-bg`: the admin's body background is page-gray, so a card that
 * inherited it would lose its fill and dissolve into the page.
 */

import type { CSSProperties } from 'react'

/**
 * Scale tokens: theme-independent, defined once on the root. Radii and
 * font sizes sit on Bootstrap 5.3 defaults (radius .375rem = 6px, small
 * text .875rem = 14px) so the panel reads native inside the admin shell,
 * and gutters (the token-driven margins and gaps) run an 8/12/16 scale so
 * they stay on one rhythm. Card inner paddings intentionally use the
 * Bootstrap-native 10px and 14px half-steps so the cards match the admin
 * shell's own controls rather than the gutter scale.
 */
const SCALE_TOKENS = `
  --cl-radius: 6px;
  --cl-radius-sm: 4px;
  --cl-radius-pill: 999px;
  --cl-font-body: 14px;
  --cl-font-small: 12px;
  --cl-font-xsmall: 11px;
  --cl-font-title: 15px;
  --cl-space-1: 8px;
  --cl-space-2: 12px;
  --cl-space-3: 16px;
`

/**
 * Light theme. Cards must read white so they stand out from the admin's
 * gray page background. Faint text is #62687a: 5.05:1 on the raised
 * surface, clearing WCAG AA (4.5:1) at the small sizes it is used at.
 * `color-scheme` rides along with each token block so native widgets
 * (number spinners, range thumbs, scrollbars) follow the panel theme
 * even when it is pinned against the host.
 */
const LIGHT_TOKENS = `
  color-scheme: light;
  --cl-bg: #e4e5e6;
  --cl-surface: #ffffff;
  --cl-surface-muted: #f8f9fa;
  --cl-surface-raised: #f1f3f5;
  --cl-border: #e0e0e0;
  --cl-text: #333333;
  --cl-text-muted: #555555;
  --cl-text-faint: #62687a;
  --cl-accent: #3b82f6;
  --cl-accent-text: #ffffff;
  --cl-ok: #22c55e;
  --cl-wait: #f59e0b;
  --cl-off: #9ca3af;
  --cl-danger-bg: #fef2f2;
  --cl-danger-fg: #991b1b;
  --cl-danger-border: #fca5a5;
  --cl-warn-bg: #fef3c7;
  --cl-warn-fg: #78350f;
  --cl-warn-border: #fbbf24;
  --cl-success-bg: #ecfdf5;
  --cl-success-fg: #065f46;
  --cl-success-border: #6ee7b7;
  --cl-info-bg: #eef2ff;
  --cl-info-fg: #3730a3;
  --cl-info-border: #c7d2fe;
`

/**
 * Dark theme. Faint text is #9ba0ad: 4.62:1 on the card surface, so AA
 * holds at the small sizes it lands on (the section descriptions, the
 * status freshness note, the field hints).
 */
const DARK_TOKENS = `
  color-scheme: dark;
  --cl-bg: #1b1c22;
  --cl-surface: #262833;
  --cl-surface-muted: #20212b;
  --cl-surface-raised: #30323f;
  --cl-border: #3a3c4a;
  --cl-text: #e6e7ea;
  --cl-text-muted: #a3a9b5;
  --cl-text-faint: #9ba0ad;
  --cl-accent: #4c93ff;
  --cl-accent-text: #ffffff;
  --cl-ok: #2dd4a0;
  --cl-wait: #fbbf24;
  --cl-off: #6b7785;
  --cl-danger-bg: #3a1a1a;
  --cl-danger-fg: #f5a3a3;
  --cl-danger-border: #7a3a3a;
  --cl-warn-bg: #3a2f12;
  --cl-warn-fg: #f5d28a;
  --cl-warn-border: #6b551f;
  --cl-success-bg: #12352a;
  --cl-success-fg: #7fe3c0;
  --cl-success-border: #2f6b54;
  --cl-info-bg: #1e2547;
  --cl-info-fg: #a9b6f0;
  --cl-info-border: #3a4577;
`

/**
 * Night theme: red-preserving for night vision at the helm. Near-black
 * surfaces, every text and accent token collapses into the desaturated
 * red and amber families, nothing renders blue, green, or white. The
 * palette is shared with the sibling panels, whose contrast audit holds
 * here too: text 7.25:1, muted 5.13:1, faint 4.56:1 worst case, every
 * status fg 5.65:1 or better on its paired bg.
 */
const NIGHT_TOKENS = `
  color-scheme: dark;
  --cl-bg: #0d0606;
  --cl-surface: #160a0a;
  --cl-surface-muted: #110808;
  --cl-surface-raised: #1f0e0e;
  --cl-border: #3a1616;
  --cl-text: #e08a8a;
  --cl-text-muted: #b87474;
  --cl-text-faint: #ad6c6c;
  --cl-accent: #cf6a3c;
  --cl-accent-text: #1a0808;
  --cl-ok: #cf8a4a;
  --cl-wait: #a9742e;
  --cl-off: #7a4f4f;
  --cl-danger-bg: #2a0d0d;
  --cl-danger-fg: #e07a6a;
  --cl-danger-border: #6e2a2a;
  --cl-warn-bg: #241204;
  --cl-warn-fg: #d9a05a;
  --cl-warn-border: #6e4a1f;
  --cl-success-bg: #1d0f08;
  --cl-success-fg: #cf8a5a;
  --cl-success-border: #6e3f1f;
  --cl-info-bg: #200c0c;
  --cl-info-fg: #c98080;
  --cl-info-border: #5e2a2a;
`

/**
 * Injected once by PluginConfigurationPanel. Covers the token contract,
 * the host-driven dark overrides, the pinned theme blocks, and the
 * pseudo-class states (focus ring, disabled controls, hover and active
 * feedback) that inline styles cannot express. Order matters: the pinned
 * `[data-cl-theme]` blocks come after the host-driven dark block so an
 * explicit user choice outranks the host theme at equal specificity.
 */
export const THEME_STYLE = `
.cl-config-panel {
${SCALE_TOKENS}${LIGHT_TOKENS}}
[data-bs-theme="dark"] .cl-config-panel,
.dark-mode .cl-config-panel {
${DARK_TOKENS}}
.cl-config-panel[data-cl-theme="light"] {
${LIGHT_TOKENS}}
.cl-config-panel[data-cl-theme="dark"] {
${DARK_TOKENS}}
.cl-config-panel[data-cl-theme="night"] {
${NIGHT_TOKENS}}
.cl-config-panel input:focus-visible,
.cl-config-panel button:focus-visible,
.cl-config-panel summary:focus-visible {
  outline: 2px solid var(--cl-accent);
  outline-offset: 1px;
}
/* The segmented control clips its overflow so segments sit flush inside the border, which would also clip
   a 1px-offset focus ring; draw the segment ring inset so keyboard focus stays visible. */
.cl-config-panel fieldset button:focus-visible {
  outline-offset: -2px;
}
/* Placeholder text: token-driven so it keeps contrast in dark and stays on-palette (not the UA blue-gray)
   in night mode. opacity 1 undoes the browser's default placeholder fade. */
.cl-config-panel input::placeholder {
  color: var(--cl-text-faint);
  opacity: 1;
}
/* Buttons set their background as an inline style, which outranks the
   browser's default disabled appearance, so a disabled button would still
   look enabled. !important is required to override the inline style for
   the disabled state. */
.cl-config-panel button:disabled,
.cl-config-panel input:disabled {
  background: var(--cl-surface-raised) !important;
  color: var(--cl-text-faint) !important;
  border-color: var(--cl-border) !important;
  cursor: not-allowed !important;
}
/* Pointer feedback. Inline styles cannot express :hover or :active, so the
   interactive elements get a shared brightness response here: a touch
   darker on hover, darker still while pressed, with a short transition so
   the shift reads as a response rather than a flicker. Brightness works on
   any background (including the accent-filled primary button), which a
   background swap could not. Disabled buttons opt out. */
.cl-config-panel input {
  transition:
    background-color 120ms ease,
    border-color 120ms ease;
}
.cl-config-panel button {
  transition:
    background-color 120ms ease,
    border-color 120ms ease,
    filter 120ms ease;
}
.cl-config-panel button:hover:not(:disabled) {
  filter: brightness(0.96);
}
.cl-config-panel button:active:not(:disabled) {
  filter: brightness(0.9);
}
/* The range slider tracks the accent so the fill reads on-palette in every
   theme, including night-red, rather than staying the browser's default blue. */
.cl-config-panel input[type="range"] {
  accent-color: var(--cl-accent);
}
`

/** Shared face of the hint paragraph; the two variants differ only in margin. */
const HINT_BASE: CSSProperties = {
  fontSize: 'var(--cl-font-small)',
  color: 'var(--cl-text-muted)',
  lineHeight: 1.45
}

/**
 * Base segment button, spread into the active variant below. Each segment
 * is a 36px touch target, sized for wet fingers on a moving boat.
 */
const SEGMENTED_BTN: CSSProperties = {
  padding: '6px 12px',
  minHeight: 36,
  background: 'transparent',
  color: 'var(--cl-text-muted)',
  border: 'none',
  fontSize: 'var(--cl-font-small)',
  cursor: 'pointer'
}

/** Shared face of the three text and number inputs; the variants differ only in width. */
const INPUT_BASE: CSSProperties = {
  padding: '6px 10px',
  minHeight: 36,
  boxSizing: 'border-box',
  borderRadius: 'var(--cl-radius)',
  border: '1px solid var(--cl-border)',
  background: 'var(--cl-surface)',
  color: 'var(--cl-text)',
  fontSize: 'var(--cl-font-body)'
}

/** Shared card shell for the section and disclosure surfaces. */
const CARD_BASE: CSSProperties = {
  background: 'var(--cl-surface)',
  border: '1px solid var(--cl-border)',
  borderRadius: 'var(--cl-radius)',
  marginBottom: 'var(--cl-space-3)',
  overflow: 'hidden'
}

/** Shared face of the status line variants; they differ only in text color. */
const MESSAGE_BASE: CSSProperties = {
  minWidth: 0,
  overflowWrap: 'anywhere'
}

/** Shared face of the banner variants; they differ only in their token triplet. */
const BANNER_BASE: CSSProperties = {
  borderRadius: 'var(--cl-radius)',
  padding: '8px 12px',
  fontSize: 'var(--cl-font-body)',
  margin: '0 0 var(--cl-space-3)'
}

/**
 * The named style tokens consumed by panel components. Declared with a
 * `satisfies` clause so each value is checked as a CSSProperties literal while
 * the inferred type of `S` keeps its specific keys: indexing `S.unknownKey`
 * remains a TypeScript error, which a `Record<string, CSSProperties>`
 * annotation would have silently allowed.
 *
 * Touch sizing stays as literals rather than tokens (36px minimum control
 * heights): the values are accessibility floors, not theme decisions, so a
 * theme must not be able to shrink them.
 */
export const S = {
  // The root paints --cl-bg itself: a pinned Dark or Night theme must read
  // as one continuous surface, not dark cards floating on the host's light
  // page.
  root: {
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    color: 'var(--cl-text)',
    background: 'var(--cl-bg)',
    padding: 'var(--cl-space-3)',
    borderRadius: 'var(--cl-radius)'
  },

  // The top control bar: the theme toggle, right-aligned so it reads as
  // panel chrome rather than as the first configuration field.
  controlBar: {
    display: 'flex',
    justifyContent: 'flex-end',
    marginBottom: 'var(--cl-space-2)'
  },

  // Compact segmented control: a bordered fieldset of aria-pressed buttons
  // with the active segment filled by the accent.
  segmented: {
    display: 'inline-flex',
    // Rendered as a <fieldset>: zero out the user-agent margin and padding
    // so the segments sit flush inside the border.
    margin: 0,
    padding: 0,
    border: '1px solid var(--cl-border)',
    borderRadius: 'var(--cl-radius)',
    overflow: 'hidden',
    background: 'var(--cl-surface)'
  },
  segmentedBtn: SEGMENTED_BTN,
  segmentedBtnActive: {
    ...SEGMENTED_BTN,
    background: 'var(--cl-accent)',
    color: 'var(--cl-accent-text)',
    fontWeight: 600
  },

  // Visually hidden but screen-reader-readable, for the segmented
  // control's naming <legend>.
  visuallyHidden: {
    position: 'absolute',
    width: 1,
    height: 1,
    padding: 0,
    margin: -1,
    overflow: 'hidden',
    clip: 'rect(0,0,0,0)',
    whiteSpace: 'nowrap',
    border: 0
  },

  // Status bar at the top of the panel: a small bordered card that shows the
  // plugin's live status line and whether it is enabled.
  statusBar: {
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
    padding: '12px 14px',
    background: 'var(--cl-surface-muted)',
    border: '1px solid var(--cl-border)',
    borderRadius: 'var(--cl-radius)',
    marginBottom: 'var(--cl-space-3)',
    fontSize: 'var(--cl-font-body)'
  },
  // Title row wrapper so the freshness note sits on the same line as the title.
  statusTitleRow: {
    display: 'flex',
    alignItems: 'baseline',
    gap: 8
  },
  statusBarTitle: {
    fontSize: 'var(--cl-font-title)',
    fontWeight: 600,
    color: 'var(--cl-text)'
  },
  // The freshness note in the title row: muted, small, right-aligned.
  statusCheckedAt: {
    fontSize: 'var(--cl-font-small)',
    fontWeight: 400,
    color: 'var(--cl-text-faint)',
    marginLeft: 'auto'
  },
  // The body row: a status dot plus the status line, aligned on one baseline.
  statusRow: {
    display: 'flex',
    alignItems: 'baseline',
    gap: 10
  },
  statusBarLoading: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 8,
    color: 'var(--cl-text-muted)'
  },
  // The primary status line: the message the plugin published, or a derived
  // enabled/disabled phrase when no message is available.
  statusMessage: {
    ...MESSAGE_BASE,
    color: 'var(--cl-text)'
  },
  statusMessageMuted: {
    ...MESSAGE_BASE,
    color: 'var(--cl-text-muted)'
  },
  dot: { width: 10, height: 10, borderRadius: '50%', display: 'inline-block', flexShrink: 0, alignSelf: 'center' },
  dotOk: { background: 'var(--cl-ok)' },
  dotOff: { background: 'var(--cl-off)' },

  // A titled section card: a header row (title plus optional description) over
  // a body of fields. A white surface so the card stands off the panel
  // background.
  section: CARD_BASE,
  sectionHeader: {
    padding: '10px 14px',
    borderBottom: '1px solid var(--cl-border)',
    background: 'var(--cl-surface-muted)'
  },
  sectionTitle: {
    margin: 0,
    fontSize: 'var(--cl-font-title)',
    fontWeight: 600,
    color: 'var(--cl-text)'
  },
  sectionDescription: {
    margin: '4px 0 0',
    fontSize: 'var(--cl-font-small)',
    color: 'var(--cl-text-muted)',
    lineHeight: 1.45
  },
  sectionBody: {
    padding: '12px 14px'
  },

  // Generic field row: a label-input pair laid out as one row, with the
  // hint rendered as a sibling block below (LabeledField composes the two
  // via the S.hintBelow variant). Labels are a fixed-width column on the
  // left, so successive rows visually align without depending on label length.
  fieldRow: {
    display: 'flex',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 12,
    marginBottom: 4
  },
  label: {
    fontSize: 'var(--cl-font-body)',
    // The label takes the primary text color and a touch of weight so the
    // field name leads the eye, with its (muted) hint reading as quiet support.
    color: 'var(--cl-text)',
    fontWeight: 500,
    width: 240,
    flexShrink: 0
  },
  input: {
    ...INPUT_BASE,
    width: 110
  },
  // Wide text input, for a filesystem path or an image tag.
  inputWide: {
    ...INPUT_BASE,
    width: '100%',
    maxWidth: 440
  },

  // Range field: a slider paired with a compact numeric readout and a unit
  // suffix, laid out on one baseline. The slider grows to fill the row, the
  // number box stays narrow.
  rangeRow: {
    display: 'flex',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 12,
    flex: 1,
    minWidth: 200
  },
  range: {
    flex: 1,
    minWidth: 160,
    minHeight: 36,
    cursor: 'pointer'
  },
  rangeNumber: {
    ...INPUT_BASE,
    width: 90
  },
  rangeUnit: {
    fontSize: 'var(--cl-font-small)',
    color: 'var(--cl-text-muted)',
    flexShrink: 0
  },

  /**
   * Default hint paragraph style. Defaults to `margin: 0` so a hint nested
   * inside a group inherits the group's vertical rhythm.
   */
  hint: {
    ...HINT_BASE,
    margin: 0
  },
  /**
   * Variant for a hint paragraph rendered immediately below a labeled field
   * row (the LabeledField shape). Adds 12px of bottom margin so successive
   * fields visually separate.
   */
  hintBelow: {
    ...HINT_BASE,
    margin: '0 0 12px'
  },

  /**
   * Collapsible "Advanced" disclosure, built on native <details>, styled to
   * read as one more section card. The summary is the header row; the body
   * holds the rarely-changed fields.
   */
  disclosure: CARD_BASE,
  disclosureSummary: {
    cursor: 'pointer',
    minHeight: 36,
    display: 'flex',
    alignItems: 'center',
    padding: '10px 14px',
    background: 'var(--cl-surface-muted)',
    fontSize: 'var(--cl-font-title)',
    fontWeight: 600,
    color: 'var(--cl-text)',
    userSelect: 'none'
  },
  disclosureBody: {
    padding: '12px 14px',
    borderTop: '1px solid var(--cl-border)'
  },

  // Footer. Sticky, painting --cl-bg, so Save stays reachable on a long
  // panel and the row does not read as a translucent strip over content.
  footer: {
    display: 'flex',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 8,
    padding: '12px 0',
    borderTop: '1px solid var(--cl-border)',
    marginTop: 8,
    position: 'sticky',
    bottom: 0,
    background: 'var(--cl-bg)'
  },
  btnPrimary: {
    padding: '8px 16px',
    minHeight: 36,
    background: 'var(--cl-accent)',
    color: 'var(--cl-accent-text)',
    border: 'none',
    borderRadius: 'var(--cl-radius)',
    fontWeight: 600,
    cursor: 'pointer'
  },
  btnSecondary: {
    padding: '8px 16px',
    minHeight: 36,
    background: 'var(--cl-surface-raised)',
    color: 'var(--cl-text)',
    border: '1px solid var(--cl-border)',
    borderRadius: 'var(--cl-radius)',
    cursor: 'pointer'
  },
  dirty: { fontSize: 'var(--cl-font-small)', color: 'var(--cl-text-muted)', marginLeft: 4 },
  savedPill: {
    display: 'inline-flex',
    alignItems: 'center',
    fontSize: 'var(--cl-font-small)',
    lineHeight: 1,
    color: 'var(--cl-success-fg)',
    background: 'var(--cl-success-bg)',
    border: '1px solid var(--cl-success-border)',
    borderRadius: 'var(--cl-radius-pill)',
    padding: '5px 12px',
    marginLeft: 4
  },

  // Non-fatal status-poll error banner.
  errorBanner: {
    ...BANNER_BASE,
    color: 'var(--cl-danger-fg)',
    background: 'var(--cl-danger-bg)',
    border: '1px solid var(--cl-danger-border)'
  },

  // Advisory warning banner (for example the cache cap exceeding free space). Uses the warn tokens,
  // never the red danger tokens, so a warning does not read as an error.
  warnBanner: {
    ...BANNER_BASE,
    color: 'var(--cl-warn-fg)',
    background: 'var(--cl-warn-bg)',
    border: '1px solid var(--cl-warn-border)'
  }
} satisfies Record<string, CSSProperties>
