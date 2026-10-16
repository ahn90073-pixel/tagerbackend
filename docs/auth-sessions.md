# Merchant session persistence

Merchant access JWTs remain short-lived (7 days). Login, registration, and Google authentication now also issue a cryptographically random refresh token. The Worker stores only its SHA-256 hash in `public.auth_refresh_sessions`; the token itself is kept by the client in Android's app-private native storage. On an expired access token, the app rotates the refresh token, receives a new access JWT, and retries the original request. Each successful rotation extends the refresh session by one year.

The session can be explicitly revoked by the logout endpoint. Offline and temporary network failures do not erase the local session or the SQLite cache. Android app updates and process restarts do not clear the app-private storage. Existing access-token sessions are upgraded by issuing a refresh token while the old JWT is still valid.
