# The Gift Auction

A Christmas gift auction game. Everyone brings a present and starts with $100 in game money, and each player can win one present. The auctioneer picks one of two modes for each present:

- **Live auction (default):** everyone sees the high bid and taps +$10, +$20 or +$50 to beat it. A 20-second clock starts when bidding opens and resets to 15 seconds after every bid, with "Going once…" and "Going twice…" on screen. When it runs out, the present is sold to the leader. Outbid phones vibrate where supported, and the big screen plays a gavel sound with confetti.
- **Sealed bids:** everyone bids secretly or skips, and the auctioneer reveals the highest. Ties go to a re-bid or a random draw.

## What's in here

| Folder | What it is |
| --- | --- |
| `apps-script/` | The Google Apps Script web app (`Code.gs`, `Index.html`, `appsscript.json`). This is the version to share by link. |
| `claude-artifact/` | The original version that runs as a Claude artifact. It only works inside Claude. |

## Deploy the Apps Script version

1. Go to [script.google.com](https://script.google.com) and create a project called "The Gift Auction".
2. Copy in `Code.gs`. Then add an HTML file named exactly `Index` and copy in `Index.html`.
3. Open **Project Settings** and turn on "Show appsscript.json manifest file in editor". Paste in `appsscript.json`.
4. Under **Project Settings > Script properties**, add a property called `HOST_PIN` and give it your auctioneer PIN. The PIN is kept out of the code on purpose, so it never ends up in git.
5. Go to **Deploy > New deployment > Web app**. Set Execute as to **Me**. Set Who has access to **Anyone**, or to your organisation only.
6. Share the `…/exec` URL. Use **I'm the auctioneer** at the bottom of the page, and your PIN, to run the auction.

To update the app after a code change, go to **Deploy > Manage deployments > Edit > New version**. The URL stays the same.

### Optional: push from this repo with clasp

```bash
npm install -g @google/clasp
clasp login
cd apps-script
clasp create --type webapp --title "The Gift Auction"   # first time only; writes .clasp.json
clasp push
```

`.clasp.json` only holds the script ID, so it's fine to commit. Your login token is stored in `~/.clasprc.json`, outside this repo.

## How the game data works

- State is kept in the script's Script Properties, under the keys `game`, `players` and `bids`.
- Writes go through `LockService`, so bids arriving at the same moment don't overwrite each other.
- Phones poll about every second during a live auction and every 2.5 seconds otherwise. Bids that arrive up to 1 second after the clock hits zero still count, to cover phone lag. Clock lengths are set at the top of `Code.gs`.
- In sealed mode, bid amounts are never sent to any phone, the auctioneer's included, until the winner is revealed.
- **Start a new game** on the auctioneer screen clears all of it.
