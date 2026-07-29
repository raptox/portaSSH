//go:build !nowindow

package main

import (
	"errors"
	"fmt"

	webview "github.com/webview/webview_go"
)

// hasNativeWindow reports whether this build can open a native window.
func hasNativeWindow() bool { return true }

// openWindow opens PortaSSH in a native OS window (WKWebView on macOS,
// WebView2 on Windows, WebKitGTK on Linux) pointed at the local UI. It blocks
// on the platform UI loop and returns when the window is closed. Must be called
// from the main OS thread.
func openWindow(title, url string) (err error) {
	defer func() {
		if r := recover(); r != nil {
			err = fmt.Errorf("native window failed: %v", r)
		}
	}()
	w := webview.New(false) // debug=false
	if w == nil {
		return errors.New("could not create a native window (no web engine available)")
	}
	defer w.Destroy()
	w.SetTitle(title)
	w.SetSize(1200, 820, webview.HintNone)
	w.SetSize(720, 480, webview.HintMin)
	w.Navigate(url)
	w.Run() // blocks until the window is closed
	return nil
}
