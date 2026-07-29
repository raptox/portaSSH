//go:build !linux

package main

// Desktop entries are a Linux (freedesktop.org) concept; macOS and Windows get
// the app icon and name from the .app bundle and the .exe resources.

func handleDesktopEntryFlags() bool { return false }
