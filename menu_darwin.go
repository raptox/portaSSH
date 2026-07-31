//go:build darwin && !nowindow

package main

/*
#cgo CFLAGS: -x objective-c
#cgo LDFLAGS: -framework Cocoa
#import <Cocoa/Cocoa.h>
#include <stdlib.h>

// A menu item's default key-equivalent modifier is ⌘, so only the items that
// want something else pass a mask.
static void addItem(NSMenu *menu, NSString *title, SEL action, NSString *key,
                    NSEventModifierFlags mods) {
	NSMenuItem *item = [[NSMenuItem alloc] initWithTitle:title
	                                             action:action
	                                      keyEquivalent:key];
	if (mods) {
		[item setKeyEquivalentModifierMask:mods];
	}
	[menu addItem:item];
}

static NSMenu *addSubmenu(NSMenu *bar, NSString *title) {
	NSMenuItem *item = [[NSMenuItem alloc] initWithTitle:title action:NULL keyEquivalent:@""];
	NSMenu *menu = [[NSMenu alloc] initWithTitle:title];
	[item setSubmenu:menu];
	[bar addItem:item];
	return menu;
}

// portasshInstallAppMenu builds the menu bar the WebView toolkit never creates.
// Every item targets nil, so AppKit walks the responder chain and the WebView
// performs the action itself.
//
// The menu bar lives for the whole process, so nothing here is released — NSApp
// owns the bar, each item owns its submenu, and there is no teardown path.
void portasshInstallAppMenu(const char *cName) {
	@autoreleasepool {
		NSApplication *app = [NSApplication sharedApplication];
		if ([app mainMenu]) {
			return; // a toolkit or bundle already provided one
		}
		NSString *name = [NSString stringWithUTF8String:cName];
		NSMenu *bar = [[NSMenu alloc] init];

		NSMenu *appMenu = addSubmenu(bar, name);
		addItem(appMenu, [@"About " stringByAppendingString:name],
		        @selector(orderFrontStandardAboutPanel:), @"", 0);
		[appMenu addItem:[NSMenuItem separatorItem]];
		addItem(appMenu, [@"Hide " stringByAppendingString:name], @selector(hide:), @"h", 0);
		addItem(appMenu, @"Hide Others", @selector(hideOtherApplications:), @"h",
		        NSEventModifierFlagCommand | NSEventModifierFlagOption);
		addItem(appMenu, @"Show All", @selector(unhideAllApplications:), @"", 0);
		[appMenu addItem:[NSMenuItem separatorItem]];
		addItem(appMenu, [@"Quit " stringByAppendingString:name], @selector(terminate:), @"q", 0);

		// The Edit menu is the point of the exercise: on macOS it is what turns
		// ⌘X/⌘C/⌘V/⌘A into the cut:/copy:/paste:/selectAll: actions the WebView
		// implements natively. Without it those keys do nothing at all.
		NSMenu *edit = addSubmenu(bar, @"Edit");
		addItem(edit, @"Undo", @selector(undo:), @"z", 0);
		addItem(edit, @"Redo", @selector(redo:), @"z",
		        NSEventModifierFlagCommand | NSEventModifierFlagShift);
		[edit addItem:[NSMenuItem separatorItem]];
		addItem(edit, @"Cut", @selector(cut:), @"x", 0);
		addItem(edit, @"Copy", @selector(copy:), @"c", 0);
		addItem(edit, @"Paste", @selector(paste:), @"v", 0);
		addItem(edit, @"Select All", @selector(selectAll:), @"a", 0);

		NSMenu *window = addSubmenu(bar, @"Window");
		addItem(window, @"Minimize", @selector(performMiniaturize:), @"m", 0);
		addItem(window, @"Zoom", @selector(performZoom:), @"", 0);
		[window addItem:[NSMenuItem separatorItem]];
		addItem(window, @"Close Window", @selector(performClose:), @"w", 0);

		[app setMainMenu:bar];
		[app setWindowsMenu:window];
	}
}
*/
import "C"

import "unsafe"

// installAppMenu gives the app a macOS menu bar. The WebView toolkit creates an
// NSApplication but never a menu, and on macOS the menu bar is what dispatches
// ⌘-key equivalents — so without one ⌘Q, ⌘W, ⌘M and the whole Edit menu are
// dead. Call it after the toolkit has created the NSApplication.
//
// Note this does not by itself fix copy/paste in the terminal: a terminal
// selection is drawn, not a DOM selection, so the WebView's native copy: has
// nothing to act on. The web UI still handles that case itself.
func installAppMenu(name string) {
	cName := C.CString(name)
	defer C.free(unsafe.Pointer(cName))
	C.portasshInstallAppMenu(cName)
}
