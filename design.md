# DryDock — Design System

Single source of truth for visual design decisions. Update before writing UI code; reference for consistency.

## Aesthetic

Dark, port-at-night UI. The name is "DryDock" — the visual language leans into ships, anchors, and shipyard cranes. The palette is inspired by the **Seattle Kraken** hockey team's brand: a Deep Sea Blue chrome with Ice accents and an emergency Red Alert reserved for failures. Closest analogues: Linear (typography restraint), GitHub Actions (terminal output), Apple Reminders (mobile sheet ergonomics), plus a touch of NHL teamcraft.

## Motif

The DryDock identity uses two recurring marks:

- **⚓ Anchor** — primary brand mark. Appears in the page wordmark (header), the app icon ([public/icon.svg](public/icon.svg)), on the empty-state for a project (no tasks yet), and on the "All services" card in Analytics → Usage. The anchor reads "moored" / "ready to be deployed."
- **🏗️ Crane** — secondary motif. Appears on the dashboard empty-state ("No projects in drydock yet") and the not-yet-built Flow tab. Reinforces the shipyard metaphor without competing with the anchor.

Don't introduce a third motif (no octopus, no kraken creature — too on-the-nose). The anchor + crane pair is intentionally restrained.

### Depth: the waterline and the gantry rail

Two structural elements in [app/layout.tsx](app/layout.tsx) give the page an actual place rather than a flat dark wash. Both are `aria-hidden`, `pointer-events-none`, and purely atmospheric — **nothing is legible only because of them**, so a rendering failure costs nothing.

- **Waterline** — a fixed full-page gradient: a faint pool of Kraken Ice light at the top where the surface would be, deepening toward `rgba(0,8,16,0.6)` at the bottom. A dry dock is a basin the water is pumped out of; this is the water it sits in. One composited layer.
- **Gantry rail** — a 1px horizontal gradient across the top of the sticky header, brightest at centre, standing in for the crane track that runs the length of a dock.

If you add a third atmospheric element, delete one of these first. Atmosphere reads as intentional at two and as decoration at four.

### Empty-state voice

Empty states are nautical and specific, never generic ("No items"). They say what the space is for: "No projects in drydock yet", "No usage recorded in the last 30 days". They never imply failure when the truth is absence — see the Charts rules on fabricated zeros.

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
| Claude | `bg-violet-500/15 text-violet-300 ring-violet-500/30` | ProviderBadge for `claude` runs; Claude series in Analytics → Usage |
| Gemini / Google AI | `bg-blue-500/15 text-blue-300 ring-blue-500/30` | ProviderBadge for `gemini` runs; Google series in Analytics → Usage |
| OpenAI / Codex | `bg-teal-500/15 text-teal-300 ring-teal-500/30` | Codex series in Analytics → Usage and the Settings budget card |

**Why teal for Codex, and not emerald** (EP-10; this palette addition is deliberate — the "don't" list below forbids ad-hoc provider colors, so adding a provider requires editing this table first). Emerald was the obvious first choice and is wrong: it already means **Done** in the status scale, so an emerald Codex bar sitting next to an emerald "success" pill reads as a status, not a brand. Everything else with enough separation is spoken for or too close to something that is — indigo reads as violet (Claude), cyan reads as `kraken-ice` (the CTA accent), orange reads as amber (Running), rose reads as `kraken-alert` (Failed), lime reads as emerald. Teal is the remaining hue with real separation; its nearest neighbour is Gemini blue, and at pill scale `text-teal-300` and `text-blue-300` are distinguishable. If a future palette pass frees emerald up, revisit — but never let two providers or a provider and a status share a hue.

Providers are **never** distinguished by intensity of the same hue. Three shades of blue is not a legend anyone can read at 375px.

Contrast is spot-checked, not automated. Worth adding: a vitest that parses the token table above and asserts ≥ 4.5:1 for every text/bg pair actually rendered (pill text on pill bg, `kraken-shadow` on `kraken-deep`, etc.) — near-free guard, catches violations at edit time.

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

## Radii, shadows, motion

- Radii in use (keep to this scale): `rounded-md` (buttons, inputs — the default), `rounded-lg` (cards, panels), `rounded-full` (pills, badges, FAB), `rounded-2xl` (bottom sheets/modals). Don't introduce new radius steps.
- Motion: `animate-pulse` for the two live indicators (SyncStatus dot, RunningTasksPanel ⬤) — no other animation today; CSS transitions only.
- Respect `prefers-reduced-motion`: enforced **globally** in [app/globals.css](app/globals.css), which collapses every animation and transition to ~0ms under the media query. Global rather than per-component `motion-reduce:` classes, because a component added later can't forget. (This was a documented rule with no implementation until EP-10.)

## Charts

No chart library. Every chart in DryDock is CSS — flex rows of divs with a percentage height or width, `tabular-nums` for the figures beside them. The 30-day trend on Analytics → Runs set the pattern; Analytics → Usage follows it (stacked model-mix bars, an hour×weekday rhythm grid, a dense daily trend). A charting dependency would add more bundle weight than the entire app currently ships for four card types.

Rules that keep CSS charts honest:

- **Dense, not sparse.** A day with no activity renders as a zero-height bar, never as a missing element. A gap in a bar row reads as "the chart ends here" rather than "nothing happened that day."
- **Never fabricate a zero.** A provider that has no data is different from a provider that has zero usage. The former renders its empty state ("no local data — deep link"), the latter renders zeros. Getting these backwards is the single most misleading thing this UI can do.
- **Label the unit when it differs.** Google records activity counts, not tokens; its cards say "activity" and are never summed into a token total.
- **A percentage always carries its age.** A quota reading is only meaningful with "as of N min ago" beside it.
- **`title` on every bar.** Hover/long-press is the only affordance a CSS chart has for exact values.

## Progressive disclosure (how we spend vertical space)

DryDock is a 375×812-first PWA, and scrolling is the most expensive interaction on a phone held one-handed: it costs attention, loses your place, and buries the one number you opened the app for. Two dense screens had grown past it — Analytics → Usage ran several screens, and Settings was 1.3 screens of mostly *prose you read once and never need again*.

The pattern is [components/Disclosure.tsx](components/Disclosure.tsx), in two forms:

- **`<Disclosure>`** — a full collapsible panel. Used for the per-provider cards, Rhythm, and Projects on Analytics → Usage.
- **`<InlineDisclosure>`** — a quiet inline "why?" line for explanatory prose. Used under each Settings control and under the fleet totals ("What's a turn? What's a token?").

Both wrap native `<details>/<summary>`, not a `useState` toggle. That is deliberate: `<details>` is keyboard-operable and screen-reader-announced for free, it costs no JavaScript, and **the browser's own find-in-page opens a closed `<details>` to reveal a match** — content behind a React state toggle is invisible to Cmd-F entirely.

**The rule that keeps this honest: a collapsed row must carry its headline figure.** A row reading just "Claude ▸" forces the tap it was supposed to save. "Claude · 18.14B tokens · 57.7k turns ▸" lets you scan the whole page and open only what you actually want. Collapse detail, never information.

What may be collapsed: rationale, methodology, per-model breakdowns, historical charts. What may **not**: the headline number, a health warning, an error, or anything the user needs in order to decide whether to expand.

## Touch targets

Every touch-usable interactive element is `min-h-[44px]` (or `h-14 w-14` for the FAB). Non-negotiable on touch — see `CLAUDE.md` "touch targets must be at least 44px."

**Use the `.tap` class for secondary controls**, never a bare `min-h-[36px]`. `.tap` (in [app/globals.css](app/globals.css)) is 36px where there's a mouse and 44px under `@media (pointer: coarse)` — the escape hatch this section always described, now actually implemented. The codebase had drifted to a hardcoded 36px in **28 places**, which silently dropped the floor on phones too; Codex caught it on PR #8.

- **`.tap`** — filter pills, inline row actions, disclosure summaries, back-links, the header budget pill.
- **`min-h-[44px]` flat** — primary actions, form inputs, anything a thumb aims at deliberately.

Don't bloat desktop controls just because the mobile-first rule exists, and don't shrink touch targets to please desktop. That's the whole point of the two-tier class.

## Layout breakpoints

Mobile-first with Tailwind's default scale:
- Default (mobile): single column, FAB visible, modal slides up from bottom. The header drops the "DryDock" wordmark and keeps the ⚓ — the app's name is already on the home-screen icon and the tab title, and reclaiming that width is what lets the nav have 44px targets *and* the budget pill fit in 375px.
- `sm` (640px): modals center; the wordmark returns.
- `md` (768px): Analytics → Usage and Flow cards go 2-up.
- `lg` (1024px): project grid 3-up; `/backlog` grows a **sticky right rail** for the inbox and GitHub work, leaving the reading column to the list. Below `lg` those stack *above* the list — on a phone, "what needs deciding" outranks browsing.
- `xl` (1280px): Usage cards go 3-up and the page container widens from `max-w-5xl` to `88rem`. It stops there rather than going full-bleed: past ~1400px, line length hurts readability more than the extra width helps.

Grid containers holding `<Disclosure>` cards need **`items-start`**. Grid items stretch to the row height by default, so a collapsed card beside an open one grows a tall empty box under its summary.

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

## In-UI glyph catalog

System-emoji only — no SVG icons, no icon library. Sized via `text-base` (for the trash) / `text-xs` (for inline action buttons).

| Glyph | Where it's used | Meaning |
|---|---|---|
| `⚓` | Wordmark, project empty-state, Apple Note body header | Brand mark; "moored, ready to deploy" |
| `🏗️` | Dashboard empty-state | Shipyard motif; "no projects in drydock yet" |
| `+` | FAB on dashboard and project pages | Create-new |
| `✕` | Modal/sheet close buttons (NOT row delete — see 🗑️) | Dismiss |
| `🔥 Burn down` | `/backlog` row | Promote item to a Pending task in its assigned project. Requires a project. Doesn't auto-Run. |
| `Mark done` | `/backlog` row | Close-loop a backlog item without creating any task. |
| `✏️ Edit` | `/backlog` row | Inline edit title + description. Save / Cancel swap in. |
| `🗑️` | `/backlog` row (right-aligned) | Hard delete (irreversible). The only destructive row-level action — previous "Drop" soft-archive button was removed; `status='dropped'` is now legacy. |
| `↻ Sync Notes` | `/backlog` header | Manual Apple Notes round-trip. Defers to the same `useAutoSync` orchestrator as the periodic poll. |
| Pulsing ⬤ + "Syncing…" / "Synced 30s ago" / "⚠ Sync failed" | `/backlog` header under Sync Notes button | `SyncStatus` badge — `text-xs` Kraken Shadow for idle, Kraken Ice pulsing dot for in-flight, Kraken Alert for errors. |
| `⬤` (pulsing) | `RunningTasksPanel` header on dashboard | In-flight task indicator. Kraken Ice, `animate-pulse`. |

## Don't list

- Don't add an icon library. System emoji only.
- Don't add page-level animation libraries. CSS transitions / Tailwind's `animate-pulse` only.
- Don't introduce a third provider's accent color (e.g. green for "openai") without expanding this file.
- Don't render the same content twice in the DOM for mobile vs. desktop. Use responsive utility classes.
- Don't break the touch-target rule, even for "small" admin actions.
- Don't use `kraken-alert` for non-failure states. It's a 50-watt signal — reserve it.
- Don't introduce a third brand motif. Stick with anchor + crane.
- Don't reintroduce a "Drop" / soft-archive button on `/backlog`. The user explicitly asked for a single destructive action (🗑️). The status enum still has `dropped` for legacy rows but new UI shouldn't surface it.
