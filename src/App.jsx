import React, { useState, useEffect, useRef } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { Plus, X, FileText, LogIn, LogOut, Cloud, Menu, MoreVertical, Edit2, Trash2 } from 'lucide-react';
import { v4 as uuidv4 } from 'uuid';
import { db } from './db';
import { auth, googleProvider, firestoreDb } from './firebase';
import { signInWithPopup, signOut, onAuthStateChanged } from 'firebase/auth';
import { collection, onSnapshot, setDoc, deleteDoc, doc, query, where, serverTimestamp } from 'firebase/firestore';
import './index.css';

function App() {
  const [activeTabId, setActiveTabId] = useState(null);
  const [openTabs, setOpenTabs] = useState([]);
  const [user, setUser] = useState(null);
  const [isSyncing, setIsSyncing] = useState(false);
  const [isMobileSidebarOpen, setIsMobileSidebarOpen] = useState(false);

  // Context Menu State
  const [contextMenu, setContextMenu] = useState({ visible: false, x: 0, y: 0, noteId: null });
  const [editingNoteId, setEditingNoteId] = useState(null);
  const [editingTitle, setEditingTitle] = useState("");

  const currentUserId = user ? user.uid : 'local';

  // Fetch all notes (including pending deletes so worker can process them)
  const allNotes = useLiveQuery(
    () => db.notes.where('userId').equals(currentUserId).toArray(),
    [currentUserId]
  ) || [];

  // Filter out soft-deleted notes from the UI
  const notes = allNotes.filter(n => n.syncStatus !== 'deleted');

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
          // Also remove from open tabs if open
          setOpenTabs(prev => {
            if (prev.includes(change.doc.id)) {
               const newTabs = prev.filter(id => id !== change.doc.id);
               saveAppState(null, newTabs); // simplistic active tab fallback
               return newTabs;
            }
            return prev;
          });
        }
      });
    }, (error) => {
      console.error("Firestore sync error:", error);
    });

    return () => unsubscribe();
  }, [user]);

  // Sync Worker
  useEffect(() => {
    if (!user) return;
    
    const syncInterval = setInterval(async () => {
      // 1. Sync pending updates/creates
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

      // 2. Sync pending deletes
      const pendingDeletes = await db.notes
        .where('userId').equals(user.uid)
        .and(n => n.syncStatus === 'deleted')
        .toArray();
      
      if (pendingDeletes.length > 0) {
        setIsSyncing(true);
        for (let note of pendingDeletes) {
          try {
            await deleteDoc(doc(firestoreDb, 'notes', note.id));
            await db.notes.delete(note.id);
          } catch (error) {
            console.error("Failed to delete remote note:", note.id, error);
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
    setIsMobileSidebarOpen(false);
  };

  const closeTab = async (e, idToClose) => {
    if (e) e.stopPropagation();
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

  // Delete Note Logic
  const handleDeleteNote = async (idToDelete) => {
    // Remove from UI open tabs first
    if (openTabs.includes(idToDelete)) {
      await closeTab(null, idToDelete);
    }

    if (user) {
      // Soft delete for syncing
      await db.notes.update(idToDelete, { syncStatus: 'deleted' });
    } else {
      // Hard delete if offline/local-only
      await db.notes.delete(idToDelete);
    }
    setContextMenu({ visible: false, x: 0, y: 0, noteId: null });
  };

  // Rename Note Logic
  const handleRenameSubmit = async (e) => {
    if (e.key === 'Enter') {
      const newTitle = editingTitle.trim() || "Untitled";
      const note = await db.notes.get(editingNoteId);
      
      // Update the first line of content to match the new title, keeping the rest
      const lines = note.content.split('\n');
      lines[0] = newTitle;
      const newContent = lines.join('\n');

      await db.notes.update(editingNoteId, {
        title: newTitle,
        content: newContent,
        lastModified: Date.now(),
        syncStatus: 'pending'
      });
      setEditingNoteId(null);
    }
  };

  // Context Menu and Long Press Handlers
  const touchTimer = useRef(null);

  const handleContextMenu = (e, noteId) => {
    e.preventDefault();
    setContextMenu({
      visible: true,
      x: e.clientX,
      y: e.clientY,
      noteId
    });
  };

  const handleTouchStart = (e, noteId) => {
    const touch = e.touches[0];
    touchTimer.current = setTimeout(() => {
      setContextMenu({
        visible: true,
        x: touch.clientX,
        y: touch.clientY,
        noteId
      });
    }, 500); // 500ms long press
  };

  const handleTouchEnd = () => {
    if (touchTimer.current) clearTimeout(touchTimer.current);
  };

  // Close context menu on any outside click
  useEffect(() => {
    const handleClick = () => setContextMenu({ visible: false, x: 0, y: 0, noteId: null });
    document.addEventListener('click', handleClick);
    return () => document.removeEventListener('click', handleClick);
  }, []);

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
        
        <div className={`sidebar-overlay ${isMobileSidebarOpen ? 'open' : ''}`} onClick={() => setIsMobileSidebarOpen(false)}></div>
        
        <div className={`app-sidebar ${isMobileSidebarOpen ? 'open' : ''}`}>
          <div style={{ padding: '16px', fontSize: '12px', fontWeight: 'bold', borderBottom: '1px solid var(--border-color)', color: 'var(--text-muted)' }}>
            ALL NOTES
          </div>
          <div style={{ flex: 1, overflowY: 'auto', padding: '8px' }}>
            {notes.map(note => (
              <div 
                key={note.id}
                onClick={() => {
                  if (editingNoteId !== note.id) {
                    if (!openTabs.includes(note.id)) {
                      saveAppState(note.id, [...openTabs, note.id]);
                    } else {
                      saveAppState(note.id, openTabs);
                    }
                    setIsMobileSidebarOpen(false);
                  }
                }}
                onContextMenu={(e) => handleContextMenu(e, note.id)}
                onTouchStart={(e) => handleTouchStart(e, note.id)}
                onTouchEnd={handleTouchEnd}
                onTouchMove={handleTouchEnd}
                style={{
                  padding: '12px',
                  borderRadius: '6px',
                  cursor: 'pointer',
                  backgroundColor: activeTabId === note.id ? 'var(--tab-active-bg)' : 'transparent',
                  marginBottom: '4px',
                  fontSize: '14px',
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  display: 'flex',
                  alignItems: 'center',
                  userSelect: 'none',
                  WebkitUserSelect: 'none'
                }}
              >
                <FileText size={14} color="#60cdff" style={{ marginRight: 8, flexShrink: 0 }} />
                
                {editingNoteId === note.id ? (
                  <input 
                    autoFocus
                    value={editingTitle}
                    onChange={(e) => setEditingTitle(e.target.value)}
                    onKeyDown={handleRenameSubmit}
                    onBlur={() => setEditingNoteId(null)}
                    onClick={(e) => e.stopPropagation()}
                    style={{ background: 'transparent', border: '1px solid var(--border-color)', color: 'white', outline: 'none', padding: '2px 4px', borderRadius: '4px', width: '100%' }}
                  />
                ) : (
                  <span>{note.title}</span>
                )}
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
              No tabs open. Open the menu to select a note or create a new one.
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

      {/* Custom Context Menu */}
      {contextMenu.visible && (
        <div 
          style={{
            position: 'fixed',
            top: contextMenu.y,
            left: contextMenu.x,
            backgroundColor: 'var(--tab-active-bg)',
            border: '1px solid var(--border-color)',
            boxShadow: '0 4px 12px rgba(0,0,0,0.5)',
            borderRadius: '8px',
            padding: '4px',
            zIndex: 9999,
            display: 'flex',
            flexDirection: 'column',
            minWidth: '150px'
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <button 
            className="context-menu-item"
            onClick={() => {
              setEditingNoteId(contextMenu.noteId);
              const note = notes.find(n => n.id === contextMenu.noteId);
              if (note) setEditingTitle(note.title);
              setContextMenu({ visible: false, x: 0, y: 0, noteId: null });
            }}
          >
            <Edit2 size={14} /> Rename
          </button>
          <button 
            className="context-menu-item"
            onClick={() => handleDeleteNote(contextMenu.noteId)}
            style={{ color: '#ff6b6b' }}
          >
            <Trash2 size={14} /> Delete
          </button>
        </div>
      )}
    </>
  );
}

export default App;
