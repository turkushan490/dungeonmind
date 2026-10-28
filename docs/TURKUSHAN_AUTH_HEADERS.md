# Extra forward-auth headers for turkushan-auth

A spec for [turkushan-auth](https://github.com/turkushan490/turkushan-auth), to be built there. DungeonMind (`AUTH_MODE=portal`) already reads these headers; every one is optional, and without them nothing changes.

| Header | Value | DungeonMind uses it for |
|---|---|---|
| `X-Auth-Groups` | the user's group names, comma separated (`players,Game Masters`) | shown in Settings → Users; members of a group listed under **Admin groups** get the admin role |
| `X-Auth-Admin` | `true` / `false` (`u.IsAdmin`) | `true` gives the admin role |
| `X-Auth-Site-Approver` | `true` / `false` (`Rights.CanApprove(siteID)` for the requested host) | not used yet; there for other sites behind the portal |
| `X-Auth-Discord-Roles` | the user's Discord role names, comma separated | shown in Settings → Users |
| `X-Auth-Logout` | the portal's logout URL, e.g. `https://auth.example.com/logout` | where **Log out** goes; without it Log out only drops the DungeonMind session |

Values are plain text. Names must not contain commas (strip them, or replace them with a space).

## 1. `internal/server/forward.go` → `handleForwardAuth`

Next to the existing `X-Auth-User` / `X-Auth-Email` on a 200 response:

```go
w.Header().Set("X-Auth-User", u.Username)
w.Header().Set("X-Auth-Email", u.Email)

// New: optional extra info for the apps behind the portal.
if groups, err := s.store.UserGroups(ctx, u.ID); err == nil { // group names from the memberships in internal/store/groups.go
	w.Header().Set("X-Auth-Groups", joinNames(groups))
}
w.Header().Set("X-Auth-Admin", strconv.FormatBool(u.IsAdmin))
if siteID, ok := s.siteForHost(r); ok { // the site for X-Forwarded-Host, as the access check already resolves it
	w.Header().Set("X-Auth-Site-Approver", strconv.FormatBool(rights.CanApprove(siteID)))
}
if roles := s.discordRoles(ctx, u.ID); len(roles) > 0 { // the role data the OAuth flow in internal/server/oauth.go already reads
	w.Header().Set("X-Auth-Discord-Roles", joinNames(roles))
}
w.Header().Set("X-Auth-Logout", s.publicURL("/logout"))
```

```go
// joinNames makes a comma-separated header value; commas inside a name would split it.
func joinNames(names []string) string {
	out := make([]string, 0, len(names))
	for _, n := range names {
		if n = strings.TrimSpace(strings.ReplaceAll(n, ",", " ")); n != "" {
			out = append(out, n)
		}
	}
	return strings.Join(out, ",")
}
```

Notes:

- `UserGroups`, `siteForHost`, `discordRoles` and `publicURL` stand for whatever the code already has: the group names come from the store memberships in `internal/store/groups.go`, the site is the one the forward-auth check already resolves for the host, and the Discord roles are the ones `internal/server/oauth.go` reads during login. If the roles are only read at login, keep them with the user (or the session) so the forward-auth check can send them without calling Discord on every request.
- Send the headers only on the 200 (logged in and allowed). The 401/302 responses stay as they are.
- `X-Auth-Groups` and `X-Auth-Discord-Roles` may be empty when the user has none; DungeonMind treats an empty header as not sent (Nginx drops empty headers anyway).

## 2. Nginx Proxy Manager

In the proxy host's **Advanced** tab, next to the existing `auth_request` lines:

```nginx
auth_request_set $auth_user          $upstream_http_x_auth_user;
auth_request_set $auth_email         $upstream_http_x_auth_email;
auth_request_set $auth_groups        $upstream_http_x_auth_groups;
auth_request_set $auth_admin         $upstream_http_x_auth_admin;
auth_request_set $auth_site_approver $upstream_http_x_auth_site_approver;
auth_request_set $auth_discord_roles $upstream_http_x_auth_discord_roles;
auth_request_set $auth_logout        $upstream_http_x_auth_logout;

proxy_set_header X-Auth-User          $auth_user;
proxy_set_header X-Auth-Email         $auth_email;
proxy_set_header X-Auth-Groups        $auth_groups;
proxy_set_header X-Auth-Admin         $auth_admin;
proxy_set_header X-Auth-Site-Approver $auth_site_approver;
proxy_set_header X-Auth-Discord-Roles $auth_discord_roles;
proxy_set_header X-Auth-Logout        $auth_logout;
```

`proxy_set_header` with the subrequest's value also overwrites anything a visitor tries to send in these headers themselves.

## 3. Test idea for `forward_test.go`

A table test against `handleForwardAuth` with a logged-in session cookie:

1. Seed the store with a user in two groups (`players`, `Game,Masters`), `IsAdmin = false`, approver rights on site A only, and two Discord roles.
2. Call forward-auth with `X-Forwarded-Host` = site A's host. Expect 200 and:
   - `X-Auth-User` / `X-Auth-Email` unchanged;
   - `X-Auth-Groups` = `players,Game Masters` (the comma in the name is gone);
   - `X-Auth-Admin` = `false`;
   - `X-Auth-Site-Approver` = `true`;
   - `X-Auth-Discord-Roles` = the two roles;
   - `X-Auth-Logout` = the portal's logout URL.
3. Same call with site B's host: `X-Auth-Site-Approver` = `false`.
4. Make the user an admin: `X-Auth-Admin` = `true`.
5. No session cookie: no `X-Auth-*` headers at all on the 401/redirect.
