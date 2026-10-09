# Custom domains

A gym can run this app at an address it owns, such as `app.theirgym.com`,
instead of `yourplatform.com/g/theirgym/`. The usual setup:

| Address | Serves |
| --- | --- |
| `theirgym.com` (root/apex) | The gym's own marketing site: WordPress, Webflow, Wix, or a future builder here |
| `app.theirgym.com` (subdomain) | This app: staff dashboard, member portal, check-ins |

A gym can map its root domain directly if it wants to. The UI points them to
a subdomain first, because a root domain replaces whatever website already
runs there.

## How it works

### Connecting a domain (gym admin, Gym settings → Custom domain)

1. The admin types `app.theirgym.com`. The page says live whether it is a
   subdomain or a root domain (`GET /api/platform/domains/inspect`).
2. **Connect domain** creates a *pending* claim and shows two DNS records:

   | Purpose | Subdomain | Root domain |
   | --- | --- | --- |
   | Routing | `CNAME app → CUSTOM_DOMAIN_TARGET` | `A @ → CUSTOM_DOMAIN_IPV4` (or ALIAS/ANAME/flattened CNAME → target when no IPs are configured) |
   | Ownership | `TXT _gymbook-verify.app → gymbook-verify=<token>` | `TXT _gymbook-verify → gymbook-verify=<token>` |

   Each record's "Name / Host" is the short form most registrar forms expect
   (`app`, `@`), with the full name shown underneath. A collapsible section
   gives steps for GoDaddy, Namecheap, Cloudflare, Hostinger and Squarespace.
3. **Check DNS** looks both records up live and shows a pass/fail per record
   in plain language: "CNAME points to old-host.net — it should point to …",
   "TXT holds a different value", a leftover AAAA record, or a Cloudflare
   orange-cloud proxy. When both pass, the domain goes **live**.

### Why two records

The routing record only proves the domain points at *this platform*. It does
not say which gym on the platform it belongs to. Without the per-claim TXT
token, gym A could type gym B's domain in first and receive B's traffic as
soon as B set up DNS. The rules are:

- Several gyms may hold a *pending* claim on the same hostname. The registry
  enforces uniqueness only among *active* rows (a partial unique index).
- The first claim whose own token appears in DNS goes live. Every other
  pending claim on that hostname is deleted in the same transaction.
- A domain that is already live on one gym cannot be added by another. The
  gym is told to contact support, and the operator settles it.
- A failing check never takes a live domain offline, because one flaky
  lookup should not take a front desk offline. Only removal or the operator's
  **Take offline** does that.

### Request routing (`resolveTenant` in `src/tenant.js`)

The tenant is resolved from these sources, in this order:

1. **Custom domain.** If the Host header is not one of the platform's own
   hostnames, it is looked up among *active* custom domains. A match pins
   the gym. On that domain, `/g/<same-slug>/` still works (old bookmarks),
   `/g/<other-slug>/` returns 404 (no gym can render under another gym's
   domain), and the dev-only `X-Tenant-Slug` header is ignored.
2. `/g/<slug>` path prefix.
3. `X-Tenant-Slug` header (non-production only).
4. `<slug>.ROOT_DOMAIN` subdomain.

"Platform hostnames" (`isPlatformHost`) are IPs, `localhost`/`*.localhost`,
`ROOT_DOMAIN` and its subdomains, `*.trycloudflare.com`, and
`CUSTOM_DOMAIN_TARGET`. They never touch the custom-domain table, so local
development behaves as it did before.

The SPA needs no changes to work on a custom domain. With no `/g/` prefix in
the URL it calls `/api/...` on the same origin, the same as on a per-gym
subdomain, and its localStorage is naturally scoped to that origin. Staff and
member tokens carry the gym's slug, so a token issued on
`yourplatform.com/g/acme/` is accepted on `app.acme.com`, and another gym's
token is rejected there.

Once a gym has a live domain, `tenantUrl()` advertises it (in password-reset
links and the operator console). The `/g/<slug>` address still works and is
shown as the fallback.

**HSTS:** on a custom domain the header is sent *without*
`includeSubDomains`. On a gym's root domain that flag would force HTTPS onto
all of its other subdomains for six months.

### Operator console → Domains

The **Domains** tab lists every domain on the platform: status, gym and last
check result. The **Gyms** list shows each gym's domains under its address,
and search matches domains too. Each gym's drill-down has a **Custom
domains** card. The operator can:

- **Connect a domain** for a gym, either to go live once DNS checks out, or
  immediately ("Force live") when ownership has been confirmed another way,
  for example a DNS host that cannot publish TXT records.
- **Check DNS** (no cooldown).
- **Take offline / Force live:** stop routing a domain without forgetting it,
  or bring it back.
- **Change:** move a claim to a corrected hostname. It returns to pending and
  must verify again.
- **Disconnect:** delete it.

Deleting a gym also deletes its domains.

## Deploying it

The feature is **off until `CUSTOM_DOMAIN_TARGET` is set**. Until then, Gym
settings says it is not available, and no custom-domain lookups happen.

| Variable | Example | Meaning |
| --- | --- | --- |
| `CUSTOM_DOMAIN_TARGET` | `domains.yourplatform.com` | The hostname gyms CNAME to. Create it yourself as an A/CNAME record pointing at your server. |
| `CUSTOM_DOMAIN_IPV4` | `203.0.113.10` | Comma-separated public IPv4 address(es) of the server, for root domains (which cannot carry a CNAME). Optional: without it, root domains are told to use ALIAS/ANAME/flattening to the target. |
| `CUSTOM_DOMAIN_DNS_SERVERS` | `1.1.1.1,8.8.8.8` (default) | Resolvers the DNS check queries directly, bypassing the OS cache. Set it to an empty string to use the system resolver. |
| `CUSTOM_DOMAIN_LIMIT` | `3` (default) | Maximum domains per gym. |
| `CUSTOM_DOMAIN_CHECK_COOLDOWN_MS` | `10000` (default) | Within this window, a repeated "Check DNS" returns the stored result instead of querying DNS again. |

### TLS certificates

Each custom domain needs its own certificate. A wildcard for your platform
domain does not cover `app.theirgym.com`. The simplest setup is **Caddy with
on-demand TLS**: Caddy gets a Let's Encrypt certificate the first time a
hostname is requested, after asking this app whether that hostname is allowed.

`GET /api/custom-domains/tls-check?domain=<host>` returns `200` for:

- live custom domains
- `ROOT_DOMAIN` and `www.ROOT_DOMAIN`
- `<slug>.ROOT_DOMAIN` when that gym exists

It returns `404` for everything else, including *pending* domains. Without
this check, anyone could point junk hostnames at the server and use up your
ACME rate limit.

An example `Caddyfile` for the Oracle Cloud VM, with the app under pm2 on
port 3000:

```caddyfile
{
	on_demand_tls {
		ask http://127.0.0.1:3000/api/custom-domains/tls-check
	}
}

# The platform's own hostnames. List them explicitly so their certificates
# don't depend on the ask endpoint.
yourplatform.com, www.yourplatform.com, domains.yourplatform.com {
	reverse_proxy 127.0.0.1:3000
}

# Every gym's own domain, and per-gym subdomains of the platform.
https:// {
	tls {
		on_demand
	}
	reverse_proxy 127.0.0.1:3000
}
```

Run the app with `TRUST_PROXY=true` behind Caddy, so `req.secure` and HSTS
work. Ports 80 and 443 must be open in the VM firewall and in the OCI
security list, because Let's Encrypt validates over them.

**Fly.io:** Fly terminates TLS itself. Each custom domain has to be added with
`fly certs add <hostname>`, or through Fly's Machines API, after it goes live.
Point `CUSTOM_DOMAIN_TARGET` at `<app>.fly.dev` and set `CUSTOM_DOMAIN_IPV4`
to the app's dedicated IPv4 (`fly ips list`). Automating the `fly certs` call
is not built in.

### Activation order for a gym

1. The gym adds the CNAME (or A record) and the TXT record.
2. The gym clicks **Check DNS**. The domain goes live in the registry.
3. The first HTTPS visit to `https://app.theirgym.com` makes Caddy ask
   `tls-check`, get `200`, and issue the certificate. This takes a few
   seconds once; later visits are instant.

## API reference

Gym side (staff token; changes require an admin):

| Method | Path | |
| --- | --- | --- |
| `GET` | `/api/platform/domains` | Setup info, `platform_url`, `current_host`, and the gym's domains with their DNS records and last check |
| `GET` | `/api/platform/domains/inspect?hostname=` | Validate a hostname and classify it as root or subdomain |
| `POST` | `/api/platform/domains` | `{ hostname }` creates a pending claim |
| `POST` | `/api/platform/domains/:id/check` | Run the DNS check; goes live on success |
| `DELETE` | `/api/platform/domains/:id` | Disconnect |

Operator (platform token):

| Method | Path | |
| --- | --- | --- |
| `GET` | `/api/platform/admin/domains` | Every domain on the platform |
| `POST` | `/api/platform/admin/tenants/:slug/domains` | `{ hostname, activate? }` |
| `POST` | `/api/platform/admin/domains/:id/check` | DNS check, no cooldown |
| `PATCH` | `/api/platform/admin/domains/:id` | `{ hostname?, status?: 'active' \| 'pending' }` |
| `DELETE` | `/api/platform/admin/domains/:id` | Disconnect |

Public: `GET /api/custom-domains/tls-check?domain=` (see above).

## Known limits

- The root-vs-subdomain check uses a built-in list of common two-part
  suffixes (`co.in`, `co.uk`, `com.au`, …), not the full Public Suffix List.
  A miss only changes which routing record the instructions suggest. It never
  changes what gets verified.
- There is no background re-verification. Pending domains are checked when
  someone clicks **Check DNS**, and live domains are never demoted
  automatically.
- One TLS approach (Caddy on-demand) is documented. Fly certificate
  automation is not built in.
