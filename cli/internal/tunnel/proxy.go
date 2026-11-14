package tunnel

import (
	"bytes"
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"syscall"
	"time"
)

var hopByHop = map[string]bool{
	"connection": true, "keep-alive": true, "proxy-authenticate": true,
	"proxy-authorization": true, "proxy-connection": true, "te": true,
	"trailer": true, "trailers": true, "transfer-encoding": true, "upgrade": true,
}

// Target is the local service requests are proxied to.
type Target struct {
	Scheme string // http or https
	Host   string
	Port   string
}

func (t Target) HostPort() string { return net.JoinHostPort(t.Host, t.Port) }
func (t Target) String() string   { return t.Scheme + "://" + t.HostPort() }

// ProxyError is a classified forwarding failure.
type ProxyError struct {
	Code string // ECONNREFUSED, ETIMEDOUT, EHOSTUNREACH, EOTHER
	Msg  string
}

func (e *ProxyError) Error() string { return e.Code + ": " + e.Msg }

// Result is a completed local response.
type Result struct {
	Status  int
	Headers Headers
	Body    []byte
}

func newHTTPClient(timeout time.Duration, insecure bool) *http.Client {
	tr := &http.Transport{
		Proxy:               nil,
		DisableCompression:  true,
		MaxIdleConnsPerHost: 20,
		IdleConnTimeout:     30 * time.Second,
		TLSClientConfig:     &tls.Config{InsecureSkipVerify: insecure}, //nolint:gosec // opt-in --insecure for local dev certs
	}
	return &http.Client{
		Transport: tr,
		Timeout:   timeout,
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
}

// forward proxies one request to the local target.
func forward(ctx context.Context, hc *http.Client, t Target, preserveHost bool, m *Message, body []byte) (*Result, *ProxyError) {
	u, err := url.ParseRequestURI(m.Path)
	if err != nil {
		return nil, &ProxyError{"EOTHER", "invalid request path: " + err.Error()}
	}
	u.Scheme, u.Host = t.Scheme, t.HostPort()

	var rd io.Reader = http.NoBody
	if len(body) > 0 {
		rd = bytes.NewReader(body)
	}
	method := m.Method
	if method == "" {
		method = http.MethodGet
	}
	req, err := http.NewRequestWithContext(ctx, method, u.String(), rd)
	if err != nil {
		return nil, &ProxyError{"EOTHER", err.Error()}
	}
	req.ContentLength = int64(len(body))
	req.Host = t.HostPort()
	for k, vs := range m.Headers {
		lk := strings.ToLower(k)
		switch {
		case hopByHop[lk], lk == "content-length":
			continue
		case lk == "host":
			if preserveHost && len(vs) > 0 {
				req.Host = vs[0]
			}
			continue
		}
		for _, v := range vs {
			req.Header.Add(k, v)
		}
	}
	if _, ok := req.Header["User-Agent"]; !ok {
		req.Header.Set("User-Agent", "") // do not inject Go's default UA
	}

	resp, err := hc.Do(req)
	if err != nil {
		return nil, classify(err)
	}
	defer resp.Body.Close()
	rb, err := io.ReadAll(io.LimitReader(resp.Body, MaxResponseBody+1))
	if err != nil {
		return nil, classify(err)
	}
	if len(rb) > MaxResponseBody {
		return nil, &ProxyError{"EOTHER", fmt.Sprintf("response body exceeds %d MB relay limit", MaxResponseBody>>20)}
	}
	hdr := Headers{}
	for k, vs := range resp.Header {
		lk := strings.ToLower(k)
		if hopByHop[lk] || lk == "content-length" {
			continue
		}
		hdr[lk] = append([]string(nil), vs...)
	}
	return &Result{Status: resp.StatusCode, Headers: hdr, Body: rb}, nil
}

func classify(err error) *ProxyError {
	msg := err.Error()
	low := strings.ToLower(msg)
	var ne net.Error
	switch {
	case errors.Is(err, syscall.ECONNREFUSED) || strings.Contains(low, "connection refused") || strings.Contains(low, "actively refused"):
		return &ProxyError{"ECONNREFUSED", msg}
	case errors.Is(err, syscall.EHOSTUNREACH) || errors.Is(err, syscall.ENETUNREACH) ||
		strings.Contains(low, "no route to host") || strings.Contains(low, "network is unreachable"):
		return &ProxyError{"EHOSTUNREACH", msg}
	case errors.Is(err, context.DeadlineExceeded) || errors.Is(err, os.ErrDeadlineExceeded) ||
		(errors.As(err, &ne) && ne.Timeout()) || strings.Contains(low, "timeout"):
		return &ProxyError{"ETIMEDOUT", msg}
	}
	return &ProxyError{"EOTHER", msg}
}
