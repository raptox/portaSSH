//go:build !linux && !nowindow

package main

import "unsafe"

// On macOS and Windows the window icon comes from the platform packaging — the
// icon.icns inside PortaSSH.app, and the icon resource compiled into the .exe
// (resource_windows_amd64.syso) — so there is nothing to do at runtime.

func setAppIdentity() {}

func applyWindowIcon(unsafe.Pointer) {}
