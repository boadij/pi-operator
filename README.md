# Pi Operator

Pi Operator opens a separate Pi conversation attached to one source Pi session. Install with `pi install npm:pi-operator`, then run `/operator` in the source session. Herdr or tmux can launch a sibling pane; otherwise Pi prints a copyable attach command.

Operator inherits the source's committed, compaction-aware messages for each request and keeps its own persistent history. Imported text is untrusted evidence, never operational instructions. `operator_read_context` retrieves recent history with private reasoning and image payloads redacted. `operator_send` requires confirmation in Operator and again at the source bridge, then queues a follow-up; “submitted” is not proof of delivery or execution.

The first version is one-to-one and local-user only, supporting macOS/Linux Unix sockets. Windows named pipes and non-text source blocks are not supported. Source context is bounded, and provider-level context fidelity is not guaranteed. Operator has no ordinary coding tools or inherited authority.

## Development

Requires Node >=22.19 and npm. Run `npm ci`, `npm run validate`, and `npm run release:check`. See [architecture](docs/architecture.md) and [contributing](CONTRIBUTING.md).

## Platforms and troubleshooting

The source bridge uses a private Unix-domain socket under `~/.pi/operator`; macOS and Linux are supported. In Herdr, Operator attempts a non-focusing sibling pane; inside tmux it attempts a detached split. Elsewhere `/operator` prints the exact command to copy into a terminal. If pane startup fails, use that command. If Operator cannot attach, keep the source session running and retry against the same session; it will not switch to another session automatically. A context-budget error means the current Operator conversation plus retained source evidence cannot fit; shorten the Operator conversation or select a larger-context model. Image data is not imported (a visible omission marker is included).

## Release setup

GitHub Actions release publishing requires npm trusted publishing configured for `boadij/pi-operator` and `.github/workflows/release.yml`. Preview publication uses the same trusted publisher in `preview.yml`. Removing preview dist-tags also needs a repository Actions secret named `NPM_TOKEN` with package dist-tag permission.
