# pi-auto-thinking

Fork of [aesisify/pi-auto-thinking](https://github.com/aesisify/pi-auto-thinking),
based on 0.1.2. Includes Codex compatibility and additional trial logging;
see [Local trial changes](#local-trial-changes). Original [MIT license](./LICENSE)
and history are preserved. This variant is not published to npm.

A [pi](https://pi.dev) extension that auto-sets the thinking level each turn via
an **online prompt-difficulty classifier**. The idea is borrowed from
[oh-my-pi](https://github.com/can1357/oh-my-pi)'s `auto` thinking level.

Each interactive or RPC turn, before the agent runs, a small **classifier model** rates
the prompt `low | medium | high | xhigh`, clamps it into your configured bounds,
and sets the thinking level for that turn. Trivial prompts stay cheap; hard ones
get reasoning budget. Short continuations (`continue`, `yes`, `ok`) return `keep`
and leave the level unchanged. On any failure (timeout, no key, unparseable
reply) it preserves the current level and never throws.

The valid thinking levels are never hard-coded — they come from pi's
`getSupportedThinkingLevels(model)`, so the classifier only ever picks among
levels the active model actually offers.

## Install

```bash
pi install git:github.com/asmisha/pi-auto-thinking
```

Do not also load the upstream npm package: that would register two classifiers.
After installation, start a new pi session or run `/reload` in an existing one.

## Configure

Config lives under a `pi-auto-thinking/` folder in your pi config root.
Project-local config shadows user-global.

- User:     `~/.pi/agent/pi-auto-thinking/config.json`
- Project:  `<project>/.pi/pi-auto-thinking/config.json`

For the same Luna configuration as the local trial, authenticate OpenAI Codex
in pi and create `~/.pi/agent/pi-auto-thinking/config.json` with:

```json
{
  "enabled": true,
  "classifier": "openai-codex/gpt-5.6-luna"
}
```

Check that Luna is available with `pi --list-models luna`. Without a configured
classifier, the extension is inactive. The omitted settings retain the upstream
defaults below. Other classifiers can be selected with their `provider/model` ID.

The Codex/Luna configuration was verified with pi 0.85.1. Normal RPC inputs
(including Slack bridge messages) are classified. Streaming follow-ups and
extension-generated inputs are skipped.

In dynamic-workflow subagents, auto-thinking is disabled: it makes no classifier
call and leaves the workflow's thinking level unchanged, even after
`/auto-thinking on`. This requires a workflow runner that sets the session-local
`pi-dynamic-workflows-subagent` extension flag before binding extensions.
Normal interactive and RPC sessions still classify; headless mode alone does
not disable the extension.

| field             | default   | notes                                                 |
| ----------------- | --------- | ---------------------------------------------------- |
| `enabled`         | `true`    | Master switch. `false` disables the classifier.      |
| `classifier`      | _(none)_  | `"provider/model"` — pi convention. Unset ⇒ inactive.|
| `minLevel`        | `low`     | Floor.                                               |
| `maxLevel`        | `xhigh`   | Ceiling.                                             |
| `timeoutMs`       | `4000`    | Per-turn classification budget before fallback.      |
| `maxTokens`       | `4096`    | Reasoning-safe cap (headroom for thinking-on models).|
| `classifierLevel` | `off`     | Reasoning effort for the classifier call.            |

## Commands

```
/auto-thinking          # status (default): active, classifier, bounds, last decision
/auto-thinking status   # explicit status
/auto-thinking on|off   # toggle for this session
```

Config is re-read each turn; run pi's built-in `/reload` to re-initialize after editing.

A footer statusline shows `auto→high` (last decision) or `auto:off`.

## Logs

Decision/fallback events are written to rolling log files:

- `~/.pi/agent/pi-auto-thinking/logs/<date>.log`

Rotation: daily, max 5 MB per file, keep 14 days.

## Local trial changes

This local checkout retains the 0.1.2 classification prompt, parser, bounds,
and timeout. It also classifies normal RPC inputs, while retaining the streaming
and extension-input exclusions. It omits `temperature` only for the
`openai-codex-responses` API, which rejects that parameter.

Decision logs additionally include session/file/parent-entry identifiers, input
source, UI presence, main and classifier models, thinking before/after, classifier
usage, stop reason, and provider errors. Skipped inputs are logged with their
reason so an unused extension can be distinguished from an ineligible input.
The resolved classifier API key is redacted from provider error messages. Prompt
bodies and classifier reasoning are not added to these records.

## Tests

Node-native (`node:test`), no framework. Requires Node ≥22.6 (unit) / ≥22.7 (integration).

```bash
npm test                 # unit tests (pure functions + config/logger/paths)
npm run test:integration # extension wiring via a loader + shims
npm run test:all         # both
```

## License

[MIT](./LICENSE) © aesisify
