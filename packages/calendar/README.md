# Family calendar (2026-10-01–2026-12-31)

**Source of truth:** [`src/index.html`](src/index.html) + [`src/events.jsonl`](src/events.jsonl).

- Single static page, continuous weekly grid, fixed minimal month/weekday header, Monday by default (Sunday selectable).
- `events.jsonl`: one public event per line: `{"date":"YYYY-MM-DD","title":"..."}`; add `"holiday":true` for national holidays. Multiple records per day are allowed.
- Desktop hover reveals the browser tooltip; tapping a date shows the details. Date links use `#d-YYYY-MM-DD` and browser Back; the Today link scrolls back to today's date if in range.
- The in-page editor only previews and exports JSONL. **It never saves shared events.** Replace `src/events.jsonl` and redeploy to publish changed data.
- All content is public. **Never commit private family schedules here.** No auth, database, R2, D1, or server runtime.
- CI: `.github/workflows/calendar-ci.yml` tests the actual browser behavior and reload after changing only JSONL. This workflow **does not deploy**.

To test locally, install `playwright==1.57.0` and its Chromium browser, then run `python packages/calendar/test_calendar.py` from the repository root.
