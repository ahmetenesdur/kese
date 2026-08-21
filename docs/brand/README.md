# Brand files

| File | For | Notes |
|---|---|---|
| `telegram-avatar.svg` | The Telegram bot's profile picture | Source. Export at 512×512. |
| `../kese-mark.svg` | GitHub README | The only copy with a fixed colour — see below. |
| `../../apps/claim/public/kese-mark.svg` | The site | `currentColor` |
| `../../apps/claim/public/favicon.svg` | Browser tabs | Follows the viewer's theme |

## Setting the bot's picture

BotFather → `/setuserpic` → pick your bot → send the PNG. Telegram crops to a circle, which the
avatar already accounts for: the mark fills 58% of the frame and is centred on its true bounding
box rather than the viewBox. Those differ, because the lid sits above the body and the shape is not
vertically symmetric — centring by eye put it 20 px high.

To re-export after a change:

```bash
qlmanage -t -s 512 -o . docs/brand/telegram-avatar.svg
```

## Why one file has a fixed colour

Everywhere the surface is ours, the mark uses `currentColor` and has no colour of its own. The
system has exactly three colours and they belong to the three answers a payment can get.

Two surfaces are not ours. A browser tab follows the viewer's own theme, so `favicon.svg` carries a
`prefers-color-scheme` rule. GitHub is worse: its page theme is a GitHub setting while
`prefers-color-scheme` follows the operating system, so the two can disagree and a theme-aware mark
can end up invisible. `docs/kese-mark.svg` is therefore a neutral mid-tone that holds on both
grounds.
