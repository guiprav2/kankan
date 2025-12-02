import { Y, IndexeddbPersistence } from '../other/y.js';
import { joinRoom } from 'https://esm.sh/trystero/nostr';

let BOARDS_KEY = 'kanban:boards';
let BOARD_DB_PREFIX = 'kanban:board:';
let APP_ROOM_ID = 'wf-kanban';
let DEFAULT_COLUMNS = [
  { name: 'Backlog' },
  { name: 'In Progress' },
  { name: 'Review' },
  { name: 'Done' },
];
let encodeBinary = bytes => {
  if (!bytes?.length) return '';
  let chunk = 0x8000;
  let str = '';
  for (let i = 0; i < bytes.length; i += chunk) {
    str += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(str);
};
let decodeBinary = str => {
  if (!str) return new Uint8Array();
  let bin = atob(str);
  let out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    out[i] = bin.charCodeAt(i);
  }
  return out;
};

export default class App {
  sessions = new Map();
  state = {
    boards: [],
    selectedBoardId: null,
    columns: [],
    boardReady: false,
    peerCount: 0,
    showBoardMenu: false,
    boardStatus: 'idle',
    boardSummaries: {},
    boardPeers: {},
    get activeBoard() {
      return this.boards.find(x => x.id === this.selectedBoardId) || null;
    },
  };
  loadBoards() {
    let stored = [];
    try {
      stored = JSON.parse(localStorage.getItem(BOARDS_KEY) || '[]');
    } catch {
      stored = [];
    }
    if (!Array.isArray(stored)) stored = [];
    stored = stored
      .filter(x => x && x.id)
      .map(x => ({
        id: x.id,
        name: (x.name || 'Untitled Board').trim() || 'Untitled Board',
        createdAt: x.createdAt || Date.now(),
        placeholder: Boolean(x.placeholder),
      }));
    stored.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
    this.state.boards = stored;
    if (!this.state.selectedBoardId && stored[0]) this.state.selectedBoardId = stored[0].id;
  }
  persistBoards() {
    localStorage.setItem(BOARDS_KEY, JSON.stringify(this.state.boards));
  }
  async ensureBoardSession(boardId, options = {}) {
    let { seedDefaults = false } = options || {};
    if (!boardId) return null;
    if (this.sessions.has(boardId)) return this.sessions.get(boardId);
    let board = this.state.boards.find(x => x.id === boardId);
    if (!board) return null;
    let doc = new Y.Doc({ guid: `kanban-board-${boardId}` });
    let persistence = new IndexeddbPersistence(`${BOARD_DB_PREFIX}${boardId}`, doc);
    let networkOrigin = Symbol(`board:${boardId}`);
    let session = { boardId, doc, persistence, networkOrigin, peers: new Set(), ready: null };
    session.ready = persistence.whenSynced.then(async () => {
      if (seedDefaults) await this.initializeDoc(doc);
      this.refreshBoardState(boardId);
      this.seedBoardDocNameFromLocal(boardId);
      this.syncBoardNameFromDoc(boardId);
    });
    let broadcastUpdate = update => {
      if (!session.sendUpdate || !update?.length) return;
      let payload = encodeBinary(update);
      if (!payload?.length) return;
      session.sendUpdate({ update: payload });
    };
    doc.on('update', (update, origin) => {
      this.refreshBoardState(boardId);
      this.syncBoardNameFromDoc(boardId);
      if (origin === networkOrigin) return;
      broadcastUpdate(update);
    });
    await this.setupRoom(session);
    this.sessions.set(boardId, session);
    await session.ready;
    return session;
  }
  async setupRoom(session) {
    let boardRoom = joinRoom({ appId: APP_ROOM_ID }, session.boardId);
    session.room = boardRoom;
    let [sendVector, onVector] = boardRoom.makeAction('vec');
    let [sendUpdate, onUpdate] = boardRoom.makeAction('up');
    session.sendVector = sendVector;
    session.sendUpdate = sendUpdate;
    let pushVector = peer => {
      if (!session.doc) return;
      let vector = Y.encodeStateVector(session.doc);
      let payload = encodeBinary(vector);
      sendVector({ vector: payload }, peer);
    };
    boardRoom.onPeerJoin(peer => {
      session.peers.add(peer);
      pushVector(peer);
      this.updatePeerCount(session.boardId);
    });
    boardRoom.onPeerLeave(peer => {
      session.peers.delete(peer);
      this.updatePeerCount(session.boardId);
    });
    onVector(({ vector } = {}, peer) => {
      if (!vector) return;
      let diff = Y.encodeStateAsUpdate(session.doc, decodeBinary(vector));
      if (!diff?.length) return;
      sendUpdate({ update: encodeBinary(diff) }, peer);
    });
    onUpdate(({ update } = {}) => {
      if (!update) return;
      let decoded = decodeBinary(update);
      if (!decoded?.length) return;
      Y.applyUpdate(session.doc, decoded, session.networkOrigin);
      d.update();
    });
    pushVector();
  }
  async initializeDoc(doc) {
    doc.transact(() => {
      let columns = doc.getArray('columns');
      if (columns.length) return;
      let items = DEFAULT_COLUMNS.map(item => {
        let colMap = new Y.Map();
        colMap.set('id', crypto.randomUUID());
        colMap.set('name', item.name);
        colMap.set('cards', new Y.Array());
        return colMap;
      });
      columns.push(items);
    });
  }
  refreshBoardState(boardId) {
    if (this.state.selectedBoardId !== boardId) return;
    let session = this.sessions.get(boardId);
    if (!session) return;
    this.syncBoardNameFromDoc(boardId);
    let columns = session.doc.getArray('columns').toArray().map(col => ({
      id: col.get('id'),
      name: col.get('name') || 'Untitled Column',
      cards: (col.get('cards')?.toArray() || []).map(card => ({
        id: card.get('id'),
        title: card.get('title') || 'Untitled',
        description: card.get('description') || '',
        tag: card.get('tag') || '',
        columnId: col.get('id'),
        createdAt: card.get('createdAt') || null,
        ageLabel: this.getCardAgeLabel(card.get('createdAt')),
      })),
    }));
    this.state.columns = columns;
    this.updateCardAgeLabels();
    this.updateBoardSummary(boardId, columns);
    this.state.boardReady = true;
    this.updatePeerCount(boardId);
  }
  clearBoardState() {
    this.state.columns = [];
    this.state.peerCount = 0;
    this.state.boardReady = false;
  }
  updatePeerCount(boardId) {
    if (this.state.selectedBoardId !== boardId) return;
    let session = this.sessions.get(boardId);
    this.state.peerCount = session ? session.peers.size : 0;
    let peers = { ...this.state.boardPeers };
    peers[boardId] = this.state.peerCount;
    this.state.boardPeers = peers;
  }
  updateBoardSummary(boardId, columns) {
    if (!boardId) return;
    let columnList = Array.isArray(columns) ? columns : [];
    let cardCount = columnList.reduce((total, column) => {
      let cards = Array.isArray(column.cards) ? column.cards : [];
      return total + cards.length;
    }, 0);
    let summary = {
      columnCount: columnList.length,
      cardCount,
    };
    let summaries = { ...this.state.boardSummaries };
    summaries[boardId] = summary;
    this.state.boardSummaries = summaries;
  }
  updateCardAgeLabels() {
    let columns = this.state.columns;
    if (!Array.isArray(columns) || !columns.length) return false;
    let mutated = false;
    for (let column of columns) {
      let cards = Array.isArray(column.cards) ? column.cards : [];
      for (let card of cards) {
        let nextLabel = this.getCardAgeLabel(card.createdAt);
        if (card.ageLabel !== nextLabel) {
          card.ageLabel = nextLabel;
          mutated = true;
        }
      }
    }
    return mutated;
  }
  async updateBoardDocName(boardId, name) {
    let id = (boardId || '').trim();
    let boardName = (name || '').trim();
    if (!id || !boardName) return;
    let session = await this.ensureBoardSession(id);
    if (session?.ready) await session.ready;
    if (!session?.doc) return;
    session.doc.transact(() => {
      let meta = session.doc.getMap('meta');
      meta.set('name', boardName);
    });
  }
  syncBoardNameFromDoc(boardId) {
    if (!boardId) return;
    let session = this.sessions.get(boardId);
    if (!session?.doc) return;
    let meta = session.doc.getMap('meta');
    let docName = (meta?.get('name') || '').trim();
    if (!docName) return;
    let entry = this.state.boards.find(x => x.id === boardId);
    if (!entry || entry.name === docName) return;
    entry.name = docName;
    entry.placeholder = false;
    this.state.boards.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
    this.persistBoards();
  }
  seedBoardDocNameFromLocal(boardId) {
    if (!boardId) return;
    let entry = this.state.boards.find(x => x.id === boardId);
    if (!entry || entry.placeholder) return;
    let session = this.sessions.get(boardId);
    if (!session?.doc) return;
    let meta = session.doc.getMap('meta');
    let docName = (meta?.get('name') || '').trim();
    if (docName) return;
    let boardName = (entry.name || '').trim();
    if (!boardName) return;
    session.doc.transact(() => {
      meta.set('name', boardName);
    });
  }
  getCardAgeLabel(timestamp) {
    if (!timestamp) return '';
    let delta = Date.now() - timestamp;
    if (!Number.isFinite(delta) || delta < 0) delta = 0;
    let minute = 60 * 1000;
    let hour = 60 * minute;
    let day = 24 * hour;
    if (delta >= day) {
      let days = Math.max(1, Math.round(delta / day));
      return `${days}d`;
    }
    if (delta >= hour) {
      let hours = Math.max(1, Math.round(delta / hour));
      return `${hours}h`;
    }
    if (delta >= minute) {
      let minutes = Math.max(1, Math.round(delta / minute));
      return `${minutes}m`;
    }
    let seconds = Math.max(1, Math.round(delta / 1000));
    return `${seconds}s`;
  }
  buildBoardJoinUrl(boardId) {
    return boardId ? `https://kankan-demo.netlify.app/?joinBoard=${boardId}` : '';
  }
  consumeJoinBoardParam() {
    try {
      if (typeof location === 'undefined') return null;
      let url = new URL(location.href);
      let value = (url.searchParams.get('joinBoard') || '').trim();
      if (!value) return null;
      url.searchParams.delete('joinBoard');
      if (typeof history !== 'undefined' && history.replaceState) {
        let nextUrl = `${url.pathname}${url.search}${url.hash}`;
        let title = typeof document !== 'undefined' ? document.title : '';
        history.replaceState(history.state, title, nextUrl);
      }
      return value;
    } catch {
      return null;
    }
  }
  async joinBoardById(boardId) {
    let id = (boardId || '').trim();
    if (!id) return false;
    let board = this.state.boards.find(entry => entry.id === id);
    if (!board) {
      let shortId = id.slice(0, 6) || id;
      let placeholderName = shortId ? `Shared Board (${shortId})` : 'Shared Board';
      board = { id, name: placeholderName, createdAt: Date.now(), placeholder: true };
      this.state.boards.push(board);
      this.state.boards.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
      this.persistBoards();
    }
    this.state.selectedBoardId = id;
    this.clearBoardState();
    let session = await this.ensureBoardSession(id);
    if (!session) return false;
    this.state.boardStatus = 'ready';
    return true;
  }
  getColumnMap(doc, columnId) {
    if (!columnId) return null;
    let columns = doc.getArray('columns').toArray();
    return columns.find(col => col.get('id') === columnId) || null;
  }
  removeColumn(doc, columnId) {
    if (!doc || !columnId) return false;
    let columns = doc.getArray('columns');
    let list = columns.toArray();
    for (let i = 0; i < list.length; i++) {
      if (list[i].get('id') === columnId) {
        columns.delete(i, 1);
        return true;
      }
    }
    return false;
  }
  findCard(doc, columnId, cardId) {
    if (!columnId || !cardId) return null;
    let columns = doc.getArray('columns').toArray();
    for (let col of columns) {
      if (col.get('id') !== columnId) continue;
      let cards = col.get('cards');
      let list = cards?.toArray() || [];
      for (let i = 0; i < list.length; i++) {
        if (list[i].get('id') === cardId) {
          return { column: col, cards, card: list[i], index: i };
        }
      }
    }
    return null;
  }
  async ensureBoardSelected() {
    if (!this.state.selectedBoardId && this.state.boards[0]) {
      this.state.selectedBoardId = this.state.boards[0].id;
    }
    if (!this.state.selectedBoardId) return null;
    return await this.ensureBoardSession(this.state.selectedBoardId);
  }
  actions = {
    init: async () => {
      let joinBoardId = this.consumeJoinBoardParam();
      this.loadBoards();
      if (joinBoardId) {
        let joined = await this.joinBoardById(joinBoardId);
        if (joined) return;
      }
      this.state.boardStatus = this.state.boards.length ? 'ready' : 'empty';
      if (this.state.selectedBoardId) {
        this.state.boardReady = false;
        await this.ensureBoardSession(this.state.selectedBoardId);
      }
      if (!this.state.boards.length) {
        await this.actions.createBoard();
      }
      setInterval(() => {
        this.updateCardAgeLabels();
        d.update();
      }, 5000);
    },
    createBoard: async () => {
      let [btn, name] = await showModal('PromptDialog', {
        title: `New Board`,
        placeholder: `Board name`,
        allowEmpty: false,
        value: '',
      });
      if (btn !== 'ok') {
        if (!this.state.boards.length) this.state.boardStatus = 'empty';
        return;
      }
      let board = {
        id: crypto.randomUUID(),
        name: name.trim() || 'Untitled Board',
        createdAt: Date.now(),
        placeholder: false,
      };
      this.state.boards.push(board);
      this.state.boards.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
      this.persistBoards();
      this.state.selectedBoardId = board.id;
      this.state.boardReady = false;
      this.clearBoardState();
      await this.ensureBoardSession(board.id, { seedDefaults: true });
      await this.updateBoardDocName(board.id, board.name);
      this.state.boardStatus = 'ready';
    },
    selectBoard: async id => {
      if (!id || this.state.selectedBoardId === id) return;
      this.state.selectedBoardId = id;
      this.state.boardReady = false;
      this.clearBoardState();
      await this.ensureBoardSession(id);
    },
    renameBoard: async board => {
      if (!board) return;
      let [btn, name] = await showModal('PromptDialog', {
        title: `Rename Board`,
        placeholder: `Board name`,
        value: board.name,
        allowEmpty: false,
      });
      if (btn !== 'ok') return;
      board.name = name.trim() || board.name;
      board.placeholder = false;
      this.state.boards.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
      this.persistBoards();
      await this.updateBoardDocName(board.id, board.name);
    },
    deleteBoard: async board => {
      if (!board) return;
      let [btn, value] = await showModal('PromptDialog', {
        title: `Type DELETE to remove ${board.name}`,
        placeholder: 'DELETE',
        allowEmpty: false,
        value: '',
        caption: 'This action cannot be undone.',
      });
      if (btn !== 'ok' || value.trim().toLowerCase() !== 'delete') return;
      let idx = this.state.boards.findIndex(x => x.id === board.id);
      if (idx >= 0) this.state.boards.splice(idx, 1);
      let session = this.sessions.get(board.id);
      if (session?.persistence?.clearData) await session.persistence.clearData();
      if (session?.room?.leave) session.room.leave();
      this.sessions.delete(board.id);
      if (this.state.selectedBoardId === board.id) {
        this.state.selectedBoardId = this.state.boards[0]?.id || null;
        this.clearBoardState();
        await this.ensureBoardSelected();
      }
      let summaries = { ...this.state.boardSummaries };
      if (board.id in summaries) {
        delete summaries[board.id];
        this.state.boardSummaries = summaries;
      }
      let peers = { ...this.state.boardPeers };
      if (board.id in peers) {
        delete peers[board.id];
        this.state.boardPeers = peers;
      }
      this.persistBoards();
      if (!this.state.boards.length) this.state.boardStatus = 'empty';
      if (!this.state.selectedBoardId) this.clearBoardState();
    },
    copyBoardLink: async boardId => {
      let targetId = boardId || this.state.selectedBoardId;
      if (!targetId) return;
      let shareUrl = this.buildBoardJoinUrl(targetId);
      if (!shareUrl) return;
      await navigator.clipboard.writeText(shareUrl);
    },
    deleteColumn: async columnId => {
      if (!columnId) return;
      let session = await this.ensureBoardSelected();
      if (!session) return;
      let column = this.getColumnMap(session.doc, columnId);
      if (!column) return;
      let columnName = column.get('name') || 'Untitled Column';
      let [btn] = await showModal('ConfirmationDialog', {
        title: `Delete column`,
        message: `Delete "${columnName}" and all cards inside it? This cannot be undone.`,
        confirmLabel: 'Delete column',
      });
      if (btn !== 'ok') return;
      session.doc.transact(() => {
        this.removeColumn(session.doc, columnId);
      });
    },
    newCard: async columnId => {
      let session = await this.ensureBoardSelected();
      if (!session) return;
      let [btn, payload] = await showModal('CardEditorDialog', {
        mode: 'create',
        columns: this.state.columns,
        columnId,
      });
      if (btn !== 'ok') return;
      let targetColumn = payload?.columnId || columnId || this.state.columns[0]?.id;
      if (!targetColumn) return;
      session.doc.transact(() => {
        let columnMap = this.getColumnMap(session.doc, targetColumn);
        if (!columnMap) return;
        let cards = columnMap.get('cards');
        if (!cards) {
          cards = new Y.Array();
          columnMap.set('cards', cards);
        }
        let cardMap = new Y.Map();
        cardMap.set('id', crypto.randomUUID());
        cardMap.set('title', payload?.title?.trim() || 'Untitled');
        cardMap.set('description', payload?.description?.trim() || '');
        if (payload?.tag?.trim()) cardMap.set('tag', payload.tag.trim());
        cardMap.set('createdAt', Date.now());
        cards.push([cardMap]);
      });
    },
    viewCard: async (columnId, cardId) => {
      let session = await this.ensureBoardSelected();
      if (!session) return;
      let entry = this.findCard(session.doc, columnId, cardId);
      if (!entry) return;
      let card = {
        id: entry.card.get('id'),
        title: entry.card.get('title') || 'Untitled',
        description: entry.card.get('description') || '',
        tag: entry.card.get('tag') || '',
        createdAt: entry.card.get('createdAt') || null,
        columnId,
        columnName: entry.column.get('name') || 'Column',
      };
      let [btn, detail] = await showModal('CardViewDialog', {
        card,
        columnId,
      });
      if (btn === 'edit') {
        await this.actions.editCard(columnId, cardId);
      } else if (btn === 'delete') {
        await this.actions.deleteCard(columnId, cardId);
      }
    },
    editCard: async (columnId, cardId) => {
      let session = await this.ensureBoardSelected();
      if (!session) return;
      let entry = this.findCard(session.doc, columnId, cardId);
      if (!entry) return;
      let payloadCard = {
        title: entry.card.get('title') || '',
        description: entry.card.get('description') || '',
        tag: entry.card.get('tag') || '',
        columnId,
        id: entry.card.get('id'),
      };
      let [btn, payload] = await showModal('CardEditorDialog', {
        mode: 'edit',
        columns: this.state.columns,
        columnId,
        card: payloadCard,
      });
      if (btn !== 'ok') return;
      session.doc.transact(() => {
        let targetColumnId = payload?.columnId || columnId;
        let targetColumn = this.getColumnMap(session.doc, targetColumnId);
        if (!targetColumn) return;
        entry.card.set('title', payload?.title?.trim() || 'Untitled');
        entry.card.set('description', payload?.description?.trim() || '');
        if (payload?.tag?.trim()) entry.card.set('tag', payload.tag.trim());
        else entry.card.delete('tag');
        if (targetColumnId !== columnId) {
          entry.cards.delete(entry.index, 1);
          let targetCards = targetColumn.get('cards');
          if (!targetCards) {
            targetCards = new Y.Array();
            targetColumn.set('cards', targetCards);
          }
          targetCards.push([entry.card]);
        }
      });
    },
    deleteCard: async (columnId, cardId) => {
      let session = await this.ensureBoardSelected();
      if (!session) return;
      let entry = this.findCard(session.doc, columnId, cardId);
      if (!entry) return;
      session.doc.transact(() => {
        entry.cards.delete(entry.index, 1);
      });
    },
  };
}
