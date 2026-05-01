import React, { useState, useEffect, useRef } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { Plus, X, FileText, LogIn, LogOut, Cloud, Menu, MoreVertical, Trash2, Edit3 } from 'lucide-react';
import { v4 as uuidv4 } from 'uuid';
import { db } from './db';
import { auth, googleProvider, firestoreDb } from './firebase';
import { signInWithPopup, signOut, onAuthStateChanged } from 'firebase/auth';
import { collection, onSnapshot, setDoc, doc, query, where, serverTimestamp, deleteDoc } from 'firebase/firestore';
import './index.css';

function App() {
  const [activeTabId, setActiveTabId] = useState(null);
  const [openTabs, setOpenTabs] = useState([]);
  const [user, setUser] = useState(null);
  const [isSyncing, setIsSyncing] = useState(false);
  const [isMobileSidebarOpen, setIsMobileSidebarOpen] = useState(false);
  const [contextMenu, setContextMenu] = useState(null); // { x, y, noteId }
  const longPressTimer = useRef(null);

  const currentUserId = user ? user.uid : 'local';

  const notes = useLiveQuery(
    () => db.notes.where('userId').equals(currentUserId).toArray(),
    [currentUserId]
  ) || [];

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (currentUser) => {
      setUser(currentUser);
    });
    return () => unsubscribe();
  }, []);

  const saveAppState = async (newActiveTabId, newOpenTabs) => {
    setActiveTabId(newActiveTabId);
    setOpenTabs(newOpenTabs);
    await db.appState.put({
      id: 'main',
      activeTabId: newActiveTabId,
      openTabs: newOpenTabs
    });
  };

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

  useEffect(() => {
    if (!user) return;

    const q = query(collection(firestoreDb, 'notes'), where('userId', '==', user.uid));
    const unsubscribe = onSnapshot(q, (snapshot) => {
      snapshot.docChanges().forEach(async (change) => {
        if (change.type === 'added' || change.type === 'modified') {
          const data = change.doc.data();
          const localNote = await db.notes.get(change.doc.id);
          
          if (!localNote || localNote.lastModified < data.lastModified) {
            await db.notes.put({
              ...data,
              id: change.doc.id,
              syncStatus: 'synced'
            });

            // Auto-open tab for newly synced notes (PC behavior)
            if (!localNote) {
              const state = await db.appState.get('main');
              if (state && !state.openTabs.includes(change.doc.id)) {
                await saveAppState(change.doc.id, [...state.openTabs, change.doc.id]);
              }
            }
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
              serverTime: serverTimestamp()
            });
            await db.notes.update(note.id, { syncStatus: 'synced' });
          } catch (error) {
            console.error("Failed to sync note:", note.id, error);
          }
        }
        setIsSyncing(false);
      }
    }, 5000);

    return () => clearInterval(syncInterval);
  }, [user]);

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
    setIsMobileSidebarOpen(false); // Close sidebar on mobile when creating new
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

  const deleteNote = async (noteId) => {
    if (window.confirm('Are you sure you want to delete this note?')) {
      await db.notes.delete(noteId);
      // Remove from open tabs
      const newTabs = openTabs.filter(id => id !== noteId);
      let newActiveId = activeTabId === noteId ? (newTabs[0] || null) : activeTabId;
      await saveAppState(newActiveId, newTabs);
      
      if (user) {
        try {
          await deleteDoc(doc(firestoreDb, 'notes', noteId));
        } catch (error) {
          console.error("Failed to delete from Firestore:", error);
        }
      }
      setContextMenu(null);
    }
  };

  const renameNote = async (noteId) => {
    const note = await db.notes.get(noteId);
    const newTitle = window.prompt('Rename note:', note.title);
    if (newTitle !== null && newTitle.trim() !== '') {
      await db.notes.update(noteId, { 
        title: newTitle,
        lastModified: Date.now(),
        syncStatus: 'pending'
      });
    }
    setContextMenu(null);
  };

  const handleContextMenu = (e, noteId) => {
    e.preventDefault();
    setContextMenu({ x: e.pageX, y: e.pageY, noteId });
  };

  const handleTouchStart = (noteId) => {
    longPressTimer.current = setTimeout(() => {
      // Find coordinates from touch? Or just center?
      setContextMenu({ x: window.innerWidth / 2 - 50, y: window.innerHeight / 2 - 50, noteId });
    }, 600); // 600ms for long press
  };

  const handleTouchEnd = () => {
    if (longPressTimer.current) clearTimeout(longPressTimer.current);
  };

  return (
    <>
      {/* Mobile-only Header */}
      <div className="mobile-header">
        <button className="icon-btn" onClick={() => setIsMobileSidebarOpen(true)}>
          <Menu size={20} />
        </button>
        <div className="mobile-title">
          {activeNote ? activeNote.title : 'Notepad'}
        </div>
        <button className="icon-btn" onClick={createNewTab}>
          <Plus size={20} />
        </button>
      </div>

      {/* PC Titlebar (Hidden on Mobile) */}
      <div className="titlebar desktop-only">
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
      </div>
      
      <div className="editor-container" style={{ flexDirection: 'row' }}>
        
        {/* Mobile Sidebar Overlay */}
        <div className={`sidebar-overlay ${isMobileSidebarOpen ? 'open' : ''}`} onClick={() => setIsMobileSidebarOpen(false)}></div>
        
        {/* Sidebar */}
        <div 
          className={`app-sidebar ${isMobileSidebarOpen ? 'open' : ''}`}
          onClick={() => setContextMenu(null)}
        >
          <div style={{ padding: '16px', fontSize: '12px', fontWeight: 'bold', borderBottom: '1px solid var(--border-color)', color: 'var(--text-muted)' }}>
            ALL NOTES
          </div>
          <div style={{ flex: 1, overflowY: 'auto', padding: '8px' }}>
            {notes.map(note => (
              <div 
                key={note.id}
                onContextMenu={(e) => handleContextMenu(e, note.id)}
                onTouchStart={() => handleTouchStart(note.id)}
                onTouchEnd={handleTouchEnd}
                onClick={() => {
                  if (!openTabs.includes(note.id)) {
                    saveAppState(note.id, [...openTabs, note.id]);
                  } else {
                    saveAppState(note.id, openTabs);
                  }
                  setIsMobileSidebarOpen(false);
                }}
                className="sidebar-item"
                style={{
                  padding: '12px',
                  borderRadius: '6px',
                  cursor: 'pointer',
                  backgroundColor: activeTabId === note.id ? 'var(--tab-active-bg)' : 'transparent',
                  marginBottom: '4px',
                  fontSize: '14px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  position: 'relative'
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', overflow: 'hidden', flex: 1 }}>
                  <FileText size={14} color="#60cdff" style={{ flexShrink: 0, marginRight: 8 }} />
                  <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{note.title}</span>
                </div>
                
                {/* Delete button (visible on hover in PC or long press context) */}
                <button 
                  className="sidebar-delete-btn"
                  onClick={(e) => { e.stopPropagation(); deleteNote(note.id); }}
                  style={{
                    background: 'transparent',
                    border: 'none',
                    color: 'var(--text-muted)',
                    padding: '4px',
                    borderRadius: '4px',
                    display: 'flex'
                  }}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
            {notes.length === 0 && <div style={{ padding: '8px', fontSize: '12px', color: 'var(--text-muted)' }}>No notes found.</div>}
          </div>
          
          <div style={{ padding: '16px', paddingBottom: 'max(16px, env(safe-area-inset-bottom))', borderTop: '1px solid var(--border-color)', flexShrink: 0, backgroundColor: 'var(--bg-color)' }}>
            {user ? (
              <button className="sidebar-auth-btn" onClick={handleLogout}>
                <LogOut size={16} /> Logout ({user.displayName?.split(' ')[0] || 'User'})
              </button>
            ) : (
              <button className="sidebar-auth-btn active-auth" onClick={handleLogin}>
                <LogIn size={16} /> Sign In to Sync
              </button>
            )}
          </div>
        </div>

        {/* Context Menu */}
        {contextMenu && (
          <div 
            className="context-menu"
            style={{
              position: 'fixed',
              top: contextMenu.y,
              left: contextMenu.x,
              backgroundColor: '#2d2d2d',
              border: '1px solid var(--border-color)',
              borderRadius: '8px',
              boxShadow: '0 4px 12px rgba(0,0,0,0.5)',
              zIndex: 2000,
              padding: '4px',
              minWidth: '120px'
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <button 
              className="menu-item" 
              onClick={() => renameNote(contextMenu.noteId)}
            >
              <Edit3 size={14} /> Rename
            </button>
            <button 
              className="menu-item delete" 
              onClick={() => deleteNote(contextMenu.noteId)}
            >
              <Trash2 size={14} /> Delete
            </button>
          </div>
        )}

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
              {isMobileSidebarOpen ? '' : 'No tabs open. Open the menu to select a note or create a new one.'}
            </div>
          )}
        </div>
      </div>

      <div className="statusbar desktop-only">
        {user && isSyncing && <Cloud size={14} style={{ marginRight: 6, animation: 'pulse 2s infinite' }} />}
        <span>
          {!user ? 'Offline Mode (Local)' : (isSyncing ? 'Syncing...' : 'Synced via Firebase')}
        </span>
      </div>
    </>
  );
}

export default App;
