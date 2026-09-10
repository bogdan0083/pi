---
name: foquz-deployments
description: Check Foquz GitLab build/deployment pipelines and verify pushed changes are live on a stand such as doxswf.ru. Use after pushing fixes or when investigating deployment delays.
---

# Foquz deployments

## Deployment flow

Push → source-repo CI checks and container build → downstream deployment in
`doxsw/foquz-app-deploy` (branch `stage`) → verify the actual stand.
A successful source pipeline or trigger does **not** mean deployment finished.
Deployments can queue (`waiting_for_resource`); six minutes is an estimate, not a deadline.

Known frontend mappings (confirmed for `bugfixes` → `https://doxswf.ru`):

| Local repo | GitLab project | Build job | Deployment trigger |
|---|---|---|---|
| `foquz-frontend-vue` | `doxsw/foquz-frontend-vue` | `build-foquz-frontend-vue-admin` | `set-version-task` |
| `poll-vue-app` | `doxsw/foquz-quiz` | `build-image` | `deploy-stand` |

For other repos/branches, inspect `.gitlab-ci.yml` and its includes; do not assume
these job names or target environment. Use `foquz-projects-overview` to locate repos.

## Check CI through GitLab REST

Base: `https://doxsw.gitlab.yandexcloud.net/api/v4`.
Authenticate with the `PRIVATE-TOKEN` header from `FOQUZ_GITLAB_ACCESS_TOKEN`.
Never print tokens, credential-bearing headers, or unredacted job traces.
URL-encode project paths (e.g. `doxsw%2Ffoquz-quiz`).

1. `GET /projects/{project}/pipelines?ref=bugfixes&sha={pushed_sha}`.
   Match the exact commit; duplicate branch/MR pipelines may exist.
2. `GET /projects/{project}/pipelines/{id}/jobs` — inspect build/check statuses.
3. `GET /projects/{project}/pipelines/{id}/bridges` — follow
   `downstream_pipeline.project_id` and `downstream_pipeline.id`.
4. `GET /projects/{downstream_project_id}/pipelines/{downstream_id}` — wait for
   deployment success. Check downstream jobs if failed or stalled. Poll at bounded
   intervals (about a minute), not a busy loop. Report queued/running/failed accurately.

Read-only checks do not authorize triggering manual production jobs or retries.

## Verify live changes

Use the `browser-control` skill on the real ticket route and data.
Remove any local asset overrides (`page.unroute`) before verifying deployment.
Reload and check both new assets and actual behavior:

- Admin: `/vue-frontend/admin/admin.js` has a stable filename. If stale, fetch
  that URL in the page with `{ cache: 'reload' }`, then reload the page. Inspect
  `Last-Modified` or a distinctive new code/translation marker; never clear shared
  browser caches or cookies.
- Respondent poll: inspect the loaded `/p/assets/index-*.js` URL. A new hash
  supports deployment evidence but does not prove the fix works.
- Exercise the reported scenario and an opposite/control case. Verify resulting
  headings, modal text, unchanged row counts, or relevant API fields—not just clicks.

Report commit hashes, checks observed on the stand, and any deployment blocker.
Do not claim live verification based only on CI success or a locally overridden build.
