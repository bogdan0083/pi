---
name: redmine
description: >
  Read and manage issues in doxswf Redmine via the local `redmine` CLI. Use when the user explicitly asks to read/open a Redmine issue
  or to create/update a task: change status, assign/reassign, add a comment/note, list users/statuses/projects, or create a new issue
  (e.g. 'Смени статус задачи 9999 на тестирование и переведи на Андрея').
---

# Doxswf Redmine Issues

Use the local `redmine` CLI for authenticated operations against
`https://redmine.doxswf.ru`. Do not try to use public web fetching for Redmine
pages: the site requires authentication, and the CLI also post-processes ticket
text so inaccessible screenshot/file links are marked explicitly.

The CLI lives at `~/scripts/redmine/index.mjs` and is symlinked as
`redmine` on `PATH`.

## When to trigger

Trigger when the user explicitly asks to do any Redmine issue operation,
including reading, creating, or changing a task.

Examples:

- "see: https://redmine.doxswf.ru/issues/6314"
- "read https://redmine.doxswf.ru/issues/6314#note-3"
- "open redmine 6314"
- "fetch note 3 of redmine 6314"
- "Смени статус задачи 9999 на тестирование и переведи на Андрея"
- "Назначь задачу 9999 на Андрея"
- "Добавь комментарий в задачу 9999: ..."
- "Создай задачу в foquz.ru: ..."
- "Покажи пользователей/статусы/проекты Redmine"

Do NOT trigger:

- For arbitrary non-Redmine URLs.
- When the user only mentions a ticket id in passing without asking to read or
  change it.

## Safety policy for writes

`create` and `update` are mutating operations. The CLI is fail-closed:
without `--yes`, it prints a dry-run payload and does not change Redmine.

Agent workflow:

1. Resolve the operation with a dry run first, without `--yes`.
2. If the user's instruction is explicit and the dry run resolves status/user
   names uniquely, run the same command with `--yes`.
3. If anything is ambiguous (multiple users named Андрей, unclear project,
   uncertain status, destructive-looking action), ask the user to confirm or
   specify an id. Closed/destructive statuses (`Выполнена`, `Принята`,
   `Отклонена`, `Бэклог`, `Отложена`) require explicit confirmation unless the
   user requested that exact final state.
4. After a successful update/create, report the CLI output including the issue
   URL, status, and assignee.

Never guess among ambiguous user/status/project matches. Use explicit ids when
needed.

## Reading issues and notes

```bash
redmine --task "<URL or id>"
redmine --task "<URL or id>" --note <n>
```

`--note <n>` reads the Redmine history anchor number from `#note-n`.
For compatibility with older agent usage, if that exact history anchor is not
available through the API, the CLI falls back to the nth non-empty note.

Examples:

```bash
redmine --task https://redmine.doxswf.ru/issues/6314
redmine --task 'https://redmine.doxswf.ru/issues/6314#note-3'
redmine --task 6314 --note 3
```

Useful read flags:

- `--raw` — skip model post-processing (only when the user asks for original
  text).
- `--model <name>` — override the opencode model (default
  `opencode-go/deepseek-v4-flash`).

After reading:

- Treat `[INACCESSIBLE SCREENSHOT: <url>]` / `[INACCESSIBLE FILE: <url>]` as
  content you genuinely cannot see. Do not infer screenshot contents.
- Preserve Russian/Textile formatting when quoting.

## Updating issues

Use `--action update` (or `--update`) with `--task`.

```bash
redmine --action update --task 9999 --status "Тестирование" --assignee "Андрея"
redmine --action update --task 9999 --status-id 8 --assignee-id 85 --comment "Передано на тестирование"
```

Dry run first; then add `--yes` to apply:

```bash
redmine --action update --task 9999 --status "Тестирование" --assignee "Андрея"
redmine --action update --task 9999 --status "Тестирование" --assignee "Андрея" --yes
```

Supported update fields:

- `--status <name>` or `--status-id <id>`
- `--assignee <name>` or `--assignee-id <id>`
- `--comment <text>` / `--notes <text>` (Redmine journal note)

The CLI fetches the issue first, resolves assignees against the issue project's
memberships when possible, updates via Redmine REST API, then fetches the issue
again and prints the resulting status/assignee. Redmine may still reject a
status transition or assignee due to workflow/project permissions; surface those
API errors verbatim.

## Creating issues

Use `--action create` (or `--create`). Required: project and subject.

When creating Redmine tasks for doxswf projects, write the issue subject and description in Russian by default. If the user provides English wording,
translate it into natural Russian unless they explicitly ask to keep English or the text is a code/API identifier, URL, command, log output, package name,
version name, or other technical token that should stay as-is.

```bash
redmine --action create --project "foquz.ru" --subject "Короткий заголовок" --description "Описание задачи"
redmine --action create --project-id 1 --tracker-id 2 --subject "Короткий заголовок" --assignee-id 85
```

Dry run first; then add `--yes` to apply.

Supported create fields:

- `--project <id|identifier|name>`, `--project-id <id>`, or
  `--project-identifier <identifier>`
- `--subject <text>`
- `--description <text>`
- `--tracker <name>` or `--tracker-id <id>`
- `--status <name>` or `--status-id <id>`
- `--assignee <name>` or `--assignee-id <id>`
- `--priority-id <id>`

Redmine may require tracker, priority, or custom fields depending on project
settings. If creation fails, surface Redmine validation errors verbatim.

## Listing reference data

```bash
redmine --action list-users
redmine --action list-statuses
redmine --action list-projects
redmine --action list-trackers
```

Add `--json` when machine-readable output is useful.

### Current statuses

- `1` — `Новая`
- `2` — `В работе`
- `8` — `Тестирование`
- `7` — `Отправлена на доработку`
- `3` — `Выполнена` (closed)
- `11` — `Есть вопрос`
- `5` — `Принята` (closed)
- `6` — `Отклонена` (closed)
- `9` — `Бэклог` (closed)
- `10` — `Отложена` (closed)
- `12` — `Code Review`

### Current projects

- `1` / `hatimaki-foquz` — `foquz.ru`
- `9` / `foquz-ru-security` — `foquz.ru - security`

### Current trackers

- `1` — `Ошибка`
- `2` — `Улучшение`
- `3` — `Безопасность`

### Current visible users / assignable principals

This list comes from visible project memberships because non-admin API keys may
not access `/users.json`. It can become stale; when assigning someone, prefer to
run `redmine --action list-users` if exact identity matters. The command
may include groups if Redmine exposes group memberships.

- `83` — Александр Бурнышев
- `67` — Александр Валов
- `56` — Александр Елисеев
- `90` — Алишер Муратов
- `85` — Андрей Дмитерко
- `26` — Анна Алексеева
- `5` — Анна Кузнецова
- `88` — Богдан Долин
- `81` — Валентин Токарев
- `100` — Валерий Пузанов
- `78` — Виталий Матюнин
- `1` — Виталий Плотников
- `98` — Владислав Кабаков
- `96` — Герман Гусель
- `39` — Данил Кайков
- `104` — Дарья Рябинкова
- `86` — Дарья Иванова
- `84` — Дмитрий Журов
- `94` — Екатерина Григорьева
- `15` — Екатерина Остроумова
- `93` — Иван Гесс
- `64` — Игорь Орлов
- `102` — Илья Коновалов
- `73` — Кирилл Кузьмин
- `48` — Кирилл Zhirkin
- `80` — Константин Голощапов
- `75` — Константин Рольгайзер
- `95` — Константин Волощук
- `7` — Марина Корнеева
- `92` — Миннур Гусейнова
- `101` — Никита Барбашов
- `65` — Никита Лиханов
- `47` — Николай Черпинский
- `57` — Нодирбек Матчанов
- `87` — Ольга Горелова
- `12` — Ольга Григорьева
- `10` — Ольга Круглова
- `71` — Павел Довлатов
- `35` — Роман Козлов
- `103` — Роман Махотка
- `82` — Сергей Жидков
- `14` — Сергей Лукин
- `72` — Сергей Махов
- `91` — Снежана Волкова
- `77` — Тимофей Трофимов
- `99` — Тимур Артамов
- `6` — Федор Воропаев
- `70` — Эльвина Гареева
- `55` — Юля Ковалева
- `8` — Юрий Доця
- `89` — Sentry Foquz

Example: the phrase "переведи на Андрея" currently resolves to assignee id
`85` (`Андрей Дмитерко`) if no other project-specific Андрей is visible.

## Configuration / prerequisites

The CLI needs:

- `REDMINE_DOXSWF_API_KEY` env var (Redmine REST key).
- The `opencode` CLI on `PATH` for read-mode link cleanup.
- Company VPN/network access to `redmine.doxswf.ru`.

If prerequisites are missing or the VPN is down, tell the user and do not fall
back to unauthenticated web fetching.
