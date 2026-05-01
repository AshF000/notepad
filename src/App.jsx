import React, { useState, useEffect } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { Plus, X, FileText, LogIn, LogOut, Cloud } from 'lucide-react';
import { v4 as uuidv4 } from 'uuid';
import { db } from './db';
import { auth, googleProvider, firestoreDb } from './firebase';
import { signInWithPopup, signOut, onAuthStateChanged } from 'firebase/auth';
import { collection, onSnapshot, setDoc, doc, query, where, serverTimestamp } from 'firebase/firestore';
import './index.css';

function App() {
  const [activeTabId, setActiveTabId] = useState(null);
  const [openTabs, setOpenTabs] = useState([]);
  const [user, setUser] = useState(null);
  const [isSyncing, setIsSyncing] = useState(false);

  // Determine current user ID for database queries
  const currentUserId = user ? user.uid : 'local';

  // Query local notes for the current user
  const notes = useLiveQuery(
    () => db.notes.where('userId').equals(currentUserId).toArray(),
    [currentUserId]
  ) || [];

  // Listen to Auth State
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (currentUser) => {
      setUser(currentUser);
    });
    return () => unsubscribe();
  }, []);

  // Load app state
  useEffect(() => {
    const loadState = async () => {
      let state = await db.appState.get('main');
      if (!state) {
        state = { id: 'main', activeTabId: null, openTabs: [] };
      }
      setOpenTabs(state.openTabs || []);
      setActiveTabId(state.activeTabId);
    };
    loadState();
  }, [currentUserId]);

  // Firebase Real-time Sync (Only when logged in)
  useEffect(() => {
    if (!user) return;

    // Listen to remote changes
    const q = query(collection(firestoreDb, 'notes'), where('userId', '==', user.uid));
    const unsubscribe = onSnapshot(q, (snapshot) => {
      snapshot.docChanges().forEach(async (change) => {
        if (change.type === 'added' || change.type === 'modified') {
          const data = change.doc.data();
          const localNote = await db.notes.get(change.doc.id);
          // Simple conflict resolution: Last Write Wins
          if (!localNote || localNote.lastModified < data.lastModified) {
            await db.notes.put({
              ...data,
              id: change.doc.id,
              syncStatus: 'synced'
            });
          }
        }
        if (change.type === 'removed') {
          await db.notes.delete(change.doc.id);
        }
      });
    }, (error) => {
      console.error("Firestore sync error:", error);
    });

    return () => unsubscribe();
  }, [user]);

  // Background worker to push local pending changes to Firebase
  useEffect(() => {
    if (!user) return;
    
    const syncInterval = setInterval(async () => {
      const pendingNotes = await db.notes
        .where('userId').equals(user.uid)
        .and(n => n.syncStatus === 'pending')
        .toArray();

      if (pendingNotes.length > 0) {
        setIsSyncing(true);
        for (let note of pendingNotes) {
          try {
            await setDoc(doc(firestoreDb, 'notes', note.id), {
              ...note,
              syncStatus: 'synced',
              serverTime: serverTimestamp() // Optional: for true server ordering
            });
            await db.notes.update(note.id, { syncStatus: 'synced' });
          } catch (error) {
            console.error("Failed to sync note:", note.id, error);
          }
        }
        setIsSyncing(false);
      }
    }, 5000); // Check every 5 seconds

    return () => clearInterval(syncInterval);
  }, [user]);

  const saveAppState = async (newActiveTabId, newOpenTabs) => {
    setActiveTabId(newActiveTabId);
    setOpenTabs(newOpenTabs);
    await db.appState.put({
      id: 'main',
      activeTabId: newActiveTabId,
      openTabs: newOpenTabs
    });
  };

  const createNewTab = async () => {
    const newId = uuidv4();
    await db.notes.add({
      id: newId,
      title: 'Untitled',
      content: '',
      lastModified: Date.now(),
      syncStatus: 'pending',
      userId: currentUserId
    });
    const newTabs = [...openTabs, newId];
    await saveAppState(newId, newTabs);
  };

  const closeTab = async (e, idToClose) => {
    e.stopPropagation();
    const newTabs = openTabs.filter(id => id !== idToClose);
    
    let newActiveId = activeTabId;
    if (activeTabId === idToClose) {
      if (newTabs.length > 0) {
        const closedIndex = openTabs.indexOf(idToClose);
        newActiveId = newTabs[Math.max(0, closedIndex - 1)];
      } else {
        newActiveId = null;
      }
    }
    
    await saveAppState(newActiveId, newTabs);
  };

  const updateContent = async (e) => {
    const content = e.target.value;
    const title = content.split('\n')[0].substring(0, 30) || 'Untitled';
    
    await db.notes.update(activeTabId, {
      content,
      title,
      lastModified: Date.now(),
      syncStatus: 'pending'
    });
  };

  const handleLogin = async () => {
    try {
      await signInWithPopup(auth, googleProvider);
    } catch (error) {
      console.error("Login failed", error);
      alert("Make sure you added your Firebase API keys in .env.local!");
    }
  };

  const handleLogout = async () => {
    await signOut(auth);
    setOpenTabs([]);
    setActiveTabId(null);
  };

  const activeNote = notes.find(n => n.id === activeTabId);

  return (
    <>
      <div className="titlebar">
        {openTabs.map(tabId => {
          const note = notes.find(n => n.id === tabId);
          if (!note) return null;
          
          return (
            <button 
              key={tabId}
              className={`tab ${activeTabId === tabId ? 'active' : ''}`}
              onClick={() => saveAppState(tabId, openTabs)}
            >
              <FileText size={14} color="#60cdff" />
              <span className="tab-title">{note.title}</span>
              <div 
                className="tab-close" 
                onClick={(e) => closeTab(e, tabId)}
              >
                <X size={14} />
              </div>
            </button>
          );
        })}
        <button className="new-tab-btn" onClick={createNewTab} title="New Tab">
          <Plus size={18} />
        </button>

        {/* Auth Section in Titlebar */}
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', marginRight: '8px', paddingBottom: '4px' }}>
          {user ? (
            <button className="new-tab-btn" onClick={handleLogout} title="Logout" style={{ width: 'auto', padding: '0 12px', fontSize: '12px' }}>
              <LogOut size={14} style={{ marginRight: '6px' }} />
              {user.displayName || user.email}
            </button>
          ) : (
            <button className="new-tab-btn" onClick={handleLogin} title="Login with Google" style={{ width: 'auto', padding: '0 12px', fontSize: '12px', background: 'var(--accent-color)', color: '#000' }}>
              <LogIn size={14} style={{ marginRight: '6px' }} />
              Sign In to Sync
            </button>
          )}
        </div>
      </div>
      
      <div className="editor-container" style={{ flexDirection: 'row' }}>
        {/* Sidebar for all notes */}
        <div style={{ width: '200px', borderRight: '1px solid var(--border-color)', backgroundColor: 'rgba(0,0,0,0.2)', display: 'flex', flexDirection: 'column' }}>
          <div style={{ padding: '8px 12px', fontSize: '12px', fontWeight: 'bold', borderBottom: '1px solid var(--border-color)', color: 'var(--text-muted)' }}>
            ALL NOTES
          </div>
          <div style={{ flex: 1, overflowY: 'auto', padding: '8px' }}>
            {notes.map(note => (
              <div 
                key={note.id}
                onClick={() => {
                  if (!openTabs.includes(note.id)) {
                    saveAppState(note.id, [...openTabs, note.id]);
                  } else {
                    saveAppState(note.id, openTabs);
                  }
                }}
                style={{
                  padding: '8px',
                  borderRadius: '4px',
                  cursor: 'pointer',
                  backgroundColor: activeTabId === note.id ? 'var(--tab-active-bg)' : 'transparent',
                  marginBottom: '4px',
                  fontSize: '13px',
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis'
                }}
              >
                {note.title}
              </div>
            ))}
            {notes.length === 0 && <div style={{ padding: '8px', fontSize: '12px', color: 'var(--text-muted)' }}>No notes found.</div>}
          </div>
        </div>

        {/* Main Editor */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
          {activeNote ? (
            <textarea
              className="textarea"
              value={activeNote.content}
              onChange={updateContent}
              placeholder="Type your notes here... (Saves automatically)"
              autoFocus
            />
          ) : (
            <div style={{ padding: 24, color: 'var(--text-muted)' }}>
              No tabs open. Click + to create a new note or select one from the sidebar.
              {!user && <p style={{ marginTop: 8 }}>Sign in to access your cloud-synced notes across all your devices.</p>}
            </div>
          )}
        </div>
      </div>

      <div className="statusbar">
        {user && isSyncing && <Cloud size={14} style={{ marginRight: 6, animation: 'pulse 2s infinite' }} />}
        <span>
          {!user ? 'Offline Mode (Local Only)' : (isSyncing ? 'Syncing to Cloud...' : 'All changes synced via Firebase')}
        </span>
      </div>
    </>
  );
}

export default App;
