# The origin HMAC secret

The gateway and the private origin must hold a **byte-identical** shared secret.
The gateway signs every forwarded request with it (`ORIGIN_HMAC_SECRET`), and
the origin verifies that signature before trusting anything in the envelope
(`AGENT_GATEWAY_HMAC_SECRET`).

This is the boundary. Not the network — the origin sits behind the same
Cloudflare zone as the public site, so requests from the gateway and requests
from anyone else arrive identically. **The signature is the only thing that
distinguishes them.**

## Properties that matter

- **32 bytes minimum.** The origin refuses to verify at all below that, and
  fails closed with a 503 rather than accepting unsigned requests.
- **Identical on both sides.** A difference of one newline fails every request
  as `bad_signature`, which reads like an attack and is a typo.
- **Rotation is not atomic.** Between updating one side and the other, requests
  fail closed with 401. On a live surface, set `AGENT_SURFACE=off` first,
  rotate, then back on.
- **Never a command-line argument.** On a shared host it would be visible in
  `ps` to every other user. Pipe it, or write it directly.

## Verifying without disclosing

Compare a truncated SHA-256 of each side rather than the values:

```bash
printf '%s' "$SECRET" | sha256sum | cut -c1-16
```

Cloudflare secrets are write-only, so the Worker's copy cannot be read back. If
the two disagree, the symptom is a 401 with `bad_signature` in the origin log —
and the fix is to reinstall both sides from one generated value rather than
trying to work out which is wrong.

The rotation tooling for the Clubhouse's own deployment lives in the private
repository, because it necessarily encodes that deployment's hostnames.
