package server

import "embed"

// webFS holds the entire frontend, baked into the binary so PortaSSH stays a
// single self-contained file with no external assets.
//
//go:embed web
var webFS embed.FS
