# deepseek-v4-flash system prompt

## Effective Patterns

### figma-use usage
- Always start with `figma-use status` to confirm connection
- Use `figma-use node tree <node-id> --depth 3-5` to inspect structure, then drill deeper
- Export PNG to /tmp for visual grounding: `figma-use export node <node-id> --format PNG --output /tmp/figma-<dashed-id>.png --timeout 60 -f`
- When `node get` fails with RPC injection error, simply retry with --timeout
- Use `figma-use query "//TEXT" --root <node-id> --select id,name,text --limit 100` for text inventory
- Node IDs in URLs use hyphen form (10208-4237) but figma-use needs colon form (10208:4237)
- When exploring, start with --depth 3, then drill deeper where needed

### Exploring unknown codebases
1. First read entry points (index.js, model.js, template.html) of the target component
2. Read parent/owner components to understand the flow
3. Read related models (data structures)
4. Read sibling implementations for patterns (e.g., existing review question types)
5. Search for related constants/types (question-types.js)
6. Check migrations for DB schema understanding
7. Check PHP models and services for server-side data handling
8. Check the `question-form` models for the authoring-side data structure

### Tool choice for file system operations
- **ls** — for listing directories. Never `read` a directory (raises EISDIR). Never `bash ls`.
- **find** — for glob/pattern file search. Respects .gitignore. Prefer over `bash find`.
- **grep** — for content search within files. Respects .gitignore. Prefer over `bash grep | grep -v node_modules`.
- **bash** — use only when the dedicated tools can't do what you need (e.g., `bash find ... -name "*" | xargs grep -l` for cross-type searches, or running npm commands).

### Common mistakes to avoid
- Reading a directory with `read` — always use `ls` first, then `read` specific files
- Assuming paths without verifying — use `ls`, `find`, or `bash test -d` to check existence first
- Using `bash` for grep/find when dedicated tools exist — dedicated tools handle .gitignore automatically
- Running `figma-use` commands in parallel — run them sequentially, retry with `--timeout` on RPC errors

### Review question type implementation pattern (foquz-core)
To add a new question type to review sidesheet:
1. Create model: `ko/models/review/question/<type>.js` — extends ReviewQuestion, parses answer data
2. Register in: `ko/models/review/question/index.js` — add import and map entry
3. Create component: `ko/components/review-question/types/<type>/` — index.js, model.js, template.html, style.less
4. Register component in: `ko/components/review-question/index.js`
5. Add switch case in: `ko/components/review-question/model.js` — `getQuestionType()` and `ViewModel` constructor switch
6. Optionally add type to edit button condition in: `ko/dialogs/review-sidesheet/template.html`

### Answer JSON parsing (kano example)
When question type stores complex nested JSON in `answer.answer`, use:
```js
let parsed = {};
const raw = data.answer?.answer;
if (typeof raw === 'string') { try { parsed = JSON.parse(raw); } catch(e) {} }
else if (typeof raw === 'object') { parsed = raw; }
```

### Figma breakpoint inspection pattern
- Always check all 4 breakpoints when responsive design is mentioned
- Compare column widths, layout mode (grid→card), text stacking, and spacing changes
- Extract exact colors, dimensions from node get responses
- Document grid-template-columns per breakpoint with exact px values
- Note when layout changes from grid to card/flex (like kano at 480/320)

## Project Context: foquz-core

- **Dual-layer architecture**: PHP views (Yii2) + Knockout.js viewModels
- **Question types** defined in `ko/data/question-types.js` with numeric IDs
- **Review question types** map in `ko/components/review-question/model.js` via switch on `parseInt(question.type)`
- **Review question data models** in `ko/models/review/question/` — each type extends ReviewQuestion
- **Kano question type** = 28 (`KANO_QUESTION`), not yet implemented in review sidesheet
- **ReviewQuestion** base class: in `ko/models/review/question/question.js`
- **QuestionViewModel** base class: in `ko/components/review-question/types/question.js`
- **styles**: LESS with `@import 'Style/breakpoints'` and `@import 'Style/colors'`
- **Lodash**: commonly imported as `import { get as _get, forIn } from "lodash"`
- **Translations**: via `_t()` and `Translator("question")`

## Key Files Paths

- Review sidesheet: `ko/dialogs/review-sidesheet/`
- Review questions component: `ko/dialogs/review-sidesheet/components/review-questions/`
- Review question types: `ko/components/review-question/`
- Question types constants: `ko/data/question-types.js`
- Review question data models: `ko/models/review/question/`
- Review model: `ko/models/review/index.js`
- Question form models (authoring): `ko/components/question-form/models/types/`
- Question form utils (formatters): `ko/components/question-form/utils/`
- Related external projects: `~/projects/poll-vue-app`, `~/projects/foquz-widget-dom`, `./ko/widgets/poll_new`

## General Principles

- Never run build/test/deploy commands unless explicitly asked
- Always read AGENTS.md for project-specific instructions first
- Prefer `read + edit` over `cat/sed` for file operations
- Use `ls` instead of `bash ls` or `read` on directories — `read` on a directory raises `EISDIR`
- Use `edit` with multiple disjoint edits in one call when changing separate locations in one file
- Use `write` for new files or complete rewrites
- Always specify a clear extraction goal when using `read_session`
