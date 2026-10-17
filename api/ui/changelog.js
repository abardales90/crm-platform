// Plain language notes for people who use the CRM. Newest first.
// To add one: put a new entry at the top with a new id. Everyone sees it once as a pop up, and it stays in Settings, Change log.
export const RELEASES = [
  {
    id: '0.6', date: '2026-10-17', title: 'Tasks, search, and spreadsheets',
    items: [
      'My tasks: a new page in the menu that lists every task assigned to you, grouped into overdue, today, later and no due date. Tick the box to mark one done.',
      'The Home page now shows how many of your tasks are due today or overdue.',
      'Search everything: the new box at the top of the menu finds accounts, contacts, deals and cases from part of a name, an email, or a case number.',
      'Download CSV is on every list (accounts, contacts, deals and cases). It saves what you see to a spreadsheet.',
      'Import CSV on Accounts and Contacts: bring in up to 500 rows at a time from a spreadsheet. Tally shows you a preview and any problems before anything is saved, and you can skip rows that already exist.',
      'You can now sign in with Google if your admin has turned it on.',
    ],
  },
  {
    id: '0.5', date: '2026-10-17', title: 'Meet Tally',
    items: [
      'The CRM has a name now: Tally.',
      'New logo in the menu, on the sign in page, and on the browser tab.',
    ],
  },
  {
    id: '0.4', date: '2026-10-17', title: 'Colors, a welcome tour, and update notes',
    items: [
      'Pick your own color in Settings. Your choice follows you to any device you sign in on.',
      'Settings now lives behind the gear at the bottom left.',
      'There is a short welcome tour. You take it once when you first sign in, and you can replay it any time from Settings.',
      'When something new ships, you see a short note about it the next time you sign in.',
      'Settings has a new Change log tab with every update so far.',
    ],
  },
  {
    id: '0.3', date: '2026-10-17', title: 'Reports, Settings and email replies',
    items: [
      'New Reports screen with three views: Support, Sales pipeline, and Accounts and renewals. Each one has a Download CSV button.',
      'New Settings screen. Choose Light, Dark, or match your device. Rename the workspace. Add people and set their role.',
      'You can reply to a customer by email right from a case. This turns on once email is set up in Render.',
      'Words like Solved and Customer now show with capital letters everywhere.',
      'Fixed the stray word null at the bottom of Home.',
    ],
  },
  {
    id: '0.2', date: '2026-10-16', title: 'Your CRM is live',
    items: [
      'Accounts, contacts, deals and cases all work.',
      'Deals can be dragged between stages on the board.',
      'Cases track first response and resolution deadlines.',
      'Every change is recorded behind the scenes, and nothing is truly deleted.',
    ],
  },
];
