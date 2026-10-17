// Plain language notes for people who use the CRM. Newest first.
// To add one: put a new entry at the top with a new id. Everyone sees it once as a pop up, and it stays in Settings, Change log.
export const RELEASES = [
  {
    id: '0.9', date: '2026-10-17', title: 'Choose where each column goes when you import',
    items: [
      'Import CSV now shows every column in your file next to the field it will go into. Change any of them, or set a column to Ignore.',
      'Your custom fields are in the list too, so a spreadsheet from SFDC can land in them.',
      'Admins can pick Create a custom field for a column that has no home yet. Tally guesses the kind (number, date, yes or no, or text) from what is in the column and tells you before it creates anything.',
      'If two columns are going into the same field, Tally says so and waits for you to fix it.',
    ],
  },
  {
    id: '0.8', date: '2026-10-17', title: 'Your own fields, saved views, and a clearer task list',
    items: [
      'Custom fields: in Settings, Custom fields, add your own fields to accounts, contacts, deals and cases. Pick text, long text, number, date, yes or no, or a list of choices. You can mark one as required.',
      'Your fields show on the record page, in the CSV download, and as columns in a CSV import.',
      'Saved views: on Accounts, Contacts, Deals and Cases, click Filters to narrow the list (for example customers with a health score under 40). Save it as a view, and pick it from the menu next time. Tick Share to let everyone in your workspace use it. Only the person who made a view can change or delete it.',
      'Filters work on your own custom fields too, and the CSV download keeps only what the filter shows.',
      'My tasks now has column headings and shows the type of each item.',
      'My tasks also lists calls, meetings and emails that have a due date and are assigned to you, so nothing you planned goes missing.',
    ],
  },
  {
    id: '0.7', date: '2026-10-17', title: 'Search at the top, icons, and a menu you can arrange',
    items: [
      'Search now sits at the top of every page. It looks inside case descriptions, notes, tasks and replies, not only names, and shows a short preview of the words that matched.',
      'Every result says what it is (account, contact, deal, case, task or reply) and has its own icon. Use the buttons under the search box to look at just one kind.',
      'Press the / key any time to jump to the search box.',
      'Each page has its own icon, in the menu and in its title.',
      'Collapse the left menu down to icons with the button at the top of it. Press it again to open it up.',
      'Rearrange the menu by dragging items, or use Settings, Left menu. Your order and your choice to collapse are saved to your account.',
      'The Tally logo now takes the color you pick, and so does the little icon on your browser tab.',
    ],
  },
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
