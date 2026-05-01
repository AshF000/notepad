import Dexie from 'dexie';

export const db = new Dexie('NotepadDB');

// Added userId for account isolation
db.version(2).stores({
  notes: 'id, title, content, lastModified, syncStatus, userId',
  appState: 'id' // 'activeTabId', 'openTabs' (array of strings), 'userId'
});

// Seed initial state if needed
db.on('populate', () => {
  const initialNoteId = crypto.randomUUID();
  db.notes.add({
    id: initialNoteId,
    title: 'Welcome to Notepad',
    content: 'Start typing here...\nLog in to sync your notes across devices!',
    lastModified: Date.now(),
    syncStatus: 'synced',
    userId: 'local' // Default until logged in
  });
  db.appState.add({
    id: 'main',
    activeTabId: initialNoteId,
    openTabs: [initialNoteId]
  });
});
