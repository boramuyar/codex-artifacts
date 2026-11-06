# Author a local artboard

In library mode, start with artifact_list to find artifacts in the conversation's origin folder. Create a new artifact with artifact_create. Use type design for a workspace with pages and freely positioned frames, or type single for one board. Pass the artifact ID as artifact on every board, page, comment, asset, or export call. In MCP, call artifact_open to get the full browser URL for the live result.

Use canvas_list to discover pages, frames, and comments. Use dc_read before revising a board.

Create a board with dc_write. Pass a filename ending in .dc.html, a short title, inner template markup in html, optional logic in js, and optional metadata in props. The tool writes the document shell. Set props.$preview to an object with integer width and height in CSS pixels. The viewer uses those dimensions for the frame.

For design artifacts, use canvas_create_page to group related boards. Pass the page ID to dc_write or canvas_place_frame, and supply x and y together for explicit canvas coordinates. Frames with automatic placement sit side by side. For a single artifact, write one board and leave page and placement fields out.

## Template and logic

- Put ordinary HTML and inline SVG in html. Use <helmet><style> for CSS, and choose a compact palette and type scale that fit the user's brief. Keep text as literal markup when it can be edited independently.
- Put code in a class named Component extending DCLogic. Use this.state and this.setState. Return display values and event handlers from renderVals(). Use componentDidMount, componentDidUpdate, and componentWillUnmount for lifecycle work when needed.
- Bind values by name with {{count}} or {{item.label}}. Compute conditions and derived values in renderVals(). A whole attribute can bind a function, as in onClick="{{increment}}".
- Repeat markup with <sc-for list="{{items}}" as="item">. The loop provides item and $index. Render a branch with <sc-if value="{{showDetails}}">.
- Define configurable inputs with props keys that carry a default field. Read the values through this.props or directly in template bindings.
- Use real buttons, inputs, and links. Include focus states and fit the content to the intended frame. Try interactions in the preview before exporting.

## Edits and assets

Use dc_html_str_replace or dc_js_str_replace for a targeted edit. Set replace_all only when every match should change. dc_set_props replaces the property metadata. For a full rewrite, pass the revision from dc_read to catch concurrent changes.

Store local images, fonts, or videos with asset_put or put the files in the project's assets directory. Use literal assets/name.ext URLs in src, href, poster, or CSS url(...). The viewer and exporter inline those files.

Use comment_add with a filename, text, and x and y fractions between 0 and 1 to leave a pin. Use comment_resolve when the feedback is addressed.

Call canvas_export to produce a portable HTML file. A single artifact exports its board. For a design artifact, pass frame to export one standalone board, page to export one page, or omit both to export all pages as a gallery. The portable renderer supports the template features above, plain JavaScript logic, and local assets. Build each board's layout within its own template. The preview runs in an isolated frame with network requests blocked.
