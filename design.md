# DryDock — Design System

Single source of truth for visual design decisions. Update before writing UI code; reference for consistency.

## Aesthetic

Dark, port-at-night UI. The name is "DryDock" — the visual language leans into ships, anchors, and shipyard cranes. The palette is inspired by the **Seattle Kraken** hockey team's brand: a Deep Sea Blue chrome with Ice accents and an emergency Red Alert reserved for failures. Closest analogues: Linear (typography restraint), GitHub Actions (terminal output), Apple Reminders (mobile sheet ergonomics), plus a touch of NHL teamcraft.

## Motif

The DryDock identity uses two recurring marks:

- **⚓ Anchor** — primary brand mark. Appears in the page wordmark (header), the app icon ([public/icon.svg](public/icon.svg)), and on the empty-state for a project (no tasks yet). The anchor reads "moored" / "ready to be deployed."
- **🏗️ Crane** — secondary motif. Appears on the dashboard empty-state ("No projects in drydock yet"). Reinforces the shipyard metaphor without competing with the anchor.

Don't introduce a third motif (no octopus, no kraken creature — too on-the-nose). The anchor + crane pair is intentionally restrained.

## Palette — Seattle Kraken-inspired

All tokens are defined in [tailwind.config.ts](tailwind.config.ts) under `theme.extend.colors` and surfaced as utility classes (`bg-kraken-deep`, `text-kraken-ice`, etc).

| Token | Hex | Tailwind | Use |
|---|---|---|---|
| `kraken-deep` | `#001628` | `bg-kraken-deep` | Page background, sticky header, modal sheet input fields |
| `kraken-surface` | `#062236` | `bg-kraken-surface` | Cards, modal sheet body |
| `kraken-boundless` | `#355464` | `border-kraken-boundless` | Card/panel borders, divider lines |
| `kraken-shadow` | `#688199` | `text-kraken-shadow` | Tertiary text, helper hints |
| `kraken-ice` | `#99D9D9` | `bg-kraken-ice`, `text-kraken-ice` | Primary CTAs (FAB, submit buttons), focus ring, selected-state outlines, accent text on dark surfaces |
| `kraken-alert` | `#E9072B` | `text-kraken-alert`, `bg-kraken-alert/15` | Failed task badge, failure pill on dashboard, destructive-hover (delete button on hover). NEVER use as a general "color" — reserve for failure / alert states only. |

Provider brand colors are kept separate from the chrome palette so the user can recognize them at a glance:

| Token | Tailwind | Use |
|---|---|---|
| Claude | `bg-violet-500/15 text-violet-300 ring-violet-500/30` | ProviderBadge for `claude` runs |
| Gemini | `bg-blue-500/15 text-blue-300 ring-blue-500/30` | ProviderBadge for `gemini` runs |

### Status

- **Pending:** zinc — neutral, no action urgency
- **Claimed / Running:** amber — in-flight, attention-but-not-alarm
- **Done:** emerald — success, low intensity
- **Failed:** `kraken-alert` — needs review

Pills use `bg-X/15 text-X-* ring-X/30 ring-1 ring-inset` across colors so the eye recognizes the family at a glance.

## Typography

- System font stack everywhere except terminal output.
- Mono only for: file paths, agent stdout, run/task IDs, branch names.
- Size scale: `text-xs` (metadata), `text-sm` (body), `text-base` (card titles), `text-lg` (page-level), `text-xl` (page-title in landing area).
- Headings use `font-semibold tracking-tight`. Avoid `font-bold` — it reads heavy at the small sizes we use.

## Spacing

- Card padding: `p-4` (mobile + desktop — we don't grow it on wider screens).
- Section gaps: `space-y-3` for stacked task cards, `gap-3` for project-card grids.
- Page padding: `px-4 py-6` on `main`; max width `max-w-5xl`.
- Sheet/modal interior: `p-5` and `pb-[max(1.25rem,env(safe-area-inset-bottom))]`.

## Touch targets

Every interactive element is `min-h-[44px]` (or `h-14 w-14` for the FAB). This is non-negotiable — see `CLAUDE.md` "touch targets must be at least 44px."

## Layout breakpoints

Mobile-first with Tailwind's default scale:
- Default (mobile): single column, FAB visible, modal slides up from bottom.
- `sm` (640px): modals center.
- `md` (768px) / `lg` (1024px): project grid goes 2-up / 3-up.

The stream viewer is a bottom sheet on mobile (`inset-x-0 bottom-0`) and a fixed right-side panel on desktop (`sm:right-4 sm:top-20 sm:w-[420px]`). It is `z-30` so it sits over the FAB (`z-10`) and below any future toast (`z-50`).

## Safe areas

- Body gets `padding-bottom: env(safe-area-inset-bottom)` so FAB + sheets don't sit under the iOS home indicator.
- FAB uses `bottom-[max(1rem,env(safe-area-inset-bottom))]` directly.
- Modal sheet pads its bottom edge the same way so submit buttons aren't clipped.

## Focus

Explicit visible focus ring in `globals.css`: `:focus-visible { outline: 2px solid #99D9D9; outline-offset: 2px; }` (Kraken Ice). Don't override per-element.

## Icon + Branding

- App icon: SVG-only ([public/icon.svg](public/icon.svg)) — a stockless anchor in Kraken Ice on a Deep Sea Blue rounded square with a Boundless Blue glow ring behind the shackle. One file serves PWA, favicon, and Apple touch icon.
- Wordmark: `⚓` (Kraken Ice) followed by "DryDock" in `font-semibold tracking-tight text-zinc-50`. No raster logo.
- Manifest theme + background colors are both `#001628` (Kraken Deep Sea Blue) — the PWA blends into the dark UI when launched from the home screen.
- iOS status bar style: `black-translucent` so the Deep Sea Blue page background extends behind the notch.

## Don't list

- Don't add an icon library. The "+" FAB uses a literal `+` character. The ✕ close button uses U+2715. The anchor / crane use Apple system emoji (`⚓` / `🏗️`) so we don't ship raster glyphs.
- Don't add page-level animation libraries. CSS transitions only.
- Don't introduce a third provider's accent color (e.g. green for "openai") without expanding this file.
- Don't render the same content twice in the DOM for mobile vs. desktop. Use responsive utility classes.
- Don't break the touch-target rule, even for "small" admin actions.
- Don't use `kraken-alert` for non-failure states. It's a 50-watt signal — reserve it.
- Don't introduce a third brand motif. Stick with anchor + crane.
