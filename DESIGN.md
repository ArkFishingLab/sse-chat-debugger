---
version: alpha
name: SSE Chat Debugger
description: A local developer workbench for reproducible SSE requests and inspectable output.
colors:
  primary: '#087f72'
  background: '#f3f5f7'
  surface: '#ffffff'
  border: '#e2e7eb'
  text: '#202c36'
  muted: '#84909c'
typography:
  sans:
    fontFamily: 'Inter, -apple-system, BlinkMacSystemFont, Segoe UI, PingFang SC, Microsoft YaHei, sans-serif'
  mono:
    fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace'
rounded:
  DEFAULT: '6px'
  card: '8px'
omitted:
  - section: spacing
    reason: Existing component-specific spacing is canonical in style.css.
components:
  button:
    rounded: '6px'
  card:
    rounded: '8px'
---
# SSE Chat Debugger Design

## Overview
A developer instrument panel, not a marketing site. Dense request editing on the left, observable stream and run history on the right. Chinese controls and bilingual documentation serve developers debugging their own APIs; no geographic market is assumed. Keep the existing dark header, quiet light surfaces and teal actions. The signature is the separate reasoning, answer and tool-argument streams, with inspectable wire events.

## Colors
Runtime CSS remains canonical (mapping model B). `colors.primary` mirrors `style.css :root --green`, border maps to `--border`, muted to `--muted`; other colors mirror the root background, text and white card declarations. No generated theme adapter exists. New controls reuse these variables and existing card/button styles rather than changing the palette.

## Typography
System sans with Chinese fallbacks for labels; monospace for URLs, JSON, arguments and timing. Preserve the existing compact type scale, generous streaming line height and plain-text response rendering.

## Layout
Desktop uses the existing request/response grid; at 760px it becomes a single column. Run cards scroll horizontally rather than widening the page. Body keeps its raw editor and a separate read-only JSON view. New controls wrap at narrow widths.

## Elevation & Depth
Use borders and tonal surfaces. Reserve shadows for the existing modal and toast, not ordinary cards.

## Shapes
Existing 6px controls and 8px cards remain; native disclosure triangles denote JSON containers.

## Components
Buttons retain visible focus and disabled states. Only Send uses a filled primary action; Continue is a separate outlined action. A numeric field controls 1–100 sequential attempts; a live status announces progress. Stop aborts the current network request and cancels queued attempts. Completed results remain available after stop or failure. History selection is disabled while streaming and re-enabled at batch end; each selection restores its full independent snapshot. Clear clears the page history, not saved disk profiles.

The separate Append result action edits the current request body without sending. Any captured answer, reasoning or tool call is eligible, even when answer text is empty or the run was stopped. Preserve chat content, reasoning_content and tool_calls in separate fields, or complete native Responses output items with IDs/encrypted data. Do not reset manual edits. Sending remains exclusively the existing Send action and respects the execution count; tool calls are never executed or given fabricated results. Unsupported body shapes get an inline error without sending. Native details provide keyboard-operable JSON expansion; values are text nodes, never HTML. Raw input remains the source of truth. Results live only in page memory (latest 100); explicit request saves continue to use the existing local file.

Motion is functional character playback only. Respect reduced motion for transitions; immediate display remains available. Existing toasts/errors/metrics provide consistent recovery. No new dialogs or destructive workflows are introduced.

## Do's and Don'ts
- Preserve request bytes until the user explicitly formats JSON or appends a result.
- Freeze batch inputs so editing the form cannot change queued requests.
- Keep failures, cancellations and partial output inspectable.
- Do not execute tool calls, silently retry, persist run credentials, or add a request deadline.

Native selects are the canonical owner for method, saved profiles, and playback speed. Static buttons start disabled and are enabled only after module handlers are attached; this keeps loading and script-failure states honest. Native form bubbles are replaced with application feedback.
