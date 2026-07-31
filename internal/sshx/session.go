// Package sshx bridges an interactive SSH PTY session to a websocket, so the
// browser's xterm.js terminal can drive a real remote shell.
package sshx

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"sync"
	"time"
	"unicode/utf8"

	"golang.org/x/crypto/ssh"

	"portassh/internal/vault"
)

// knownHostCallback lets the caller decide how to handle host-key verification.
// For a portable app we default to trust-on-first-use tracked in the vault dir,
// but the server wires this up.
type Message struct {
	Type string `json:"type"` // "data" | "resize" | "error" | "status"
	Data string `json:"data,omitempty"`
	Cols int    `json:"cols,omitempty"`
	Rows int    `json:"rows,omitempty"`
}

// Conn is the minimal websocket surface Session needs. It matches
// *gorilla/websocket.Conn.
type Conn interface {
	ReadMessage() (messageType int, p []byte, err error)
	WriteMessage(messageType int, data []byte) error
	Close() error
}

const textMessage = 1 // websocket.TextMessage

// Dial establishes an SSH connection for the given credential and returns a
// live client. The caller is responsible for closing it.
func Dial(cred vault.Credential, hostKeyCb ssh.HostKeyCallback) (*ssh.Client, error) {
	auths, err := authMethods(cred)
	if err != nil {
		return nil, err
	}
	cfg := &ssh.ClientConfig{
		User:            cred.User,
		Auth:            auths,
		HostKeyCallback: hostKeyCb,
		Timeout:         15 * time.Second,
	}
	addr := net.JoinHostPort(cred.Host, fmt.Sprintf("%d", cred.Port))
	client, err := ssh.Dial("tcp", addr, cfg)
	if err != nil {
		return nil, err
	}
	return client, nil
}

func authMethods(cred vault.Credential) ([]ssh.AuthMethod, error) {
	switch cred.Auth {
	case vault.AuthPassword:
		return []ssh.AuthMethod{
			ssh.Password(cred.Password),
			// Some servers use keyboard-interactive for passwords.
			ssh.KeyboardInteractive(func(_, _ string, questions []string, _ []bool) ([]string, error) {
				answers := make([]string, len(questions))
				for i := range answers {
					answers[i] = cred.Password
				}
				return answers, nil
			}),
		}, nil
	case vault.AuthKey:
		var signer ssh.Signer
		var err error
		if cred.Passphrase != "" {
			signer, err = ssh.ParsePrivateKeyWithPassphrase([]byte(cred.PrivateKey), []byte(cred.Passphrase))
		} else {
			signer, err = ssh.ParsePrivateKey([]byte(cred.PrivateKey))
		}
		if err != nil {
			return nil, fmt.Errorf("parse private key: %w", err)
		}
		return []ssh.AuthMethod{ssh.PublicKeys(signer)}, nil
	case vault.AuthAgent:
		return nil, errors.New("ssh-agent auth is not yet supported")
	default:
		return nil, fmt.Errorf("unknown auth method %q", cred.Auth)
	}
}

// Session couples an SSH channel with a websocket and pumps bytes both ways.
type Session struct {
	client  *ssh.Client
	sess    *ssh.Session
	ws      Conn
	stdin   io.WriteCloser
	writeMu sync.Mutex
	once    sync.Once
}

// NewSession opens an interactive shell with a PTY on the given client and
// wires it to the websocket. cols/rows set the initial terminal size.
func NewSession(client *ssh.Client, ws Conn, cols, rows int) (*Session, error) {
	sess, err := client.NewSession()
	if err != nil {
		return nil, err
	}
	if cols <= 0 {
		cols = 80
	}
	if rows <= 0 {
		rows = 24
	}
	modes := ssh.TerminalModes{
		ssh.ECHO:          1,
		ssh.TTY_OP_ISPEED: 14400,
		ssh.TTY_OP_OSPEED: 14400,
	}
	if err := sess.RequestPty("xterm-256color", rows, cols, modes); err != nil {
		sess.Close()
		return nil, fmt.Errorf("request pty: %w", err)
	}
	stdin, err := sess.StdinPipe()
	if err != nil {
		sess.Close()
		return nil, err
	}
	stdout, err := sess.StdoutPipe()
	if err != nil {
		sess.Close()
		return nil, err
	}
	stderr, err := sess.StderrPipe()
	if err != nil {
		sess.Close()
		return nil, err
	}
	if err := sess.Shell(); err != nil {
		sess.Close()
		return nil, fmt.Errorf("start shell: %w", err)
	}

	s := &Session{client: client, sess: sess, ws: ws, stdin: stdin}

	// Remote stdout/stderr -> websocket
	go s.pumpOutput(stdout)
	go s.pumpOutput(stderr)

	return s, nil
}

const (
	// maxFrame caps how much output one "data" frame carries.
	maxFrame = 32 * 1024

	// coalesceWindow bounds how long output may wait for more to join it. A
	// chatty shell hands us many small reads, and one websocket frame per read
	// makes the browser pay JSON.parse + xterm write overhead per fragment —
	// which is what the WebKitGTK build (Linux) is slowest at. Batching within
	// a window well under a display frame (~16ms) is invisible either way.
	coalesceWindow = 5 * time.Millisecond
)

// pumpOutput streams remote output to the browser as "data" frames, batching
// reads that arrive close together. The read loop lives in its own goroutine so
// that a blocking Read can never strand already-buffered bytes.
func (s *Session) pumpOutput(r io.Reader) {
	chunks := make(chan []byte, 64)
	go func() {
		defer close(chunks)
		buf := make([]byte, maxFrame)
		for {
			n, err := r.Read(buf)
			if n > 0 {
				chunks <- append([]byte(nil), buf[:n]...)
			}
			if err != nil {
				return
			}
		}
	}()

	var (
		pending   []byte
		lastFlush time.Time
		timer     *time.Timer
		timerC    <-chan time.Time
	)
	stopTimer := func() {
		if timer != nil {
			timer.Stop()
			timer, timerC = nil, nil
		}
	}
	// flush sends what is buffered, holding back a trailing partial UTF-8
	// sequence so a multi-byte rune split across two reads isn't mangled into
	// U+FFFD by json.Marshal. all=true overrides that for the final flush.
	flush := func(all bool) {
		n := len(pending)
		if !all {
			n = completeLen(pending)
		}
		if n == 0 {
			return
		}
		s.sendJSON(Message{Type: "data", Data: string(pending[:n])})
		pending = append(pending[:0], pending[n:]...)
		lastFlush = time.Now()
	}

	for {
		select {
		case c, ok := <-chunks:
			if !ok {
				stopTimer()
				flush(true)
				return
			}
			pending = append(pending, c...)
			// Flush at once when the buffer is full, or when output has been
			// idle long enough that nothing is waiting to join it — so an
			// isolated keystroke echo never pays the batching delay.
			switch wait := coalesceWindow - time.Since(lastFlush); {
			case len(pending) >= maxFrame || wait <= 0:
				stopTimer()
				flush(false)
			case timerC == nil:
				timer = time.NewTimer(wait)
				timerC = timer.C
			}
		case <-timerC:
			timer, timerC = nil, nil
			flush(false)
		}
	}
}

// completeLen is the length of b with any trailing incomplete UTF-8 sequence
// trimmed off.
func completeLen(b []byte) int {
	for i := len(b) - 1; i >= 0 && i >= len(b)-utf8.UTFMax; i-- {
		if !utf8.RuneStart(b[i]) {
			continue
		}
		// b[i:] is the last rune in the buffer, whole or truncated.
		if r, size := utf8.DecodeRune(b[i:]); r == utf8.RuneError && size <= 1 {
			return i
		}
		return len(b)
	}
	return len(b)
}

// Run blocks reading websocket frames from the browser and applying them to the
// session, until the socket or shell closes. It then tears everything down.
func (s *Session) Run() {
	defer s.Close()

	// Watch for the remote shell exiting.
	go func() {
		err := s.sess.Wait()
		msg := "session closed"
		if err != nil {
			msg = err.Error()
		}
		s.sendJSON(Message{Type: "status", Data: msg})
		s.Close()
	}()

	for {
		mt, raw, err := s.ws.ReadMessage()
		if err != nil {
			return
		}
		if mt != textMessage {
			continue
		}
		var m Message
		if err := json.Unmarshal(raw, &m); err != nil {
			continue
		}
		switch m.Type {
		case "data":
			if _, err := s.stdin.Write([]byte(m.Data)); err != nil {
				return
			}
		case "resize":
			if m.Cols > 0 && m.Rows > 0 {
				_ = s.sess.WindowChange(m.Rows, m.Cols)
			}
		}
	}
}

func (s *Session) sendJSON(m Message) {
	b, err := json.Marshal(m)
	if err != nil {
		return
	}
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	_ = s.ws.WriteMessage(textMessage, b)
}

// Close tears down the SSH session, client, and websocket exactly once.
func (s *Session) Close() {
	s.once.Do(func() {
		if s.stdin != nil {
			_ = s.stdin.Close()
		}
		if s.sess != nil {
			_ = s.sess.Close()
		}
		if s.client != nil {
			_ = s.client.Close()
		}
		if s.ws != nil {
			_ = s.ws.Close()
		}
	})
}
