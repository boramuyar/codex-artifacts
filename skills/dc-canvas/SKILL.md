---
name: dc-canvas
description: Create and revise interactive DC Canvas artifacts, organize design boards into pages, address pinned feedback, and share browser previews or portable HTML.
---

# DC Canvas

1. Call `artifact_list` to find existing work in the current project. Continue the matching artifact, or call `artifact_create` for new work. Use `design` for multiple boards or pages and `single` for one board.
2. Read [the authoring guide](../../GUIDE.md) for board markup, interactions, placement, and assets. Use `canvas_list` to inspect pages, frames, and comments. Pass the artifact ID on subsequent canvas and board calls.
3. Use `dc_write` to make a board with an intentional preview size. For an existing board, call `dc_read` first and use a targeted replacement or pass its revision to `dc_write`. Use `canvas_create_page` and `canvas_place_frame` to arrange a design canvas. When asked to address comments, make and verify the requested changes before resolving the relevant pins.
4. Call `artifact_open` and return its absolute URL as a browser link. If possible, preview the changed boards at their intended dimensions and try their key interactions. Use `canvas_export` when the user asks for portable HTML.
