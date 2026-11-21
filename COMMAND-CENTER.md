# ⚡ Command Center

A live map of your whole AI system. **Your brain is in the center.** Around it are the sections of your life and business (5 Star, ArbCity, …) and the AI agents working inside them. Click any one to see what it does and **every system it can access**. Above everything sits your **Board of Directors**: Scripture, Finance and Tester, who give an outside verdict on your ideas. Your **Coach** sits beside the brain, can see all of it, and answers questions.

```
                 ⚖️  BOARD OF DIRECTORS
          📖 Scripture   📊 Finance   🧪 Tester
                  ╲          │          ╱
   ☁️ iCloud Sync ───────  🧠 MY BRAIN  ─────── ⭐ 5 Star ── 🎧 Zendesk Agent
                            │      ╲
                        🎯 ArbCity   💬 Coach
```

## What's in this folder

| File | What it does |
|---|---|
| `command.html` | The Command Center app (installable in Chrome) |
| `supabase/command-center.sql` | Database tables, security rules, live updates, the daily market-brief schedule |
| `supabase/functions/board-review` | The Board. Every member reviews in parallel and saves a verdict |
| `supabase/functions/coach-chat` | Your Coach. Reads the whole map and your brain, and suggests improvements |
| `supabase/functions/market-brief` | Finance's weekday morning brief: live markets, plus what they mean for ArbCity and your goals |
| `supabase/functions/icloud-ingest` | Receives Apple Notes, Reminders, Calendar and iCloud Drive files |
| `supabase/functions/_shared/claude.ts` | Claude Opus 5.5 calls with web search; every call is recorded in `my_spend()` |
| `mac/icloud-sync.js` + `mac/install.sh` | Runs on your Mac every 15 minutes and sends iCloud changes to your brain |

---

## Set it up (about 20 minutes)

### 1. Database
Supabase → **SQL Editor** → New query → paste all of `supabase/command-center.sql` → **Run**.
(The schedule inside it calls your project URL. If you forked this repo, change `eompdnlidiaqivakumez` to your own project's ID first.)

### 2. Secrets
`ANTHROPIC_API_KEY` and `OWNER_USER_ID` are already set from Level 5. Now make a password for your iCloud sync. Generate one:

```bash
openssl rand -hex 24
```

Copy what it prints into your password manager (your Mac and iPhone need it), then save it in Supabase:

```bash
npx supabase secrets set INGEST_TOKEN=paste-it-here
```

Optional:

```bash
npx supabase secrets set GITHUB_TOKEN=github_pat_xxx
```
This is a **read-only**, fine-grained token that lets the Tester read your *private* repos. Public repos work without it.

```bash
npx supabase secrets set BOARD_MODEL=claude-sonnet-5-5
```
Use this to make the Board and Coach cheaper. The default is `claude-opus-5-5`, which gives the best judgement.

### 3. Deploy the functions

```bash
for f in board-review coach-chat market-brief icloud-ingest enrich-thought; do npx supabase functions deploy $f --no-verify-jwt; done
```

(`enrich-thought` is redeployed because it now sends new **ideas** and **plans** to the Board automatically. Turn that off with `npx supabase secrets set AUTO_BOARD_REVIEW=off`.)

### 4. Open it and install it
1. Push to GitHub. GitHub Pages serves `command.html` next to your existing app.
2. Open `https://<you>.github.io/open-brain-student/command.html` in **Chrome** and sign in.
3. The first time you open it, it builds your starting map: the Board (Scripture, Finance, Tester), 5 Star with its Zendesk Agent, ArbCity, and iCloud Sync.
4. **Install it:** click the install icon (a monitor with a down arrow) at the right end of Chrome's address bar → **Install**. It opens in its own window with an icon in your Dock or taskbar. To launch it at login: `chrome://apps` → right-click → *Open at login*. On iPhone: Safari → Share → **Add to Home Screen**.

### 5. iCloud → your brain, automatically

**On your Mac** (covers Apple Notes, Reminders, Calendar and iCloud Drive):

```bash
bash mac/install.sh
```

Enter your Supabase project URL and the `INGEST_TOKEN`. macOS will ask whether `osascript` may control Notes, Reminders and Calendar. Click **OK** each time. From then on it runs every 15 minutes, as long as your Mac is awake. Drop any document into **iCloud Drive → Brain** and it gets read in too: txt, md, pdf, docx, rtf, pages and html.

Follow the log:

```bash
tail -f ~/.open-brain/sync.log
```

Remove it:

```bash
bash mac/install.sh --remove
```

**On your iPhone** (instant capture from anywhere, with no Mac needed): Shortcuts app → **+** → add these actions:
1. *Receive* **Text** input from **Share Sheet** (and set "If there's no input" → **Ask For** Text)
2. *Get Contents of URL*: `https://<project>.supabase.co/functions/v1/icloud-ingest`
   - Method **POST**, Headers: `Authorization` = `Bearer <INGEST_TOKEN>`
   - Request Body **JSON**: `source` = `shortcut`, `title` = `iPhone capture`, `content` = *Shortcut Input*
3. Name it **"Send to Brain"**. It now shows up in every Share sheet, including Notes, Safari and Mail.

Editing a note later **updates** the same thought in your brain instead of creating a copy, and the new text is re-tagged and re-mapped for search.

---

## Using it

- **Click anything** to see what it does, what it **runs on**, and every **connected system** with its access level (`read` / `write` / `read/write` / `admin`). Add or remove connections right there.
- **＋ Add** creates a new **section** (a business or area of life), **agent**, or **board member**. Every new agent or section goes to the Board for review automatically.
- **Board verdicts** come back as `aligned`, `caution` or `conflict`, with a score out of 10, concerns, suggestions, the questions you should be asking, and references: Bible verses, market data, or file names in your code.
- **Coach**: ask anything, or tap **💡 How do I improve my system?** When it recommends a new agent, an **Add to map** button appears under its reply.
- **Finance → 📈 Run market brief now**, or just wait for it every weekday at 7:12am Mountain. The brief is saved in your brain and sent to Telegram if you set that up.
- **Everything is live.** A note you save on your phone makes the brain pulse on your computer within seconds.

## Make the Board yours
Each member's **"How it judges"** text is the instruction it follows. Open it → **Edit** to change it. For example:
- Scripture: add your church's specific convictions, or your own position on sports betting.
- Finance: add your actual goals ("emergency fund of $X by June", "ArbCity bankroll cap $Y").
- Tester: connect more repos (GitHub → `owner/repo`).
- Add more seats: a Lawyer, a Marketing lead, a Health coach. Any member whose connections include **Web** can search the internet; any member with **GitHub** connections reads that code.

## What it costs
Each Board review is one Claude call per member, and the Coach makes one call per message. To see the exact spend:

```sql
select * from my_spend();
```

Guards built in: at most 40 Board reviews and 60 Coach messages an hour; the scheduled brief runs at most once every 18 hours, and an on-demand brief at most once an hour.

## Security notes
- Every Command Center table is owner-only. Board verdicts and Coach messages can only be written by your server functions, so nobody can forge them.
- `INGEST_TOKEN` is a password. Keep it out of GitHub. It's stored on your Mac in `~/.open-brain/config.json`, readable only by you.
- Give agents the **least access** they need. The Tester will point out anything with `write` or `admin` access it thinks is too broad.
