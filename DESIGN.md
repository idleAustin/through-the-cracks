---
name: idleAustin
description: High-velocity developer craft. Obsidian surfaces, electric lime, hairline structure, deadpan copy.
colors:
  bg-base: "#0a0a0c"
  bg-surface: "#121216"
  bg-elevated: "#18181f"
  bg-overlay: "#202029"
  border-subtle: "#22222a"
  border-strong: "#33333f"
  accent-primary: "#84cc16"
  accent-hover: "#65a30d"
  accent-text: "#1a2e05"
  accent-fg: "#84cc16"
  text-primary: "#f4f4f5"
  text-secondary: "#a1a1aa"
  text-muted: "#71717a"
  status-success: "#10b981"
  status-warning: "#f59e0b"
  status-error: "#f43f5e"
  status-info: "#38bdf8"
  light-bg-base: "#f4f4f6"
  light-bg-surface: "#ffffff"
  light-bg-overlay: "#eaeaee"
  light-border-subtle: "#e4e4e7"
  light-border-strong: "#c8c8d0"
  light-accent-fg: "#3f6212"
  light-text-primary: "#18181b"
  light-text-secondary: "#52525b"
  light-status-success: "#047857"
  light-status-warning: "#92400e"
  light-status-error: "#be123c"
  light-status-info: "#0369a1"
typography:
  display:
    fontFamily: "Outfit, -apple-system, sans-serif"
    fontSize: "2.25rem"
    fontWeight: 800
    lineHeight: 1.15
    letterSpacing: "-0.03em"
  h1:
    fontFamily: "Outfit, -apple-system, sans-serif"
    fontSize: "1.75rem"
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: "-0.025em"
  h2:
    fontFamily: "Outfit, -apple-system, sans-serif"
    fontSize: "1.25rem"
    fontWeight: 700
    lineHeight: 1.25
    letterSpacing: "-0.02em"
  h3:
    fontFamily: "Outfit, -apple-system, sans-serif"
    fontSize: "1rem"
    fontWeight: 600
    lineHeight: 1.35
    letterSpacing: "-0.01em"
  body:
    fontFamily: "Geist, -apple-system, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "normal"
  caption:
    fontFamily: "Geist, -apple-system, sans-serif"
    fontSize: "0.6875rem"
    fontWeight: 500
    lineHeight: 1.4
    letterSpacing: "0.02em"
  code:
    fontFamily: "Fira Code, monospace"
    fontSize: "0.75rem"
    fontWeight: 500
    lineHeight: 1.5
    letterSpacing: "normal"
rounded:
  sm: "4px"
  md: "6px"
  lg: "10px"
  pill: "9999px"
spacing:
  xxs: "2px"
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "24px"
  2xl: "32px"
  3xl: "48px"
components:
  button-primary:
    backgroundColor: "{colors.accent-primary}"
    textColor: "{colors.accent-text}"
    typography: "{typography.body}"
    rounded: "{rounded.sm}"
    padding: "8px 16px"
  button-primary-hover:
    backgroundColor: "{colors.accent-hover}"
  icon-action-button:
    backgroundColor: "{colors.bg-surface}"
    textColor: "{colors.text-secondary}"
    rounded: "{rounded.sm}"
    size: "36px"
  card:
    backgroundColor: "{colors.bg-surface}"
    rounded: "{rounded.md}"
    padding: "16px"
  input:
    backgroundColor: "{colors.bg-base}"
    textColor: "{colors.text-primary}"
    rounded: "{rounded.sm}"
    padding: "8px 12px"
---

# Design System: idleAustin

> Portable edition for `/impeccable` and other DESIGN.md-aware tools. Copy this file to a project's root next to `tokens.css`. The full system lives in the boilerplate's `02.Design/` (or the `thread-level-midnight` skill's `reference/`); where they differ, `02.Design/` wins. Do not regenerate this file with `/impeccable document`.

## Overview

High-velocity developer craft. The persona is deadpan competence: "Mostly idle. There probably was an easier way to do this." Interfaces are dense, fast to scan, and built from standard controls. The brand lives in type, palette, density, and the icon dock, never in invented affordances or terminal costumes.

Surface modes: **Operate** (app UI, the default), **Read** (docs), **Persuade** (landing and pricing). There is no Experience mode; treat showcases as Persuade.

Themes: **dark is the default**. A light theme exists for tools that offer a switch. It reassigns the same semantic tokens; it is never the dark theme inverted.

## Colors

### Primary

Electric lime `#84cc16` (`--as-accent-primary`) is the one accent. It has four jobs and no others: the primary action, the current selection, live state, and focus. Lime used as text, icon, border, or caret uses `--as-accent-fg` (`#84cc16` dark, `#3f6212` light).

### Neutral

Dark: obsidian depths `#0a0a0c` → `#121216` → `#18181f` → `#202029`, where higher surfaces are lighter. Light: cool paper `#f4f4f6` base with `#ffffff` surfaces and `#eaeaee` overlay, with depth from white-on-gray plus a soft shadow on floating layers.

### Named Rules

- **One lime fill per view.**
- **Status colors only where something is in that status**, always with a text label. Lime never means "success".
- **`--as-text-muted` is never reading text**, in either theme.
- **No raw hex outside `tokens.css`.**

## Typography

`Outfit` for headings only. `Geist` for body, buttons, labels, nav, and tables. `Fira Code` for code, numbers, timestamps, hashes, and key legends only. Tabular figures on every number.

### Hierarchy

Fixed Operate scale (no fluid type in app UI): display 36, H1 28, H2 20, H3 16, body 14, compact 13, caption 11, code 12. Read surfaces raise body to 16. Persuade pages use the hero `clamp(2.5rem, 7vw, 5rem)`. Display type never exceeds `6rem`.

## Layout

Group by proximity before adding a box. Spacing is tight inside groups (4 to 8), generous between them (16 to 32), with more space above a heading than below. Containers: prose 840 (text 68ch), dashboard 1200, canvas full-bleed. Mobile (640 and below) is one column, with navigation at the bottom, `44px` targets, and safe-area padding.

## Elevation & Depth

Depth is surface color plus a 1px border. Shadows (`--as-shadow-float`) only on things that float: tooltips, menus, the palette, an elevated dock. The lime glow appears only on hover and focus of an action control, never at rest.

## Shapes

Radii: 4 for buttons and inputs, 6 for cards and docks, 10 for dialogs and the palette, pill for status chips. Inner radius equals the outer radius minus padding.

## Components

### Buttons

One lime-filled primary text button per view. Repeated and secondary actions are 36px (28px in tables) icon action buttons with a floating tooltip that shows the label and shortcut. Every action on a public page is a text button.

### Cards / Containers

Surface fill, 1px subtle border, 6 radius, 16 padding. Never a card inside a card. Never a colored side stripe.

### Inputs / Fields

Strong border with a base-colored well, so the field reads as recessed. `16px` text on mobile.

### Navigation

Cockpit sidebar (260) on desktop; a labeled bottom tab bar or a drawer on mobile. The current item uses `aria-current="page"`, primary text, and a lime marker.

### Icon Dock

The signature control: a row of icon action buttons with precision tooltips, elevated when floating. On touch, icons get visible labels.

## Do's and Don'ts

### Do:

- Ship every state: hover, focus, active, disabled, loading, empty, error.
- Use realistic content: service names, commit hashes, durations.
- Write errors that name the problem and the fix.
- Verify at 375 and 1440, in both themes when the surface has a switch.

### Don't:

- Use emojis, or Unicode glyphs as icons.
- Use gradient text, glass or backdrop blur, a glow at rest, or dot-grid backgrounds.
- Put an eyebrow above a heading, use the hero-metric template, or build a grid of identical icon cards.
- Build a fake terminal window, or use monospace on labels or nav.
- Write "Get Started", "Learn More", "Oops", or exclamation points.
