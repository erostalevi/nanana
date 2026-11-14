// Package api is a small client for the nanana REST API (docs/API.md).
package api

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"time"
)

type Subdomain struct {
	Slug          string `json:"slug"`
	URL           string `json:"url"`
	DashboardURL  string `json:"dashboardUrl"`
	IsCustom      bool   `json:"isCustom"`
	OwnerID       string `json:"ownerId"`
	State         string `json:"state"`
	LastActivity  string `json:"lastActivityAt"`
	HardExpiresAt string `json:"hardExpiresAt"`
	TunnelOnline  bool   `json:"tunnelOnline"`
}

type Account struct {
	ID          string `json:"id"`
	Email       string `json:"email"`
	DisplayName string `json:"displayName"`
	Plan        string `json:"plan"`
}

type Me struct {
	Account Account                `json:"account"`
	Limits  map[string]interface{} `json:"limits"`
}

type CreateResult struct {
	Subdomain             Subdomain `json:"subdomain"`
	Token                 string    `json:"token"`
	DashboardURLWithToken string    `json:"dashboardUrlWithToken"`
}

type DeviceStart struct {
	DeviceCode              string `json:"deviceCode"`
	UserCode                string `json:"userCode"`
	VerificationURI         string `json:"verificationUri"`
	VerificationURIComplete string `json:"verificationUriComplete"`
	Interval                int    `json:"interval"`
	ExpiresIn               int    `json:"expiresIn"`
}

type DeviceToken struct {
	AccessToken string  `json:"accessToken"`
	Account     Account `json:"account"`
}

// Error is an API error response.
type Error struct {
	Status  int
	Code    string
	Message string
}

func (e *Error) Error() string {
	if e.Message != "" {
		return fmt.Sprintf("%s (%d %s)", e.Message, e.Status, e.Code)
	}
	return fmt.Sprintf("HTTP %d %s", e.Status, e.Code)
}

// Client talks to the API.
type Client struct {
	Base  string
	Token string
	HTTP  *http.Client
	UA    string
}

func New(base, token, version string) *Client {
	return &Client{Base: base, Token: token, HTTP: &http.Client{Timeout: 30 * time.Second}, UA: "nanana-cli/" + version}
}

func (c *Client) do(ctx context.Context, method, path string, in, out interface{}) error {
	var body io.Reader
	if in != nil {
		b, err := json.Marshal(in)
		if err != nil {
			return err
		}
		body = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.Base+path, body)
	if err != nil {
		return err
	}
	if in != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", c.UA)
	req.Header.Set("X-Nanana-Protocol", "1")
	if c.Token != "" {
		req.Header.Set("Authorization", "Bearer "+c.Token)
	}
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if resp.StatusCode >= 400 {
		e := &Error{Status: resp.StatusCode, Code: http.StatusText(resp.StatusCode)}
		var env struct {
			Error struct {
				Code    string `json:"code"`
				Message string `json:"message"`
			} `json:"error"`
		}
		if json.Unmarshal(data, &env) == nil && env.Error.Code != "" {
			e.Code, e.Message = env.Error.Code, env.Error.Message
		}
		return e
	}
	if out != nil && len(data) > 0 {
		return json.Unmarshal(data, out)
	}
	return nil
}

func (c *Client) DeviceStart(ctx context.Context, clientName string) (*DeviceStart, error) {
	var r DeviceStart
	err := c.do(ctx, "POST", "/auth/device", map[string]string{"clientName": clientName}, &r)
	return &r, err
}

func (c *Client) DevicePoll(ctx context.Context, deviceCode string) (*DeviceToken, error) {
	var r DeviceToken
	err := c.do(ctx, "POST", "/auth/device/token", map[string]string{"deviceCode": deviceCode}, &r)
	if err != nil {
		return nil, err
	}
	return &r, nil
}

func (c *Client) Me(ctx context.Context) (*Me, error) {
	var r Me
	err := c.do(ctx, "GET", "/me", nil, &r)
	return &r, err
}

func (c *Client) List(ctx context.Context) ([]Subdomain, error) {
	var r struct {
		Subdomains []Subdomain `json:"subdomains"`
	}
	err := c.do(ctx, "GET", "/subdomains", nil, &r)
	return r.Subdomains, err
}

func (c *Client) Create(ctx context.Context, name string) (*CreateResult, error) {
	in := map[string]string{}
	if name != "" {
		in["name"] = name
	}
	var r CreateResult
	err := c.do(ctx, "POST", "/subdomains", in, &r)
	return &r, err
}

func (c *Client) Get(ctx context.Context, slug string) (*Subdomain, error) {
	var r Subdomain
	err := c.do(ctx, "GET", "/subdomains/"+url.PathEscape(slug), nil, &r)
	return &r, err
}

// Self returns the subdomain bound to the presented nnt_ token
// (GET /subdomains/_self, a CLI-driven addition to API.md).
func (c *Client) Self(ctx context.Context) (*Subdomain, error) { return c.Get(ctx, "_self") }

func (c *Client) Delete(ctx context.Context, slug string) error {
	return c.do(ctx, "DELETE", "/subdomains/"+url.PathEscape(slug), nil, nil)
}

func (c *Client) Claim(ctx context.Context, slug, subToken string) (*Subdomain, error) {
	var r Subdomain
	err := c.do(ctx, "POST", "/subdomains/"+url.PathEscape(slug)+"/claim", map[string]string{"token": subToken}, &r)
	return &r, err
}
