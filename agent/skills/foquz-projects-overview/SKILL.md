---
name: foquz-projects-overview
description: Map Foquz-related projects, local repository paths, product aliases, and ownership boundaries. Use when a task requires access, data, code, documentation, or context from another related project; when work spans repositories; or when it is unclear which Foquz application or service owns a feature.
---

# Foquz Projects Overview

Foquz is split across multiple local repositories. Use this map to locate the project that owns the required code or context.

## Workflow

1. Determine which application, service, or shared package owns the relevant behavior.
2. Locate it using the map below, verifying that the directory exists.
3. Before working there, read that repository's `AGENTS.md` or other local instructions when present.
4. Inspect the owning project directly instead of inferring its behavior from the current repository.
5. If a task spans projects, follow each repository's conventions and run its relevant checks.
6. Ask for clarification when product terminology could refer to multiple implementations.

## Frontend and shared projects

| Project path | Purpose and aliases |
|---|---|
| `/Users/bgdn0083/projects/foquz-repositories` | Container folder for `foquz-core` and all backend services. Holds shared Docker/compose config (`compose.yml`), service configs (`auth.yml`, `sa.yml`, `text-answers.yml`, `widget.yml`), and planning docs (`anketa-status-refactor-plan.md`, `quota-limit-implementation.md`). |
| `/Users/bgdn0083/projects/poll-vue-app` | Vue respondent poll walkthrough. Often called **«Прохождение»**. Replaces the legacy `ko/pages/poll/process` implementation. |
| `/Users/bgdn0083/projects/foquz-frontend-vue` | Vue and TypeScript monorepo containing `apps/admin`, `apps/superadmin`, and `packages/common`. Often called **«Новый КВ»**. |
| `/Users/bgdn0083/projects/foquz-widget-dom` | VanJS DOM embed without an iframe. Often called **«DOM-виджет»** or **«виджет»**. |
| `/Users/bgdn0083/projects/foquz-ui` | Shared UI kit distributed through the private GitLab npm registry and consumed by frontend projects. |
| `/Users/bgdn0083/projects/foquz-repositories/foquz-core` | Main legacy/core application. Its `ko/widgets/poll_new` directory contains the legacy iframe widget and should be treated as a separate project area. |

## Backend projects

Backend repositories are located under the repositories folder:

`/Users/bgdn0083/projects/foquz-repositories/`

| Project | Purpose |
|---|---|
| `foquz-poll-api` | Symfony API for the new questionnaire constructor. Task environment OpenAPI is usually available at `https://task-N.docs.foquzdev.ru/openapi/poll.json`. |
| `foquz-stats-analyzing-api` | Statistics-analyzing service. |
| `foquz-auth-api` | Authentication service. |
| `foquz-mailings` | Mailing-related service. |
| `foquz-screenshoot-api` | Screenshot-related service. |
| `foquz-superadmin-api` | Superadmin API. |
| `foquz-text-answers-api` | Text-answer processing service. |
| `foquz-url-shortener` | URL-shortening service. |
| `foquz-widget-api` | Widget API. |

## Terminology and ambiguity

- **«Прохождение»** usually means `poll-vue-app`.
- **«Новый КВ»** usually involves `foquz-frontend-vue` and may also require `foquz-poll-api`.
- Questionnaire-form work may instead refer to the legacy/core `ko/components/question-form`; verify which implementation is intended.
- **«DOM-виджет»** means `foquz-widget-dom`; do not confuse it with the legacy iframe widget in `foquz-core/ko/widgets/poll_new`.
- Generic references to a widget, constructor, admin, or poll flow are not sufficient to assume ownership when multiple implementations exist.

## Maintenance

Use repository-local instructions as the authority for work inside that repository. If project paths or ownership change, update this global map to keep cross-project discovery accurate.
