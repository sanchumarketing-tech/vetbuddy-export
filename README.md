# VetBuddy automation – Sanchu Animal Hospital

Fully automatic, in the cloud (GitHub Actions). Nobody's computer needs to be on.

```
06:47 AM IST  VetBuddy ──► report "Detailed Goods & Services usage by Patients", 1st of month → yesterday, all clinics
                         ├─► .xlsx (title + summary rows removed) ──► SharePoint: CRM Upload
                         ├─► Master "Vetbuddy Master Data 2.xlsx":  this month's rows replaced,
                         │      AX = date,  AY = "VOW Unit" (Vet on Wheels flag)
                         └─► Supabase database (for the Teams bot), same rows + VOW split
11:47 PM IST  CRM Upload ──► CRM Archive
```
On the 1st of a month the run takes the **whole previous month** (so the last day is never missed).

---

## Files

| File | What it does |
|---|---|
| `vetbuddy_sales_export.py` | Main script: VetBuddy login & report, .xlsx, SharePoint upload, archive, runs everything |
| `master_sheet.py` | Updates the master workbook (60 MB, 300k rows) without opening it in Excel |
| `vow.py` | **Vet on Wheels rules – the one place to change them** |
| `vetbuddy_sql.py` | Loads the rows into Supabase (daily + one-time backfill) |
| `.github/workflows/vetbuddy-daily.yml` | The schedule (6:47 AM / 11:47 PM IST) and the **Run workflow** button |
| `sql/01_schema.sql`, `sql/02_users.sql` | Create the database (run once in Supabase) |
| `bot_glossary.yaml` | Dictionary for the Teams bot (stage 2) |
| `.env.example`, `run_vetbuddy_export.bat` | Only for running on a Windows PC instead of GitHub |

---

## The master sheet

| Column | Content |
|---|---|
| A – AW | The 49 VetBuddy columns, exactly as exported |
| AX | `=INT(B)` – the date without time. Correct in every language/region setting (the old `DATEVALUE(TEXT(…))` swapped day and month for the 1st–12th). All date filters should use AX. |
| AY | **VOW Unit** – `CH VET ON WHEELS`, `CBE VET ON WHEELS`, `MADURAI VET ON WHEELS`, `TRICHY VET ON WHEELS` on **every line of a Vet on Wheels invoice**; empty = clinic sales |

Each morning only the current month's rows are replaced (deleted + pasted fresh under the last row,
empty rows at the bottom removed). Values of older months are never changed; AX and AY are
re-applied to all rows, so if the VOW rules change, the whole history follows.
SharePoint keeps version history – any day's update can be undone (⋯ → Version history).
**Nobody should have the master open (desktop Excel or Excel for the web) at 6:47 AM** – the script
retries for 30 minutes, then reports a failure.

## Vet on Wheels rule (`vow.py`)
1. A line is a VOW item if *Services and Goods* contains `VOW`, or starts with `Home visit`,
   `Nobivac`, `Mobile Veterinary Consult`, or is exactly `Consultation VOW` (not case-sensitive).
2. If **any** line of an invoice is a VOW item, **every** line of that invoice is VOW.
3. The unit comes from the Billed Clinic: Chennai clinics → CH, Coimbatore → CBE, Madurai, Trichy.
   A VOW invoice from a clinic that is not in the list is marked `VOW - UNMAPPED CLINIC`.

To change the rules: edit the two lists at the top of `vow.py` in GitHub (✏️ → commit) – the next
run applies them to the master and the database.

---

## One-time setup

### A. GitHub repository
Repository `vetbuddy-export` (private) must contain **all** files above, with the workflow at
`.github/workflows/vetbuddy-daily.yml`.

**Settings → Secrets and variables → Actions**

Secrets:
| Name | Value |
|---|---|
| `VETBUDDY_USER` / `VETBUDDY_PASS` | VetBuddy login (just the value, no `NAME=`) |
| `SP_TENANT_ID` / `SP_CLIENT_ID` / `SP_CLIENT_SECRET` | Azure app "VetBuddy Export" (Sites.ReadWrite.All, admin consent ✓) |
| `SUPABASE_DB_URL` | see C below |

Variables:
| Name | Value |
|---|---|
| `SP_SITE_URL` | `https://sanchuhospital.sharepoint.com/sites/SalesTeam` |
| `SP_LIBRARY` | `Sales Reports Sanchu` |
| `SP_FOLDER` | `CRM Upload` |
| `SP_ARCHIVE_FOLDER` | `CRM Archive` |
| `SP_MASTER_PATH` | `Vetbuddy Master Data 2.xlsx` |

### B. Microsoft (already done)
Azure → Entra ID → App registrations → *VetBuddy Export* → API permissions:
Microsoft Graph **Sites.ReadWrite.All (Application)**, status **✓ Granted**.
The client secret expires (24 months) – renew it and update `SP_CLIENT_SECRET` before then.

### C. Supabase (database for the Teams bot)
1. supabase.com → New project `sanchu-vetbuddy`, region **South Asia (Mumbai)**; save the database password.
2. **SQL Editor → New query**: paste `sql/01_schema.sql` → Run.
3. Edit `sql/02_users.sql`: replace the two passwords (letters + digits only) → paste → Run.
4. **Connect → Session pooler** → copy the URI, change `postgres.` to `vb_loader.` and put password 1 in →
   GitHub secret `SUPABASE_DB_URL`.
5. **Actions → Run workflow → `backfill`** once (~2 min): loads the whole master history.

The data is in schema `vetbuddy` (not published by Supabase's web API). Login `vb_loader` can only
replace rows; login `vb_bot` can only read a view **without** phone, email, GST, client ID or names.

---

## Running by hand
**Actions → VetBuddy daily MTD export → Run workflow**, choose:
- `export` – the morning run (report → CRM Upload → master → database)
- `archive` – move files from CRM Upload to CRM Archive
- `backfill` – reload the whole master into the database

## What a good morning log looks like
```
Logged in as ***
Requesting report 2026-11-01 -> 2026-11-03 (all clinics)...
Saved …MTD_2026-11-01_to_2026-11-03.xlsx (0.7 MB, 3964 data rows)
Uploaded to SharePoint: CRM Upload/…
Master: removed 2950 rows of 11/2026, removed 0 empty rows, added 3964 rows (now 300014 rows incl. header); VOW: 4350 invoices / 19400 lines flagged in column AY
Master updated in SharePoint: Vetbuddy Master Data 2.xlsx
Database: removed 2950 rows of 11/2026, added 3964 rows (85 VOW invoices)
```

## Troubleshooting
| Log says | Do this |
|---|---|
| `VETBUDDY_USER / VETBUDDY_PASS missing` | Secrets missing or misspelled |
| `Login failed` | VetBuddy password changed → update the secret. `login_debug.html` is in the run's Artifacts |
| `401 Unauthorized` (graph.microsoft.com) | Azure admin consent not granted / client secret expired |
| `Library '…' not found. Available: …` | Fix `SP_LIBRARY` (copy a name from the list) |
| `Master is open/locked` | Someone had the master open – close it; the next run (or a manual export) fixes it |
| `Master columns don't match the export` | VetBuddy changed its columns – master was NOT changed; send the log |
| `Column AY already holds …` | Someone typed in column AY – clear it |
| `Database load FAILED` | Check `SUPABASE_DB_URL` (Session pooler, `vb_loader.` user) |
| GitHub email "Run failed" | Open the run → red step → read the last lines |

Every run keeps the report, the log and `login_debug.html` for 14 days (run page → Artifacts).
