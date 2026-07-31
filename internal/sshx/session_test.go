package sshx

import (
	"encoding/json"
	"io"
	"strings"
	"sync"
	"testing"
	"time"
)

// captureConn collects the frames pumpOutput writes.
type captureConn struct {
	mu     sync.Mutex
	frames []string
	closed chan struct{}
	once   sync.Once
}

func newCaptureConn() *captureConn {
	return &captureConn{closed: make(chan struct{})}
}

func (c *captureConn) ReadMessage() (int, []byte, error) { <-c.closed; return 0, nil, io.EOF }

func (c *captureConn) WriteMessage(_ int, data []byte) error {
	var m Message
	if err := json.Unmarshal(data, &m); err != nil {
		return err
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	c.frames = append(c.frames, m.Data)
	return nil
}

func (c *captureConn) Close() error { c.once.Do(func() { close(c.closed) }); return nil }

func (c *captureConn) snapshot() (n int, joined string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return len(c.frames), strings.Join(c.frames, "")
}

// waitFor polls until cond holds or the deadline passes.
func waitFor(t *testing.T, cond func() bool) bool {
	t.Helper()
	for deadline := time.Now().Add(2 * time.Second); time.Now().Before(deadline); {
		if cond() {
			return true
		}
		time.Sleep(time.Millisecond)
	}
	return cond()
}

// slowReader hands out chunks one Read at a time, pausing between them.
type slowReader struct {
	chunks [][]byte
	gap    time.Duration
	i      int
}

func (r *slowReader) Read(p []byte) (int, error) {
	if r.i >= len(r.chunks) {
		return 0, io.EOF
	}
	if r.i > 0 && r.gap > 0 {
		time.Sleep(r.gap)
	}
	n := copy(p, r.chunks[r.i])
	r.i++
	return n, nil
}

// Output arriving back-to-back should be batched into far fewer frames than
// there were reads, without losing or reordering a byte.
func TestPumpOutputCoalescesBurst(t *testing.T) {
	const reads = 500
	var chunks [][]byte
	var want strings.Builder
	for i := 0; i < reads; i++ {
		s := "line of remote output\r\n"
		chunks = append(chunks, []byte(s))
		want.WriteString(s)
	}

	conn := newCaptureConn()
	s := &Session{ws: conn}
	go s.pumpOutput(&slowReader{chunks: chunks})

	if !waitFor(t, func() bool { _, got := conn.snapshot(); return got == want.String() }) {
		n, got := conn.snapshot()
		t.Fatalf("output mismatch: %d frames, %d bytes, want %d bytes", n, len(got), want.Len())
	}
	n, _ := conn.snapshot()
	if n >= reads {
		t.Errorf("no coalescing: %d frames for %d reads", n, reads)
	}
	t.Logf("coalesced %d reads into %d frames", reads, n)
}

// An isolated read after an idle gap must go out immediately rather than
// waiting out the batching window — this is the keystroke-echo path.
func TestPumpOutputFlushesIdleReadImmediately(t *testing.T) {
	conn := newCaptureConn()
	s := &Session{ws: conn}
	r := &slowReader{chunks: [][]byte{[]byte("a"), []byte("b")}, gap: 50 * time.Millisecond}
	go s.pumpOutput(r)

	start := time.Now()
	if !waitFor(t, func() bool { n, _ := conn.snapshot(); return n >= 1 }) {
		t.Fatal("first read never flushed")
	}
	if elapsed := time.Since(start); elapsed > coalesceWindow {
		t.Errorf("first flush took %v, want under the %v window", elapsed, coalesceWindow)
	}
	if !waitFor(t, func() bool { _, got := conn.snapshot(); return got == "ab" }) {
		_, got := conn.snapshot()
		t.Fatalf("got %q, want %q", got, "ab")
	}
	if n, _ := conn.snapshot(); n != 2 {
		t.Errorf("got %d frames, want 2 (idle reads must not be batched together)", n)
	}
}

// A multi-byte rune split across two reads must survive intact: json.Marshal
// replaces invalid UTF-8 with U+FFFD, so a frame must never end mid-rune.
func TestPumpOutputKeepsSplitRuneIntact(t *testing.T) {
	const want = "héllo → wörld ✓ 日本語"
	b := []byte(want)

	// Split every byte into its own read, so every rune straddles a boundary.
	var chunks [][]byte
	for i := range b {
		chunks = append(chunks, b[i:i+1])
	}

	conn := newCaptureConn()
	s := &Session{ws: conn}
	go s.pumpOutput(&slowReader{chunks: chunks, gap: 8 * time.Millisecond})

	if !waitFor(t, func() bool { _, got := conn.snapshot(); return got == want }) {
		_, got := conn.snapshot()
		t.Fatalf("got %q, want %q", got, want)
	}
	// Every emitted frame must itself be valid UTF-8.
	conn.mu.Lock()
	defer conn.mu.Unlock()
	for i, f := range conn.frames {
		if strings.ContainsRune(f, '�') {
			t.Errorf("frame %d contains U+FFFD: %q", i, f)
		}
	}
}

// Whatever is buffered when the stream ends must still be delivered, including
// a trailing byte sequence that is not valid UTF-8.
func TestPumpOutputFlushesTrailingBytesAtEOF(t *testing.T) {
	conn := newCaptureConn()
	s := &Session{ws: conn}
	// 0xE6 opens a 3-byte rune that never completes.
	go s.pumpOutput(&slowReader{chunks: [][]byte{[]byte("done"), {0xE6}}})

	if !waitFor(t, func() bool { _, got := conn.snapshot(); return len(got) > 0 && got != "done" }) {
		_, got := conn.snapshot()
		t.Fatalf("trailing bytes lost at EOF: got %q", got)
	}
}

func TestCompleteLen(t *testing.T) {
	cases := []struct {
		name string
		in   []byte
		want int
	}{
		{"empty", nil, 0},
		{"ascii", []byte("abc"), 3},
		{"whole 2-byte rune", []byte("é"), 2},
		{"whole 3-byte rune", []byte("→"), 3},
		{"whole 4-byte rune", []byte("𝄞"), 4},
		{"truncated 2-byte", []byte("a\xc3"), 1},
		{"truncated 3-byte", []byte("a\xe2\x86"), 1},
		{"truncated 4-byte", []byte("a\xf0\x9d\x84"), 1},
		{"ascii after whole rune", []byte("é!"), 3},
	}
	for _, c := range cases {
		if got := completeLen(c.in); got != c.want {
			t.Errorf("%s: completeLen(%q) = %d, want %d", c.name, c.in, got, c.want)
		}
	}
}
