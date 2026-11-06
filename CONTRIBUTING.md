# Contribute to Codex Artifacts

You can change how Codex works with DC Canvas by editing one Markdown file: [`skills/dc-canvas/SKILL.md`](skills/dc-canvas/SKILL.md). Keep the frontmatter name `dc-canvas`; the description tells Codex when to use the skill. Put reusable board syntax and examples in [`GUIDE.md`](GUIDE.md).

| Change | Start here |
| --- | --- |
| Agent workflow and behavior | `skills/dc-canvas/SKILL.md` |
| Board authoring reference | `GUIDE.md` |
| Canvas editor and library | `ui/` |
| MCP tools, artifact storage, and rendering | `src/` |
| Plugin and marketplace setup | `plugin.json`, `mcp.json`, `.agents/plugins/marketplace.json` |

Fork the repository and work in a branch. With Node.js 20 or newer, `npm test` runs the suite without installing dependencies. Start the editor with `node bin/dc-canvas.mjs serve` and open [the local library](http://127.0.0.1:4173/).

To try your skill in Codex, register your checkout and install the local copy:

```sh
codex plugin marketplace add .
codex plugin add dc-canvas@codex-artifacts
```

If you already track the GitHub marketplace under the same name, remove that marketplace before registering your checkout. After editing the skill, remove and reinstall the local plugin, then start a new chat (restart the desktop app if it still shows the previous version). Ask Codex to make a small board and return its browser link. Describe the prompt and the behavior you verified in your pull request.

Keep local libraries, board exports, and credentials out of pull requests. Use synthetic examples for tests or screenshots.
