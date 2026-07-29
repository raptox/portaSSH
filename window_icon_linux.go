//go:build linux && !nowindow

package main

/*
#cgo pkg-config: gtk+-3.0
#include <stdlib.h>
#include <gtk/gtk.h>
#include <gdk-pixbuf/gdk-pixbuf.h>

// glib turns g_object_ref/unref into type-safe macros under GCC, which cgo
// cannot call, so reach them through plain functions.
static void portassh_ref(gpointer obj)   { g_object_ref(obj); }
static void portassh_unref(gpointer obj) { g_object_unref(obj); }
*/
import "C"

import "unsafe"

// setAppIdentity gives the process a stable program name before GTK starts.
// GDK derives the X11 WM_CLASS and the Wayland app_id from it, and desktop
// shells use that to match a .desktop entry — without it the app is identified
// by the (versioned) binary filename and nothing can match it.
func setAppIdentity() {
	name := C.CString(appID)
	defer C.free(unsafe.Pointer(name)) // g_set_prgname copies the string
	C.g_set_prgname(name)
}

// applyWindowIcon attaches the embedded icon to the webview's GtkWindow, at
// every size we ship so the window manager can pick what it needs. This is what
// X11 (and XWayland) window managers read via _NET_WM_ICON.
//
// GTK3 has no way to send an icon over Wayland, so under a Wayland session the
// shell instead looks up an installed .desktop entry — see --install-desktop-entry.
func applyWindowIcon(win unsafe.Pointer) {
	var (
		list    *C.GList
		pixbufs []*C.GdkPixbuf
	)
	for _, size := range iconSizes {
		data, err := iconPNG(size)
		if err != nil {
			continue
		}
		pb := pixbufFromPNG(data)
		if pb == nil {
			continue
		}
		pixbufs = append(pixbufs, pb)
		list = C.g_list_append(list, C.gpointer(unsafe.Pointer(pb)))
	}
	if list == nil {
		return
	}
	C.gtk_window_set_default_icon_list(list) // also covers dialogs GTK opens itself
	if win != nil {
		C.gtk_window_set_icon_list((*C.GtkWindow)(win), list)
	}
	// GTK refs what it keeps, so drop our own references.
	C.g_list_free(list)
	for _, pb := range pixbufs {
		C.portassh_unref(C.gpointer(unsafe.Pointer(pb)))
	}
}

// pixbufFromPNG decodes PNG bytes into a GdkPixbuf, or nil if gdk-pixbuf can't
// (a missing PNG loader shouldn't stop the app from opening).
func pixbufFromPNG(png []byte) *C.GdkPixbuf {
	if len(png) == 0 {
		return nil
	}
	loader := C.gdk_pixbuf_loader_new()
	if loader == nil {
		return nil
	}
	defer C.portassh_unref(C.gpointer(unsafe.Pointer(loader)))

	ok := C.gdk_pixbuf_loader_write(loader, (*C.guchar)(unsafe.Pointer(&png[0])), C.gsize(len(png)), nil)
	C.gdk_pixbuf_loader_close(loader, nil)
	if ok == 0 {
		return nil
	}
	pb := C.gdk_pixbuf_loader_get_pixbuf(loader)
	if pb == nil {
		return nil
	}
	C.portassh_ref(C.gpointer(unsafe.Pointer(pb))) // outlive the loader
	return pb
}
