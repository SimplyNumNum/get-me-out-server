const WebSocket = require('ws');
const bcrypt    = require('bcryptjs');
const crypto    = require('crypto');
const fs        = require('fs');
const path      = require('path');

const PORT      = process.env.PORT || 8765;
// DATA_DIR can be overridden by an env var so a persistent volume survives deployments.
// On Railway: set DATA_DIR=/data and mount a Volume at /data.
const DATA_DIR  = process.env.DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'accounts.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// Persistent account data
// ---------------------------------------------------------------------------
// {
//   username: {
//     passwordHash: string,
//     tokens:       string[],   // session tokens (up to 5, for multiple devices)
//     friends:      string[],
//     pendingIn:    string[],
//     pendingOut:   string[],
//     achievements: string[]    // for later!
//   }
// }

function loadAccounts() {
    if (fs.existsSync(DATA_FILE)) {
        try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch { return {}; }
    }
    return {};
}
function saveAccounts() {
    fs.writeFileSync(DATA_FILE, JSON.stringify(accounts, null, 2));
}

let accounts = loadAccounts();

// ---------------------------------------------------------------------------
// Runtime state (lives only while server is running)
// ---------------------------------------------------------------------------

const clients = new Map(); // ws → { username, x, y, lobby_id }
const byName  = new Map(); // username → ws
const lobbies = new Map(); // lobby_id → lobby object

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function generateToken() {
    return crypto.randomBytes(32).toString('hex');
}

function isValidUsername(u) {
    return typeof u === 'string' && u.length >= 2 && u.length <= 20 && /^[a-zA-Z0-9_\- ]+$/.test(u);
}

function isValidPassword(p) {
    return typeof p === 'string' && p.length >= 6;
}

function send(ws, type, extra = {}) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type, ...extra }));
    }
}

function broadcastHub(type, extra, skip = null) {
    clients.forEach((p, ws) => {
        if (ws !== skip && !p.lobby_id) send(ws, type, extra);
    });
}

function notifyLobby(lobby_id, type, extra) {
    const lobby = lobbies.get(lobby_id);
    if (!lobby) return;
    lobby.players.forEach(u => {
        const ws = byName.get(u);
        if (ws) send(ws, type, extra);
    });
}

function lobbySummary(lobby) {
    return {
        id: lobby.id, name: lobby.name, host: lobby.host,
        max_players: lobby.max_players, is_public: lobby.is_public,
        players: lobby.players,
    };
}

function leaveLobby(player, ws) {
    const lobby = lobbies.get(player.lobby_id);
    if (!lobby) { player.lobby_id = null; return; }

    lobby.players = lobby.players.filter(u => u !== player.username);
    player.lobby_id = null;

    if (lobby.players.length === 0) {
        lobbies.delete(lobby.id);
    } else {
        if (lobby.host === player.username) {
            lobby.host = lobby.players[0];
            notifyLobby(lobby.id, 'lobby_host_changed', { new_host: lobby.host });
        }
        notifyLobby(lobby.id, 'lobby_updated', { lobby: lobbySummary(lobby) });
    }
    send(ws, 'lobby_left', {});
}

// ---------------------------------------------------------------------------
// Shared login completion (called after password/token verified)
// ---------------------------------------------------------------------------

function completeLogin(ws, username, token) {
    if (byName.has(username)) {
        send(ws, 'error', { message: 'This account is already logged in.' });
        return;
    }

    const acc = accounts[username];
    const player = { username, x: 400, y: 300, lobby_id: null, skin: 'default' };
    clients.set(ws, player);
    byName.set(username, ws);

    const hubPlayers = [];
    clients.forEach((p, w) => {
        if (w !== ws && !p.lobby_id) hubPlayers.push({ username: p.username, x: p.x, y: p.y, skin: p.skin || 'default' });
    });

    send(ws, 'registered', {
        username,
        token,                                                  // client saves this for auto-login
        friends:       acc.friends,
        pendingIn:     acc.pendingIn,
        onlineFriends: acc.friends.filter(f => byName.has(f)),
        hubPlayers,
    });

    broadcastHub('player_joined_hub', { username, x: player.x, y: player.y, skin: player.skin }, ws);

    acc.friends.forEach(f => {
        const fw = byName.get(f);
        if (fw) send(fw, 'friend_online', { username });
    });

    console.log(`[+] ${username}`);
}

// ---------------------------------------------------------------------------
// Auth handlers
// ---------------------------------------------------------------------------

async function handleRegister(ws, msg) {
    const { username, password } = msg;

    if (!isValidUsername(username)) {
        send(ws, 'error', { message: 'Username must be 2–20 chars (letters, numbers, spaces, _ -).' });
        return;
    }
    if (!isValidPassword(password)) {
        send(ws, 'error', { message: 'Password must be at least 6 characters.' });
        return;
    }
    if (accounts[username]) {
        send(ws, 'error', { message: 'That username is already taken. Try another or log in.' });
        return;
    }

    try {
        const passwordHash = await bcrypt.hash(password, 10);
        const token = generateToken();
        accounts[username] = {
            passwordHash,
            tokens:       [token],
            friends:      [],
            pendingIn:    [],
            pendingOut:   [],
            achievements: [],
        };
        saveAccounts();
        completeLogin(ws, username, token);
    } catch (err) {
        console.error('Register error:', err);
        send(ws, 'error', { message: 'Server error during registration. Please try again.' });
    }
}

async function handleLogin(ws, msg) {
    const { username, password } = msg;
    const acc = accounts[username];

    if (!acc) {
        send(ws, 'error', { message: 'No account found with that username.' });
        return;
    }

    try {
        const valid = await bcrypt.compare(password, acc.passwordHash);
        if (!valid) {
            send(ws, 'error', { message: 'Incorrect password.' });
            return;
        }

        const token = generateToken();
        acc.tokens.push(token);
        if (acc.tokens.length > 5) acc.tokens.shift(); // keep last 5
        saveAccounts();
        completeLogin(ws, username, token);
    } catch (err) {
        console.error('Login error:', err);
        send(ws, 'error', { message: 'Server error during login. Please try again.' });
    }
}

function handleAutoLogin(ws, msg) {
    const { username, token } = msg;
    const acc = accounts[username];

    if (!acc || !acc.tokens.includes(token)) {
        send(ws, 'token_invalid', {});
        return;
    }
    completeLogin(ws, username, token);
}

// ---------------------------------------------------------------------------
// Social handlers (same as before)
// ---------------------------------------------------------------------------

const VALID_SIZES = new Set([1, 2, 3, 4, 8]);

function handleHubMove(ws, msg, player) {
    player.x = msg.x;
    player.y = msg.y;
    broadcastHub('player_moved', { username: player.username, x: msg.x, y: msg.y }, ws);
}

function handleSetSkin(ws, msg, player) {
    // Accept any short alphanumeric skin id
    const skin = (typeof msg.skin === 'string' && msg.skin.length <= 32) ? msg.skin : 'default';
    player.skin = skin;
    broadcastHub('player_skin_changed', { username: player.username, skin }, ws);
}

function handleFriendRequest(ws, msg, player) {
    const target = msg.target_username;
    if (!target || target === player.username) return;

    const acc  = accounts[player.username];
    const tacc = accounts[target];
    if (!tacc) { send(ws, 'error', { message: `No account found for "${target}".` }); return; }
    if (acc.friends.includes(target)) { send(ws, 'error', { message: 'Already friends.' }); return; }
    if (acc.pendingOut.includes(target)) { send(ws, 'error', { message: 'Request already sent.' }); return; }

    if (acc.pendingIn.includes(target)) {
        acc.friends.push(target);
        acc.pendingIn = acc.pendingIn.filter(u => u !== target);
        tacc.friends.push(player.username);
        tacc.pendingOut = tacc.pendingOut.filter(u => u !== player.username);
        saveAccounts();
        send(ws, 'friend_added', { username: target });
        const tw = byName.get(target);
        if (tw) send(tw, 'friend_added', { username: player.username });
        return;
    }

    acc.pendingOut.push(target);
    tacc.pendingIn.push(player.username);
    saveAccounts();
    send(ws, 'friend_request_sent', { target });
    const tw = byName.get(target);
    if (tw) send(tw, 'friend_request_received', { from: player.username });
}

function handleFriendAccept(ws, msg, player) {
    const { from } = msg;
    const acc  = accounts[player.username];
    const facc = accounts[from];
    if (!facc || !acc.pendingIn.includes(from)) return;

    acc.friends.push(from);
    acc.pendingIn = acc.pendingIn.filter(u => u !== from);
    facc.friends.push(player.username);
    facc.pendingOut = facc.pendingOut.filter(u => u !== player.username);
    saveAccounts();

    send(ws, 'friend_added', { username: from });
    const fw = byName.get(from);
    if (fw) send(fw, 'friend_added', { username: player.username });
}

function handleFriendDecline(ws, msg, player) {
    const { from } = msg;
    const acc  = accounts[player.username];
    const facc = accounts[from];
    if (!facc) return;
    acc.pendingIn = acc.pendingIn.filter(u => u !== from);
    facc.pendingOut = facc.pendingOut.filter(u => u !== player.username);
    saveAccounts();
    send(ws, 'friend_request_declined', { from });
}

function handleRemoveFriend(ws, msg, player) {
    const { target } = msg;
    const acc  = accounts[player.username];
    const tacc = accounts[target];
    if (!acc) return;
    acc.friends = acc.friends.filter(u => u !== target);
    if (tacc) tacc.friends = tacc.friends.filter(u => u !== player.username);
    saveAccounts();
    send(ws, 'friend_removed', { username: target });
    const tw = byName.get(target);
    if (tw) send(tw, 'friend_removed', { username: player.username });
}

function handleCreateLobby(ws, msg, player) {
    if (player.lobby_id) { send(ws, 'error', { message: 'Leave your current lobby first.' }); return; }
    if (!VALID_SIZES.has(msg.max_players)) { send(ws, 'error', { message: 'Invalid lobby size.' }); return; }

    const lobby_id = `${player.username}_${Date.now()}`;
    const lobby = {
        id: lobby_id,
        name: (msg.lobby_name || `${player.username}'s Lobby`).slice(0, 40),
        host: player.username,
        max_players: msg.max_players,
        is_public: !!msg.is_public,
        players: [player.username],
        invited: [],
    };
    lobbies.set(lobby_id, lobby);
    player.lobby_id = lobby_id;
    send(ws, 'lobby_created', { lobby: lobbySummary(lobby) });
}

function handleJoinLobby(ws, msg, player) {
    if (player.lobby_id) { send(ws, 'error', { message: 'Leave your current lobby first.' }); return; }
    const lobby = lobbies.get(msg.lobby_id);
    if (!lobby) { send(ws, 'error', { message: 'Lobby not found.' }); return; }
    if (lobby.players.length >= lobby.max_players) { send(ws, 'error', { message: 'Lobby is full.' }); return; }
    if (!lobby.is_public && !lobby.invited.includes(player.username)) {
        send(ws, 'error', { message: 'This lobby is invite only.' }); return;
    }

    lobby.players.push(player.username);
    player.lobby_id = lobby.id;
    send(ws, 'lobby_joined', { lobby: lobbySummary(lobby) });
    notifyLobby(lobby.id, 'lobby_updated', { lobby: lobbySummary(lobby) });
}

function handleLobbyInvite(ws, msg, player) {
    if (!player.lobby_id) return;
    const lobby = lobbies.get(player.lobby_id);
    if (!lobby || lobby.host !== player.username) return;
    const target = msg.target_username;
    if (!lobby.invited.includes(target)) lobby.invited.push(target);
    const tw = byName.get(target);
    if (tw) send(tw, 'lobby_invite_received', { lobby_id: lobby.id, lobby_name: lobby.name, from: player.username });
}

function handleGetPublicLobbies(ws) {
    const list = [];
    lobbies.forEach(lobby => {
        if (lobby.is_public && lobby.players.length < lobby.max_players) list.push(lobbySummary(lobby));
    });
    send(ws, 'public_lobbies', { lobbies: list });
}

// ---------------------------------------------------------------------------
// WebSocket server
// ---------------------------------------------------------------------------

const wss = new WebSocket.Server({ port: PORT });
console.log(`Relay server listening on port ${PORT}`);

wss.on('connection', (ws) => {
    ws.on('message', async (raw) => {
        let msg;
        try { msg = JSON.parse(raw); } catch { return; }

        const player = clients.get(ws);

        // Auth messages are allowed before login
        if (!player) {
            switch (msg.type) {
                case 'register':   await handleRegister(ws, msg);  break;
                case 'login':      await handleLogin(ws, msg);     break;
                case 'auto_login': handleAutoLogin(ws, msg);        break;
            }
            return;
        }

        // All other messages require being logged in
        switch (msg.type) {
            case 'hub_move':          handleHubMove(ws, msg, player);     break;
            case 'set_skin':          handleSetSkin(ws, msg, player);     break;
            case 'friend_request':    handleFriendRequest(ws, msg, player); break;
            case 'friend_accept':     handleFriendAccept(ws, msg, player);  break;
            case 'friend_decline':    handleFriendDecline(ws, msg, player); break;
            case 'remove_friend':     handleRemoveFriend(ws, msg, player);  break;
            case 'create_lobby':      handleCreateLobby(ws, msg, player);   break;
            case 'join_lobby':        handleJoinLobby(ws, msg, player);     break;
            case 'leave_lobby':       if (player.lobby_id) leaveLobby(player, ws); break;
            case 'lobby_invite':      handleLobbyInvite(ws, msg, player);   break;
            case 'get_public_lobbies': handleGetPublicLobbies(ws);           break;
            case 'webrtc_offer':
            case 'webrtc_answer':
            case 'webrtc_ice': {
                const tw = byName.get(msg.target);
                if (tw) send(tw, msg.type, { from: player.username, data: msg.data });
                break;
            }
        }
    });

    ws.on('close', () => {
        const player = clients.get(ws);
        if (!player) return;
        const { username } = player;

        if (player.lobby_id) leaveLobby(player, ws);
        broadcastHub('player_left_hub', { username });

        const acc = accounts[username];
        if (acc) {
            acc.friends.forEach(f => {
                const fw = byName.get(f);
                if (fw) send(fw, 'friend_offline', { username });
            });
        }

        clients.delete(ws);
        byName.delete(username);
        console.log(`[-] ${username}`);
    });

    ws.on('error', err => console.error('WebSocket error:', err.message));
});
