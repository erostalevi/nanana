package tunnel

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math/rand"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"
)

// ExitError is a terminal condition: the client must not reconnect.
type ExitError struct {
	Code int
	Msg  string
}

func (e *ExitError) Error() string { return e.Msg }

// Event describes one proxied request for the live tail.
type Event struct {
	Time    time.Time
	ID      string
	Method  string
	Path    string
	Status  int // 0 when the request failed
	Latency time.Duration
	Replay  bool
	ErrCode string // set when Status == 0
	ErrMsg  string
}

// Hooks receive lifecycle notifications. All fields are optional.
type Hooks struct {
	Connecting   func(attempt int)
	Connected    func(hello Message)
	Disconnected func(err error, retryIn time.Duration)
	Request      func(Event)
}

// Config configures a Client.
type Config struct {
	APIBase       string
	Token         string
	Sub           string
	Target        Target
	PreserveHost  bool
	Insecure      bool
	ClientVersion string
	Hooks         Hooks

	RequestTimeout time.Duration // default 25s
	MaxInFlight    int           // default 20
	BackoffMin     time.Duration // default 1s
	BackoffMax     time.Duration // default 30s
	IdleTimeout    time.Duration // default 60s
}

// Client maintains a tunnel to the nanana server.
type Client struct {
	cfg Config
	hc  *http.Client
}

func New(cfg Config) *Client {
	if cfg.RequestTimeout == 0 {
		cfg.RequestTimeout = 25 * time.Second
	}
	if cfg.MaxInFlight == 0 {
		cfg.MaxInFlight = 20
	}
	if cfg.BackoffMin == 0 {
		cfg.BackoffMin = time.Second
	}
	if cfg.BackoffMax == 0 {
		cfg.BackoffMax = 30 * time.Second
	}
	if cfg.IdleTimeout == 0 {
		cfg.IdleTimeout = 60 * time.Second
	}
	return &Client{cfg: cfg, hc: newHTTPClient(cfg.RequestTimeout, cfg.Insecure)}
}

// WSURL converts the API base into the tunnel websocket URL.
func WSURL(apiBase, sub string) (string, error) {
	u, err := url.Parse(apiBase)
	if err != nil {
		return "", err
	}
	switch u.Scheme {
	case "https":
		u.Scheme = "wss"
	case "http":
		u.Scheme = "ws"
	default:
		return "", fmt.Errorf("unsupported API scheme %q", u.Scheme)
	}
	u.Path = strings.TrimRight(u.Path, "/") + "/tunnel"
	u.RawQuery = url.Values{"sub": {sub}}.Encode()
	return u.String(), nil
}

// Run connects and serves until ctx is cancelled (returns nil) or a terminal
// condition occurs (returns *ExitError).
func (c *Client) Run(ctx context.Context) error {
	attempt := 0
	for {
		if h := c.cfg.Hooks.Connecting; h != nil {
			h(attempt)
		}
		connected, err := c.session(ctx)
		if ctx.Err() != nil {
			return nil
		}
		var ee *ExitError
		if errors.As(err, &ee) {
			return ee
		}
		if connected {
			attempt = 0
		}
		delay := backoff(attempt, c.cfg.BackoffMin, c.cfg.BackoffMax)
		attempt++
		if h := c.cfg.Hooks.Disconnected; h != nil {
			h(err, delay)
		}
		select {
		case <-ctx.Done():
			return nil
		case <-time.After(delay):
		}
	}
}

func backoff(attempt int, min, max time.Duration) time.Duration {
	d := min
	for i := 0; i < attempt && d < max; i++ {
		d *= 2
	}
	if d > max {
		d = max
	}
	// +-25% jitter
	j := 0.75 + rand.Float64()*0.5
	d = time.Duration(float64(d) * j)
	if d > max {
		d = max
	}
	return d
}

type pending struct {
	msg    Message
	buf    []byte
	got    int
	reject string
}

type session struct {
	c        *Client
	conn     *websocket.Conn
	wmu      sync.Mutex
	inflight atomic.Int32
	wg       sync.WaitGroup
	ctx      context.Context
}

func (s *session) sendJSON(v interface{}) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	s.wmu.Lock()
	defer s.wmu.Unlock()
	_ = s.conn.SetWriteDeadline(time.Now().Add(30 * time.Second))
	return s.conn.WriteMessage(websocket.TextMessage, b)
}

func (s *session) sendBinary(b []byte) error {
	s.wmu.Lock()
	defer s.wmu.Unlock()
	_ = s.conn.SetWriteDeadline(time.Now().Add(30 * time.Second))
	return s.conn.WriteMessage(websocket.BinaryMessage, b)
}

func (c *Client) dial(ctx context.Context) (*websocket.Conn, error) {
	wsu, err := WSURL(c.cfg.APIBase, c.cfg.Sub)
	if err != nil {
		return nil, &ExitError{Code: 1, Msg: err.Error()}
	}
	h := http.Header{}
	h.Set("Authorization", "Bearer "+c.cfg.Token)
	h.Set("X-Nanana-Protocol", "1")
	h.Set("X-Nanana-Client", "nanana-cli/"+c.cfg.ClientVersion)
	d := websocket.Dialer{HandshakeTimeout: 15 * time.Second, Proxy: http.ProxyFromEnvironment}
	conn, resp, err := d.DialContext(ctx, wsu, h)
	if err != nil {
		if resp != nil {
			return nil, httpDialError(resp.StatusCode)
		}
		return nil, err
	}
	return conn, nil
}

func httpDialError(status int) error {
	switch status {
	case 401:
		return &ExitError{1, "unauthorized: the token is invalid or revoked (run `nanana login` or check -t)"}
	case 403:
		return &ExitError{1, "forbidden: this token does not own that subdomain"}
	case 404:
		return &ExitError{1, "not found: that subdomain does not exist (it may have expired or been deleted)"}
	case 426:
		return &ExitError{1, "upgrade required: this nanana CLI is too old for the server; run `nanana update-check` and upgrade"}
	}
	return fmt.Errorf("tunnel handshake failed: HTTP %d", status)
}

// session runs one connection. connected reports whether the hello was received.
func (c *Client) session(parent context.Context) (connected bool, err error) {
	conn, err := c.dial(parent)
	if err != nil {
		return false, err
	}
	ctx, cancel := context.WithCancel(parent)
	s := &session{c: c, conn: conn, ctx: ctx}
	done := make(chan struct{})
	go func() { // graceful shutdown: close frame unblocks the read loop
		select {
		case <-parent.Done():
			s.wmu.Lock()
			_ = conn.WriteControl(websocket.CloseMessage,
				websocket.FormatCloseMessage(websocket.CloseNormalClosure, "bye"), time.Now().Add(time.Second))
			s.wmu.Unlock()
			conn.Close()
		case <-done:
		}
	}()
	defer func() {
		close(done)
		cancel()
		conn.Close()
		s.wg.Wait()
	}()

	pend := map[string]*pending{}
	for {
		_ = conn.SetReadDeadline(time.Now().Add(c.cfg.IdleTimeout))
		typ, data, rerr := conn.ReadMessage()
		if rerr != nil {
			if parent.Err() != nil {
				return connected, nil
			}
			return connected, fmt.Errorf("connection lost: %w", rerr)
		}
		switch typ {
		case websocket.TextMessage:
			var m Message
			if err := json.Unmarshal(data, &m); err != nil {
				continue
			}
			switch m.T {
			case "hello":
				connected = true
				if h := c.cfg.Hooks.Connected; h != nil {
					h(m)
				}
			case "ping":
				_ = s.sendJSON(map[string]string{"t": "pong"})
			case "bye":
				return connected, byeError(m.Reason)
			case "req":
				p := &pending{msg: m}
				if s.inflight.Load() >= int32(c.cfg.MaxInFlight) {
					p.reject = "too many in-flight requests (max 20)"
				} else if m.BodyLen > 64<<20 {
					p.reject = "request body too large"
				}
				s.inflight.Add(1)
				if m.BodyLen <= 0 {
					s.start(p)
				} else {
					if p.reject == "" {
						p.buf = make([]byte, 0, m.BodyLen)
					}
					pend[m.ID] = p
				}
			}
		case websocket.BinaryMessage:
			id, chunk, err := DecodeBinary(data)
			if err != nil {
				continue
			}
			key := FormatUUID(id)
			p := pend[key]
			if p == nil {
				continue
			}
			p.got += len(chunk)
			if p.reject == "" {
				p.buf = append(p.buf, chunk...)
			}
			if p.got >= p.msg.BodyLen {
				delete(pend, key)
				s.start(p)
			}
		}
	}
}

func byeError(reason string) error {
	switch reason {
	case "replaced":
		return &ExitError{2, "this tunnel was replaced: another client connected to the same subdomain (only one tunnel per subdomain is allowed)"}
	case "deleted":
		return &ExitError{1, "the subdomain was deleted"}
	case "expired":
		return &ExitError{1, "the subdomain expired"}
	}
	return fmt.Errorf("server closed the tunnel (%s)", reason)
}

func (s *session) start(p *pending) {
	s.wg.Add(1)
	go func() {
		defer s.wg.Done()
		defer s.inflight.Add(-1)
		s.handle(p)
	}()
}

func (s *session) handle(p *pending) {
	m := p.msg
	t0 := time.Now()
	ev := Event{Time: t0, ID: m.ID, Method: m.Method, Path: m.Path, Replay: m.Replay}
	emit := func() {
		ev.Latency = time.Since(t0)
		if h := s.c.cfg.Hooks.Request; h != nil {
			h(ev)
		}
	}
	fail := func(code, msg string) {
		ev.ErrCode, ev.ErrMsg = code, msg
		_ = s.sendJSON(Message{T: "err", ID: m.ID, Code: code, Msg: msg})
		emit()
	}
	if p.reject != "" {
		fail("EOTHER", p.reject)
		return
	}
	res, perr := forward(s.ctx, s.c.hc, s.c.cfg.Target, s.c.cfg.PreserveHost, &m, p.buf)
	if perr != nil {
		if s.ctx.Err() != nil {
			return
		}
		fail(perr.Code, perr.Msg)
		return
	}
	id, err := ParseUUID(m.ID)
	if err != nil {
		fail("EOTHER", err.Error())
		return
	}
	if err := s.sendJSON(Message{T: "res", ID: m.ID, Status: res.Status, Headers: res.Headers, BodyLen: len(res.Body)}); err != nil {
		return
	}
	for off := 0; off < len(res.Body); off += ChunkSize {
		end := off + ChunkSize
		if end > len(res.Body) {
			end = len(res.Body)
		}
		if err := s.sendBinary(EncodeBinary(id, res.Body[off:end])); err != nil {
			return
		}
	}
	ev.Status = res.Status
	emit()
}
