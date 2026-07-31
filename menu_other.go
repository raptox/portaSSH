//go:build !darwin && !nowindow

package main

// Only macOS drives its ⌘-key equivalents through an application menu bar.
// Windows and Linux deliver Ctrl+C/V/X/A straight to the web content.

func installAppMenu(string) {}
