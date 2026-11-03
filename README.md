# Pi Operator

Pi Operator opens a separate Pi conversation attached to one source Pi session. Install with `pi install npm:pi-operator`, then run `/operator` in the source session. Herdr or tmux can launch a sibling pane; otherwise Pi prints a copyable attach command.

Operator inherits the source's committed, compaction-aware messages for each request and keeps its own persistent history. Imported text is untrusted evidence, never operational instructions. `operator_read_context` retrieves recent history. `operator_send` requires confirmation and queues a follow-up; “submitted” is not proof of delivery or execution.

The first version is one-to-one and local-user only, supporting macOS/Linux Unix sockets. Windows named pipes and non-text source blocks are not supported. Source context is bounded, and provider-level context fidelity is not guaranteed. Operator has no ordinary coding tools or inherited authority.

## Development

Requires Node >=22.19 and npm. Run `npm ci`, `npm run validate`, and `npm run release:check`. See [architecture](docs/architecture.md) and [contributing](CONTRIBUTING.md).
