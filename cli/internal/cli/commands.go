package cli

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"text/tabwriter"
	"time"

	"github.com/spf13/cobra"

	"github.com/erostalevi/nanana/cli/internal/api"
	"github.com/erostalevi/nanana/cli/internal/config"
)

// test seams
var (
	sleep          = time.Sleep
	updateCheckURL = "https://api.github.com/repos/erostalevi/nanana-releases/releases/latest"
)

func openBrowser(u string) error {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("open", u)
	case "windows":
		cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", u)
	default:
		cmd = exec.Command("xdg-open", u)
	}
	if err := cmd.Start(); err != nil {
		return err
	}
	go func() { _ = cmd.Wait() }()
	return nil
}

// accountClient returns a client authenticated with the env/credentials token.
func (a *app) accountClient() (*api.Client, error) {
	base := config.APIBase(a.api)
	tok, _ := config.Token("", base)
	if tok == "" {
		return nil, errors.New("not logged in: run `nanana login` (or set NANANA_TOKEN)")
	}
	return api.New(base, tok, a.version), nil
}

func (a *app) loginCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "login",
		Short: "Log in with your browser (device flow)",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			base := config.APIBase(a.api)
			c := api.New(base, "", a.version)
			host, _ := os.Hostname()
			ds, err := c.DeviceStart(ctx, "nanana-cli/"+a.version+" ("+host+")")
			if err != nil {
				return err
			}
			link := firstNonEmpty(ds.VerificationURIComplete, ds.VerificationURI)
			fmt.Fprintf(a.out, "Open this URL to authorize the CLI:\n\n  %s\n\nYour code: %s\n\n", link, ds.UserCode)
			if err := a.openBrowser(link); err != nil {
				fmt.Fprintln(a.out, "(could not open a browser automatically; open the URL manually)")
			}
			fmt.Fprintln(a.out, "Waiting for approval...")
			interval := time.Duration(ds.Interval) * time.Second
			if interval <= 0 {
				interval = 5 * time.Second
			}
			deadline := time.Now().Add(time.Duration(ds.ExpiresIn) * time.Second)
			if ds.ExpiresIn <= 0 {
				deadline = time.Now().Add(10 * time.Minute)
			}
			for {
				if err := ctx.Err(); err != nil {
					return err
				}
				if time.Now().After(deadline) {
					return errors.New("the login code expired; run `nanana login` again")
				}
				sleep(interval)
				tok, err := c.DevicePoll(ctx, ds.DeviceCode)
				if err == nil {
					if err := config.Save(&config.Credentials{Token: tok.AccessToken, Email: tok.Account.Email, API: base}); err != nil {
						return fmt.Errorf("saving credentials: %w", err)
					}
					p, _ := config.Path()
					fmt.Fprintf(a.out, "Logged in as %s. Credentials saved to %s\n", tok.Account.Email, p)
					return nil
				}
				var ae *api.Error
				if !errors.As(err, &ae) {
					return err
				}
				switch ae.Code {
				case "authorization_pending":
				case "slow_down":
					interval += 5 * time.Second
				case "expired_token":
					return errors.New("the login code expired; run `nanana login` again")
				case "access_denied":
					return errors.New("login was denied in the browser")
				default:
					return err
				}
			}
		},
	}
}

func (a *app) logoutCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "logout",
		Short: "Remove stored credentials",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			if err := config.Delete(); err != nil {
				return err
			}
			fmt.Fprintln(a.out, "Logged out (local credentials removed).")
			return nil
		},
	}
}

func (a *app) whoamiCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "whoami",
		Short: "Show the logged-in account",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			c, err := a.accountClient()
			if err != nil {
				return err
			}
			me, err := c.Me(cmd.Context())
			if err != nil {
				return err
			}
			fmt.Fprintf(a.out, "%s (plan: %s)\n", me.Account.Email, me.Account.Plan)
			keys := make([]string, 0, len(me.Limits))
			for k := range me.Limits {
				keys = append(keys, k)
			}
			sort.Strings(keys)
			for _, k := range keys {
				fmt.Fprintf(a.out, "  %s: %v\n", k, me.Limits[k])
			}
			return nil
		},
	}
}

func (a *app) listCmd() *cobra.Command {
	return &cobra.Command{
		Use:     "list",
		Aliases: []string{"ls"},
		Short:   "List your subdomains",
		Args:    cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			c, err := a.accountClient()
			if err != nil {
				return err
			}
			subs, err := c.List(cmd.Context())
			if err != nil {
				return err
			}
			if len(subs) == 0 {
				fmt.Fprintln(a.out, "No subdomains yet. Create one with `nanana create`.")
				return nil
			}
			tw := tabwriter.NewWriter(a.out, 0, 4, 2, ' ', 0)
			fmt.Fprintln(tw, "SLUG\tSTATE\tTUNNEL\tURL\tEXPIRES")
			for _, s := range subs {
				tun := "offline"
				if s.TunnelOnline {
					tun = "online"
				}
				fmt.Fprintf(tw, "%s\t%s\t%s\t%s\t%s\n", s.Slug, s.State, tun, s.URL, s.HardExpiresAt)
			}
			return tw.Flush()
		},
	}
}

func (a *app) createCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "create [name]",
		Short: "Create a subdomain (custom name needs an account)",
		Args:  cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			base := config.APIBase(a.api)
			tok, _ := config.Token("", base)
			name := ""
			if len(args) == 1 {
				name = args[0]
				if tok == "" {
					return errors.New("custom names need an account: run `nanana login` first")
				}
			}
			res, err := api.New(base, tok, a.version).Create(cmd.Context(), name)
			if err != nil {
				return err
			}
			fmt.Fprintf(a.out, "Created %s\n  URL        %s\n  Dashboard  %s\n  Token      %s   (shown once; keep it safe)\n  Dashboard with token  %s\n",
				res.Subdomain.Slug, res.Subdomain.URL, res.Subdomain.DashboardURL, res.Token, res.DashboardURLWithToken)
			fmt.Fprintf(a.out, "\nForward it:  nanana -t=%s -p=3000\n", res.Token)
			return nil
		},
	}
}

func (a *app) deleteCmd() *cobra.Command {
	var yes bool
	cmd := &cobra.Command{
		Use:   "delete <slug>",
		Short: "Delete a subdomain",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			c, err := a.accountClient()
			if err != nil {
				return err
			}
			slug := args[0]
			if !yes {
				fmt.Fprintf(a.out, "Delete %s and all its captured requests? This cannot be undone. [y/N] ", slug)
				line, _ := bufio.NewReader(a.in).ReadString('\n')
				if l := strings.ToLower(strings.TrimSpace(line)); l != "y" && l != "yes" {
					fmt.Fprintln(a.out, "Aborted.")
					return nil
				}
			}
			if err := c.Delete(cmd.Context(), slug); err != nil {
				return err
			}
			fmt.Fprintf(a.out, "Deleted %s.\n", slug)
			return nil
		},
	}
	cmd.Flags().BoolVarP(&yes, "yes", "y", false, "do not ask for confirmation")
	return cmd
}

func (a *app) claimCmd() *cobra.Command {
	var token, slug string
	cmd := &cobra.Command{
		Use:   "claim -t <subdomain-token> [--slug <slug>]",
		Short: "Attach an anonymous subdomain to your account",
		Long: `Attach an anonymous subdomain to your logged-in account.

-t is the subdomain token (nnt_...) printed when it was created. The slug comes from
--slug, or, when omitted, from GET /subdomains/_self called with that token.
The account token is taken from NANANA_TOKEN (nna_...) or the credentials file.`,
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			if token == "" {
				return errors.New("pass the subdomain token with -t <nnt_...>")
			}
			ctx := cmd.Context()
			base := config.APIBase(a.api)
			acct, err := a.accountClient()
			if err != nil {
				return err
			}
			if strings.HasPrefix(acct.Token, "nnt_") {
				return errors.New("claiming needs an account token (nna_): run `nanana login`")
			}
			if slug == "" {
				self, err := api.New(base, token, a.version).Self(ctx)
				if err != nil {
					return fmt.Errorf("could not determine the slug for this token (pass --slug): %w", err)
				}
				slug = self.Slug
			}
			s, err := acct.Claim(ctx, slug, token)
			if err != nil {
				return err
			}
			fmt.Fprintf(a.out, "Claimed %s (%s). It now belongs to your account.\n", s.Slug, s.URL)
			return nil
		},
	}
	cmd.Flags().StringVarP(&token, "token", "t", "", "subdomain token (nnt_...)")
	cmd.Flags().StringVar(&slug, "slug", "", "subdomain slug (default: derived from the token)")
	return cmd
}

func (a *app) versionCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "version",
		Short: "Print the CLI version",
		Args:  cobra.NoArgs,
		Run: func(cmd *cobra.Command, args []string) {
			fmt.Fprintf(a.out, "nanana %s (%s/%s)\n", a.version, runtime.GOOS, runtime.GOARCH)
		},
	}
}

func (a *app) updateCheckCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "update-check",
		Short: "Check GitHub for a newer release",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			latest, link, err := fetchLatest(cmd.Context(), updateCheckURL)
			if err != nil {
				fmt.Fprintf(a.errOut, "could not check for updates: %v\n", err)
				return nil
			}
			if newer(latest, a.version) {
				fmt.Fprintf(a.out, "A new version is available: %s (you have %s)\n%s\n", latest, a.version, link)
			} else {
				fmt.Fprintf(a.out, "You are up to date (%s).\n", a.version)
			}
			return nil
		},
	}
}

func fetchLatest(ctx context.Context, url string) (tag, link string, err error) {
	ctx, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
	if err != nil {
		return "", "", err
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("User-Agent", "nanana-cli")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return "", "", fmt.Errorf("GitHub returned HTTP %d", resp.StatusCode)
	}
	var r struct {
		Tag string `json:"tag_name"`
		URL string `json:"html_url"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&r); err != nil {
		return "", "", err
	}
	if r.Tag == "" {
		return "", "", errors.New("no release found")
	}
	return r.Tag, r.URL, nil
}

// newer reports whether latest > current for dotted numeric versions. A "dev"
// build is never considered outdated.
func newer(latest, current string) bool {
	parse := func(v string) []int {
		v = strings.TrimPrefix(strings.TrimSpace(v), "v")
		if i := strings.IndexAny(v, "-+"); i >= 0 {
			v = v[:i]
		}
		var out []int
		for _, p := range strings.Split(v, ".") {
			n, err := strconv.Atoi(p)
			if err != nil {
				return nil
			}
			out = append(out, n)
		}
		return out
	}
	l, c := parse(latest), parse(current)
	if l == nil || c == nil {
		return false
	}
	for i := 0; i < len(l) || i < len(c); i++ {
		var a, b int
		if i < len(l) {
			a = l[i]
		}
		if i < len(c) {
			b = c[i]
		}
		if a != b {
			return a > b
		}
	}
	return false
}
