# DungeonMind guide

This is the setup and admin guide. The player guide lives inside the app (**Guide** tab).

## 1. Install

### Unraid (Community Apps)
1. Search for **DungeonMind** in Apps, or add the template URL `https://raw.githubusercontent.com/turkushan490/dungeonmind/main/templates/dungeonmind.xml`.
2. Set **Data** (default `/mnt/user/appdata/dungeonmind`), **HiveMind URL** and **HiveMind token**.
3. Pick the **Auth mode** (see below) and start the container.

### Plain Docker
See the README quick start. Everything lives in `/data`.

## 2. Accounts (auth modes)

- **`AUTH_MODE=builtin`** (default): username + password accounts inside DungeonMind. Passwords are hashed with argon2id (scrypt on Node < 24.7). The **first account becomes the admin**. The admin can close registration in Settings → Users.
- **`AUTH_MODE=header`**: a forward-auth proxy logs people in and passes `X-Auth-User` and `X-Auth-Email` upstream. DungeonMind creates the account on the first visit (the first one is the admin). Set `AUTH_HEADER_TRUSTED_IPS` to your proxy's IP so nobody can fake the headers by reaching the port directly. In Nginx Proxy Manager, pass the headers from the auth subrequest:
  ```nginx
  auth_request_set $auth_user $upstream_http_x_auth_user;
  auth_request_set $auth_email $upstream_http_x_auth_email;
  proxy_set_header X-Auth-User $auth_user;
  proxy_set_header X-Auth-Email $auth_email;
  ```
- **18+:** every account answers the age question once (in the registration form, or on the first visit in header mode). Nothing else works until it's answered.

## 3. Backups

Back up the **Data** folder (`/mnt/user/appdata/dungeonmind`): `dungeonmind.db` (+ `-wal`/`-shm`), `secret.key`, `images/`, `audio/` and `models/`. Stop the container (or use the Unraid Appdata Backup plugin) for a consistent SQLite copy. Audio and models can be regenerated; the database and `secret.key` cannot.
