# YouTube Toolbelt CLI

Local generated CLI for the official YouTube Data API v3. Google does not publish a dedicated official YouTube CLI, so this wrapper uses HTTPS directly with Node's built-in `fetch`.

## Auth

- Public reads: set `YOUTUBE_API_KEY` in the runtime environment.
- Account playlist reads: set `YOUTUBE_ACCESS_TOKEN`, or set `YOUTUBE_TOKEN_FILE` / `YOUTUBE_OAUTH_TOKEN_FILE` to a JSON file containing `access_token`.
- Required OAuth scope for account playlist reads: `https://www.googleapis.com/auth/youtube.readonly`.

Do OAuth setup outside Toolbelt. Runtime credentials must stay out of Toolbelt args and output.

## Operations

- `status`
- `auth-help`
- `auth-login --args '{"clientFile":"/path/to/client.json"}'` writes the auth URL to `~/.config/pi/youtube/auth-url.txt`, listens on localhost, and stores `~/.config/pi/youtube/token.json` after approval
- `auth-refresh`
- `videos-get --args '{"id":"VIDEO_ID"}'`
- `search --args '{"query":"topic","limit":5}'`
- `playlists-mine`
- `playlist-find --args '{"title":"for extraction"}'`
- `playlist-items --args '{"playlistId":"PL...","limit":10}'`
- `extraction-playlist --args '{"title":"for extraction","limit":10}'`
- `latest-extraction --args '{"title":"for extraction"}'`
- `captions-list --args '{"id":"VIDEO_ID"}'` (official caption metadata only; arbitrary public transcripts still need Pi's YouTube transcript/fetch tooling)
