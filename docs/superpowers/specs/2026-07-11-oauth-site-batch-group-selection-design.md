# OAuth Site Batch Group Selection Design

## Outcome

`npm run oauth:site:batch` prepares all group choices before the success-counted batch loop starts. It selects the Sub2API upload group exactly as today, authenticates one GitHub session into each target site to discover token groups, asks for one or more token groups per site, and atomically saves the complete choice set. A later run can reuse that file without prompts or discovery.

The batch must no longer apply `ROUTING_PROFILES` to every site. Those four routing definitions are an a6api-only fallback. A successful live response from `/api/user/self/groups` is authoritative, even when it contains only `default`.

## Runtime Evidence

- a6api's served frontend references `GET /api/user/self/groups`.
- A GitHub account found through the navigator search endpoint and verified through `/settings/profile` completed a6api OAuth successfully.
- The authenticated group request returned `{"default":{"desc":"默认分组","ratio":1}}`.
- Applying the existing four routing profiles to cun.ai and xyc.ai is therefore an existing behavior bug, not a compatibility requirement.

## Session Pool Preparation

The rescreener discovers session records from `data/sessions*.jsonl`, `data/remote-imports/*.jsonl`, `data/backups/*.jsonl`, `data/github-cookies.json`, and `data/github-cookies/*.json`. It normalizes records, groups all variants by lowercase email (falling back to lowercase username), and never edits source artifacts.

For each identity:

1. Query `https://github.com/search?q=<username>&type=users` with navigator JSON headers through one search-capable GitHub session.
2. Accept the account only when `payload.results` contains an exact case-insensitive `login` match.
3. For an existing account, test all stored cookie variants newest-first against `/settings/profile`.
4. Keep the first live variant. If every cookie is expired and credentials exist, run the existing browser refresh flow once and verify the refreshed state.
5. Exclude missing/suspended/unrefreshable identities from the usable output and preserve their reason in a rejected output.

Outputs are derived and written atomically:

- `data/sessions.merged.jsonl`
- `data/sessions.rescreened.usable.jsonl`
- `data/sessions.rescreened.rejected.jsonl`
- `data/sessions.rescreened.report.json`

## Group Discovery And Selection

After selecting the Sub2API upload group, batch preflight resolves target sites and obtains one usable session per site from `SESSION_STORE_FILE`, defaulting to `data/sessions.rescreened.usable.jsonl` when present and otherwise the existing store.

For each site it completes OAuth without minting a key, then requests `/api/user/self/groups` using the authenticated client and `new-api-user` header. Live data is normalized from an object map or array into options with a stable `value`, human label, description, ratio, and `source: "live"`.

Fallbacks apply only when authentication, the endpoint, or response parsing fails:

- a6api: the four existing `DEFAULT_ROUTING_PROFILES`, tagged `source: "fallback-routing"` and retaining their routing payload fields.
- Other sites: exactly one option based on `site.tokenGroup`, or `default` when no override exists.

The prompt accepts comma-separated indices or values plus `all`. At least one option is required. Each selected option creates exactly one key. There is no group/profile Cartesian product.

## Persisted Configuration

The default file is `data/oauth-site-batch-groups.json`:

```json
{
  "version": 1,
  "savedAt": "2026-07-11T00:00:00.000Z",
  "uploadGroup": { "id": 9, "name": "Claude 渠道" },
  "sites": {
    "a6api": {
      "source": "live",
      "selected": [
        { "value": "default", "label": "默认分组", "ratio": 1, "source": "live" }
      ]
    }
  }
}
```

`--group-config <path>` changes the path. `--reuse-group-config` loads and validates the file, skips all group prompts/discovery, and applies both the saved upload group and per-site token selections. Reuse rejects unsupported versions, missing target sites, empty selections, and malformed upload groups before starting the batch.

## Key Creation

`hybrid-oauth` is split conceptually into authentication, group discovery, and key minting. Normal execution authenticates once and mints one token for each selected option:

- Live option: writes only the selected `group` value plus the site's existing quota/expiry fields.
- a6api fallback-routing option: writes the existing routing fields and the site's default group.
- No selection supplied by a non-batch caller: creates one legacy default key, never four global routing keys.

Result rows include the selected group value and source. Existing Sub2API account priority, concurrency, proxy assignment, upload group payload, retry, and ledger behavior remain unchanged.

## Failure Handling

- One site discovery failure uses its fallback and logs the reason; it does not abort other sites.
- OAuth failure while establishing the preflight account is an error only when no fallback can be presented. The selected fallback can still be persisted and normal batch attempts may later succeed.
- A failure for one selected key does not prevent other selected keys for that site, matching existing per-profile tolerance.
- Configuration writes use temp-file plus rename so interrupted runs do not corrupt the last valid file.

## Verification

Unit tests cover discovery parsing, fallback ownership, multi-selection, config validation, one-key-per-selection payloads, batch argument parsing, prompt skipping during reuse, and unchanged Sub2API upload parameters. Integration-style tests inject HTTP/session dependencies. Final verification runs the full Node test suite, a session rescreen command, and a no-key live group probe.
