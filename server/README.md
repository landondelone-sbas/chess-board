# Chess relay

A small WebSocket relay (`index.js`, Node 20 or newer, the `ws` package). It pairs two players in a room and passes
moves between them. It does not judge whether a move is legal; the site checks that itself.

```bash
npm ci
npm start        # listens on PORT (default 8787)
```

Every setting is an optional `RELAY_*` environment variable, listed with its default at the top of `index.js`.

## First deploy behind a proxy (Render)

The relay limits connections and rooms per player address. Behind a proxy it reads that address from the
`X-Forwarded-For` header, counting `RELAY_TRUST_PROXY_HOPS` entries from the right (default 1). Whether 1 is right for
Render has not been checked, and a wrong value puts every player under one address.

1. Deploy with `RELAY_MAX_CONNECTIONS_PER_IP=1000` and `RELAY_MAX_ROOMS_PER_IP=1000`, so a wrong hop count cannot lock players out.
2. Connect once and read the log line `Connection: socket=... x-forwarded-for=... counted-as=...`. `counted-as` must be your own address.
3. If it is not, change `RELAY_TRUST_PROXY_HOPS` until it is, and redeploy.
4. Remove the two high limits to get the defaults (20 connections, 10 rooms per address), or set your own.

The log line contains player addresses. `RELAY_LOG_CONNECTIONS=off` stops it once the setting is confirmed.

Deploy the site (GitHub Pages) before the relay, so the site and relay agree on the move format.
