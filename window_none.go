//go:build nowindow

// This stub is used for headless / pure-Go builds (`go build -tags nowindow`),
// which drop the cgo WebView dependency. In that mode PortaSSH serves the UI and
// opens a browser instead of a native window.

package main

import "errors"

func hasNativeWindow() bool { return false }

func openWindow(title, url string) error {
	return errors.New("this build has no native-window support (built with -tags nowindow)")
}
