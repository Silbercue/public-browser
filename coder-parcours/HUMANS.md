# Test the Stillwater Yoga site (for human testers)

Thank you for helping. You test a small web site for a yoga studio, the way you would test a site for a
friend who asked "does everything work?". Please do not look for hints about what might be wrong; use the
site normally and write down anything that seems off.

## What you need

- A computer with the Chrome browser (not a phone).
- 30 to 45 minutes without interruption.
- The link you were given. It looks like
  `https://<address>/?seed=<n>&report=1&tester=<your-name>`. Open it exactly as given and use that link
  (or that tab) for the whole session. Each person gets one link; please do not try other seeds.

## How to test

1. **Use the site like a visitor:** look at the schedule and class pages, sign in, put classes in the
   cart, check out, look at your bookings and your profile, change settings, sign out and in again.
2. **Test accounts** (you may use both; do not use real data):
   - `maya@stillwater.test` / `lotus-breath-26` (has two upcoming bookings)
   - `sam@stillwater.test` / `mountain-pose-26` (no bookings)
3. **Explore at three widths.** Go through the site at each of these widths:
   - phone: 390 px wide
   - tablet: 768 px wide
   - desktop: 1440 px wide

   To set a width: open the developer tools (`F12`, or `Ctrl+Shift+I` on Windows and Linux,
   `Cmd+Option+I` on a Mac), click the **device toolbar** icon (a phone and tablet symbol at the top left
   of the tools; shortcut `Ctrl+Shift+M` or `Cmd+Shift+M`), choose "Responsive" and type the width into the
   first number field at the top. Reload the page after changing the width. For desktop, close the tools or
   set 1440.
4. **Click "Report a problem"** (button fixed at the bottom right of every page) **for every oddity you notice**: something
   broken, confusing, cut off, wrong, slow, or simply strange. Say where you were, which width, what you did,
   what you expected and what happened. A short report is fine; several small ones are better than none.
   If you are unsure whether it is a problem, report it anyway and say that you are unsure.
5. Use the developer tools only to set the width. Do not read the page's source code or inspect elements to find problems; judge what you see and what
   the site does.

You do not have to finish everything. When your time is up, stop and tell the maintainer that you are done.
Your reports are stored with your name from the link and the seed number. They are used for the comparison
described in METHOD.md, and nothing else.
