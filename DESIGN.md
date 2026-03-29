# Design System — CoachIQ

## Product Context
- **What this is:** Client management system with AI-powered coaching intelligence — session capture, billing, semantic search, pre-meeting briefs
- **Who it's for:** Todd Zimbelman, executive coach at Co-Create Coaching (single user)
- **Space/industry:** Executive coaching, practice management. Competitors: Coaching.com, Profi, Delenta, CoachAccountable
- **Project type:** Web app / dashboard (Next.js 14, App Router)

## Aesthetic Direction
- **Direction:** Luxury/Refined with Editorial influence
- **Decoration level:** Intentional — subtle warmth through neutral tones. No gradients, no decorative blobs, no stock imagery. Typography and spacing do the heavy lifting.
- **Mood:** Private equity portfolio dashboard meets well-typeset briefing document. Warm, confident, serious about the work. Not corporate, not techy. The three-second reaction: "This is mine."
- **Reference sites:** Linear (dark precision, strong identity), Bloomberg (data density done right). Deliberately NOT like Coaching.com/Profi/Delenta (generic SaaS pastels).

## Typography
- **Display/Hero:** Instrument Serif — editorial weight for client names and page headers. Signals authority and curation, not a spreadsheet.
- **Body:** DM Sans — clean geometric sans with good tabular number support. Readable at every size, professional without being boring.
- **UI/Labels:** DM Sans (same as body, weight 500 for labels)
- **Data/Tables:** Geist Mono — precision feel for dates, durations, dollar amounts. Tabular-nums supported.
- **Code:** Geist Mono
- **Loading:** Google Fonts for Instrument Serif + DM Sans. CDN (jsdelivr) for Geist Mono.
- **Scale:** 12px / 14px / 16px (base) / 20px / 24px / 32px / 40px

## Color
- **Approach:** Restrained — one accent color used meaningfully
- **Background:** #FAFAF9 (Stone 50, warm off-white)
- **Surface/Cards:** #FFFFFF
- **Sidebar:** #1C1917 (Stone 900, warm near-black)
- **Sidebar surface:** #292524 (Stone 800)
- **Sidebar text:** #E7E5E4 (Stone 200)
- **Sidebar muted:** #A8A29E (Stone 400)
- **Primary text:** #1C1917 (Stone 900)
- **Muted text:** #78716C (Stone 500)
- **Borders:** #E7E5E4 (Stone 200)
- **Accent:** #B45309 (Amber 700) — warm amber-gold. Confident, not flashy. Used for active states, CTAs, important markers.
- **Accent hover:** #92400E (Amber 800)
- **Accent light:** #FEF3C7 (Amber 100) — for highlights, tags, search result marks
- **Semantic:** success #16A34A, warning #CA8A04, error #DC2626, info #2563EB
- **Dark mode:** Background #0C0A09 (Stone 950), Surface #1C1917, Borders #292524, Accent #D97706 (reduce saturation ~15%). Sidebar stays dark. Alert colors shift to dark-friendly variants.

## Spacing
- **Base unit:** 4px
- **Density:** Comfortable — not cramped (not a trading terminal), not airy (Todd needs to see data)
- **Scale:** 2xs(4) xs(8) sm(12) md(16) lg(24) xl(32) 2xl(48) 3xl(64)

## Layout
- **Approach:** Split-pane dossier — persistent dark left sidebar with compact client list and search, deep right content pane
- **Sidebar width:** 280px
- **Grid:** Single-column content in dossier view, 4-column stat grid on dashboard, responsive down to 2-col
- **Max content width:** 1200px (overall), content pane fills remaining space
- **Border radius:** sm: 4px, md: 8px, lg: 12px, full: 9999px
- **Key layout decisions:**
  - Search is prominent (top of sidebar or dedicated home view), not buried behind an icon
  - Client list in sidebar shows name + last-session date + amber dot for action needed
  - Content pane scrolls like a dossier: header, AI brief, session timeline, themes, billing
  - Data tables for sessions/invoices, vertical timelines for session history

## Motion
- **Approach:** Minimal-functional — the tool should feel instant and solid
- **Easing:** enter(ease-out) exit(ease-in) move(ease-in-out)
- **Duration:** micro(50-100ms) short(150-250ms) medium(250-400ms) long(400-700ms)
- **What moves:** Sidebar transitions, panel content slides, hover states on interactive elements. No bouncing, no choreography, no scroll-driven animations.

## Design Risks (deliberate departures from category)
1. **Warm dark sidebar + light content** — coaching tools are all-light or all-pastel. The contrast creates focus and instant visual identity.
2. **Amber accent instead of blue/purple/teal** — unexpected in this category. Reads as warmth, expertise, gold-standard. Must be used sparingly to avoid "warning" connotation.
3. **Serif display font for client names/headers** — coaching platforms use sans-serif everything. Instrument Serif says "editorial, authoritative, curated."

## Decisions Log
| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-03-28 | Initial design system created | Created by /design-consultation based on competitive research (Coaching.com, Profi, Delenta, Alle Loop, Linear) + Claude subagent input. Chose luxury/editorial direction to differentiate from generic coaching SaaS. |
| 2026-03-28 | Amber accent over purple/teal | Every competitor uses cool-toned accents. Amber is distinctive, warm, and signals intelligence/expertise. |
| 2026-03-28 | Split-pane dossier layout | Subagent proposed "Analyst's Notebook" concept. Adopted the dossier structure but warmed it for an executive coach audience. |
| 2026-03-28 | Instrument Serif for display | Editorial authority without being stuffy. Pairs well with DM Sans body and Geist Mono data. |
