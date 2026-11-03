# Architecture

Two independent Pi sessions have separate owners and histories. The source extension serves a same-user Unix socket identified by exact session ID and session file. The Operator session contacts only that bound bridge, borrows committed source evidence request-by-request, and stores only its own conversation plus attachment metadata. The bridge accepts read requests and an explicitly confirmed instruction submission; it grants no source tools or authority. Submission is asynchronous and not a delivery guarantee.

Socket permissions are private to the user. Context is serialized as attributed text and bounded; historical lookup is exposed as a tool. Non-text content, Windows named pipes, multiple attachments, delivery outboxes, and manual Operator compaction are out of scope. Herdr and tmux are optional; the shell command is the universal fallback.
