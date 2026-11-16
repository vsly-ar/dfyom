# DFYOM – Design For Your Own Manufacturing

A desktop app for hobbyists and small shops who own CNC machines: **design** manufacturable parts, **plan** the manufacturing process, and **run** it on your machines – with LLM agents as first-class users.

- What and why: [docs/vision.md](docs/vision.md)
- Principles: [docs/principles.md](docs/principles.md)
- All docs: [docs/README.md](docs/README.md)

## Development

Requires Node ≥ 22.12 (see `.nvmrc`).

```sh
npm install        # also enables git hooks (.githooks/)
npm run dev        # start the app with hot reload
npm run check      # typecheck + unit tests
npm run build      # production build to out/
```

Commits that change app code bump the version automatically – see [docs/conventions/versioning.md](docs/conventions/versioning.md).
